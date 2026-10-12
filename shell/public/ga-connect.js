"use strict";
/* ============================================================================
 * ga-connect.js —— Google Analytics 账户连接（技能页 / 设置页共用）
 * ----------------------------------------------------------------------------
 * 来源：这段真实逻辑原本写在 settings.js 的 loadGaStatus() / connectGa() 里。
 *       技能页面改版需要同一套能力，这里整体搬出来共享 —— 契约、校验规则、
 *       错误文案与原来完全一致，不另写一份实现。
 *
 * 依赖后端契约（业务线已合并进 main：GA 连接 92c26b2 / 解除连接 2922274）：
 *   GET    /api/business/ga-connector/status
 *          -> 200 { ok:true, connected, propertyId, updatedAt }  未绑定时 connected:false
 *   GET    /api/business/ga-connector/oauth/authorize?propertyId=<纯数字>
 *          -> 302 跳真实 Google 授权页（PKCE + state，一次性）
 *   DELETE /api/business/ga-connector/connection
 *          -> 200，删除本租户绑定；未连接时同样 200（幂等）
 *
 * 三条请求都走 shell 的 /api/business 反代：浏览器只带同源登录 cookie，
 * shell 侧按租户算 HMAC token 转发给 analytics，前端不接触任何 token。
 *
 * P1-3：所有外部文本一律走 textContent，本文件不产生 HTML 字符串。
 * ========================================================================== */
(function () {
  var STATUS_URL = "/api/business/ga-connector/status";
  var CONNECTION_URL = "/api/business/ga-connector/connection";
  var AUTHORIZE_URL = "/api/business/ga-connector/oauth/authorize";
  var PROPERTY_ID_RE = /^\d+$/;
  var PROPERTY_ID_HINT = "请输入纯数字的 GA4 property ID，例如 123456789；不是 G- 开头的衡量 ID。";
  var PROPERTY_ID_TIP = "property ID 是 GA4 后台里那串纯数字，不是 G- 开头的衡量 ID。";

  // property ID 校验：与 settings.js connectGa() 同一条规则（纯数字）
  function validatePropertyId(v) {
    return PROPERTY_ID_RE.test(String(v == null ? "" : v).trim());
  }

  // 读真实连接状态；拿不到/未登录返回 null（未登录会跳登录页）
  async function loadStatus() {
    var r = await fetch(STATUS_URL, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 401) { location.replace("/login"); return null; }
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.ok !== true || typeof j.connected !== "boolean") return null;
    return { ok: true, connected: !!j.connected, propertyId: j.propertyId || null, updatedAt: j.updatedAt || null };
  }

  // 解除连接；成功返回 true（含「本来就没连」的幂等成功）
  async function disconnect() {
    var r = await fetch(CONNECTION_URL, { method: "DELETE", credentials: "same-origin" });
    if (r.status === 401) { location.replace("/login"); return false; }
    if (!r.ok) return false;
    var j = await r.json().catch(function () { return null; });
    return !j || j.ok !== false;
  }

  function authorizeUrl(propertyId) {
    return AUTHORIZE_URL + "?propertyId=" + encodeURIComponent(String(propertyId).trim());
  }

  function defaultOpenWindow(url) {
    try { return window.open(url, "ga-oauth", "width=520,height=680"); } catch (e) { return null; }
  }

  /* 发起真实授权。
   * 用弹窗承载 Google 授权页，当前页面不跳走 —— 授权完成后能原地继续「去使用」。
   * 弹窗被浏览器拦截时退化为同页跳转（= settings.js 原来的 location.assign 行为）。
   * 回调：onDone(连接状态) / onFail(文案) / onInvalid(文案) / onRedirect(url)
   * 返回 { cancel } 可提前停掉轮询；同页跳转或参数非法时返回 null。
   */
  function connect(opts) {
    var o = opts || {};
    var propertyId = String(o.propertyId == null ? "" : o.propertyId).trim();
    if (!validatePropertyId(propertyId)) {
      if (typeof o.onInvalid === "function") o.onInvalid(PROPERTY_ID_HINT);
      return null;
    }
    var url = authorizeUrl(propertyId);
    var open = typeof o.openWindow === "function" ? o.openWindow : defaultOpenWindow;
    var win = null;
    try { win = open(url); } catch (e) { win = null; }
    if (!win) {
      if (typeof o.onRedirect === "function") o.onRedirect(url);
      else location.assign(url);
      return null;
    }
    var timeoutMs = o.timeoutMs || 180000;
    var intervalMs = o.intervalMs || 1500;
    var started = Date.now();
    var stopped = false;
    var timer = setInterval(async function () {
      if (stopped) return;
      var st = null;
      try { st = await (o.loadStatus || loadStatus)(); } catch (e) { st = null; }
      if (st && st.connected) {
        stopped = true; clearInterval(timer);
        try { win.close(); } catch (e) {}
        if (typeof o.onDone === "function") o.onDone(st);
        return;
      }
      if (win.closed && Date.now() - started > 3000) {
        stopped = true; clearInterval(timer);
        if (typeof o.onFail === "function") o.onFail("授权窗口已关闭，未检测到连接。");
        return;
      }
      if (Date.now() - started > timeoutMs) {
        stopped = true; clearInterval(timer);
        try { win.close(); } catch (e) {}
        if (typeof o.onFail === "function") o.onFail("等待授权超时，请重新连接。");
      }
    }, intervalMs);
    return { cancel: function () { stopped = true; clearInterval(timer); } };
  }

  window.GaConnect = {
    STATUS_URL: STATUS_URL,
    CONNECTION_URL: CONNECTION_URL,
    AUTHORIZE_URL: AUTHORIZE_URL,
    PROPERTY_ID_HINT: PROPERTY_ID_HINT,
    PROPERTY_ID_TIP: PROPERTY_ID_TIP,
    validatePropertyId: validatePropertyId,
    authorizeUrl: authorizeUrl,
    loadStatus: loadStatus,
    disconnect: disconnect,
    connect: connect,
  };
})();
