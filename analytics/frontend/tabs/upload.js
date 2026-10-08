/* ==========================================================================
   PowerTokens 归因面板 · 单元 U4 新增上传流程
   --------------------------------------------------------------------------
   依赖全局（先加载 app.js）：escapeHtml。不依赖 shell 的图标系统（本面板无 initIcons）。
   复用 Shell 广告数据导入（A18 两阶段：结构校验 → 确认入库）的交互与「逐行逐字段」
   错误展示范式，但代码在本面板内自包含，直连同一后端 import 服务。

   端点（与 shell/public/app.js 一致）：
     GET    /jobs                       → { jobs }
     POST   /jobs  { provider, originalName, contentBase64 } → { job }   （仅结构校验，201）
     POST   /jobs/:id/confirm  {}       → { job }                        （真正入库）
     GET    /jobs/:id                   → { job }
     GET    /workspace                  → { workspace: { firstConnectedAt, ... } }
   鉴权：tenant 只从服务端注入的 token 派生（同源 same-origin），前端不传 tenantId。
   ========================================================================== */
(function (global) {
  "use strict";

  const IMP_API = "/api/business/attribution/import";
  const IMP_MAX_BYTES = 20 * 1024 * 1024;

  /** 状态枚举 → 中文友好文案（绝不把英文枚举直接甩给用户） */
  const IMP_STATUS = {
    pending:        { zh: "排队中",            tone: "wait" },
    validating:     { zh: "结构校验中",        tone: "wait" },
    ready:          { zh: "结构校验通过 · 待确认", tone: "ready" },
    importing:      { zh: "正在入库",          tone: "wait" },
    completed:      { zh: "导入完成",          tone: "ok" },
    partial_failed: { zh: "部分行失败",        tone: "warn" },
    failed:         { zh: "导入失败",          tone: "bad" },
    cancelled:      { zh: "已取消",            tone: "muted" },
  };

  /** 后端错误码 → 人话 */
  const IMP_ERR_ZH = {
    UNAUTHORIZED: "登录状态没传过去（服务端未注入分析 token）",
    FORBIDDEN: "分析 token 无效或已过期",
    NO_WORKSPACE: "当前租户还没有绑定工作区",
    NOT_FOUND: "找不到这个导入任务",
    BAD_PROVIDER: "平台参数非法（需为 google / meta / x）",
    EMPTY_FILE: "文件是空的",
    TOO_LARGE: "文件超过 20MB 上限",
    CLIENT_TENANT_REJECTED: "请求里不该带 tenantId（租户只认登录身份）",
    CONTEXT_REQUIRED: "缺少租户上下文",
    BAD_STATUS: "当前状态不允许确认导入",
    POOL_REQUIRED: "后端数据库连接不可用",
  };

  /* ---------------- token 解析 ----------------
     后端 import 路由的 authContext 强制要求 `Authorization: Bearer <token>`
     （见 business/attribution/import/routes.js），只靠 same-origin cookie 会 401。
     优先复用 app.js 的 resolveToken()（localStorage["pt_ro_token"] → CONFIG.READONLY_TOKEN），
     保证与只读分析 API 用同一份 token；app.js 未加载时自行兜底，不抛异常。 */
  function impToken() {
    try {
      if (typeof global.resolveToken === "function") {
        const t = global.resolveToken();
        if (t) return t;
      }
    } catch (e) { /* app.js 未就绪，走下面兜底 */ }
    try {
      const ls = global.localStorage && global.localStorage.getItem("pt_ro_token");
      if (ls) return ls;
    } catch (e) { /* 存储不可用（隐私模式等） */ }
    try {
      if (global.CONFIG && global.CONFIG.READONLY_TOKEN) return global.CONFIG.READONLY_TOKEN;
    } catch (e) { /* 忽略 */ }
    return "";
  }

  /* ---------------- 统一请求封装 ---------------- */
  async function impFetch(path, opts) {
    const o = Object.assign({ credentials: "same-origin" }, opts || {});
    // 合并请求头：调用方给的 Content-Type 等 + 鉴权头（鉴权头不覆盖调用方显式传入的）
    const h = Object.assign({}, o.headers || {});
    const tk = impToken();
    if (tk && !h.Authorization && !h.authorization) h.Authorization = "Bearer " + tk;
    if (o.body && !h["Content-Type"]) h["Content-Type"] = "application/json";
    o.headers = h;
    let res;
    try {
      res = await fetch(IMP_API + path, o);
    } catch (e) {
      throw Object.assign(new Error("网络请求失败：" + e.message), { impKind: "network" });
    }
    if (res.status === 413) {
      throw Object.assign(new Error("请求体超过服务端上限（20MB）。请拆分文件后再传。"), { impKind: "413" });
    }
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const code = j && j.error && j.error.code;
      const msg = (j && j.error && j.error.message) || (j && j.message) || ("HTTP " + res.status);
      const zh = code && IMP_ERR_ZH[code] ? IMP_ERR_ZH[code] : null;
      throw Object.assign(new Error(zh ? zh + "（" + code + "）" : msg), { impKind: "http", status: res.status, code: code });
    }
    return j;
  }

  const PTImportClient = {
    listJobs: () => impFetch("/jobs").then((j) => (j && j.jobs ? j.jobs : [])),
    getJob: (id) => impFetch("/jobs/" + encodeURIComponent(id)).then((j) => (j && j.job) || null),
    upload: ({ provider, originalName, contentBase64 }) =>
      impFetch("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, originalName, contentBase64 }),
      }).then((j) => (j && j.job) || null),
    confirm: (id) =>
      impFetch("/jobs/" + encodeURIComponent(id) + "/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((j) => (j && j.job) || null),
    getWorkspace: () => impFetch("/workspace").then((j) => (j && j.workspace) || null),
  };

  function impFmtBytes(n) {
    if (n == null || isNaN(n)) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function impStatusChip(status) {
    const s = IMP_STATUS[status] || { zh: status || "未知", tone: "muted" };
    return '<span class="pt-chip pt-chip-' + s.tone + '">' + escapeHtml(s.zh) + "</span>";
  }

  /** 逐行展示错误：行号 + 字段 + 原因；原因单元格留空，稍后用 textContent 填（防 XSS） */
  function impRenderErrors(details, extra) {
    if (!details || !details.length) return "";
    const rows = details.slice(0, 200).map((d) => {
      const rn = d.sourceRowNumber != null ? d.sourceRowNumber : "—";
      const fd = d.field ? d.field : null;
      return '<tr><td class="pt-err-row">第 ' + escapeHtml(String(rn)) + " 行</td>"
        + '<td class="pt-err-field">' + (fd ? escapeHtml(String(fd)) : "—") + "</td>"
        + '<td class="pt-err-reason"></td></tr>';
    }).join("");
    const more = details.length > 200 ? '<p class="pt-more">另有 ' + (details.length - 200) + " 条未显示</p>" : "";
    return '<div class="pt-errbox">'
      + '<div class="pt-errbox-h">有 ' + details.length + " 行没通过" + (extra ? " · " + escapeHtml(extra) : "") + "</div>"
      + '<table class="pt-errtab"><thead><tr><th>源文件行号</th><th>字段</th><th>问题</th></tr></thead><tbody>' + rows + "</tbody></table>"
      + more + "</div>";
  }

  function impFillReasons(container, details) {
    if (!container) return;
    const cells = container.querySelectorAll(".pt-err-reason");
    const list = (details || []).slice(0, 200);
    cells.forEach((c, i) => { c.textContent = (list[i] && (list[i].reason || list[i].message)) || "未知原因"; });
  }

  /* ---------------- 上传 modal ---------------- */
  const state = { provider: "google", file: null, jobId: null, busy: false };

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.onerror = () => reject(new Error("读取文件失败"));
      r.readAsDataURL(file);
    });
  }

  function _buildModal() {
    let overlay = document.getElementById("pt-upload-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "pt-upload-overlay";
    overlay.className = "pt-upload-overlay";
    overlay.innerHTML =
      '<div class="pt-upload-modal" role="dialog" aria-modal="true" aria-label="新增上传">'
      + '<div class="pt-upload-head">'
      +   '<div class="pt-upload-title">新增上传 · 广告数据</div>'
      +   '<button type="button" class="pt-upload-close" data-pt-close>关闭</button>'
      + "</div>"
      + '<div class="pt-upload-body">'
      +   '<div class="pt-upload-step1">'
      +     '<div class="pt-upload-field"><label class="pt-upload-label">广告平台</label>'
      +       '<div class="pt-prov-row" id="pt-prov-row">'
      +         '<button type="button" class="pt-prov on" data-prov="google">Google Ads</button>'
      +         '<button type="button" class="pt-prov" data-prov="meta">Meta Ads</button>'
      +         '<button type="button" class="pt-prov" data-prov="x">X Ads</button>'
      +       "</div></div>"
      +     '<div class="pt-upload-field"><label class="pt-upload-label">选择文件（CSV / Excel，≤20MB）</label>'
      +       '<div class="pt-dropzone" id="pt-dropzone">'
      +         '<input type="file" id="pt-file" accept=".csv,.xlsx,.xls" hidden />'
      +         '<button type="button" class="pt-file-btn" id="pt-pick">选择文件</button>'
      +         '<span class="pt-file-name" id="pt-file-name">未选择文件</span>'
      +       "</div>"
      +       '<div class="pt-file-hint">表头算第 1 行，数据行从第 2 行起；校验会精确到具体行与字段。</div>'
      +     "</div>"
      +     '<div class="pt-upload-actions">'
      +       '<button type="button" class="pt-btn primary" id="pt-upload-btn" disabled>上传并校验</button>'
      +       '<span class="pt-busy" id="pt-busy" hidden><span class="pt-spin"></span> 上传中…</span>'
      +     "</div>"
      +   "</div>"
      +   '<div class="pt-upload-result" id="pt-upload-result" hidden></div>'
      + "</div></div>";
    document.body.appendChild(overlay);

    // —— 事件绑定（一次性）——
    overlay.querySelector("[data-pt-close]").addEventListener("click", () => PTUpload.close());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) PTUpload.close(); });
    overlay.querySelectorAll(".pt-prov").forEach((b) => {
      b.addEventListener("click", () => {
        overlay.querySelectorAll(".pt-prov").forEach((x) => x.classList.toggle("on", x === b));
        state.provider = b.dataset.prov;
      });
    });
    const fileInput = overlay.querySelector("#pt-file");
    overlay.querySelector("#pt-pick").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => { if (fileInput.files && fileInput.files[0]) _setFile(fileInput.files[0]); });
    const dz = overlay.querySelector("#pt-dropzone");
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault(); dz.classList.remove("drag");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) _setFile(e.dataTransfer.files[0]);
    });
    overlay.querySelector("#pt-upload-btn").addEventListener("click", _doUpload);
    return overlay;
  }

  function _setFile(f) {
    if (!f) return;
    if (f.size > IMP_MAX_BYTES) {
      _showError(Object.assign(new Error("文件 " + impFmtBytes(f.size) + " 超过 20MB 上限，请拆分后再传。"), { impKind: "local" }));
      return;
    }
    state.file = f;
    const overlay = document.getElementById("pt-upload-overlay");
    overlay.querySelector("#pt-file-name").textContent = f.name + " · " + impFmtBytes(f.size);
    overlay.querySelector("#pt-upload-btn").disabled = state.busy;
    overlay.querySelector("#pt-upload-result").hidden = true;
  }

  function _busy(on, text) {
    state.busy = on;
    const overlay = document.getElementById("pt-upload-overlay");
    const b = overlay.querySelector("#pt-busy");
    const up = overlay.querySelector("#pt-upload-btn");
    if (b) { b.hidden = !on; if (text) b.lastChild.textContent = " " + text; }
    if (up) up.disabled = on || !state.file;
  }

  async function _doUpload() {
    if (!state.file || state.busy) return;
    const overlay = document.getElementById("pt-upload-overlay");
    _busy(true, "上传并结构校验…");
    try {
      const contentBase64 = await fileToBase64(state.file);
      const job = await PTImportClient.upload({
        provider: state.provider,
        originalName: state.file.name,
        contentBase64,
      });
      if (job) _renderJob(job, "validate", overlay.querySelector("#pt-upload-result"));
      else _showError(new Error("后端没返回 job 对象"), overlay.querySelector("#pt-upload-result"));
    } catch (e) {
      _showError(e, overlay.querySelector("#pt-upload-result"));
    } finally {
      _busy(false);
    }
  }

  async function _doConfirm() {
    if (!state.jobId || state.busy) return;
    const overlay = document.getElementById("pt-upload-overlay");
    const btn = overlay.querySelector("#pt-confirm-btn");
    const busy = overlay.querySelector("#pt-confirm-busy");
    if (btn) btn.disabled = true;
    if (busy) busy.hidden = false;
    state.busy = true;
    try {
      const job = await PTImportClient.confirm(state.jobId);
      if (job) _renderJob(job, "confirm", overlay.querySelector("#pt-upload-result"));
      else _showError(new Error("后端没返回 job 对象"), overlay.querySelector("#pt-upload-result"));
    } catch (e) {
      _showError(e, overlay.querySelector("#pt-upload-result"));
    } finally {
      state.busy = false;
    }
  }

  /** 渲染单个 job 的完整结果（结构校验 / 最终入库 两阶段） */
  function _renderJob(job, phase, box) {
    state.jobId = job.importId;
    if (!box) return;
    box.hidden = false;

    const st = job.status;
    const isReady = st === "ready";
    const isTerminal = ["completed", "partial_failed", "failed", "cancelled"].indexOf(st) >= 0;

    let nums = "";
    const hasStruct = job.rowCount != null;
    const hasFinal = job.successRows != null || job.persistedRows != null;
    if (hasStruct || hasFinal) {
      nums = '<div class="pt-nums">';
      if (hasStruct) nums += _num("读到行数", String(job.rowCount));
      if (isReady) nums += _num("结构校验", "通过", "ready");
      if (hasFinal) {
        nums += _num("最终入库", String(job.successRows != null ? job.successRows : (job.persistedRows || 0)), "ok");
        if (job.failedRows) nums += _num("被刷掉", String(job.failedRows), "bad");
      }
      nums += "</div>";
    }

    let readyHint = "";
    if (isReady) {
      readyHint = '<div class="pt-ready-hint"><b>结构校验通过，但数据还没入库。</b>'
        + "点下面的「确认导入」才会真正写入，并再做一次语义校验（比如事件名不在映射表里）——"
        + "<b>最终成功行数可能比现在少，这是正常的</b>，不是丢数据。</div>";
    }

    let diffNote = "";
    if (isTerminal && phase === "confirm" && job.rowCount != null && job.successRows != null && job.successRows < job.rowCount) {
      diffNote = '<div class="pt-diffnote">读到 ' + job.rowCount + " 行，最终入库 " + job.successRows + " 行，"
        + (job.failedRows ? "有 " + job.failedRows + " 行在语义校验或落库阶段被刷掉" : "差额来自语义校验")
        + "。两步口径不同是 A18 两阶段校验的设计，不是 bug。</div>";
    }

    const meta = [];
    if (job.provider) meta.push("平台 " + job.provider);
    if (job.originalName) meta.push(job.originalName);
    if (job.dateRange && job.dateRange.from) meta.push("数据区间 " + job.dateRange.from + " ~ " + job.dateRange.to);
    if (job.currencySeen && job.currencySeen.length) meta.push("币种 " + job.currencySeen.join("/"));
    if (job.updatedAt) meta.push("更新于 " + _fmtTime(job.updatedAt));

    const errHtml = impRenderErrors(job.errorDetails, isReady ? "结构校验阶段" : "最终入库阶段");

    let actions = "";
    if (isReady) {
      actions = '<div class="pt-actions">'
        + '<button type="button" class="pt-btn primary" id="pt-confirm-btn">确认导入（真正写入）</button>'
        + '<span class="pt-busy" id="pt-confirm-busy" hidden><span class="pt-spin"></span> 正在入库…</span></div>';
    } else if (isTerminal) {
      actions = '<div class="pt-actions"><button type="button" class="pt-btn" id="pt-again-btn">再传一个文件</button></div>';
    }

    box.innerHTML =
      '<div class="pt-jobhead">' + impStatusChip(st) + (job.errorMessage ? '<span class="pt-jobmsg"></span>' : "") + "</div>"
      + (meta.length ? '<div class="pt-meta">' + meta.map(escapeHtml).join(" · ") + "</div>" : "")
      + nums + readyHint + diffNote + errHtml + actions;

    const msgEl = box.querySelector(".pt-jobmsg");
    if (msgEl && job.errorMessage) msgEl.textContent = job.errorMessage;
    impFillReasons(box, job.errorDetails);

    const cf = box.querySelector("#pt-confirm-btn");
    if (cf) cf.addEventListener("click", _doConfirm);
    const ag = box.querySelector("#pt-again-btn");
    if (ag) ag.addEventListener("click", _resetResult);
  }

  function _num(k, v, tone) {
    return '<div class="pt-num"><span class="pt-num-k">' + escapeHtml(k) + '</span>'
      + '<span class="pt-num-v' + (tone ? " pt-v-" + tone : "") + '">' + escapeHtml(v) + "</span></div>";
  }

  function _showError(e, box) {
    if (!box) return;
    box.hidden = false;
    const kind = e && e.impKind;
    const hint = kind === "network" || kind === "413"
      ? '<div class="pt-gapnote"><b>这可能是环境缺口，不是你操作错了。</b><span class="pt-gapdetail"></span></div>'
      : "";
    box.innerHTML = '<div class="pt-jobhead">' + impStatusChip("failed") + '<span class="pt-jobmsg"></span></div>' + hint;
    box.querySelector(".pt-jobmsg").textContent = (e && e.message) ? e.message : String(e);
    const d = box.querySelector(".pt-gapdetail");
    if (d) d.textContent = " 后端 import 服务未就绪或反代未接线时会出现，需要服务端补上后才能联调。";
  }

  function _resetResult() {
    state.file = null; state.jobId = null;
    const overlay = document.getElementById("pt-upload-overlay");
    if (!overlay) return;
    const fi = overlay.querySelector("#pt-file"); if (fi) fi.value = "";
    overlay.querySelector("#pt-file-name").textContent = "未选择文件";
    overlay.querySelector("#pt-upload-result").hidden = true;
    overlay.querySelector("#pt-upload-result").innerHTML = "";
    overlay.querySelector("#pt-upload-btn").disabled = true;
  }

  function _fmtTime(ts) {
    if (!ts) return "";
    let d;
    if (typeof ts === "number") d = new Date(ts < 1e12 ? ts * 1000 : ts);
    else d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------------- 对外 API ---------------- */
  const PTUpload = {
    open() {
      const overlay = _buildModal();
      state.file = null; state.jobId = null;
      const result = overlay.querySelector("#pt-upload-result");
      result.hidden = true; result.innerHTML = "";
      overlay.querySelector("#pt-file-name").textContent = "未选择文件";
      overlay.querySelector("#pt-upload-btn").disabled = true;
      overlay.classList.add("open");
    },
    close() {
      const overlay = document.getElementById("pt-upload-overlay");
      if (overlay) overlay.classList.remove("open");
    },
    /** 供 schedule tab 复用：状态 chip 与错误表渲染 */
    statusChip: impStatusChip,
    errorsHtml: impRenderErrors,
    fillReasons: impFillReasons,
  };

  global.PTImportClient = PTImportClient;
  global.PTUpload = PTUpload;
})(window);
