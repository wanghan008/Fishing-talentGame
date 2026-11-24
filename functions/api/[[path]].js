const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 310000;
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
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
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
async function createSession(userId, env) {
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_DAYS * 86400;
  await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)")
    .bind(await sha256(token), userId, now, expires).run();
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
  let stage = "request";
  try {
  if (!env.DB) return json({ error: "服务器尚未绑定 D1 数据库" }, 503);
  if (!validOrigin(request)) return json({ error: "请求来源不合法" }, 403);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const method = request.method.toUpperCase();

  if (path === "/api/register" && method === "POST") {
    stage = "read_body";
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const password = body.password;
    const invalid = validateCredentials(username, password);
    if (invalid) return json({ error: invalid }, 400);
    stage = "password_hash";
    const id = randomHex(16);
    const salt = randomHex(16);
    const hash = await passwordHash(password, salt);
    const now = Math.floor(Date.now() / 1000);
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
    stage = "create_session";
    const token = await createSession(id, env);
    return json({ user: { id, username }, save: guestSave }, 201, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
  }

  if (path === "/api/login" && method === "POST") {
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const password = body.password;
    if (!username || typeof password !== "string") return json({ error: "请输入昵称和密码" }, 400);
    const user = await env.DB.prepare("SELECT id,username,password_salt,password_hash FROM users WHERE username_norm=? LIMIT 1")
      .bind(username.toLocaleLowerCase()).first();
    if (!user) return json({ error: "昵称或密码错误" }, 401);
    const hash = await passwordHash(password, user.password_salt);
    if (hash !== user.password_hash) return json({ error: "昵称或密码错误" }, 401);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE users SET last_login_at=? WHERE id=?").bind(now, user.id).run();
    const token = await createSession(user.id, env);
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

  if (path === "/api/save" && method === "GET") {
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录" }, 401);
    const row = await env.DB.prepare("SELECT save_json,updated_at FROM player_saves WHERE user_id=?").bind(user.id).first();
    return json({ save: row ? JSON.parse(row.save_json) : null, updatedAt: row ? row.updated_at : null });
  }

  if (path === "/api/save" && method === "PUT") {
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录" }, 401);
    const body = await readJson(request);
    if (!body.save || typeof body.save !== "object" || Array.isArray(body.save)) return json({ error: "存档格式不正确" }, 400);
    const save = body.save;
    const coins = Number(save.coins);
    if (!Number.isFinite(coins) || coins < 0 || coins > 999999) return json({ error: "金币数据不合法" }, 400);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO player_saves (user_id,save_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET save_json=excluded.save_json,updated_at=excluded.updated_at"
    ).bind(user.id, JSON.stringify(save), now).run();
    return json({ ok: true, updatedAt: now });
  }

  return json({ error: "接口不存在" }, 404);
  } catch (error) {
    console.error("FishJoy API error:", stage, error);
    return json({ error: "服务器暂时无法处理请求", code: stage }, 500);
  }
}
export async function onRequest(context) {
  return await handle(context.request, context.env);
}
