"use strict";
/* ============================================================================
 * reset.js —— 重置密码页前端（U3）
 * ----------------------------------------------------------------------------
 * 从 URL ?token= 读取令牌；POST /api/auth/reset-password { token, password }
 *   -> 200 { ok } | 400 令牌无效/过期/已用/密码过短
 * ========================================================================== */
(function () {
  const $ = (s) => document.querySelector(s);
  if (window.attachPwStrength) attachPwStrength({ inputId: "np", barId: "pwBar", tipId: "pwTip", meterId: "pwMeter", matchInputId: "np2", matchMsgId: "pwMatch" });
  const f = $("#f"), np = $("#np"), np2 = $("#np2"), b = $("#b"), e = $("#e");

  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";
  if (!token) {
    e.style.color = "var(--bad)";
    e.textContent = "重置链接缺少令牌，请从完整的重置链接打开。";
    b.disabled = true;
    return;
  }

  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    e.textContent = ""; e.style.color = "var(--bad)";
    const n = np.value, c = np2.value;
    if (n.length < 8) { e.textContent = "新密码至少 8 位"; return; }
    if (n !== c) { e.textContent = "两次输入的密码不一致"; return; }
    b.disabled = true; const ot = b.textContent; b.textContent = "重置中…";
    try {
      const r = await fetch("/api/auth/reset-password", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: n }),
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) {
        e.style.color = "var(--ok)";
        e.textContent = "✅ 密码已重置，正在前往登录…";
        setTimeout(() => { location.href = "/login"; }, 900);
        return;
      }
      e.textContent = (j && j.error) || ("重置失败（HTTP " + r.status + "）");
    } catch (x) {
      e.textContent = "连不上服务：" + x.message;
    } finally {
      b.disabled = false; b.textContent = ot;
    }
  });
})();
