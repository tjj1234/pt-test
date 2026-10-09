"use strict";
/* ============================================================================
 * settings-pw.js —— 设置页「修改登录密码」前端（U3，外部脚本以符合 CSP script-src 'self'）
 * ----------------------------------------------------------------------------
 * 后端契约：POST /api/auth/change-password { currentPassword, newPassword }
 *   -> 200 { ok } | 400 当前密码错/新密码过短 | 401 未登录
 * 安全：明文密码只存在于本函数的局部变量 + 请求体；提交后立即清空输入框。
 * ========================================================================== */
(function () {
  const $ = (s) => document.querySelector(s);
  if (window.attachPwStrength) attachPwStrength({ inputId: "np", barId: "pwBar2", tipId: "pwTip2", meterId: "pwMeter2", matchInputId: "np2", matchMsgId: "pwMatch2" });

  const f = $("#pwf"), cp = $("#cp"), np = $("#np"), np2 = $("#np2"), save = $("#pwSave"), e = $("#pwe");

  // 先确认登录态（未登录跳登录页）；确认后再显示该区块
  fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => {
    if (r.status === 401) { location.replace("/login"); return; }
    if (f) f.style.display = "";
  }).catch(() => { if (f) f.style.display = ""; });

  if (!f) return;
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    e.textContent = ""; e.style.color = "var(--bad)";
    const cur = cp.value, n = np.value, c = np2.value;
    if (!cur) { e.textContent = "请输入当前密码"; return; }
    if (n.length < 8) { e.textContent = "新密码至少 8 位"; return; }
    if (n !== c) { e.textContent = "两次输入的新密码不一致"; return; }
    save.disabled = true; const ot = save.textContent; save.textContent = "更新中…";
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: cur, newPassword: n }),
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) { e.style.color = "var(--ok)"; e.textContent = "✅ 密码已更新"; cp.value = np.value = np2.value = ""; }
      else { e.textContent = (j && j.error) || ("更新失败（HTTP " + r.status + "）"); }
    } catch (x) { e.textContent = "连不上服务：" + x.message; }
    finally { save.disabled = false; save.textContent = ot; }
  });
})();
