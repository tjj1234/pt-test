/* ==========================================================================
   PowerTokens 归因面板 · 单元 U6 接入 Tab（事件映射 + 数据质量监控）
   --------------------------------------------------------------------------
   背景：真实 GTM 联调发现缺口——有些事件名（如 GA4 标准的 sign_up）和归因
   白名单（signup 等）对不上，之前没有任何产品内入口能配置「这个事件名该算
   哪种归因事件」。本 Tab 是事件映射的正式 UI，同时监控接入数据质量。

   四块内容（对齐原型「接入健康-事件映射页面」）：
     ① 数据质量总览 KPI（GET quality-stats）
     ② 事件名映射表（GET/PUT mapping，可随时调整——与 U5 首次向导同一份存储）
     ③ event_id 质量分布（quality-stats.eventIdQuality）
     ④ 最近被拒收事件样例（后端暂无样例接口，先展示 unmappedEventCount 计数
        + 占位说明；接口补好后在此接真实列表）

   后端接口（A17 · business/attribution/ingestion-adapter/routes.js，已挂载）：
     GET /api/business/attribution/ingestion/mapping
       → { ok, mapping: { workspaceId, mappings, updatedAt, updatedBy } }
     PUT /api/business/attribution/ingestion/mapping   body { mappings }
       → { ok, mapping }（merge 语义：值为 null 表示删除该键）
     GET /api/business/attribution/ingestion/quality-stats
       → { ok, stats: { totalAdapted, ignored, unmappedEventCount,
             eventIdQuality: { client_native_unique, adapter_fallback,
                               client_native_ratio },
             timestampFallback: { count, ratio, client_count },
             mappedViaConfig, updatedAt } }

   鉴权：与 U4 upload.js 同一套——authContext 强制 Authorization: Bearer，
   token 解析优先复用 app.js 的 resolveToken()。

   映射目标白名单：与 business/attribution/contracts/invariants.js 的
   EVENT_NAMES 一致（前端硬编码副本；后端 PUT 时会再校验，非法目标 400）。

   依赖全局（先加载 app.js）：RENDERERS / renderPage / state / loadingHtml /
   errorHtml / escapeHtml。自接线方式与 schedule.js 相同。
   ========================================================================== */
(function (global) {
  "use strict";

  const ING_API = "/api/business/attribution/ingestion";

  /* 白名单目标（contracts/invariants.js EVENT_NAMES 的前端副本）+ ignore。
     后端 save() 会再校验一次（ALLOWED_TARGETS），前端只做 UI 约束。 */
  const TARGETS = ["visit", "signup", "key_created", "model_call", "recharge", "auto_recharge_toggle"];

  /* 目标的中文说明（select 选项里展示，帮用户选对） */
  const TARGET_ZH = {
    visit: "访问",
    signup: "注册",
    key_created: "创建 Key",
    model_call: "模型调用",
    recharge: "充值",
    auto_recharge_toggle: "自动充值开关",
    ignore: "忽略（不计入归因）",
  };

  /* 内置默认映射（mapping-store.js DEFAULT_EVENT_MAPPINGS 的前端副本，只读展示）：
     仅当「无显式配置」且「原始名不是白名单原名」时兜底命中。 */
  const DEFAULT_MAPPINGS = { page_view: "visit", pageview: "visit" };

  /* 后端错误码 → 人话 */
  const ING_ERR_ZH = {
    UNAUTHORIZED: "登录状态没传过去（缺少或无效的分析 token）",
    FORBIDDEN: "分析 token 无效，或当前租户还没有绑定工作区",
    NO_WORKSPACE: "当前租户还没有绑定工作区",
    WORKSPACE_REQUIRED: "缺少工作区上下文",
    BAD_MAPPING_TARGET: "映射目标非法（必须是归因白名单事件名或 ignore）",
    BAD_MAPPING: "映射内容非法",
  };

  /* ---------------- token 解析（与 upload.js 同一套优先级） ---------------- */
  function ingToken() {
    try {
      if (typeof global.resolveToken === "function") {
        const t = global.resolveToken();
        if (t) return t;
      }
    } catch (e) { /* app.js 未就绪，走下面兜底 */ }
    try {
      const ls = global.localStorage && global.localStorage.getItem("pt_ro_token");
      if (ls) return ls;
    } catch (e) { /* 存储不可用 */ }
    try {
      if (global.CONFIG && global.CONFIG.READONLY_TOKEN) return global.CONFIG.READONLY_TOKEN;
    } catch (e) { /* 忽略 */ }
    return "";
  }

  /* ---------------- 统一请求封装（GET/PUT；本 Tab 有写操作） ---------------- */
  async function ingFetch(path, opts) {
    const o = Object.assign({ credentials: "same-origin" }, opts || {});
    const h = Object.assign({}, o.headers || {});
    const tk = ingToken();
    if (tk && !h.Authorization && !h.authorization) h.Authorization = "Bearer " + tk;
    if (o.body && !h["Content-Type"]) h["Content-Type"] = "application/json";
    o.headers = h;
    let res;
    try {
      res = await fetch(ING_API + path, o);
    } catch (e) {
      throw Object.assign(new Error("网络请求失败：" + e.message), { ingKind: "network" });
    }
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const code = j && j.error && j.error.code;
      const msg = (j && j.error && j.error.message) || (j && j.message) || ("HTTP " + res.status);
      const zh = code && ING_ERR_ZH[code] ? ING_ERR_ZH[code] : null;
      throw Object.assign(new Error(zh ? zh + "（" + code + "）" : msg),
        { ingKind: "http", status: res.status, code: code });
    }
    return j;
  }

  const PTIngestionClient = {
    getMapping: () => ingFetch("/mapping").then((j) => (j && j.mapping) || null),
    putMapping: (mappings) =>
      ingFetch("/mapping", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      }).then((j) => (j && j.mapping) || null),
    getQualityStats: () => ingFetch("/quality-stats").then((j) => (j && j.stats) || null),
  };

  /* ---------------- 小工具 ---------------- */

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtPct1(r) {
    if (r == null || !isFinite(r)) return "—";
    return (r * 100).toFixed(1) + "%";
  }

  function esc(v) { return escapeHtml(v); }

  /* ---------------- 页面状态（模块级；切 Tab 回来重拉，不做跨 Tab 缓存） ---- */
  const ui = {
    mapping: null,        // 后端最近一次返回的 mapping 对象
    stats: null,          // 后端最近一次返回的 quality-stats
    draft: null,          // 编辑中的映射草稿 { 原始名: 目标 }（null=未加载）
    deleted: null,        // 本次编辑中删除的键 Set
    dirty: false,
    busy: false,
    notice: null,         // { tone: 'ok'|'bad', text }
  };

  function resetDraft() {
    ui.draft = Object.assign({}, (ui.mapping && ui.mapping.mappings) || {});
    ui.deleted = new Set();
    ui.dirty = false;
  }

  /* ---------------- ① 数据质量总览 KPI ---------------- */

  function kpiCard(label, value, tone, hint) {
    return '<div class="pt-ing-kpi">'
      + '<div class="pt-ing-kpi-k">' + esc(label) + "</div>"
      + '<div class="pt-ing-kpi-v' + (tone ? " pt-v-" + tone : "") + '">' + esc(String(value)) + "</div>"
      + (hint ? '<div class="pt-ing-kpi-h">' + esc(hint) + "</div>" : "")
      + "</div>";
  }

  function renderKpis(stats) {
    if (!stats) {
      return '<div class="pt-ing-empty muted">质量统计暂不可用（接口未返回）</div>';
    }
    const noData = !stats.totalAdapted;
    const cards = [
      kpiCard("已适配事件总数", stats.totalAdapted == null ? "—" : stats.totalAdapted,
        null, noData ? "还没有事件经过适配层" : "经 A17 适配层处理的事件"),
      kpiCard("未映射被拒收", stats.unmappedEventCount == null ? "—" : stats.unmappedEventCount,
        stats.unmappedEventCount > 0 ? "bad" : "ok",
        stats.unmappedEventCount > 0 ? "事件名对不上白名单 → 在下方映射表配置" : "全部事件名都能识别"),
      kpiCard("已忽略（ignore）", stats.ignored == null ? "—" : stats.ignored,
        null, "映射为 ignore 的事件，主动不计入归因"),
      kpiCard("命中显式映射", stats.mappedViaConfig == null ? "—" : stats.mappedViaConfig,
        null, "按你配置的映射表翻译的事件数"),
      kpiCard("时间戳兜底占比", fmtPct1(stats.timestampFallback && stats.timestampFallback.ratio),
        (stats.timestampFallback && stats.timestampFallback.ratio > 0.2) ? "ready" : null,
        "事件缺客户端时间戳、用接收时间兜底的比例"),
    ];
    return '<div class="pt-ing-kpis">' + cards.join("") + "</div>"
      + (stats.updatedAt
        ? '<div class="pt-ing-updated muted">统计更新于 ' + esc(fmtTime(stats.updatedAt)) + "</div>"
        : "");
  }

  /* ---------------- ③ event_id 质量分布 ---------------- */

  function renderEventIdQuality(stats) {
    const q = stats && stats.eventIdQuality;
    if (!q || (q.client_native_unique == null && q.adapter_fallback == null)) {
      return '<div class="pt-ing-empty muted">暂无 event_id 质量数据（还没有事件经过适配层）</div>';
    }
    const native = q.client_native_unique || 0;
    const fallback = q.adapter_fallback || 0;
    const total = native + fallback;
    const ratio = q.client_native_ratio != null ? q.client_native_ratio : (total ? native / total : null);
    const pct = ratio == null ? 0 : Math.round(ratio * 1000) / 10;
    const tone = ratio == null ? "" : ratio >= 0.8 ? "good" : ratio >= 0.5 ? "mid" : "low";
    return '<div class="pt-ing-eid">'
      + '<div class="pt-ing-eid-bar">'
      +   '<div class="pt-ing-eid-native" style="width:' + pct + '%"></div>'
      + "</div>"
      + '<div class="pt-ing-eid-legend">'
      +   '<span class="pt-ing-dot native"></span>客户端原生唯一 event_id：<b>' + native + "</b>（" + fmtPct1(ratio) + "）"
      +   '<span class="pt-ing-dot fallback"></span>适配层确定性兜底：<b>' + fallback + "</b>"
      + "</div>"
      + '<div class="pt-ing-eid-hint muted">'
      +   (tone === "good"
        ? "多数事件带客户端原生 event_id，幂等去重可靠。"
        : tone === "mid"
        ? "约一半事件靠适配层兜底生成 event_id（同输入恒等，可幂等，但建议上游补发原生 ID）。"
        : "多数事件缺客户端原生 event_id，由适配层按内容指纹兜底生成——建议检查 GTM/上游是否漏发 event_id。")
      + "</div>"
      + "</div>";
  }

  /* ---------------- ④ 最近被拒收事件样例（占位 + 计数） ---------------- */

  function renderRejected(stats) {
    const n = stats ? stats.unmappedEventCount : null;
    const countHtml = n == null
      ? '<span class="muted">计数暂不可用</span>'
      : n > 0
      ? '<b class="pt-v-bad">' + n + "</b> 条事件因「事件名未映射」被拒收"
      : '<b class="pt-v-ok">0</b> 条——没有事件被拒收';
    return '<div class="pt-ing-rejected">'
      + '<div class="pt-ing-rejected-count">' + countHtml + "</div>"
      + '<div class="pt-ing-gapnote">'
      +   "<b>样例列表接口待后端补齐。</b>当前适配层拒收事件（如未映射的 sign_up）只累计数、"
      +   "不留样例明细，DLQ 也尚未暴露 HTTP 查询路由。计数来自 quality-stats 真实数据；"
      +   "「最近被拒收事件样例」列表等后端补接口后在此接入（已预留区块）。"
      + "</div>"
      + '<div class="pt-ing-rejected-placeholder muted">— 样例列表占位（事件名 / 拒收原因 / 时间）—</div>'
      + "</div>";
  }

  /* ---------------- ② 事件名映射表（可编辑） ---------------- */

  function targetOptions(selected) {
    let html = '<option value=""' + (selected ? "" : " selected") + ">（未设置）</option>";
    for (const t of TARGETS) {
      html += '<option value="' + t + '"' + (selected === t ? " selected" : "") + ">"
        + t + " · " + TARGET_ZH[t] + "</option>";
    }
    html += '<option value="ignore"' + (selected === "ignore" ? " selected" : "") + ">ignore · "
      + TARGET_ZH.ignore + "</option>";
    return html;
  }

  function renderMappingSection() {
    const m = ui.mapping;
    const draft = ui.draft || {};
    const keys = Object.keys(draft).sort();

    const meta = m && m.updatedAt
      ? "上次保存：" + esc(fmtTime(m.updatedAt)) + (m.updatedBy ? " · 保存人 " + esc(m.updatedBy) : "")
      : "该工作区还没有保存过显式映射";

    const rows = keys.length
      ? keys.map((k) =>
          '<tr data-key="' + esc(k) + '">'
          + '<td class="pt-ing-map-src mono">' + esc(k) + "</td>"
          + '<td><select class="pt-ing-map-sel">' + targetOptions(draft[k]) + "</select></td>"
          + '<td class="pt-ing-map-op"><button type="button" class="pt-ing-del" title="删除这条映射">删除</button></td>'
          + "</tr>").join("")
      : '<tr class="pt-ing-map-empty"><td colspan="3" class="muted">还没有显式映射。'
        + "在下方「新增映射」里添加，例如 sign_up → signup。</td></tr>";

    const defaultRows = Object.keys(DEFAULT_MAPPINGS).map((k) =>
      '<div class="pt-ing-default-item"><span class="mono">' + esc(k) + "</span> → <span class=\"mono\">"
      + esc(DEFAULT_MAPPINGS[k]) + '</span></div>').join("");

    return '<div class="pt-ing-map-toolbar">'
      +   '<div class="pt-ing-map-toolbar-h">'
      +     '<h3 class="section-title">事件名映射表</h3>'
      +     '<span class="pt-ing-map-meta muted">' + meta + "</span>"
      +   "</div>"
      +   '<div class="pt-ing-map-actions">'
      +     '<span class="pt-ing-dirty-hint" hidden>有未保存的修改</span>'
      +     '<button type="button" class="pt-btn primary" id="pt-ing-save" disabled>保存映射</button>'
      +   "</div>"
      + "</div>"
      + '<div class="pt-ing-map-desc muted">把上游原始事件名（GTM / GA4 / Meta 等发来的名字）翻译成归因白名单事件。'
      + "保存后立即生效——之后进来的事件按新映射识别，<b>不需要重走首次向导</b>（与向导共用同一份存储）。</div>"
      + '<div class="table-scroll"><table class="pt-ing-maptab">'
      +   "<thead><tr><th>原始事件名</th><th>映射为（归因事件）</th><th></th></tr></thead>"
      +   "<tbody>" + rows + "</tbody>"
      + "</table></div>"
      + '<div class="pt-ing-addrow">'
      +   '<input type="text" class="pt-ing-add-src" id="pt-ing-add-src" placeholder="原始事件名，如 sign_up" maxlength="128" />'
      +   '<span class="pt-ing-add-arrow">→</span>'
      +   '<select class="pt-ing-add-sel" id="pt-ing-add-sel">' + targetOptions("signup") + "</select>"
      +   '<button type="button" class="pt-btn" id="pt-ing-add">＋ 新增映射</button>'
      + "</div>"
      + '<div class="pt-ing-rules">'
      +   '<div class="pt-ing-rules-h">识别规则（优先级从高到低）</div>'
      +   "<ol>"
      +     "<li><b>显式映射</b>：上表配置的「原始名 → 目标」，随时可改。</li>"
      +     "<li><b>白名单直通</b>：原始名本身就是归因事件名（"
      +       TARGETS.map((t) => '<span class="mono">' + t + "</span>").join("、")
      +       "）时直接识别，无需配置。</li>"
      +     "<li><b>内置默认映射</b>（系统兜底，不可改）：" + defaultRows + "</li>"
      +     "<li>都对不上 → 事件被<b>拒收</b>（计入上方「未映射被拒收」），配好映射后新事件即可识别。</li>"
      +   "</ol>"
      + "</div>";
  }

  /* ---------------- 通知条 / 忙碌态 ---------------- */

  function renderNotice() {
    if (!ui.notice) return "";
    const cls = ui.notice.tone === "ok" ? "pt-ing-notice-ok" : "pt-ing-notice-bad";
    return '<div class="pt-ing-notice ' + cls + '" id="pt-ing-notice">' + esc(ui.notice.text) + "</div>";
  }

  function setSaveBusy(on, text) {
    ui.busy = on;
    const container = document.getElementById("page-ingestion");
    if (!container) return;
    const btn = container.querySelector("#pt-ing-save");
    if (btn) {
      btn.disabled = on || !ui.dirty;
      btn.textContent = on ? (text || "保存中…") : "保存映射";
    }
  }

  function refreshDirtyUI() {
    const container = document.getElementById("page-ingestion");
    if (!container) return;
    const btn = container.querySelector("#pt-ing-save");
    const hint = container.querySelector(".pt-ing-dirty-hint");
    if (btn && !ui.busy) btn.disabled = !ui.dirty;
    if (hint) hint.hidden = !ui.dirty;
  }

  /* ---------------- 保存（PUT，merge 语义：删除的键传 null） ---------------- */

  async function doSave() {
    if (!ui.dirty || ui.busy) return;
    setSaveBusy(true);
    const payload = Object.assign({}, ui.draft);
    for (const k of ui.deleted) payload[k] = null; // 后端 putMappings：null = 删除
    try {
      const mapping = await PTIngestionClient.putMapping(payload);
      ui.mapping = mapping;
      ui.notice = { tone: "ok", text: "映射已保存，立即生效（之后进来的事件按新映射识别）。" };
      resetDraft();
      setSaveBusy(false); // 成功路径必须复位 busy，否则下次保存被 if(ui.busy) return 挡掉
      rerender();
    } catch (e) {
      ui.notice = { tone: "bad", text: "保存失败：" + ((e && e.message) || String(e)) };
      setSaveBusy(false);
      rerenderNoticeOnly();
    }
  }

  function rerenderNoticeOnly() {
    const container = document.getElementById("page-ingestion");
    if (!container) return;
    const old = container.querySelector("#pt-ing-notice");
    const html = renderNotice();
    if (old) {
      if (html) old.outerHTML = html;
      else old.remove();
    } else if (html) {
      const anchor = container.querySelector(".pt-ing-body");
      if (anchor) anchor.insertAdjacentHTML("afterbegin", html);
    }
  }

  /* ---------------- 事件绑定（每次重渲染后调用） ---------------- */

  function bindMappingEvents(container) {
    // 目标 select 变更 → 更新草稿
    container.querySelectorAll(".pt-ing-maptab tbody tr[data-key]").forEach((tr) => {
      const key = tr.dataset.key;
      const sel = tr.querySelector(".pt-ing-map-sel");
      if (sel) {
        sel.addEventListener("change", () => {
          const v = sel.value;
          if (!v) {
            // 选「未设置」= 删除该键（与删除按钮同语义，保存时传 null）
            delete ui.draft[key];
            ui.deleted.add(key);
          } else {
            ui.draft[key] = v;
            ui.deleted.delete(key);
          }
          ui.dirty = true;
          refreshDirtyUI();
        });
      }
      const del = tr.querySelector(".pt-ing-del");
      if (del) {
        del.addEventListener("click", () => {
          delete ui.draft[key];
          ui.deleted.add(key);
          ui.dirty = true;
          rerender(); // 重渲染表格（行消失）
        });
      }
    });

    // 新增映射
    const addBtn = container.querySelector("#pt-ing-add");
    const addSrc = container.querySelector("#pt-ing-add-src");
    const addSel = container.querySelector("#pt-ing-add-sel");
    if (addBtn && addSrc && addSel) {
      const doAdd = () => {
        const raw = addSrc.value.trim();
        if (!raw) {
          ui.notice = { tone: "bad", text: "请先填写原始事件名（例如 sign_up）。" };
          rerenderNoticeOnly();
          return;
        }
        if (TARGETS.indexOf(raw) >= 0) {
          ui.notice = { tone: "bad", text: "「" + raw + "」本身就是归因白名单事件名，会自动直通识别，不需要配映射。" };
          rerenderNoticeOnly();
          return;
        }
        const target = addSel.value;
        if (!target) {
          ui.notice = { tone: "bad", text: "请选择映射目标。" };
          rerenderNoticeOnly();
          return;
        }
        ui.draft[raw] = target;
        ui.deleted.delete(raw);
        ui.dirty = true;
        ui.notice = null;
        rerender();
      };
      addBtn.addEventListener("click", doAdd);
      addSrc.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }

    // 保存
    const saveBtn = container.querySelector("#pt-ing-save");
    if (saveBtn) saveBtn.addEventListener("click", doSave);
  }

  /* ---------------- 主渲染 ---------------- */

  function rerender() {
    const container = document.getElementById("page-ingestion");
    if (!container) return;
    paint(container);
  }

  function paint(container) {
    container.innerHTML =
      '<div class="pt-ing">'
      +   '<div class="pt-ing-banner">'
      +     '<div class="pt-ing-banner-h">接入 · 事件映射与数据质量</div>'
      +     '<div class="pt-ing-banner-b">上游（GTM / GA4 / Meta 等）发来的事件名和归因白名单对不上时会被拒收。'
      +       "在下面的<b>映射表</b>里配置「原始事件名 → 归因事件」，保存后立即生效；"
      +       "本页同时监控接入数据的<b>质量</b>（event_id / 时间戳 / 拒收计数）。</div>"
      +   "</div>"
      +   renderNotice()
      +   '<div class="pt-ing-body">'
      +     '<div class="card pt-ing-sec">'
      +       '<h2 class="section-title">数据质量总览</h2>'
      +       renderKpis(ui.stats)
      +     "</div>"
      +     '<div class="card pt-ing-sec">'
      +       renderMappingSection()
      +     "</div>"
      +     '<div class="card pt-ing-sec">'
      +       '<h2 class="section-title">event_id 质量分布</h2>'
      +       renderEventIdQuality(ui.stats)
      +     "</div>"
      +     '<div class="card pt-ing-sec">'
      +       '<h2 class="section-title">最近被拒收事件</h2>'
      +       renderRejected(ui.stats)
      +     "</div>"
      +   "</div>"
      + "</div>";
    bindMappingEvents(container);
    refreshDirtyUI();
  }

  async function renderIngestionTab() {
    const container = document.getElementById("page-ingestion");
    if (!container) return;
    container.innerHTML = loadingHtml("正在加载接入健康…");
    try {
      // 两个接口独立容错：一个挂了另一个照常展示
      const [mappingRes, statsRes] = await Promise.allSettled([
        PTIngestionClient.getMapping(),
        PTIngestionClient.getQualityStats(),
      ]);
      if (mappingRes.status === "rejected" && statsRes.status === "rejected") {
        // 两个都失败才整页错误态（多半是 token / 后端问题）
        throw mappingRes.reason;
      }
      ui.mapping = mappingRes.status === "fulfilled" ? mappingRes.value : null;
      ui.stats = statsRes.status === "fulfilled" ? statsRes.value : null;
      if (mappingRes.status === "rejected") {
        ui.notice = { tone: "bad", text: "映射表加载失败：" + ((mappingRes.reason && mappingRes.reason.message) || "未知错误") };
      } else if (statsRes.status === "rejected") {
        ui.notice = { tone: "bad", text: "质量统计加载失败：" + ((statsRes.reason && statsRes.reason.message) || "未知错误") };
      } else {
        ui.notice = null;
      }
      resetDraft();
      paint(container);
    } catch (err) {
      container.innerHTML = errorHtml(err);
      const retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderIngestionTab);
    }
  }

  /* ---------------- 自接线（与 schedule.js 相同模式） ---------------- */

  function wire() {
    if (typeof RENDERERS === "undefined" || typeof renderPage !== "function") return false;
    RENDERERS.ingestion = renderIngestionTab;
    if (typeof state !== "undefined" && state.page === "ingestion") renderPage();
    return true;
  }
  if (!wire()) global.addEventListener("load", wire);

  /* 对外暴露（验收 / 其他 Tab 复用） */
  global.PTIngestionClient = PTIngestionClient;
})(window);
