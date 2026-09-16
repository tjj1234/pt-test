"use strict";
/* ============================================================================
 * settings.js —— 「我的 PT Key」设置页前端（U4）
 * ----------------------------------------------------------------------------
 * 依赖后端契约（U1 / U2 已就位）：
 *   GET  /api/auth/me   -> 200 { ok, user, tenant }         | 401 未登录
 *   GET  /api/auth/key  -> 200 { ok, key:{key_last4,updated_at}|null } | 401
 *   POST /api/auth/key  -> 200 { ok, key_last4 }            | 400 空/非法 / 401
 * 安全铁律：明文 PT key 只存在于「保存」函数的一个局部变量 + 请求体字符串里，
 *           提交后立即清空输入框；不落任何本地存储、不打任何日志、不进地址栏。
 * ========================================================================== */
(function () {
  const $ = (s) => document.querySelector(s);

  // PT 平台门户地址（可配置常量）。
  // 注：仓库里能确认的只有 API 基址 https://api.powertokens.ai/v1（见
  //     运行时/dsh-home/settings.yaml 的 powertokens.baseURL），Web 门户域名据此
  //     推断为 https://powertokens.ai；产品方给出确切控制台地址后改这一行即可。
  const PT_PORTAL_URL = "https://powertokens.ai";

  const el = {
    f: $("#f"), status: $("#status"), inputArea: $("#inputArea"), boundArea: $("#boundArea"),
    key: $("#key"), toggle: $("#toggle"), save: $("#save"), modify: $("#modify"),
    cancel: $("#cancel"), mask: $("#mask"), updated: $("#updated"), err: $("#e"), ptLink: $("#ptLink"),
  };

  let bound = false;      // 当前是否处于「已绑定」状态
  let busy = false;

  el.ptLink.href = PT_PORTAL_URL;

  const setErr = (m) => { el.err.textContent = m || ""; };
  const show = (n) => { n.style.display = ""; };
  const hide = (n) => { n.style.display = "none"; };
  const setBusy = (b) => { busy = b; el.save.disabled = b; if (b) el.save.textContent = "保存中…"; };
  const maskOf = (last4) => "····" + (last4 || "");   // 只按末 4 位造掩码，绝不拼接明文

  /* ---------- 三种视图 ---------- */
  function renderLoading() {
    hide(el.inputArea); hide(el.boundArea);
    el.status.textContent = "读取中…";
  }
  function renderUnset() {
    bound = false;
    hide(el.boundArea); show(el.inputArea);
    el.status.textContent = "当前账号还没有绑定 PT key";
    el.key.value = ""; el.key.disabled = false;
    el.save.disabled = false; el.save.textContent = "保存绑定";
    hide(el.cancel);
    el.key.focus();
  }
  function renderBound(last4, updatedAt) {
    bound = true;
    hide(el.inputArea); show(el.boundArea);
    el.status.textContent = "当前账号已绑定 PT key";
    el.mask.textContent = maskOf(last4);
    el.updated.textContent = updatedAt
      ? "上次更新：" + new Date(updatedAt).toLocaleString("zh-CN")
      : "";
    el.key.value = "";                    // 明文绝不残留
    setErr("");
  }
  function renderEdit() {
    hide(el.boundArea); show(el.inputArea);
    el.status.textContent = "修改：粘贴新 key 覆盖旧的";
    el.key.value = ""; el.key.disabled = false;
    el.save.disabled = false; el.save.textContent = "保存并覆盖";
    show(el.cancel);
    el.key.focus();
  }

  /* ---------- 登录守卫（未登录跳登录页） ---------- */
  async function ensureLogin() {
    try {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (r.status === 401) { location.replace("/login"); return false; }
      if (!r.ok) { setErr("无法确认登录状态（HTTP " + r.status + "）"); return false; }
      return true;
    } catch (x) { setErr("连不上服务：" + x.message); return false; }
  }

  /* ---------- 读当前 key 状态 ---------- */
  async function loadState() {
    if (!(await ensureLogin())) return;
    try {
      const r = await fetch("/api/auth/key", { credentials: "same-origin" });
      if (r.status === 401) { location.replace("/login"); return; }
      const j = await r.json().catch(() => null);
      if (j && j.ok) {
        if (j.key && j.key.key_last4) renderBound(j.key.key_last4, j.key.updated_at);
        else renderUnset();
      } else {
        setErr((j && j.error) || "读取 key 状态失败（HTTP " + r.status + "）");
        renderUnset();
      }
    } catch (x) {
      setErr("连不上服务：" + x.message);
      renderUnset();
    }
  }

  /* ---------- 保存 / 覆盖（POST 后立即清空输入框） ---------- */
  async function doSave() {
    const key = el.key.value.trim();       // 明文只存在这一个局部变量里
    if (!key) { setErr("请先粘贴你的 PT key"); return; }
    if (busy) return;
    setBusy(true);
    el.key.value = "";                     // ★ POST 前立刻清空输入框，明文不留驻
    try {
      const r = await fetch("/api/auth/key", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),     // key 只进请求体，随后随局部变量一起释放
      });
      if (r.status === 401) { location.replace("/login"); return; }
      const j = await r.json().catch(() => null);
      if (j && j.ok && j.key_last4) {
        setErr("");
        renderBound(j.key_last4, null);
      } else {
        setErr((j && j.error) || "保存失败（HTTP " + r.status + "）");
        renderEdit();                      // 失败回到编辑态，方便重试
      }
    } catch (x) {
      setErr("保存失败（网络）：" + x.message);
      renderEdit();
    } finally {
      el.save.disabled = false;
      busy = false;
    }
  }

  /* ---------- 事件 ---------- */
  el.f.addEventListener("submit", (ev) => { ev.preventDefault(); doSave(); });
  el.save.addEventListener("click", () => doSave());
  el.modify.addEventListener("click", renderEdit);
  el.cancel.addEventListener("click", () => loadState());   // 取消修改：重新读当前状态
  el.toggle.addEventListener("click", () => {
    const showIt = el.key.type === "password";
    el.key.type = showIt ? "text" : "password";
    el.toggle.textContent = showIt ? "隐藏" : "显示";
    el.key.focus();
  });

  /* ---------- 启动 ---------- */
  renderLoading();
  loadState();
})();
