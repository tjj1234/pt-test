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
const { createRateLimiter, createLoginGuard, clientIp } = require("./ratelimit.cjs");

const COOKIE_NAME = "pt_session";

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
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    return true;
  }

  return false; // 不是身份接口，交给别的处理器
}

module.exports = { handleAuthRoutes, sessionFromCookie, parseCookie, COOKIE_NAME };
