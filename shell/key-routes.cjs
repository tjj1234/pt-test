"use strict";
/**
 * key-routes.cjs —— PT key 存/读路由（存 key 前加「有效性校验」）
 * ============================================================================
 * 存 key 流程：
 *   ① 本地「格式校验」（fail-fast，不发网络）：
 *        非字符串 / 空 / 太短(<4) / 太长(>256) / 明显非法字符（空格、换行、非 ASCII）
 *   ② 「有效性校验」（live 探活）：对 PowerTokens 做一次最小代价鉴权探测
 *         GET {PT_KEY_VERIFY_BASEURL}/models ，带 Authorization: Bearer <key>
 *         2xx → 有效；401/403 → 无效；404 → 端点/地址不对；429/5xx/网络/超时
 *         → 暂时无法完成校验。以上非 2xx 一律拒绝落库并给中文原因（fail-closed）。
 *   ③ 校验通过才用 keys.cjs 的 encryptApiKey（AES-256-GCM 主密钥）落库。
 *
 * ★ live 探活默认开启（PT_KEY_LIVE_VERIFY 默认 "1"）。退化开关：PT_KEY_LIVE_VERIFY=0
 *   → 仅格式校验（不再发网络），保存响应里 verified="format"。
 * 默认 PT 校验端点：https://api.powertokens.ai/v1，可用 PT_KEY_VERIFY_BASEURL 覆盖。
 *
 * 对外 API：
 *   POST /api/auth/key   保存前先校验，通过才落库 → 只回 { ok, key_last4, verified }
 *   GET  /api/auth/key   只回 { key_last4, updated_at }（或 null），绝不回明文
 * 安全铁律：明文 key 只进内存 + Authorization 头；绝不打日志 / 不回传 / 不进错误信息。
 * ============================================================================
 */
const http = require("http");
const https = require("https");
const { sessionFromCookie } = require("./auth-routes.cjs");

const MAX_KEY_LEN = 256;                            // 与 keys.cjs 一致
const DEFAULT_PT_BASEURL = "https://api.powertokens.ai/v1";
const VERIFY_PATH = "/models";                      // 最小代价鉴权探测端点

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/* ============================================================================
 * ① 本地格式校验（fail-fast，不发网络）
 * ========================================================================== */
function validatePtKeyFormat(value) {
  if (typeof value !== "string") {
    return { ok: false, code: "NOT_STRING", reason: "PT key 必须是字符串" };
  }
  const text = value.trim();
  if (!text) return { ok: false, code: "EMPTY", reason: "PT key 不能为空" };
  if (text.length < 4) return { ok: false, code: "TOO_SHORT", reason: "PT key 太短（至少 4 位）" };
  if (text.length > MAX_KEY_LEN) return { ok: false, code: "TOO_LONG", reason: "PT key 太长（最多 " + MAX_KEY_LEN + " 字符）" };
  if (/[^\x21-\x7E]/.test(text)) {
    return { ok: false, code: "ILLEGAL_CHARS", reason: "PT key 含非法字符（空格/换行/非英文字符等）" };
  }
  return { ok: true, text };
}

/* ============================================================================
 * ② 有效性校验（live 探活）
 * ========================================================================== */
function liveVerifyEnabled(env) {
  const v = String((env || process.env).PT_KEY_LIVE_VERIFY || "1").trim().toLowerCase();
  return v !== "0" && v !== "off" && v !== "false" && v !== "no";
}

function liveVerifyPtKey(plaintext, opts = {}) {
  return new Promise((resolve) => {
    let baseURL = String(opts.baseURL != null ? opts.baseURL : (process.env.PT_KEY_VERIFY_BASEURL || DEFAULT_PT_BASEURL)).trim();
    if (!baseURL) return resolve({ ok: false, code: "VERIFY_DISABLED", reason: "未配置 PT 校验地址" });
    baseURL = baseURL.replace(/\/+$/, "");

    let u;
    try { u = new URL(baseURL + VERIFY_PATH); }
    catch (e) { return resolve({ ok: false, code: "VERIFY_BAD_URL", reason: "PT 校验地址不合法" }); }

    const mod = u.protocol === "https:" ? https : http;
    const timeoutMs = Number(opts.timeoutMs != null ? opts.timeoutMs : (process.env.PT_KEY_VERIFY_TIMEOUT_MS || 8000)) || 8000;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    let req;
    try {
      req = mod.request({
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          Authorization: "Bearer " + plaintext,          // 明文只出现在这里
          Accept: "application/json",
          "User-Agent": "northstar-key-check/1.0",
        },
        timeout: timeoutMs,
      }, (res) => {
        res.resume();
        const st = res.statusCode || 0;
        if (st >= 200 && st < 300) return done({ ok: true, status: st, code: "OK" });
        if (st === 401 || st === 403) return done({ ok: false, status: st, code: "AUTH_REJECTED", reason: "PT 拒绝了这个 key（鉴权失败）" });
        if (st === 404) return done({ ok: false, status: st, code: "ENDPOINT_NOT_FOUND", reason: "PT 校验端点不存在（baseURL 可能不对）" });
        if (st === 429) return done({ ok: false, status: st, code: "RATE_LIMITED", reason: "PT 校验被限流，请稍后重试" });
        return done({ ok: false, status: st, code: "PT_ERROR", reason: "PT 校验端点返回异常状态 " + st + "，暂时无法确认 key 是否有效" });
      });
    } catch (e) {
      return done({ ok: false, code: "NETWORK", reason: "无法发起 PT 校验请求（" + (e && e.code ? e.code : "网络错误") + "）" });
    }

    req.on("timeout", () => { req.destroy(); done({ ok: false, code: "TIMEOUT", reason: "PT 校验超时，暂时无法确认 key 是否有效" }); });
    req.on("error", (e) => done({ ok: false, code: "NETWORK", reason: "连不上 PT 校验端点（" + (e && e.code ? e.code : "网络错误") + "）" }));
    req.end();
  });
}

async function runLiveVerify(text) {
  if (!liveVerifyEnabled(process.env)) {
    return { ok: true, code: "FORMAT_ONLY", mode: "format", reason: "已跳过 live 校验（PT_KEY_LIVE_VERIFY=0，仅格式校验）" };
  }
  const r = await liveVerifyPtKey(text, {});
  return r.ok
    ? { ok: true, code: "OK", mode: "live", status: r.status }
    : { ok: false, code: r.code, mode: "live", status: r.status, reason: r.reason };
}

/* ============================================================================
 * 路由入口
 * ========================================================================== */
async function handleKeyRoutes(req, res, auth, keys) {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  if (p !== "/api/auth/key") return false;
  const method = (req.method || "GET").toUpperCase();

  try {
    const s = await sessionFromCookie(req, auth);
    if (!s) return sendJson(res, 401, { ok: false, error: "没登录" }), true;

    if (method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { /* 非法 JSON 当空 */ }
      const raw = body.key != null ? body.key : (body.apiKey != null ? body.apiKey : "");

      // ① 格式校验
      const fmt = validatePtKeyFormat(raw);
      if (!fmt.ok) return sendJson(res, 400, { ok: false, code: fmt.code, error: "key 校验失败：" + fmt.reason }), true;

      // ② 有效性校验（live 探活，或退化纯格式校验）
      const live = await runLiveVerify(fmt.text);
      if (!live.ok) return sendJson(res, 400, { ok: false, code: live.code, error: "key 校验失败：" + (live.reason || "key 无效") }), true;

      // ③ 通过 → AES-256-GCM 加密落库（明文零落盘）
      const r = await keys.encryptApiKey(s.user.id, fmt.text);
      if (!r.ok) return sendJson(res, 400, { ok: false, code: r.code, error: r.error }), true;
      return sendJson(res, 200, { ok: true, key_last4: r.key_last4, verified: live.mode || "format" }), true;
    }

    if (method === "GET") {
      const meta = await keys.getKeyMeta(s.user.id);
      return sendJson(res, 200, {
        ok: true,
        key: meta ? { key_last4: meta.key_last4, updated_at: meta.updated_at } : null,
      }), true;
    }

    return sendJson(res, 405, { ok: false, error: "只支持 GET / POST" }), true;
  } catch (e) {
    console.error("[key] 出错：", e && e.message ? e.message : e);
    sendJson(res, 500, { ok: false, error: "服务器内部错误" });
    return true;
  }
}

module.exports = {
  handleKeyRoutes,
  validatePtKeyFormat,
  liveVerifyPtKey,
  liveVerifyEnabled,
  runLiveVerify,
  DEFAULT_PT_BASEURL,
  MAX_KEY_LEN,
  VERIFY_PATH,
};
