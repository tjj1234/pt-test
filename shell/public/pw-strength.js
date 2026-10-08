"use strict";
/* ============================================================================
 * pw-strength.js —— 密码强度提示（U3，可复用：注册 / 改密码 / 重置密码共用）
 * ----------------------------------------------------------------------------
 * 纯前端 advisory：只给「强度 + 建议」，不强制；后端仍会校验「至少 8 位」。
 * 暴露全局 attachPwStrength({inputId, barId, tipId, meterId, matchInputId, matchMsgId})
 * 用法：页面先 <script src="/assets/pw-strength.js"></script> 再调用。
 * ========================================================================== */
(function () {
  function score(p) {
    let s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    return s; // 0..5
  }
  function levelOf(s) {
    if (s <= 1) return { t: "弱", c: "bad" };
    if (s <= 3) return { t: "中", c: "warn" };
    return { t: "强", c: "ok" };
  }
  function attachPwStrength(opts) {
    const inp = document.getElementById(opts.inputId);
    const bar = document.getElementById(opts.barId);
    const tip = document.getElementById(opts.tipId);
    const meter = document.getElementById(opts.meterId);
    const matchInp = opts.matchInputId ? document.getElementById(opts.matchInputId) : null;
    const matchMsg = opts.matchMsgId ? document.getElementById(opts.matchMsgId) : null;
    if (!inp || !bar || !tip || !meter) return;

    const chk = function () {
      const v = inp.value;
      if (!v) { meter.hidden = true; return; }
      meter.hidden = false;
      const s = score(v);
      const lv = levelOf(s);
      bar.style.width = (Math.max(1, s) / 5 * 100) + "%";
      bar.className = "pw-bar-fill " + lv.c;
      const req = [];
      if (v.length < 8) req.push("至少 8 位");
      if (!/[A-Z]/.test(v)) req.push("含大写字母");
      if (!/[a-z]/.test(v)) req.push("含小写字母");
      if (!/\d/.test(v)) req.push("含数字");
      if (!/[^A-Za-z0-9]/.test(v)) req.push("含符号");
      tip.textContent = "强度：" + lv.t + (req.length ? ("（建议：" + req.join("、") + "）") : "（已满足全部条件）");
      if (matchInp && matchMsg) {
        if (!matchInp.value) { matchMsg.hidden = true; return; }
        matchMsg.hidden = false;
        if (matchInp.value === v) { matchMsg.textContent = "✅ 两次输入一致"; matchMsg.className = "pw-match ok"; }
        else { matchMsg.textContent = "⚠️ 两次输入的密码不一致"; matchMsg.className = "pw-match bad"; }
      }
    };
    inp.addEventListener("input", chk);
    if (matchInp) matchInp.addEventListener("input", chk);
  }
  window.attachPwStrength = attachPwStrength;
})();
