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
    // Every newly registered account starts with exactly 10,000 coins.
    // Preserve the guest's other progress, but set the starting balance consistently.
    guestSave = { ...guestSave, coins: 10000 };
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
    stage = "register_record_location";
    await ensureLoginLogsTable();
    const registerCf = request.cf || {};
    const registerIp = request.headers.get("CF-Connecting-IP") || "";
    await env.DB.prepare(
      "INSERT INTO login_logs (user_id,ip,country,region,city,colo,logged_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(
      id,
      registerIp.slice(0, 64),
      String(registerCf.country || request.headers.get("CF-IPCountry") || "").slice(0, 80),
      String(registerCf.region || "").slice(0, 120),
      String(registerCf.city || "").slice(0, 120),
      String(registerCf.colo || "").slice(0, 20),
      now
    ).run();
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
    // Older D1 databases may have been created before last_login_at was added
    // to the account schema. Add the column automatically without requiring
    // a manual SQL step in the D1 Console.
    stage = "login_check_last_login_column";
    const userColumns = await env.DB.prepare("PRAGMA table_info(users)").all();
    const hasLastLoginColumn = (userColumns.results || []).some(column => column.name === "last_login_at");
    if (!hasLastLoginColumn) {
      stage = "login_add_last_login_column";
      try {
        await env.DB.prepare("ALTER TABLE users ADD COLUMN last_login_at INTEGER").run();
      } catch (error) {
        // Concurrent first logins can both observe the missing column.
        // Ignore only the expected duplicate-column race.
        if (!String(error && error.message || error).toLowerCase().includes("duplicate column")) {
          throw error;
        }
      }
    }

    // Only record a login after the password is verified and a session is created.
    const token = await createSession(user.id, env, setStage);
    const now = Math.floor(Date.now() / 1000);
    stage = "login_update_last_login";
    await env.DB.prepare("UPDATE users SET last_login_at=? WHERE id=?").bind(now, user.id).run();
    stage = "login_record_location";
    await ensureLoginLogsTable();
    const cf = request.cf || {};
    const ip = request.headers.get("CF-Connecting-IP") || "";
    await env.DB.prepare(
      "INSERT INTO login_logs (user_id,ip,country,region,city,colo,logged_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(
      user.id,
      ip.slice(0, 64),
      String(cf.country || request.headers.get("CF-IPCountry") || "").slice(0, 80),
      String(cf.region || "").slice(0, 120),
      String(cf.city || "").slice(0, 120),
      String(cf.colo || "").slice(0, 20),
      now
    ).run();
    stage = "login_build_response";
    return json({ user: { id: user.id, username: user.username } }, 200, { "set-cookie": cookieHeader(token, SESSION_DAYS * 86400) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = cookieValue(request, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }

  if (path === "/api/delete-account" && method === "POST") {
    stage = "delete_account_check_session";
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录后再注销账号" }, 401);

    stage = "delete_account_read_password";
    const body = await readJson(request);
    if (typeof body.password !== "string" || !body.password) {
      return json({ error: "请输入当前账号密码" }, 400);
    }

    stage = "delete_account_verify_password";
    const credentials = await env.DB.prepare(
      "SELECT password_salt,password_hash FROM users WHERE id=? LIMIT 1"
    ).bind(user.id).first();
    if (!credentials) return json({ error: "账号不存在或已注销" }, 404);
    const hash = await passwordHash(body.password, credentials.password_salt, setStage);
    if (hash !== credentials.password_hash) return json({ error: "账号密码错误，未执行注销" }, 401);

    stage = "delete_account_database";
    await env.DB.batch([
      env.DB.prepare("DELETE FROM player_saves WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id)
    ]);
    return json({ ok: true, message: "账号及云端存档已永久删除" }, 200, { "set-cookie": cookieHeader("", 0) });
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

  // Login location history starts with successful logins after this feature is deployed.
  async function ensureLoginLogsTable() {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS login_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ip TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', colo TEXT NOT NULL DEFAULT '', logged_at INTEGER NOT NULL)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_login_logs_user_time ON login_logs(user_id, logged_at DESC)").run();
  }
  // Presence records are created lazily so existing production D1 databases
  // work without a manual migration step.
  async function ensurePresenceTable() {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS player_presence (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, last_seen_at INTEGER NOT NULL)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_player_presence_last_seen ON player_presence(last_seen_at)").run();
  }

  if (path === "/api/heartbeat" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录" }, 401);
    await ensurePresenceTable();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO player_presence (user_id,last_seen_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at")
      .bind(user.id, now).run();
    const row = await env.DB.prepare("SELECT COUNT(*) AS onlineCount FROM player_presence WHERE last_seen_at>?").bind(now - 45).first();
    return json({ ok: true, onlineCount: Number(row && row.onlineCount || 0) });
  }

  if (path === "/api/online-count" && method === "GET") {
    await ensurePresenceTable();
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare("SELECT COUNT(*) AS onlineCount FROM player_presence WHERE last_seen_at>?").bind(now - 45).first();
    return json({ onlineCount: Number(row && row.onlineCount || 0) });
  }

  // Each signed-in player can view only the login history tied to their own session.
  if (path === "/api/my-login-history" && method === "GET") {
    const user = await currentUser(request, env);
    if (!user) return json({ error: "请先登录后查看登录记录" }, 401);
    await ensureLoginLogsTable();
    const rows = await env.DB.prepare(
      "SELECT ip,country,region,city,logged_at FROM login_logs WHERE user_id=? ORDER BY logged_at DESC LIMIT 50"
    ).bind(user.id).all();
    return json({ logins: rows.results || [] });
  }

  if (path === "/api/leaderboard" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT u.username, COALESCE(CAST(json_extract(p.save_json,'$.coins') AS REAL),0) AS coins FROM users u LEFT JOIN player_saves p ON p.user_id=u.id ORDER BY coins DESC, u.created_at ASC LIMIT 10"
    ).all();
    return json({ entries: (rows.results || []).map(row => ({ username: row.username, coins: Math.max(0, Math.floor(Number(row.coins) || 0)) })) });
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


  // Admin console: independent password + short-lived server-side sessions.
  async function ensureAdminSessionsTable() {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at)").run();
  }
  async function currentAdmin() {
    const token = cookieValue(request, "fishjoy_admin_session");
    if (!token) return false;
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>? LIMIT 1")
      .bind(await sha256(token), now).first();
    return !!row;
  }
  function adminCookie(value, maxAge) {
    return value
      ? `fishjoy_admin_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
      : "fishjoy_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
  }

  if (path === "/api/admin/login" && method === "POST") {
    if (!env.ADMIN_PASSWORD) return json({ error: "尚未设置管理员密码，请先在 Cloudflare Worker 设置 ADMIN_PASSWORD Secret" }, 503);
    const body = await readJson(request);
    if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 200) {
      return json({ error: "请输入管理员密码" }, 400);
    }
    // Compare fixed-length digests rather than raw password strings.
    const supplied = await sha256(body.password);
    const expected = await sha256(String(env.ADMIN_PASSWORD));
    if (supplied !== expected) return json({ error: "管理员密码错误" }, 401);
    await ensureAdminSessionsTable();
    const token = randomHex(32);
    const now = Math.floor(Date.now() / 1000);
    const expires = now + 12 * 60 * 60;
    await env.DB.prepare("INSERT INTO admin_sessions (token_hash,created_at,expires_at) VALUES (?,?,?)")
      .bind(await sha256(token), now, expires).run();
    return json({ ok: true, expiresAt: expires }, 200, { "set-cookie": adminCookie(token, 12 * 60 * 60) });
  }

  if (path === "/api/admin/logout" && method === "POST") {
    const token = cookieValue(request, "fishjoy_admin_session");
    if (token) {
      await ensureAdminSessionsTable();
      await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(token)).run();
    }
    return json({ ok: true }, 200, { "set-cookie": adminCookie("", 0) });
  }

  if (path.startsWith("/api/admin/") && path !== "/api/admin/login" && path !== "/api/admin/logout") {
    await ensureAdminSessionsTable();
    if (!(await currentAdmin())) return json({ error: "管理员登录已失效，请重新登录" }, 401);

    if (path === "/api/admin/status" && method === "GET") {
      return json({ ok: true });
    }

    if (path === "/api/admin/players" && method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 80);
      const rows = await env.DB.prepare(
        "SELECT u.id,u.username,u.created_at,p.save_json,p.updated_at FROM users u LEFT JOIN player_saves p ON p.user_id=u.id WHERE (?='' OR u.username LIKE ? OR u.id LIKE ?) ORDER BY u.created_at DESC LIMIT 200"
      ).bind(q, `%${q}%`, `%${q}%`).all();
      const players = (rows.results || []).map(row => {
        let save = {};
        try { save = row.save_json ? JSON.parse(row.save_json) : {}; } catch (_) {}
        return {
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at || null,
          updatedAt: row.updated_at || null,
          coins: Number(save.coins) || 0,
          cannonLevel: Number(save.cannonLevel) || 0,
          saveExists: !!row.save_json
        };
      });
      return json({ players, count: players.length });
    }

    if (path === "/api/admin/player" && method === "GET") {
      const id = String(url.searchParams.get("id") || "").trim();
      if (!id || id.length > 100) return json({ error: "缺少有效的玩家 ID" }, 400);
      const row = await env.DB.prepare(
        "SELECT u.id,u.username,u.created_at,u.last_login_at,p.save_json,p.updated_at FROM users u LEFT JOIN player_saves p ON p.user_id=u.id WHERE u.id=? LIMIT 1"
      ).bind(id).first();
      if (!row) return json({ error: "找不到该玩家" }, 404);
      let save = {};
      try { save = row.save_json ? JSON.parse(row.save_json) : {}; } catch (_) {
        return json({ error: "该玩家存档 JSON 已损坏，已阻止编辑" }, 409);
      }
      return json({
        player: { id: row.id, username: row.username, createdAt: row.created_at, updatedAt: row.updated_at || null },
        save
      });
    }

    if (path === "/api/admin/player" && method === "PUT") {
      const body = await readJson(request);
      const id = String(body.id || "").trim();
      const save = body.save;
      if (!id || id.length > 100) return json({ error: "缺少有效的玩家 ID" }, 400);
      if (!save || typeof save !== "object" || Array.isArray(save)) return json({ error: "存档必须是 JSON 对象" }, 400);
      if (!Number.isFinite(Number(save.coins)) || Number(save.coins) < 0 || Number(save.coins) > 999999) {
        return json({ error: "金币必须是 0 到 999999 之间的数字" }, 400);
      }
      if (JSON.stringify(save).length > 30000) return json({ error: "存档内容过大" }, 413);
      const exists = await env.DB.prepare("SELECT id FROM users WHERE id=? LIMIT 1").bind(id).first();
      if (!exists) return json({ error: "找不到该玩家" }, 404);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "INSERT INTO player_saves (user_id,save_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET save_json=excluded.save_json,updated_at=excluded.updated_at"
      ).bind(id, JSON.stringify(save), now).run();
      return json({ ok: true, updatedAt: now });
    }
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
