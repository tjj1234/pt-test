"use strict";
/* ============================================================================
 * key-drawer.js —— 「我的 PT Key」侧边抽屉（体验优化）
 * ----------------------------------------------------------------------------
 * 把原来独立的 /settings 页面改成右侧抽屉弹窗：
 *   · 点侧栏「我的 Key」/ 未绑提示条 / 聊天里的「🔑 去绑定」→ 右侧滑出抽屉，不离开当前页；
 *   · 抽屉右上角「×」、底部「完成」、点遮罩均可关闭；
 *   · 首次进入（没绑 key）自动弹出，绑定成功后同步主界面的红点/末4位/提示条。
 *
 * 安全铁律沿用 settings.js：明文 PT key 只在「保存」的局部变量 + 请求体里出现，
 *   提交后立即清空输入框；不落本地存储、不打日志、不进地址栏。
 * ========================================================================== */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const PT_PORTAL_URL = "https://powertokens.ai";

  /* ---- 注入样式（复用 styles.css 的 CSS 变量，不新造配色） ---- */
  const style = document.createElement("style");
  style.textContent = [
    ".kd-overlay{position:fixed;inset:0;z-index:100;display:flex;justify-content:flex-end}",
    ".kd-overlay[hidden]{display:none}",
    ".kd-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.35)}",
    ".kd-panel{position:relative;width:400px;max-width:92vw;height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(15,23,42,.18)}",
    ".kd-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)}",
    ".kd-head h2{font-size:16px;margin:0;color:var(--ink)}",
    ".kd-close{width:30px;height:30px;border:0;border-radius:8px;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--sub)}",
    ".kd-close:hover{background:#f1f3f9;color:var(--ink)}",
    ".kd-body{flex:1;overflow:auto;padding:18px 20px}",
    ".kd-foot{padding:14px 20px;border-top:1px solid var(--line)}",
    ".kd-foot button{width:100%}",
    ".kd-portal{display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:12px 14px;border:1px dashed var(--line);border-radius:10px;background:#fafbff;font-size:13px}",
    ".kd-portal a{font-weight:600;text-decoration:none}",
    ".kd-status{font-size:13px;color:var(--sub);margin-bottom:14px}",
    ".kd-keyrow{display:flex;gap:8px}",
    ".kd-keyrow input{flex:1;font-family:ui-monospace,Consolas,monospace}",
    ".kd-ghost{flex:0 0 auto;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--sub);font-size:13px;cursor:pointer;font-family:inherit}",
    ".kd-ghost:hover{border-color:var(--brand);color:var(--brand)}",
    ".kd-bound{text-align:center;padding:14px 0 4px}",
    ".kd-badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--ok);background:#e8f7ee;border-radius:999px;padding:5px 14px}",
    ".kd-mask{font:600 26px/1.4 ui-monospace,Consolas,monospace;letter-spacing:2px;margin:14px 0 4px;color:var(--ink)}",
    ".kd-sub{font-size:12px;color:var(--sub);margin-bottom:16px}",
    ".kd-err{font-size:13px;color:var(--bad);min-height:18px;margin:10px 0}",
    ".kd-hint{font-size:12px;color:var(--sub);margin-top:14px;line-height:1.6}",
    ".kd-cancel{width:100%;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--sub);font-size:13px;cursor:pointer;font-family:inherit}",
    ".kd-cancel:hover{border-color:var(--brand);color:var(--brand)}",
    ".kd-cancel[hidden]{display:none}",
  ].join("\n");
  document.head.appendChild(style);

  /* ---- 注入抽屉 DOM ---- */
  const overlay = document.createElement("div");
  overlay.className = "kd-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="kd-backdrop"></div>' +
    '<aside class="kd-panel">' +
      '<div class="kd-head"><h2>🔑 我的 PT Key</h2><button class="kd-close" id="kdClose" type="button" title="关闭">×</button></div>' +
      '<div class="kd-body">' +
        '<div class="kd-portal"><span>🔑</span><span>还没有 key？</span><a id="kdPtLink" href="' + PT_PORTAL_URL + '" target="_blank" rel="noopener noreferrer">前往 PowerTokens 获取 ↗</a></div>' +
        '<div class="kd-status" id="kdStatus">读取中…</div>' +
        '<div id="kdInputArea" hidden>' +
          '<label for="kdKey">粘贴你的 PT Key（例如 sk-…）</label>' +
          '<div class="kd-keyrow">' +
            '<input id="kdKey" type="password" placeholder="sk-…" spellcheck="false" autocomplete="off">' +
            '<button type="button" id="kdToggle" class="kd-ghost">显示</button>' +
          '</div>' +
          '<button class="btn" id="kdSave" type="button">保存绑定</button>' +
          '<button type="button" id="kdCancel" class="kd-cancel" hidden>取消修改</button>' +
        '</div>' +
        '<div id="kdBoundArea" hidden>' +
          '<div class="kd-bound"><span class="kd-badge">✅ 已绑定</span><div class="kd-mask" id="kdMask">····</div><div class="kd-sub" id="kdUpdated"></div></div>' +
          '<button type="button" class="btn" id="kdModify">修改 Key</button>' +
        '</div>' +
        '<div class="kd-err" id="kdErr"></div>' +
        '<div class="kd-hint">你的 PT key 只在你点「保存绑定」时进入浏览器内存并立即 POST 到服务端加密落库，提交后输入框马上清空；明文 key 不会写入本地存储、不会打印到控制台、也不会出现在网址里。服务端也只回显末 4 位。</div>' +
      '</div>' +
      '<div class="kd-foot"><button class="btn" id="kdDone" type="button">完成</button></div>' +
    '</aside>';
  document.body.appendChild(overlay);

  const el = {
    status: $("#kdStatus"), inputArea: $("#kdInputArea"), boundArea: $("#kdBoundArea"),
    key: $("#kdKey"), toggle: $("#kdToggle"), save: $("#kdSave"), modify: $("#kdModify"),
    cancel: $("#kdCancel"), mask: $("#kdMask"), updated: $("#kdUpdated"), err: $("#kdErr"),
  };
  const closeBtn = $("#kdClose"), doneBtn = $("#kdDone");

  let bound = false, busy = false;
  const setErr = (m) => { el.err.textContent = m || ""; };
  const maskOf = (last4) => "····" + (last4 || "");

  function renderUnset() {
    bound = false; el.boundArea.hidden = true; el.inputArea.hidden = false;
    el.status.textContent = "当前账号还没有绑定 PT key";
    el.key.value = ""; el.key.disabled = false;
    el.save.disabled = false; el.save.textContent = "保存绑定";
    el.cancel.hidden = true; el.key.focus();
  }
  function renderBound(last4, updatedAt) {
    bound = true; el.inputArea.hidden = true; el.boundArea.hidden = false;
    el.status.textContent = "当前账号已绑定 PT key";
    el.mask.textContent = maskOf(last4);
    el.updated.textContent = updatedAt ? "上次更新：" + new Date(updatedAt).toLocaleString("zh-CN") : "";
    el.key.value = ""; setErr("");
  }
  function renderEdit() {
    el.boundArea.hidden = true; el.inputArea.hidden = false;
    el.status.textContent = "修改：粘贴新 key 覆盖旧的";
    el.key.value = ""; el.key.disabled = false;
    el.save.disabled = false; el.save.textContent = "保存并覆盖";
    el.cancel.hidden = false; el.key.focus();
  }

  async function loadState() {
    try {
      const r = await fetch("/api/auth/key", { credentials: "same-origin" });
      if (r.status === 401) { location.replace("/login"); return; }
      const j = await r.json().catch(() => null);
      if (j && j.ok) {
        if (j.key && j.key.key_last4) renderBound(j.key.key_last4, j.key.updated_at);
        else renderUnset();
      } else { setErr((j && j.error) || "读取 key 状态失败（HTTP " + r.status + "）"); renderUnset(); }
    } catch (x) { setErr("连不上服务：" + x.message); renderUnset(); }
  }

  /* 绑定成功后，同步主界面的 key 状态（红点 / 末4位 / 未绑提示条） */
  function syncAppIndicators(last4) {
    const dot = $("#keyDot"), last4El = $("#keyLast4"), banner = $("#keyBanner");
    const has = !!last4;
    if (dot) dot.hidden = has;
    if (last4El) { last4El.hidden = !has; if (has) last4El.textContent = "····" + last4; }
    if (banner) banner.hidden = has;
  }

  async function doSave() {
    const key = el.key.value.trim();
    if (!key) { setErr("请先粘贴你的 PT key"); return; }
    if (busy) return;
    busy = true; el.save.disabled = true; el.save.textContent = "保存中…";
    el.key.value = "";   // ★ POST 前立刻清空输入框
    try {
      const r = await fetch("/api/auth/key", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
      });
      if (r.status === 401) { location.replace("/login"); return; }
      const j = await r.json().catch(() => null);
      if (j && j.ok && j.key_last4) {
        setErr(""); renderBound(j.key_last4, null); syncAppIndicators(j.key_last4);
      } else {
        setErr((j && j.error) || "保存失败（HTTP " + r.status + "）"); renderEdit();
      }
    } catch (x) { setErr("保存失败（网络）：" + x.message); renderEdit(); }
    finally { el.save.disabled = false; busy = false; }
  }

  function open() { overlay.hidden = false; loadState(); }
  function close() { overlay.hidden = true; }
  window.openKeyDrawer = open;
  window.closeKeyDrawer = close;

  /* ---- 事件 ---- */
  closeBtn.addEventListener("click", close);
  doneBtn.addEventListener("click", close);
  overlay.querySelector(".kd-backdrop").addEventListener("click", close);
  el.save.addEventListener("click", doSave);
  el.modify.addEventListener("click", renderEdit);
  el.cancel.addEventListener("click", () => loadState());
  el.toggle.addEventListener("click", () => {
    const showIt = el.key.type === "password";
    el.key.type = showIt ? "text" : "password";
    el.toggle.textContent = showIt ? "隐藏" : "显示";
    el.key.focus();
  });

  /* ---- 入口接线：侧栏「我的 Key」、未绑提示条（原来是 <a href="/settings">） ---- */
  const keyNav = $("#keyNav"), keyBanner = $("#keyBanner");
  if (keyNav) keyNav.addEventListener("click", (e) => { e.preventDefault(); open(); });
  if (keyBanner) keyBanner.addEventListener("click", (e) => { e.preventDefault(); open(); });

  /* ---- 首次进入：没绑 key 自动弹出抽屉（首次注册/登录后的引导） ---- */
  (async () => {
    try {
      const r = await fetch("/api/auth/key", { credentials: "same-origin" });
      if (r.status === 401) return;
      const j = await r.json().catch(() => null);
      if (j && j.ok && !(j.key && j.key.key_last4)) open();
    } catch (e) { /* 静默 */ }
  })();
})();
