/* ==========================================================================
   PowerTokens 归因面板 · 单元 U5 首次接入向导
   --------------------------------------------------------------------------
   四步结构（对齐用户需求）：
     ① 选接入方式      → GTM/sGTM 容器（实时事件） 或 广告平台 CSV 批量上传
     ② sGTM 连接测试   → POST /api/business/attribution/ingestion/connection-test
     ③ 确认事件名映射  → GET/PUT /mapping（与 U6 接入 Tab 同一份存储）
     ④ 上传广告数据校验→ 复用 U4 PTUpload 上传 + 确认，触发 firstConnectedAt 写入
     ⑤ 生成归因面板    → 确认接入完成，跳转到「总览」（归因面板）

   真实接口（A17 / A18，已挂载）：
     POST /api/business/attribution/ingestion/connection-test  { collectUrl, secret, event, probeEventName }
     GET  /api/business/attribution/ingestion/mapping          → { ok, mapping }
     PUT  /api/business/attribution/ingestion/mapping          → { ok, mapping }（merge，null=删除）
     POST /api/business/attribution/ingestion/adapt            → { ok, event|ignored, quality } / 422
     GET  /api/business/attribution/import/workspace           → { workspace: { firstConnectedAt } }
     POST /api/business/attribution/import/jobs + /confirm     （由 U4 PTUpload 复用）

   鉴权：与 U4/U6 同一套——authContext 强制 Authorization: Bearer，优先复用
   app.js 的 resolveToken()。

   依赖全局（先加载 app.js/ingestion.js/upload.js）：RENDERERS / renderPage /
   navigate / escapeHtml / PTIngestionClient / PTImportClient / PTUpload。
   自接线方式与 ingestion.js 相同（IIFE + wire()）。
   ========================================================================== */
(function (global) {
  "use strict";

  const ING_API = "/api/business/attribution/ingestion";

  /* 白名单目标（与 ingestion.js / contracts/invariants.js 对齐）+ ignore */
  const TARGETS = ["visit", "signup", "key_created", "model_call", "recharge", "auto_recharge_toggle"];
  const TARGET_ZH = {
    visit: "访问", signup: "注册", key_created: "创建 Key", model_call: "模型调用",
    recharge: "充值", auto_recharge_toggle: "自动充值开关", ignore: "忽略（不计入归因）",
  };
  const DEFAULT_MAPPINGS = { page_view: "visit", pageview: "visit", sign_up: "signup" };

  /* 后端错误码 → 人话 */
  const ING_ERR_ZH = {
    UNAUTHORIZED: "登录状态没传过去（缺少或无效的分析 token）",
    FORBIDDEN: "分析 token 无效，或当前租户还没有绑定工作区",
    NO_WORKSPACE: "当前租户还没有绑定工作区",
    BAD_MAPPING_TARGET: "映射目标非法（必须是归因白名单事件名或 ignore）",
    BAD_MAPPING: "映射内容非法",
  };
  /* connection-test 诊断码 → 人话（DIAG 来自后端，这里只做兜底文案） */
  const CONN_HINT_EXTRA = {
    OK: "Collect 已接受探测事件，实时接入链路打通。",
    SECRET_INVALID: "Webhook Secret 无效或已轮换，请到设置核对。",
    SECRET_MISSING: "请求未携带 Secret，请确认密钥已填。",
    TARGET_UNREACHABLE: "网络连不上 Collect，检查 URL / 端口 / 防火墙。",
    TARGET_BAD_GATEWAY: "Collect 上游返回 5xx，目标服务可能离线。",
    FORBIDDEN: "Secret 已识别但无权访问该端点（403）。",
    INVALID_EVENT: "探测事件未通过 Collect 校验。",
  };

  /* ---------------- token 解析（与 ingestion.js 同一套优先级） ---------------- */
  function onbToken() {
    try {
      if (typeof global.resolveToken === "function") {
        const t = global.resolveToken();
        if (t) return t;
      }
    } catch (e) { /* app.js 未就绪 */ }
    try {
      const ls = global.localStorage && global.localStorage.getItem("pt_ro_token");
      if (ls) return ls;
    } catch (e) { /* 存储不可用 */ }
    try {
      if (global.CONFIG && global.CONFIG.READONLY_TOKEN) return global.CONFIG.READONLY_TOKEN;
    } catch (e) { /* 忽略 */ }
    return "";
  }

  /* ---------------- 统一请求封装（GET/PUT/POST；本向导有写操作） ---------------- */
  async function onbFetch(path, opts) {
    const o = Object.assign({ credentials: "same-origin" }, opts || {});
    const h = Object.assign({}, o.headers || {});
    const tk = onbToken();
    if (tk && !h.Authorization && !h.authorization) h.Authorization = "Bearer " + tk;
    if (o.body && !h["Content-Type"]) h["Content-Type"] = "application/json";
    o.headers = h;
    let res;
    try {
      res = await fetch(ING_API + path, o);
    } catch (e) {
      throw Object.assign(new Error("网络请求失败：" + e.message), { onbKind: "network" });
    }
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const code = j && j.error && j.error.code;
      const msg = (j && j.error && j.error.message) || (j && j.message) || ("HTTP " + res.status);
      const zh = code && ING_ERR_ZH[code] ? ING_ERR_ZH[code] : null;
      throw Object.assign(new Error(zh ? zh + "（" + code + "）" : msg),
        { onbKind: "http", status: res.status, code: code });
    }
    return j;
  }

  /* 复用 U4/U6 已暴露的全局 client；缺失时本地兜底 */
  const PTOnbClient = {
    getMapping: () => (global.PTIngestionClient
      ? global.PTIngestionClient.getMapping()
      : onbFetch("/mapping").then((j) => (j && j.mapping) || null)),
    putMapping: (mappings) => (global.PTIngestionClient
      ? global.PTIngestionClient.putMapping(mappings)
      : onbFetch("/mapping", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings }) }).then((j) => (j && j.mapping) || null)),
    testConnection: (body) => onbFetch("/connection-test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    adapt: (event) => onbFetch("/adapt", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }),
    }),
    getWorkspace: () => (global.PTImportClient
      ? global.PTImportClient.getWorkspace()
      : null),
  };

  function esc(v) { return escapeHtml(v); }
  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------------- 向导状态（模块级；切 Tab 回来重拉，不做跨 Tab 缓存） ---- */
  const ui = {
    step: 1,
    method: null,            // 'gtm' | 'csv'
    connected: false,        // 连接测试通过（gtm 必过）
    connDiag: null,          // connection-test 返回
    mapping: null,           // 后端最近一次 mapping 对象
    draft: null,             // 编辑中映射草稿
    deleted: null,           // 本次编辑删除的键 Set
    dirty: false,
    firstConnectedAt: null,  // workspace.firstConnectedAt
    uploadDone: false,       // step4 上传确认完成
    busy: false,
    notice: null,            // { tone: 'ok'|'bad', text }
  };

  function resetMappingDraft() {
    ui.draft = Object.assign({}, (ui.mapping && ui.mapping.mappings) || {});
    ui.deleted = new Set();
    ui.dirty = false;
  }

  /* ============================ 顶部步骤条 ============================ */
  const STEP_LABELS = ["选接入方式", "sGTM 连接测试", "确认事件名映射", "上传广告数据校验"];

  function renderStepper() {
    const items = STEP_LABELS.map((label, i) => {
      const n = i + 1;
      const cls = n === ui.step ? " active" : (n < ui.step ? " done" : "");
      const mark = n < ui.step ? "✓" : String(n);
      return '<div class="onb-step ' + cls + '">'
        + '<span class="onb-step-n">' + mark + "</span>"
        + '<span class="onb-step-t">' + esc(label) + "</span>"
        + "</div>";
    }).join('<span class="onb-step-sep">→</span>');
    return '<div class="onb-steps">' + items + "</div>";
  }

  /* ============================ 步骤 1：选接入方式 ============================ */
  function renderStep1() {
    const cards = [
      { m: "gtm", icon: "M3 12h18M12 3v18", t: "GTM / sGTM 容器", d: "通过 Google Tag Manager 服务端容器实时转发事件到 Collect。适合已在用 GTM 的团队，接入后事件实时进入归因。", tone: "realtime" },
      { m: "csv", icon: "M4 4h16v16H4zM4 9h16M9 4v16", t: "广告平台 CSV 批量上传", d: "把 Google Ads / Meta / X 导出的广告花费 CSV 直接上传校验入库。适合先快速把历史广告数据接进来。", tone: "batch" },
    ];
    return '<div class="onb-block">'
      + '<h2 class="section-title">第一步 · 选择接入方式</h2>'
      + '<p class="muted">两种方式可任选其一完成首次接入；后续也可在「接入」Tab 里再补另一种。</p>'
      + '<div class="onb-methods">'
      + cards.map((c) =>
          '<button type="button" class="onb-method' + (ui.method === c.m ? " selected" : "") + '" data-method="' + c.m + '">'
          + '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="' + c.icon + '"/></svg>'
          + '<div class="onb-method-t">' + esc(c.t) + "</div>"
          + '<div class="onb-method-d">' + esc(c.d) + "</div>"
          + "</button>").join("")
      + "</div>"
      + '<div class="onb-step-actions"><button type="button" class="pt-btn primary" id="onb-next1"'
      + (ui.method ? "" : " disabled") + ">下一步</button></div>"
      + "</div>";
  }

  /* ============================ 步骤 2：sGTM 连接测试 ============================ */
  function renderStep2() {
    const isCsv = ui.method === "csv";
    const diagHtml = ui.connDiag ? renderConnDiag(ui.connDiag) : "";
    const gtmHint = isCsv
      ? '<div class="onb-note">你选择了 CSV 批量上传，本步可选。若你同时部署了 GTM/sGTM 容器，也可在此验证 Collect 可达性；不测也能继续。</div>'
      : '<div class="onb-note">把你的 Collect 接收地址与 Webhook Secret 填好，点「测试连接」验证实时链路是否打通。</div>';
    return '<div class="onb-block">'
      + '<h2 class="section-title">第二步 · sGTM 连接测试</h2>'
      + gtmHint
      + '<div class="onb-form">'
      +   '<label class="onb-label">Collect 接收地址</label>'
      +   '<input type="text" class="onb-input" id="onb-collurl" placeholder="https://collect.example.com/api/v1/collect/wh_xxx" />'
      +   '<label class="onb-label">Webhook Secret</label>'
      +   '<input type="password" class="onb-input" id="onb-secret" placeholder="与 Collect 接入密钥一致" />'
      +   '<div class="onb-step-actions">'
      +     '<button type="button" class="pt-btn primary" id="onb-test">测试连接</button>'
      +     (isCsv ? '<button type="button" class="pt-btn" id="onb-next2-skip">跳过，下一步</button>' : "")
      +     '<button type="button" class="pt-btn ghost" id="onb-back2">上一步</button>'
      +   "</div>"
      + "</div>"
      + '<div class="onb-diag" id="onb-diag">' + diagHtml + "</div>"
      + "</div>";
  }

  function renderConnDiag(diagResult) {
    const ok = !!(diagResult && diagResult.ok);
    const diag = diagResult && diagResult.diagnosis ? diagResult.diagnosis : null;
    const title = (diag && diag.title) || (ok ? "连接正常" : "连接失败");
    const hint = (diag && diag.hint)
      || (diag && diag.code && CONN_HINT_EXTRA[diag.code])
      || (ok ? "Collect 已接受探测事件。" : "请查看详情排查。");
    const http = diagResult && diagResult.httpStatus != null ? " · HTTP " + diagResult.httpStatus : "";
    return '<div class="onb-diag-card ' + (ok ? " ok" : " bad") + '">'
      + '<div class="onb-diag-title">' + (ok ? "✓ " : "✕ ") + esc(title) + http + "</div>"
      + '<div class="onb-diag-hint">' + esc(hint) + "</div>"
      + (ui.connected ? '<div class="onb-diag-next">连接已通过，可继续下一步。</div>' : "")
      + "</div>";
  }

  /* ============================ 步骤 3：确认事件名映射 ============================ */
  function targetOptions(selected) {
    let html = '<option value=""' + (selected ? "" : " selected") + ">（未设置）</option>";
    for (const t of TARGETS) {
      html += '<option value="' + t + '"' + (selected === t ? " selected" : "") + ">"
        + t + " · " + TARGET_ZH[t] + "</option>";
    }
    html += '<option value="ignore"' + (selected === "ignore" ? " selected" : "") + ">ignore · " + TARGET_ZH.ignore + "</option>";
    return html;
  }

  function renderStep3() {
    const draft = ui.draft || {};
    const keys = Object.keys(draft).sort();
    const meta = (ui.mapping && ui.mapping.updatedAt)
      ? "上次保存：" + esc(fmtTime(ui.mapping.updatedAt)) + (ui.mapping.updatedBy ? " · " + esc(ui.mapping.updatedBy) : "")
      : "该工作区还没有保存过显式映射（默认映射已生效）";
    const defaultRows = Object.keys(DEFAULT_MAPPINGS).map((k) =>
      '<span class="onb-def-item"><span class="mono">' + esc(k) + "</span> → <span class=\"mono\">" + esc(DEFAULT_MAPPINGS[k]) + "</span></span>").join("");
    const rows = keys.length
      ? keys.map((k) =>
          '<tr data-key="' + esc(k) + '">'
          + '<td class="mono">' + esc(k) + "</td>"
          + '<td><select class="onb-map-sel">' + targetOptions(draft[k]) + "</select></td>"
          + '<td><button type="button" class="onb-del">删除</button></td>'
          + "</tr>").join("")
      : '<tr class="onb-map-empty"><td colspan="3" class="muted">还没有显式映射。下方可新增，例如 sign_up → signup。</td></tr>';

    return '<div class="onb-block">'
      + '<h2 class="section-title">第三步 · 确认事件名映射</h2>'
      + '<p class="muted">把上游原始事件名翻译成归因白名单事件。与「接入」Tab 共用同一份存储，保存后立即生效。</p>'
      + '<div class="onb-map-meta">' + meta + "</div>"
      + '<div class="table-scroll"><table class="onb-maptab">'
      +   "<thead><tr><th>原始事件名</th><th>映射为（归因事件）</th><th></th></tr></thead>"
      +   "<tbody>" + rows + "</tbody></table></div>"
      + '<div class="onb-addrow">'
      +   '<input type="text" class="onb-input onb-add-src" id="onb-add-src" placeholder="原始事件名，如 sign_up" maxlength="128" />'
      +   '<span class="onb-add-arrow">→</span>'
      +   '<select class="onb-add-sel" id="onb-add-sel">' + targetOptions("signup") + "</select>"
      +   '<button type="button" class="pt-btn" id="onb-add">＋ 新增映射</button>'
      + "</div>"
      + '<div class="onb-defs"><b>内置默认映射</b>（系统兜底，不可改）：' + defaultRows + "</div>"
      + '<div class="onb-step-actions">'
      +   '<button type="button" class="pt-btn primary" id="onb-save-map"' + (ui.dirty ? "" : " disabled") + ">保存映射</button>"
      +   '<button type="button" class="pt-btn" id="onb-next3">下一步</button>'
      +   '<button type="button" class="pt-btn ghost" id="onb-back3">上一步</button>'
      + "</div>"
      + "</div>";
  }

  /* ============================ 步骤 4：上传广告数据校验 ============================ */
  function renderStep4() {
    const isCsv = ui.method === "csv";
    const uploadedNote = ui.uploadDone
      ? '<div class="onb-diag-card ok"><div class="onb-diag-title">✓ 广告数据已入库</div>'
        + '<div class="onb-diag-hint">firstConnectedAt = ' + esc(fmtTime(ui.firstConnectedAt)) + "（首次接入已记录）</div></div>"
      : "";
    let body;
    if (isCsv) {
      body = '<p class="muted">上传一份广告花费 CSV（Google Ads / Meta / X 导出），系统会做结构校验与逐行检查，确认后写入归因库并记下首次接入时间。</p>'
        + '<div class="onb-step-actions"><button type="button" class="pt-btn primary" id="onb-upload">上传广告数据</button>'
        + '<button type="button" class="pt-btn" id="onb-check">检查接入状态</button>'
        + '<button type="button" class="pt-btn ghost" id="onb-back4">上一步</button></div>'
        + uploadedNote;
    } else {
      body = '<p class="muted">你选择了 GTM 实时接入，无需上传文件——事件会经 sGTM 实时进入。点击「完成接入」即可进入归因面板；首个实时事件到达时 firstConnectedAt 会自动写入。</p>'
        + '<div class="onb-step-actions"><button type="button" class="pt-btn primary" id="onb-finish-gtm">完成接入</button>'
        + '<button type="button" class="pt-btn ghost" id="onb-back4">上一步</button></div>';
    }
    return '<div class="onb-block">'
      + '<h2 class="section-title">第四步 · 上传广告数据校验</h2>'
      + body
      + "</div>";
  }

  /* ============================ 完成态 ============================ */
  function renderDone() {
    const hasFc = !!ui.firstConnectedAt;
    return '<div class="onb-done">'
      + '<div class="onb-done-badge">✓</div>'
      + '<h2 class="section-title">首次接入完成</h2>'
      + '<p class="muted">' + (hasFc
          ? "已记录首次接入时间：" + esc(fmtTime(ui.firstConnectedAt))
          : "连接与映射已配置完成；首个实时事件到达时 firstConnectedAt 会自动写入。")
      + "</p>"
      + '<div class="onb-step-actions"><button type="button" class="pt-btn primary" id="onb-goto-overview">进入归因面板</button>'
      + '<button type="button" class="pt-btn" id="onb-goto-ingestion">去「接入」Tab 看质量</button></div>'
      + "</div>";
  }

  /* ============================ 主渲染 ============================ */
  function paint(container) {
    container.innerHTML =
      '<div class="onb">'
      + (ui.firstConnectedAt && ui.step <= 4 ? '<div class="onb-already">本工作区已于 ' + esc(fmtTime(ui.firstConnectedAt)) + " 完成首次接入。可重走向导或直达归因面板。</div>" : "")
      + renderStepper()
      + (ui.notice ? '<div class="onb-notice ' + (ui.notice.tone === "ok" ? "ok" : "bad") + '">' + esc(ui.notice.text) + "</div>" : "")
      + (ui.step === 1 ? renderStep1() : "")
      + (ui.step === 2 ? renderStep2() : "")
      + (ui.step === 3 ? renderStep3() : "")
      + (ui.step === 4 ? renderStep4() : "")
      + (ui.step === 5 ? renderDone() : "")
      + "</div>";
    bindEvents(container);
  }

  function rerender() {
    const container = document.getElementById("page-onboarding");
    if (container) paint(container);
  }

  /* ============================ 事件绑定 ============================ */
  function bindEvents(container) {
    // 步骤1：选方式
    container.querySelectorAll(".onb-method").forEach((b) => {
      b.addEventListener("click", () => {
        ui.method = b.dataset.method;
        ui.connected = false; ui.connDiag = null;
        rerender();
      });
    });
    const next1 = container.querySelector("#onb-next1");
    if (next1) next1.addEventListener("click", () => { if (ui.method) { ui.step = 2; rerender(); } });

    // 步骤2：连接测试
    const testBtn = container.querySelector("#onb-test");
    if (testBtn) testBtn.addEventListener("click", doTestConnection);
    const skip2 = container.querySelector("#onb-next2-skip");
    if (skip2) skip2.addEventListener("click", () => { ui.step = 3; ensureMapping(); });
    const back2 = container.querySelector("#onb-back2");
    if (back2) back2.addEventListener("click", () => { ui.step = 1; rerender(); });

    // 步骤3：映射
    bindMappingEvents(container);
    const next3 = container.querySelector("#onb-next3");
    if (next3) next3.addEventListener("click", () => { ui.step = 4; rerender(); });
    const back3 = container.querySelector("#onb-back3");
    if (back3) back3.addEventListener("click", () => { ui.step = 2; rerender(); });

    // 步骤4：上传 / 完成
    const uploadBtn = container.querySelector("#onb-upload");
    if (uploadBtn) uploadBtn.addEventListener("click", () => { if (global.PTUpload) global.PTUpload.open(); });
    const checkBtn = container.querySelector("#onb-check");
    if (checkBtn) checkBtn.addEventListener("click", checkConnected);
    const finishGtm = container.querySelector("#onb-finish-gtm");
    if (finishGtm) finishGtm.addEventListener("click", () => { ui.step = 5; rerender(); });
    const back4 = container.querySelector("#onb-back4");
    if (back4) back4.addEventListener("click", () => { ui.step = 3; rerender(); });

    // 完成态
    const gotoOv = container.querySelector("#onb-goto-overview");
    if (gotoOv) gotoOv.addEventListener("click", () => { if (typeof navigate === "function") navigate("overview"); });
    const gotoIng = container.querySelector("#onb-goto-ingestion");
    if (gotoIng) gotoIng.addEventListener("click", () => { if (typeof navigate === "function") navigate("ingestion"); });
  }

  function bindMappingEvents(container) {
    container.querySelectorAll(".onb-maptab tbody tr[data-key]").forEach((tr) => {
      const key = tr.dataset.key;
      const sel = tr.querySelector(".onb-map-sel");
      if (sel) sel.addEventListener("change", () => {
        const v = sel.value;
        if (!v) { delete ui.draft[key]; ui.deleted.add(key); }
        else { ui.draft[key] = v; ui.deleted.delete(key); }
        ui.dirty = true; refreshMapDirty();
      });
      const del = tr.querySelector(".onb-del");
      if (del) del.addEventListener("click", () => {
        delete ui.draft[key]; ui.deleted.add(key); ui.dirty = true; rerender();
      });
    });
    const addBtn = container.querySelector("#onb-add");
    const addSrc = container.querySelector("#onb-add-src");
    const addSel = container.querySelector("#onb-add-sel");
    if (addBtn && addSrc && addSel) {
      const doAdd = () => {
        const raw = addSrc.value.trim();
        if (!raw) { ui.notice = { tone: "bad", text: "请先填写原始事件名。" }; rerender(); return; }
        if (TARGETS.indexOf(raw) >= 0) { ui.notice = { tone: "bad", text: "「" + raw + "」本身是白名单事件名，会自动直通，无需映射。" }; rerender(); return; }
        ui.draft[raw] = addSel.value; ui.deleted.delete(raw); ui.dirty = true; ui.notice = null; rerender();
      };
      addBtn.addEventListener("click", doAdd);
      addSrc.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }
    const saveBtn = container.querySelector("#onb-save-map");
    if (saveBtn) saveBtn.addEventListener("click", doSaveMapping);
  }

  function refreshMapDirty() {
    const container = document.getElementById("page-onboarding");
    if (!container) return;
    const b = container.querySelector("#onb-save-map");
    if (b) b.disabled = !ui.dirty;
  }

  /* ============================ 动作 ============================ */
  async function doTestConnection() {
    const container = document.getElementById("page-onboarding");
    if (!container) return;
    const urlEl = container.querySelector("#onb-collurl");
    const secEl = container.querySelector("#onb-secret");
    const url = urlEl ? urlEl.value.trim() : "";
    const secret = secEl ? secEl.value.trim() : "";
    const diagBox = container.querySelector("#onb-diag");
    if (!url || !secret) {
      ui.notice = { tone: "bad", text: "请填写 Collect 接收地址与 Webhook Secret。" };
      rerender(); return;
    }
    ui.busy = true; ui.notice = null;
    if (diagBox) diagBox.innerHTML = loadingHtml("正在测试连接…");
    try {
      const probeEvent = {
        event_name: "visit",
        event_id: (global.crypto && global.crypto.randomUUID) ? global.crypto.randomUUID() : ("probe-" + Date.now()),
        timestamp: Date.now(),
        visitor_id: "onboarding_probe",
      };
      const r = await PTOnbClient.testConnection({ collectUrl: url, secret, event: probeEvent, probeEventName: "visit" });
      ui.connDiag = r;
      ui.connected = !!(r && r.ok);
      if (diagBox) diagBox.innerHTML = renderConnDiag(r);
      if (!ui.connected) ui.notice = { tone: "bad", text: "连接未通过，请按诊断信息修正后重试。" };
    } catch (e) {
      ui.connDiag = { ok: false, diagnosis: { code: "CLIENT_ERR", title: "测试失败", hint: (e && e.message) || String(e) } };
      ui.connected = false;
      if (diagBox) diagBox.innerHTML = renderConnDiag(ui.connDiag);
    } finally {
      ui.busy = false;
    }
  }

  async function ensureMapping() {
    if (ui.mapping) { resetMappingDraft(); rerender(); return; }
    const container = document.getElementById("page-onboarding");
    if (container) container.innerHTML = loadingHtml("正在加载当前映射…");
    try {
      ui.mapping = await PTOnbClient.getMapping();
      resetMappingDraft();
      rerender();
    } catch (e) {
      ui.notice = { tone: "bad", text: "加载映射失败：" + ((e && e.message) || "未知错误") };
      rerender();
    }
  }

  async function doSaveMapping() {
    if (!ui.dirty || ui.busy) return;
    ui.busy = true;
    const payload = Object.assign({}, ui.draft);
    for (const k of ui.deleted) payload[k] = null;
    try {
      const mapping = await PTOnbClient.putMapping(payload);
      ui.mapping = mapping;
      ui.notice = { tone: "ok", text: "映射已保存，立即生效。" };
      resetMappingDraft();
      ui.busy = false;
      rerender();
    } catch (e) {
      ui.notice = { tone: "bad", text: "保存失败：" + ((e && e.message) || String(e)) };
      ui.busy = false;
      rerender();
    }
  }

  async function checkConnected() {
    try {
      const ws = await PTOnbClient.getWorkspace();
      ui.firstConnectedAt = ws && ws.firstConnectedAt ? ws.firstConnectedAt : null;
      if (ui.firstConnectedAt) {
        ui.uploadDone = true;
        ui.step = 5;
        rerender();
      } else {
        ui.notice = { tone: "bad", text: "尚未检测到已入库数据。请先完成上传并确认导入。" };
        rerender();
      }
    } catch (e) {
      ui.notice = { tone: "bad", text: "检查接入状态失败：" + ((e && e.message) || "未知错误") };
      rerender();
    }
  }

  /* ============================ 首屏：判断是否已接入 ============================ */
  async function renderOnboardingTab() {
    const container = document.getElementById("page-onboarding");
    if (!container) return;
    container.innerHTML = loadingHtml("正在准备接入向导…");
    try {
      const ws = await PTOnbClient.getWorkspace();
      ui.firstConnectedAt = ws && ws.firstConnectedAt ? ws.firstConnectedAt : null;
      ui.step = 1; ui.method = null; ui.connected = false; ui.connDiag = null;
      ui.mapping = null; ui.draft = null; ui.deleted = null; ui.dirty = false; ui.uploadDone = false;
      ui.notice = null;
      paint(container);
    } catch (e) {
      container.innerHTML = errorHtml(e);
      const retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderOnboardingTab);
    }
  }

  /* ============================ 自接线（与 ingestion.js 相同模式） ============================ */
  function wire() {
    if (typeof RENDERERS === "undefined" || typeof renderPage !== "function") return false;
    RENDERERS.onboarding = renderOnboardingTab;
    if (typeof state !== "undefined" && state.page === "onboarding") renderPage();
    return true;
  }
  if (!wire()) global.addEventListener("load", wire);

  global.PTOnbClient = PTOnbClient;
})(window);
