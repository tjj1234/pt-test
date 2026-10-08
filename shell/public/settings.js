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
      const account = await r.json();
      const identity = $("#accountIdentity");
      if (identity) identity.textContent = [account.user && account.user.username, account.user && account.user.email, account.tenant && account.tenant.name].filter(Boolean).join(" · ") || "已登录";
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

  /* ============================================================================
   * M7【前端半部】：广告与数据源授权分节（mock 先行，待基座接口就绪换血）
   * ----------------------------------------------------------------------------
   * 契约（基座后续按此实现，前端先用 mock 跑通交互）：
   *   GET    /api/auth-accounts        -> [{id,tenantId,accountType,status,scope,updatedAt}]
   *   DELETE /api/auth-accounts/:id    -> 解除该账户授权
   * 切换真实数据：将 USE_MOCK_AUTH_ACCOUNTS 置 false，并确保上面两个端点已上线，
   *   渲染层 renderAccounts(list) 对来源无感知，换源即回归，无需改 UI。
   * ========================================================================== */
  const USE_MOCK_AUTH_ACCOUNTS = true;   // ★ 基座接口上线后改为 false
  const MOCK_ACCOUNTS = [
    { id: "acc_ssgtm_01", tenantId: "t_default", accountType: "SS-GTM", status: "有效",
      scope: "Server 容器 GTM-WP7H3CBN 全量事件转发", updatedAt: "2026-09-28T14:20:00+08:00" },
    { id: "acc_meta_01", tenantId: "t_default", accountType: "Meta", status: "即将过期",
      scope: "Meta CAPI 转化回传（像素 ID 1029…）", updatedAt: "2026-07-12T09:05:00+08:00" },
    { id: "acc_mcp_01", tenantId: "t_default", accountType: "MCP", status: "需重验",
      scope: "MCP 数据源只读权限", updatedAt: "2026-06-30T18:42:00+08:00" },
  ];

  const acctEl = {
    status: $("#acctStatus"), list: $("#acctList"),
    modal: $("#revokeModal"), modalBody: $("#revokeBody"),
    revokeCancel: $("#revokeCancel"), revokeConfirm: $("#revokeConfirm"),
  };
  let acctData = [];
  let pendingRevokeId = null;

  // 状态 -> 徽标配色（有效/即将过期/需重验 三种视觉区分）
  const STATUS_BADGE = { "有效": "ok", "即将过期": "warn", "需重验": "danger" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderAccounts(list) {
    acctData = Array.isArray(list) ? list : [];
    if (!acctData.length) {
      acctEl.status.textContent = "暂无已授权账户，业务线接入后可在此配置。";
      acctEl.list.innerHTML = "";
      return;
    }
    acctEl.status.textContent = "共 " + acctData.length + " 个已授权账户";
    acctEl.list.innerHTML = acctData.map((a) => {
      const bc = STATUS_BADGE[a.status] || "ok";
      const upd = a.updatedAt ? new Date(a.updatedAt).toLocaleString("zh-CN") : "未知";
      return '<div class="acct-item" data-id="' + esc(a.id) + '">'
        + '<div class="acct-main">'
        +   '<div class="acct-type">' + esc(a.accountType) + "</div>"
        +   '<div class="acct-scope">' + esc(a.scope) + "</div>"
        +   '<div class="acct-updated">最后更新：' + esc(upd) + "</div>"
        + "</div>"
        + '<div class="acct-side">'
        +   '<span class="acct-badge ' + bc + '">' + esc(a.status) + "</span>"
        +   '<button type="button" class="acct-revoke" data-id="' + esc(a.id) + '">解除</button>'
        + "</div>"
        + "</div>";
    }).join("");
  }

  async function loadAuthAccounts() {
    if (!USE_MOCK_AUTH_ACCOUNTS) {
      try {
        const r = await fetch("/api/auth-accounts", { credentials: "same-origin" });
        if (r.status === 401) { location.replace("/login"); return; }
        const j = await r.json().catch(() => null);
        renderAccounts(Array.isArray(j) ? j : (j && j.accounts) || []);
      } catch (x) {
        acctEl.status.textContent = "读取授权账户失败：" + x.message;
      }
      return;
    }
    renderAccounts(MOCK_ACCOUNTS);
  }

  function openRevokeModal(id) {
    const a = acctData.find((x) => x.id === id);
    if (!a) return;
    pendingRevokeId = id;
    acctEl.modalBody.textContent =
      "确认解除「" + a.accountType + "」的授权吗？\n\n"
      + "解除影响：\n"
      + "• 该数据源将停止向归因面板回传数据；\n"
      + "• 已生成的归因结果不受影响，但新的事件将不再归集；\n"
      + "• 如需恢复，可在对应平台（GTM 容器 / Meta / MCP）重新授权后再次添加。";
    acctEl.modal.style.display = "flex";
  }
  function closeRevokeModal() {
    pendingRevokeId = null;
    acctEl.modal.style.display = "none";
  }
  async function confirmRevoke() {
    const id = pendingRevokeId;
    closeRevokeModal();
    if (!id) return;
    if (!USE_MOCK_AUTH_ACCOUNTS) {
      try {
        const r = await fetch("/api/auth-accounts/" + encodeURIComponent(id),
          { method: "DELETE", credentials: "same-origin" });
        if (r.status === 401) { location.replace("/login"); return; }
        await loadAuthAccounts();
      } catch (x) {
        acctEl.status.textContent = "解除失败：" + x.message;
      }
      return;
    }
    // mock 阶段：本地移除并刷新，不真正调后端
    acctData = acctData.filter((x) => x.id !== id);
    renderAccounts(acctData);
  }

  // 事件：列表内「解除」按钮（事件委托）
  acctEl.list.addEventListener("click", (ev) => {
    const btn = ev.target.closest && ev.target.closest(".acct-revoke");
    if (btn) openRevokeModal(btn.getAttribute("data-id"));
  });
  acctEl.revokeCancel.addEventListener("click", closeRevokeModal);
  acctEl.revokeConfirm.addEventListener("click", confirmRevoke);
  acctEl.modal.addEventListener("click", (ev) => { if (ev.target === acctEl.modal) closeRevokeModal(); });

  loadAuthAccounts();
})();
