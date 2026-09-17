"use strict";
/* ============================================================================
 * register.js —— 登录页前端（登录 + 注册，P0-1）
 * ----------------------------------------------------------------------------
 * 依赖后端契约（auth-routes-v2.cjs，已就位，本文件不新增任何路由）：
 *   POST /api/auth/login    -> 200 { ok,user,tenant } 并 Set-Cookie pt_session | 401
 *   POST /api/auth/register -> 200 { ok,user,tenant } | 409 USERNAME_TAKEN | 400 VALIDATION
 *
 * 注册成功 = 服务端自动建「1 用户 = 1 租户」，随后前端用同一组用户名密码自动登录，
 * 然后跳 /settings 引导绑 key（P0-1）。错误文案全部中文，客户端先挡一遍、服务端再兜底。
 *
 * 安全铁律（沿用 settings.js 的规矩）：本文件只把 username/password 放进请求体，
 * 不接触任何 PT key、不写 localStorage / sessionStorage、不 console.log、不进 URL。
 * ========================================================================== */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const el = {
    tabs: Array.prototype.slice.call(document.querySelectorAll(".tab")),
    f: $("#f"), u: $("#u"), p: $("#p"), b: $("#b"), e: $("#e"),           // 登录
    rf: $("#rf"), ru: $("#ru"), rp: $("#rp"), rp2: $("#rp2"), rb: $("#rb"), re: $("#re"), // 注册
  };

  const setBusy = (btn, busy, busyText, idleText) => {
    btn.disabled = busy;
    if (busyText) btn.textContent = busy ? busyText : idleText;
  };

  /* ---------- 「登录 / 注册」标签切换 ---------- */
  function switchTab(tab) {
    el.tabs.forEach((t) => t.classList.toggle("on", t === tab));
    const isLogin = tab.dataset.tab === "login";
    el.f.classList.toggle("on", isLogin);
    el.rf.classList.toggle("on", !isLogin);
    el.e.textContent = "";
    el.re.textContent = "";
    (isLogin ? el.u : el.ru).focus();
  }
  el.tabs.forEach((t) => t.addEventListener("click", () => switchTab(t)));

  /* ---------- 登录 ---------- */
  el.f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (el.b.disabled) return;
    setBusy(el.b, true, "登录中…", "登录");
    el.e.textContent = "";
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: el.u.value.trim(), password: el.p.value }),
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) { location.href = "/"; return; }
      el.e.textContent = (j && j.error) || "登录失败（HTTP " + r.status + "）";
    } catch (x) {
      el.e.textContent = "连不上服务：" + x.message;
    } finally {
      setBusy(el.b, false, null, "登录");
    }
  });

  /* ---------- 注册 ---------- */
  el.rf.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (el.rb.disabled) return;
    const username = el.ru.value.trim();
    const password = el.rp.value;
    const confirm = el.rp2.value;
    el.re.textContent = "";

    // 客户端即时中文提示（后端仍会再校验一遍，双保险）
    if (username.length < 2 || username.length > 64) { el.re.textContent = "用户名需 2~64 个字符"; return; }
    if (password.length < 8) { el.re.textContent = "密码至少 8 位"; return; }
    if (password !== confirm) { el.re.textContent = "两次输入的密码不一致"; return; }

    setBusy(el.rb, true, "注册中…", "注册并进入设置");
    try {
      const rr = await fetch("/api/auth/register", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const rj = await rr.json().catch(() => null);
      if (!(rj && rj.ok)) {
        // 用户名已被占用（409 USERNAME_TAKEN）/ 校验失败（400 VALIDATION）等：后端返回的就是中文
        el.re.textContent = (rj && rj.error) || "注册失败（HTTP " + rr.status + "）";
        return;
      }
      // 注册成功 → 用同一组用户名密码自动登录 → 跳 /settings 引导绑 key
      const lr = await fetch("/api/auth/login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const lj = await lr.json().catch(() => null);
      if (lj && lj.ok) { location.href = "/"; return; }
      el.re.textContent = "注册成功，但自动登录失败，请切回「登录」手动登录";
      switchTab(el.tabs[0]);
    } catch (x) {
      el.re.textContent = "连不上服务：" + x.message;
    } finally {
      setBusy(el.rb, false, null, "注册并进入设置");
    }
  });
})();
