"use strict";
/**
 * ratelimit-v2.cjs —— 单进程内存限流 + 登录暴力破解防护（P1 收尾 · 反代 IP 修复版）
 * ============================================================================
 * 本文件 = ratelimit.cjs（P1 硬化 #8/#9）+ P1-1 修复：
 *
 *   【问题】clientIp() 只信 socket.remoteAddress。按 nginx 模板部署后，
 *          所有请求的 remoteAddress 都变成 127.0.0.1（反代回源），于是：
 *            · /api/chat 限流（默认 20/分）退化成「全站合计 20/分」；
 *            · 登录防爆破的「IP 维度」变成「127.0.0.1 一个桶」，一人失败连坐锁死整站。
 *
 *   【修复】加可信反代开关 TRUST_PROXY：
 *            · 默认（TRUST_PROXY != "1"）—— 只信 socket，与旧行为完全一致，防伪造；
 *            · TRUST_PROXY=1 —— 依次尝试 X-Real-IP、X-Forwarded-For 最左一个，
 *              校验是合法 IP（v4/v6）后才采用，否则回落到 socket。
 *
 *   【信任边界（重要）】只有「nginx 与本应用同机 / 同一可信网络、且 nginx 是唯一入口」
 *           时才允许开 TRUST_PROXY=1。否则外部能伪造 X-Real-IP / X-Forwarded-For
 *           任意 IP，从而绕过按 IP 限流与防爆破（把攻击拆成无数个假 IP）。详见
 *           《P1收尾-落地说明.md》与 nginx.conf.example-v2。
 *
 * 对外接口（与 ratelimit.cjs 完全一致，可无缝替换）：
 *   createRateLimiter({ windowMs, max })        -> { allow(key): boolean }
 *   createLoginGuard({ maxFailures, windowMs, lockMs })
 *       -> { isLocked(username, ip), recordFailure(username, ip), clear(username, ip) }
 *   clientIp(req)                              -> 归一化后的来源 IP
 * ============================================================================
 */

/** 读一个请求头（兼容 Node 将同名头折叠成数组的情况），取第一个字符串值。 */
function _header(req, name) {
  const h = req && req.headers ? req.headers[name] : undefined;
  if (Array.isArray(h)) return h[0];
  return typeof h === "string" ? h : undefined;
}

/**
 * 归一化并校验一个「反代透传的 IP」：
 *   - 去首尾空白；去掉 nginx 可能给 IPv6 加的中括号；
 *   - 仅接受合法 IPv4（4 段 0-255）或形如 hex[:.] 的 IPv6；
 *   - 其余（含注入的逗号列表、换行、伪协议等）一律返回 null（视为不可信，回落 socket）。
 */
function _normalizeProxyIp(s) {
  if (typeof s !== "string") return null;
  let v = s.trim();
  if (!v) return null;
  if (v[0] === "[" && v[v.length - 1] === "]") v = v.slice(1, -1);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    const ok = v.split(".").every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
    return ok ? v : null;
  }
  if (v.includes(":") && /^[0-9a-fA-F:.]+$/.test(v)) return v;
  return null;
}

/** 归一化来源 IP（P1-1：仅在 TRUST_PROXY=1 时才信任反代透传头，默认仍只信 socket）。 */
function clientIp(req) {
  let a = (req && req.socket && req.socket.remoteAddress) || "127.0.0.1";

  // 每次调用读 env：便于自测在同一进程内切换开关，也避免「进程长跑后开关失效」的错觉。
  if (process.env.TRUST_PROXY === "1") {
    const xReal = _header(req, "x-real-ip");
    const xff = _header(req, "x-forwarded-for");
    const candidate = xReal || (xff ? String(xff).split(",")[0] : null);
    const trusted = _normalizeProxyIp(candidate);
    if (trusted) a = trusted;
  }

  if (a === "::1" || a === "::ffff:127.0.0.1") a = "127.0.0.1";
  return String(a);
}

/** 剪掉 arr 中 <= cutoff 的时间戳（就地）。 */
function pruneTimes(arr, cutoff) {
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

const _timers = [];
/** 周期清理：删掉已无有效时间戳的 key，防内存无限增长。unref 不阻塞进程退出。 */
function _scheduleSweep(map, windowMs) {
  const t = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of map) {
      pruneTimes(arr, cutoff);
      if (arr.length === 0) map.delete(k);
    }
  }, Math.max(windowMs, 60000));
  if (t && t.unref) t.unref();
  _timers.push(t);
  return t;
}

/** 滑动窗口限流器。allow(key) 命中并记录一次，返回是否放行。 */
function createRateLimiter({ windowMs = 60000, max = 10 } = {}) {
  const hits = new Map(); // key -> number[] 命中时间戳（升序）
  _scheduleSweep(hits, windowMs);

  function allow(key) {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) { arr = []; hits.set(key, arr); }
    pruneTimes(arr, now - windowMs);
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }

  return { allow };
}

/**
 * 登录暴力破解防护。
 *   recordFailure：同一「用户名」与同一「IP」各记一次失败；任一方在窗口内达到
 *                  maxFailures 即把该维度 lockedUntil 设到 now+lockMs。
 *   isLocked：任一方仍在锁定期内即返回 true（锁定「该用户名+IP」）。
 *   clear：成功登录后清零两个维度。
 */
function createLoginGuard({ maxFailures = 5, windowMs = 600000, lockMs = 600000 } = {}) {
  const byUser = new Map(); // username -> { times:number[], lockedUntil:number }
  const byIp = new Map();   // ip       -> { times:number[], lockedUntil:number }

  function _rec(map, key) {
    let r = map.get(key);
    if (!r) { r = { times: [], lockedUntil: 0 }; map.set(key, r); }
    return r;
  }
  function _prune(r) { pruneTimes(r.times, Date.now() - windowMs); }

  function recordFailure(username, ip) {
    const now = Date.now();
    const u = _rec(byUser, username); _prune(u); u.times.push(now);
    const i = _rec(byIp, ip);         _prune(i); i.times.push(now);
    if (u.times.length >= maxFailures) u.lockedUntil = now + lockMs;
    if (i.times.length >= maxFailures) i.lockedUntil = now + lockMs;
  }

  function isLocked(username, ip) {
    const now = Date.now();
    const u = byUser.get(username);
    if (u && u.lockedUntil > now) return true;
    const i = byIp.get(ip);
    if (i && i.lockedUntil > now) return true;
    return false;
  }

  function clear(username, ip) {
    byUser.delete(username);
    byIp.delete(ip);
  }

  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, r] of byUser) { _prune(r); if (r.times.length === 0 && r.lockedUntil <= now) byUser.delete(k); }
    for (const [k, r] of byIp)   { _prune(r); if (r.times.length === 0 && r.lockedUntil <= now) byIp.delete(k); }
  }, Math.max(windowMs, 60000));
  if (t && t.unref) t.unref();
  _timers.push(t);

  return { isLocked, recordFailure, clear };
}

module.exports = { createRateLimiter, createLoginGuard, clientIp };
