"use strict";
/* ============================================================================
 * forgot.js —— 忘记密码页前端（U3）
 * ----------------------------------------------------------------------------
 * 后端契约：POST /api/auth/forgot-password { username|email }
 *   -> 200 { ok, message } 并（仅开发态 return 模式）附带 { delivery, token, resetUrl }
 * 抗枚举：无论账号是否存在，后端都返回同一套成功文案；只有 return 模式才回传令牌。
 * ========================================================================== */
(function () {
  const $ = (s) => document.querySelector(s);
  const f = $("#f"), id = $("#id"), b = $("#b"), e = $("#e"), box = $("#box"), msg = $("#msg"), url = $("#url"), copy = $("#copy");

  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    e.textContent = ""; e.style.color = "var(--bad)";
    box.style.display = "none";
    const identifier = id.value.trim();
    if (!identifier) { e.textContent = "请输入用户名或邮箱"; return; }
    b.disabled = true; const ot = b.textContent; b.textContent = "处理中…";
    try {
      const r = await fetch("/api/auth/forgot-password", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: identifier }),
      });
      const j = await r.json().catch(() => null);
      if (!(j && j.ok)) { e.textContent = (j && j.error) || ("请求失败（HTTP " + r.status + "）"); return; }
      msg.textContent = j.message || "若该账号存在，已生成重置链接。";
      if (j.delivery === "return" && j.resetUrl) {
        url.textContent = j.resetUrl;
        box.style.display = "";
        // 明确告诉用户：当前是开发态，未真实发信
        e.style.color = "var(--warn)";
        e.textContent = "⚠️ 当前为开发态（PT_RESET_DELIVERY=return）：重置链接直接返回页面，未真实发信。生产接入邮件后切换为 email 模式即可。";
      } else {
        e.style.color = "var(--ok)";
        e.textContent = "✅ 已处理。若为真实发信模式，请查收邮件。";
      }
    } catch (x) {
      e.textContent = "连不上服务：" + x.message;
    } finally {
      b.disabled = false; b.textContent = ot;
    }
  });

  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url.textContent); copy.textContent = "已复制"; }
    catch (x) { copy.textContent = "复制失败，请手动选择"; }
  });
})();
