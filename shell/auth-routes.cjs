"use strict";
/**
 * auth-routes.cjs —— 身份 API 的路由胶水（U1.1 + P1 硬化 #8/#9 + P1-1 反代 IP）
 * ============================================================================
 *   #8 登录暴力破解：同一「用户名」或同一「来源 IP」连续失败达标即锁定。
 *   #9 API 限流：/api/auth/login（默认 10/分）、/api/auth/register（默认 5/分）。
 * 阈值均可用环境变量覆盖（自测用）：
 *   PT_RATE_LOGIN_PER_MIN / PT_RATE_REGISTER_PER_MIN
 *   PT_BF_MAX_FAILURES / PT_BF_WINDOW_MS / PT_BF_LOCK_MS
 * ============================================================================
 */
const crypto = require("crypto");
const { createRateLimiter, createLoginGuard, clientIp } = require("./ratelimit.cjs");
// 仅复用 auth.cjs 的哈希原语，不改动其登录/注册/会话等既有逻辑
const { hashPassword, verifyPassword } = require("./auth.cjs");

const COOKIE_NAME = "pt_session";
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// ---- U3：忘记/改密码相关限流（抗枚举 / 抗暴破）----
const forgotLimiter   = createRateLimiter({ windowMs: 60000, max: Number(process.env.PT_RATE_FORGOT_PER_MIN   || 5) });
const changePwLimiter = createRateLimiter({ windowMs: 60000, max: Number(process.env.PT_RATE_CHANGE_PW_PER_MIN || 10) });

// 重置令牌表：懒创建（不新增迁移文件、不碰 db-migrations），users.id 为 UUID
let resetTableReady = false;
async function ensureResetTable(db) {
  if (resetTableReady) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
       token_hash  TEXT PRIMARY KEY,
       user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       expires_at  TIMESTAMPTZ NOT NULL,
       used        INTEGER NOT NULL DEFAULT 0,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  resetTableReady = true;
}

// ---- P1 硬化阈值（生产默认；可用环境变量覆盖供自测）----
const RATE_LOGIN_PER_MIN    = Number(process.env.PT_RATE_LOGIN_PER_MIN    || 10);
const RATE_REGISTER_PER_MIN = Number(process.env.PT_RATE_REGISTER_PER_MIN || 5);
const BF_MAX_FAILURES       = Number(process.env.PT_BF_MAX_FAILURES || 5);
const BF_WINDOW_MS          = Number(process.env.PT_BF_WINDOW_MS    || 10 * 60 * 1000);
const BF_LOCK_MS            = Number(process.env.PT_BF_LOCK_MS      || 10 * 60 * 1000);

const loginLimiter    = createRateLimiter({ windowMs: 60000, max: RATE_LOGIN_PER_MIN });
const registerLimiter = createRateLimiter({ windowMs: 60000, max: RATE_REGISTER_PER_MIN });
const loginGuard      = createLoginGuard({ maxFailures: BF_MAX_FAILURES, windowMs: BF_WINDOW_MS, lockMs: BF_LOCK_MS });

function parseCookie(req, name) {
  const h = req.headers.cookie || "";
  const m = h.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function setSessionCookie(res, token) {
  // P0-4 安全：PT_COOKIE_SECURE=1 时加 Secure（HSTS 由 server 统一加）
  const sec = process.env.PT_COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader("Set-Cookie", COOKIE_NAME + "=" + token + "; HttpOnly; SameSite=Lax; Path=/" + sec);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", COOKIE_NAME + "=; Max-Age=0; Path=/");
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** 从 cookie 反查会话（异步，查库）。未登录 / 过期 / token 无效 → null。 */
async function sessionFromCookie(req, auth) {
  const t = parseCookie(req, COOKIE_NAME);
  return t ? auth.getSession(t) : null;
}

async function handleAuthRoutes(req, res, auth) {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  const method = (req.method || "GET").toUpperCase();

  try {
    // ---- 注册（不传 role，角色由服务端决定）+ P1 #9 限流 ----
    if (p === "/api/auth/register" && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
      // ---- P1 #9：注册按 IP 限流（默认 5/分）----
      if (!registerLimiter.allow(clientIp(req))) {
        return sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }), true;
      }
      const r = await auth.register({
        username: body.username || body.user,
        email: body.email,
        password: body.password || body.pass,
        // 刻意忽略 body.role：匿名用户不能靠请求体自封 admin
      });
      if (!r.ok) return sendJson(res, r.code === "USERNAME_TAKEN" || r.code === "EMAIL_TAKEN" ? 409 : 400, r), true;
      
      // B3-fix：新建租户时自动创建 workspace
      const { createWorkspace } = require("./workspace/index.cjs");
      await createWorkspace("ws_" + r.tenant.id, r.tenant.id);
      
      return sendJson(res, 200, { ok: true, user: r.user, tenant: r.tenant }), true;
    }

    // ---- 登录（含旧接口 /api/login 别名）+ P1 #8/#9 ----
    if ((p === "/api/auth/login" || p === "/api/login") && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}

      const ip = clientIp(req);
      // ---- P1 #9：登录按 IP 限流（默认 10/分）----
      if (!loginLimiter.allow(ip)) {
        return sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }), true;
      }
      const username = String(body.username || body.user || "").trim();
      // ---- P1 #8：同一「用户名」或「来源 IP」连续失败达标即锁定 ----
      if (loginGuard.isLocked(username, ip)) {
        return sendJson(res, 429, { ok: false, error: "尝试次数过多，请稍后再试" }), true;
      }

      const r = await auth.login({ username, password: body.password || body.pass });
      if (!r.ok) {
        loginGuard.recordFailure(username, ip);
        return sendJson(res, 401, r), true;
      }
      loginGuard.clear(username, ip);
      setSessionCookie(res, r.token);
      return sendJson(res, 200, { ok: true, user: r.user, tenant: r.tenant }), true;
    }

    // ---- 登出（含旧接口 /api/logout 别名）----
    if ((p === "/api/auth/logout" || p === "/api/logout") && method === "POST") {
      const t = parseCookie(req, COOKIE_NAME);
      if (t) await auth.logout(t);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true }), true;
    }

    // ---- 当前身份（含旧接口 /api/me 别名）----
    if ((p === "/api/auth/me" || p === "/api/me") && method === "GET") {
      const s = await sessionFromCookie(req, auth);
      if (!s) return sendJson(res, 401, { ok: false, error: "没登录" }), true;
      return sendJson(res, 200, { ok: true, user: s.user, tenant: s.tenant }), true;
    }

    // ===== U3：忘记 / 重置 / 改密码（仅新增这三个端点，不改动既有登录/注册/会话逻辑）=====

    // ---- 忘记密码（返回重置令牌；开发态 PT_RESET_DELIVERY=return 直接在响应返回，不假设任何发信通道）----
    if (p === "/api/auth/forgot-password" && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
      if (!forgotLimiter.allow(clientIp(req))) {
        return sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }), true;
      }
      const identifier = String(body.username || body.email || "").trim();
      let tokenInfo = null;
      if (identifier) {
        const r = await auth.db.query(
          "SELECT id, username, email FROM users WHERE username = $1 OR email = $1",
          [identifier]
        );
        if (r.rows.length) {
          await ensureResetTable(auth.db);
          const token = crypto.randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + Number(process.env.PT_RESET_TTL_MS || 30 * 60 * 1000));
          await auth.db.query(
            "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1,$2,$3)",
            [sha256(token), r.rows[0].id, expiresAt]
          );
          // 开发态：直接把重置链接返回前端，绕开「尚不存在的发信基础设施」
          const delivery = (process.env.PT_RESET_DELIVERY || "return").toLowerCase();
          if (delivery === "return") {
            const host = req.headers.host || "localhost";
            tokenInfo = { delivery, token, resetUrl: "http://" + host + "/reset?token=" + token };
          }
        }
      }
      // 抗账户枚举：无论是否找到用户，都返回同一套成功文案；仅 return 模式才附带令牌
      const out = { ok: true, message: "若该账号存在，已生成重置链接（开发态直接返回在下方）。" };
      if (tokenInfo) { out.delivery = tokenInfo.delivery; out.token = tokenInfo.token; out.resetUrl = tokenInfo.resetUrl; }
      return sendJson(res, 200, out), true;
    }

    // ---- 用令牌重置密码 ----
    if (p === "/api/auth/reset-password" && method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
      const token = String(body.token || "").trim();
      const password = String(body.password || "");
      if (!token) return sendJson(res, 400, { ok: false, error: "缺少重置令牌" }), true;
      if (password.length < 8) return sendJson(res, 400, { ok: false, error: "新密码至少 8 位" }), true;
      await ensureResetTable(auth.db);
      const r = await auth.db.query(
        "SELECT token_hash, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = $1",
        [sha256(token)]
      );
      if (!r.rows.length) return sendJson(res, 400, { ok: false, error: "重置链接无效或已失效" }), true;
      const row = r.rows[0];
      if (row.used) return sendJson(res, 400, { ok: false, error: "该重置链接已使用过" }), true;
      if (new Date(row.expires_at).getTime() < Date.now()) return sendJson(res, 400, { ok: false, error: "重置链接已过期，请重新申请" }), true;
      await auth.db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(password), row.user_id]);
      await auth.db.query("UPDATE password_reset_tokens SET used = 1 WHERE token_hash = $1", [row.token_hash]);
      return sendJson(res, 200, { ok: true }), true;
    }

    // ---- 已登录改密码（校验当前密码后更新；改密后让其他会话失效，保留当前会话）----
    if (p === "/api/auth/change-password" && method === "POST") {
      const sess = await sessionFromCookie(req, auth);
      if (!sess) return sendJson(res, 401, { ok: false, error: "没登录" }), true;
      if (!changePwLimiter.allow(clientIp(req))) {
        return sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }), true;
      }
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
      const current = String(body.currentPassword || "");
      const np = String(body.newPassword || "");
      if (!current) return sendJson(res, 400, { ok: false, error: "请输入当前密码" }), true;
      if (np.length < 8) return sendJson(res, 400, { ok: false, error: "新密码至少 8 位" }), true;
      const ur = await auth.db.query("SELECT password_hash FROM users WHERE id = $1", [sess.user.id]);
      if (!ur.rows.length) return sendJson(res, 400, { ok: false, error: "用户不存在" }), true;
      if (!verifyPassword(current, ur.rows[0].password_hash)) return sendJson(res, 400, { ok: false, error: "当前密码不正确" }), true;
      await auth.db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(np), sess.user.id]);
      const curTok = parseCookie(req, COOKIE_NAME);
      if (curTok) {
        // 改密后让同一用户的其他设备/标签页会话失效，仅保留当前这次会话
        await auth.db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [sess.user.id, sha256(curTok)]);
      }
      return sendJson(res, 200, { ok: true }), true;
    }
  } catch (e) {
    console.error("[auth] 出错：", e && e.message ? e.message : e);
    sendJson(res, 500, { ok: false, error: "服务器内部错误" });
    return true;
  }

  return false; // 不是身份接口，交给别的处理器
}

module.exports = { handleAuthRoutes, sessionFromCookie, parseCookie, COOKIE_NAME };
