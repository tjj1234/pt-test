"use strict";
/* ============================================================================
 * key-drawer-v3.js —— 「我的 PT Key」侧边抽屉（体验优化，v3：全 inline style）
 * v3 变化：抽屉的显示/隐藏与关键布局全部用 inline style + style.display 控制，
 *          避开页面里 `[hidden]{display:none!important}` 全局规则与注入样式的不确定性。
 * 功能：点侧栏「我的 Key」/未绑提示条/聊天「去绑定」→ 右侧滑出抽屉，不离开当前页；
 *       右上角 × / 底部「完成」/ 点遮罩均可关闭；首次进入（没绑 key）自动弹出。
 * 安全铁律：明文 PT key 只在「保存」局部变量 + 请求体出现，提交后立即清空输入框。
 * ========================================================================== */
(function () {
  const $ = (s) => document.querySelector(s);
  const PT_PORTAL_URL = "https://powertokens.ai";
  const p = (o) => Object.assign({}, o);

  /* ---- 构造抽屉 DOM（关键布局用 inline style，颜色沿用 CSS 变量） ---- */
  const overlay = document.createElement("div");
  overlay.setAttribute("style",
    "position:fixed;top:0;right:0;bottom:0;left:0;z-index:9999;" +
    "display:none;justify-content:flex-end;align-items:stretch");

  overlay.innerHTML =
    '<div style="position:absolute;top:0;right:0;bottom:0;left:0;background:rgba(15,23,42,.38)"></div>' +
    '<aside style="position:relative;width:400px;max-width:92vw;height:100%;background:#fff;' +
      'display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(15,23,42,.2)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)">' +
        '<h2 style="font-size:16px;margin:0;color:var(--ink)">🔑 我的 PT Key</h2>' +
        '<button id="kdClose" type="button" style="width:30px;height:30px;border:0;border-radius:8px;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--sub)">×</button>' +
      '</div>' +
      '<div style="flex:1;overflow:auto;padding:18px 20px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:12px 14px;border:1px dashed var(--line);border-radius:10px;background:#fafbff;font-size:13px">' +
          '<span>🔑</span><span>还没有 key？</span>' +
          '<a href="' + PT_PORTAL_URL + '" target="_blank" rel="noopener noreferrer" style="font-weight:600;text-decoration:none">前往 PowerTokens 获取 ↗</a>' +
        '</div>' +
        '<div id="kdStatus" style="font-size:13px;color:var(--sub);margin-bottom:14px">读取中…</div>' +
        '<div id="kdInputArea" style="display:none">' +
          '<label for="kdKey">粘贴你的 PT Key（例如 sk-…）</label>' +
          '<div style="display:flex;gap:8px">' +
            '<input id="kdKey" type="password" placeholder="sk-…" spellcheck="false" autocomplete="off" style="flex:1;font-family:ui-monospace,Consolas,monospace">' +
            '<button type="button" id="kdToggle" style="flex:0 0 auto;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--sub);font-size:13px;cursor:pointer;font-family:inherit">显示</button>' +
          '</div>' +
          '<button class="btn" id="kdSave" type="button">保存绑定</button>' +
          '<button type="button" id="kdCancel" style="display:none;width:100%;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--sub);font-size:13px;cursor:pointer;font-family:inherit">取消修改</button>' +
        '</div>' +
        '<div id="kdBoundArea" style="display:none">' +
          '<div style="text-align:center;padding:14px 0 4px">' +
            '<span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--ok);background:#e8f7ee;border-radius:999px;padding:5px 14px">✅ 已绑定</span>' +
            '<div id="kdMask" style="font:600 26px/1.4 ui-monospace,Consolas,monospace;letter-spacing:2px;margin:14px 0 4px;color:var(--ink)">····</div>' +
            '<div id="kdUpdated" style="font-size:12px;color:var(--sub);margin-bottom:16px"></div>' +
          '</div>' +
          '<button type="button" class="btn" id="kdModify">修改 Key</button>' +
        '</div>' +
        '<div id="kdErr" style="font-size:13px;color:var(--bad);min-height:18px;margin:10px 0"></div>' +
        '<div style="font-size:12px;color:var(--sub);margin-top:14px;line-height:1.6">你的 PT key 只在你点「保存绑定」时进入浏览器内存并立即 POST 到服务端加密落库，提交后输入框马上清空；明文 key 不会写入本地存储、不会打印到控制台、也不会出现在网址里。服务端也只回显末 4 位。</div>' +
      '</div>' +
      '<div style="padding:14px 20px;border-top:1px solid var(--line)">' +
        '<button class="btn" id="kdDone" type="button" style="width:100%">完成</button>' +
      '</div>' +
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
  const show = (n) => { n.style.display = "block"; };
  const hide = (n) => { n.style.display = "none"; };

  function renderUnset() {
    bound = false; hide(el.boundArea); show(el.inputArea);
    el.status.textContent = "当前账号还没有绑定 PT key";
    el.key.value = ""; el.key.disabled = false;
    el.save.disabled = false; el.save.textContent = "保存绑定";
    hide(el.cancel); el.key.focus();
  }
  function renderBound(last4, updatedAt) {
    bound = true; hide(el.inputArea); show(el.boundArea);
    el.status.textContent = "当前账号已绑定 PT key";
    el.mask.textContent = maskOf(last4);
    el.updated.textContent = updatedAt ? "上次更新：" + new Date(updatedAt).toLocaleString("zh-CN") : "";
    el.key.value = ""; setErr("");
  }
  function renderEdit() {
    hide(el.boundArea); show(el.inputArea);
    el.status.textContent = "修改：粘贴新 key 覆盖旧的";
    el.key.value = ""; el.key.disabled = false;
    el.save.disabled = false; el.save.textContent = "保存并覆盖";
    show(el.cancel); el.key.focus();
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

  function open() { overlay.style.display = "flex"; loadState(); }
  function close() { overlay.style.display = "none"; }
  window.openKeyDrawer = open;
  window.closeKeyDrawer = close;

  /* ---- 事件 ---- */
  closeBtn.addEventListener("click", close);
  doneBtn.addEventListener("click", close);
  overlay.firstElementChild.addEventListener("click", close); // 遮罩
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

  /* ---- 首次进入：没绑 key 自动弹出抽屉 ---- */
  (async () => {
    try {
      const r = await fetch("/api/auth/key", { credentials: "same-origin" });
      if (r.status === 401) return;
      const j = await r.json().catch(() => null);
      if (j && j.ok && !(j.key && j.key.key_last4)) open();
    } catch (e) { /* 静默 */ }
  })();
})();
