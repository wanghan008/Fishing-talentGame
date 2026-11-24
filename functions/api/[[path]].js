const SESSION_DAYS = 30;
// Cloudflare Workers WebCrypto supports at most 100,000 PBKDF2 iterations.
const PBKDF2_ITERATIONS = 100000;
const COOKIE = "fishjoy_session";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function passwordHash(password, salt, setStage) {
  setStage("password_import_key");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  setStage("password_derive_bits_" + PBKDF2_ITERATIONS);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
  setStage("password_hash_complete");
  return bytesToHex(bits);
}
function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  const part = header.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}
function cookieHeader(value, maxAge) {
  return value
    ? `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
    : `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function validOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 40000) throw new Error("请求内容过大");
  return await request.json();
}
async function currentUser(request, env) {
  const token = cookieValue(request, COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1"
  ).bind(tokenHash, now).first();
  return row || null;
}
async function createSession(userId, env, setStage) {
  setStage("session_generate_token");
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_DAYS * 86400;
  setStage("session_hash_token");
  const tokenHash = await sha256(token);
  setStage("session_database_insert");
  await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)")
    .bind(tokenHash, userId, now, expires).run();
  return token;
}
function normalizeUsername(value) {
  return String(value || "").trim().normalize("NFKC");
}
function validateCredentials(username, password) {
  if (username.length < 3 || username.length > 20 || !/^[\p{L}\p{N}_-]+$/u.test(username)) {
    return "昵称需为3-20位字母、数字、汉字、下划线或短横线";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 72) {
    return "密码长度需为8-72位";
  }
  return "";
}
async function handle(request, env) {
  let stage = "start";
  let traceId = "unavailable";
  const setStage = value => { stage = value; };
  try {
  traceId = crypto.randomUUID();
  stage = "check_database_binding";
  if (!env.DB) return json({ error: "服务器尚未绑定 D1 数据库", code: stage, traceId }, 503);
  stage = "check_request_origin";
  if (!validOrigin(request)) {
    const receivedOrigin = request.headers.get("Origin") || "";
    const apiOrigin = new URL(request.url).origin;
    console.warn("FishJoy origin rejected", { traceId, receivedOrigin, apiOrigin, host: request.headers.get("Host") || "" });
    return json({
      error: "请求来源与游戏服务器地址不一致",
      code: stage,
      traceId,
      diagnostic: {
        receivedOrigin: receivedOrigin || "(Origin header missing)",
        apiOrigin,
        host: request.headers.get("Host") || ""
      }
    }, 403);
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const method = request.method.toUpperCase();

  if (path === "/api/register" && method === "POST") {
    stage = "read_body";
    const body = await readJson(request);
    stage = "normalize_username";
    const username = normalizeUsername(body.username);
    const password = body.password;
    stage = "validate_credentials";
    const invalid = validateCredentials(username, password);
    if (invalid) return json({ error: invalid, code: stage, traceId }, 400);
    stage = "generate_user_credentials";
    const id = randomHex(16);
    const salt = randomHex(16);
    stage = "password_hash";
    const hash = await passwordHash(password, salt, setStage);
    const now = Math.floor(Date.now() / 1000);
    stage = "prepare_guest_save";
    let guestSave = body.guestSave && typeof body.guestSave === "object" ? body.guestSave : {};
    const coins = Number.isFinite(Number(guestSave.coins)) ? Math.max(0, Math.min(999999, Math.floor(Number(guestSave.coins)))) : 10000;
    guestSave = { ...guestSave, coins };
    try {
      stage = "database_insert";
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id,username,username_norm,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?)")
          .bind(id, username, username.toLocaleLowerCase(), salt, hash, now),
        env.DB.prepare("INSERT INTO player_saves (user_id,save_json,updated_at) VALUES (?,?,?)")
          .bind(id, JSON.stringify(guestSave), now)
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return json({ error: "这个游戏昵称已被注册" }, 409);
      throw error;
    }
    const token = await createSession(id, env, setStage);
    stage = "build_register_response";
    return json({ user: { id, username }, save: guestSave }, 201, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
  }

  if (path === "/api/login" && method === "POST") {
    stage = "login_read_body";
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const password = body.password;
    if (!username || typeof password !== "string") return json({ error: "请输入昵称和密码" }, 400);
    stage = "login_find_user";
    const user = await env.DB.prepare("SELECT id,username,password_salt,password_hash FROM users WHERE username_norm=? LIMIT 1")
      .bind(username.toLocaleLowerCase()).first();
    if (!user) return json({ error: "昵称或密码错误" }, 401);
    stage = "login_password_hash";
    const hash = await passwordHash(password, user.password_salt, setStage);
    if (hash !== user.password_hash) return json({ error: "昵称或密码错误" }, 401);
    const now = Math.floor(Date.now() / 1000);
    stage = "login_update_last_login";
    await env.DB.prepare("UPDATE users SET last_login_at=? WHERE id=?").bind(now, user.id).run();
    const token = await createSession(user.id, env, setStage);
    stage = "login_build_response";
    return json({ user: { id: user.id, username: user.username } }, 200, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = cookieValue(request, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }

  if (path === "/api/me" && method === "GET") {
    const user = await currentUser(request, env);
    return user ? json({ user }) : json({ user: null }, 401);
  }

  // Temporary browser-cookie diagnostic: uses a separate harmless test cookie.
  if (path === "/api/debug-cookie" && method === "GET") {
    return json(
      { message: "测试 Cookie 已发送，请再打开 /api/debug-cookie-check 检查浏览器是否保存" },
      200,
      { "set-cookie": "fishjoy_cookie_test=ok; Path=/; Secure; SameSite=Lax; Max-Age=600" }
    );
  }

  if (path === "/api/debug-cookie-check" && method === "GET") {
    const testCookie = cookieValue(request, "fishjoy_cookie_test");
    return json({ testCookieReceived: testCookie === "ok", cookieHeaderPresent: !!request.headers.get("Cookie") });
  }

  // Temporary session diagnostic: never returns the cookie or its hash.
  if (path === "/api/debug-session" && method === "GET") {
    const cookieHeaderValue = request.headers.get("Cookie") || "";
    const token = cookieValue(request, COOKIE);
    if (!token) {
      return json({ cookieHeaderPresent: !!cookieHeaderValue, sessionCookiePresent: false, cookieHeaderLength: cookieHeaderValue.length });
    }
    const tokenHash = await sha256(token);
    const row = await env.DB.prepare(
      "SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1"
    ).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
    return json({ cookieHeaderPresent: !!cookieHeaderValue, sessionCookiePresent: true, tokenLength: token.length, sessionMatched: !!row, user: row ? { id: row.id, username: row.username } : null });
  }

  if (path === "/api/save" && method === "GET") {
    stage = "save_get_check_session";
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录" }, 401);
    stage = "save_get_read_database";
    const row = await env.DB.prepare("SELECT save_json,updated_at FROM player_saves WHERE user_id=?").bind(user.id).first();
    return json({ save: row ? JSON.parse(row.save_json) : null, updatedAt: row ? row.updated_at : null });
  }

  if (path === "/api/save" && method === "PUT") {
    stage = "save_put_check_session";
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录" }, 401);
    stage = "save_put_read_body";
    const body = await readJson(request);
    if (!body.save || typeof body.save !== "object" || Array.isArray(body.save)) return json({ error: "存档格式不正确", code: stage, traceId }, 400);
    stage = "save_put_validate";
    const save = body.save;
    const coins = Number(save.coins);
    if (!Number.isFinite(coins) || coins < 0 || coins > 999999) return json({ error: "金币数据不合法", code: stage, traceId }, 400);
    const now = Math.floor(Date.now() / 1000);
    stage = "save_put_database_write";
    await env.DB.prepare(
      "INSERT INTO player_saves (user_id,save_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET save_json=excluded.save_json,updated_at=excluded.updated_at"
    ).bind(user.id, JSON.stringify(save), now).run();
    stage = "save_put_complete";
    return json({ ok: true, updatedAt: now });
  }

  return json({ error: "接口不存在" }, 404);
  } catch (error) {
    console.error("FishJoy API error", {
      traceId,
      stage,
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : ""
    });
    const diagnostic = {
      name: error && error.name ? String(error.name) : "Error",
      message: error && error.message ? String(error.message).slice(0, 240) : String(error).slice(0, 240)
    };
    return json({
      error: "服务器暂时无法处理请求",
      code: stage,
      traceId,
      ...(stage.startsWith("password_") ? { diagnostic } : {})
    }, 500);
  }
}
export async function onRequest(context) {
  return await handle(context.request, context.env);
}
