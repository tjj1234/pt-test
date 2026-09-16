/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.1 看板骨架 + 全局筛选 + API 对接层
   --------------------------------------------------------------------------
   原生 JS + HTML + CSS，无框架、无构建步骤，浏览器直接打开可跑。
   只读铁律：本文件只发起 GET，绝不发起任何写操作（无 POST/PUT/PATCH/DELETE）。

   本单元范围（地基，供 3.2/3.3/3.4 填充）：
     1) 看板骨架：顶部筛选栏 + Tab 导航 + 单内容区
     2) 全局筛选：时间范围 + 平台 + 国家（单一共享 state，切 Tab 不丢）
     3) 三态：加载态 / 空态 / 错误态
     4) AnalyticsClient：统一 fetch 封装（只读 token 注入 + 错误处理 + 参数序列化）

   数据约定（只读、不编造）：
     · 无数据 → 空态；请求失败 → 错误态；绝不在前端伪造数字/图表。
     · 本单元各 Tab 只渲染「占位卡片 + 数据状态」，真实图表/表格由 3.x 填入。

   注意：本文件是 app.js 的修正版（修复 tab-data-state 作用域 bug）。
   ========================================================================== */

"use strict";

/* ============================ 配置 ============================ */

const CONFIG = {
  // 只读分析 API 基址。默认同源（相对路径 /api/analytics/...）。
  // 若后端单独部署，改成完整 origin，例如 "http://localhost:8080"。
  API_BASE: "",

  // 只读分析 token（scope analytics:read，前缀 pt_ro_）。留空则运行时按
  // 优先级读取：URL ?pt_ro_token= → localStorage["pt_ro_token"] → 此处默认值。
  READONLY_TOKEN: "",
};

/* ============================ 常量 ============================ */

// 平台 → utm_source/utm_medium 映射（设计 3.1 §4.1，前端维护）
const PLATFORMS = ["Google Ads", "Meta Ads", "X Ads"];
const PLATFORM_UTM = {
  "Google Ads": { source: "google", medium: "cpc" },
  "Meta Ads": { source: "meta", medium: "paid_social" },
  "X Ads": { source: "x", medium: "paid_social" },
};

// 国家值集（ISO 3166-1 alpha-2，与原型/设计 3.1 §1.1 一致）
const COUNTRIES = ["US", "JP", "KR", "DE", "BR", "IN", "SG", "GB", "FR", "AU"];

/* ============================ Tab 定义 ============================
   设计 3.1 §1.2 的 5 个 Tab（总览/素材/用户/产品/健康），分组落到 3 个承接单元：
     3.2 = 总览 + 素材；3.3 = 用户 + 产品；3.4 = 健康。
   说明：任务书把 5 个 Tab 概括为「总览/素材、用户/产品、健康」三组；此处按设计
   文档的 5 Tab 落地，TABS 是单一事实来源，如需收敛可只改这一处。 */
const TABS = [
  { key: "overview", label: "总览", en: "Overview" },
  { key: "creatives", label: "素材", en: "Creatives" },
  { key: "users", label: "用户", en: "Users" },
  { key: "product", label: "产品", en: "Product" },
  { key: "ads", label: "健康", en: "Health" },
];

// 每个 Tab 的「占位卡片」数据契约（设计 3.1 §3）
const TAB_CONTRACT = {
  overview: {
    title: "总览",
    unit: "3.2",
    source: "GET /api/analytics/funnel（KPI + 漏斗聚合）+ GET /api/analytics/events（趋势/明细）",
    needs: ["访问 / 注册 / 建Key / 充值 / ROI 五张 KPI 卡", "转化漏斗（访问→注册→建Key→充值）", "漏斗日趋势（granularity=day）"],
  },
  creatives: {
    title: "素材",
    unit: "3.2",
    source: "GET /api/analytics/funnel（roi_by_entity）+ 广告落库（广告侧明细，待广告侧接口）",
    needs: ["素材级 ROI 排行表（roi_by_entity）", "广告侧指标（消耗/点击/CTR/缩略图，待广告侧接口）"],
  },
  users: {
    title: "用户",
    unit: "3.3",
    source: "GET /api/analytics/funnel（转化路径）+ GET /api/analytics/events（用户明细抽屉）",
    needs: ["注册→建Key→充值 转化路径", "按 utm_source / 按 model 转化", "用户行为详情抽屉"],
  },
  product: {
    title: "产品",
    unit: "3.3",
    source: "GET /api/analytics/funnel（model_call 聚合）",
    needs: ["模型调用（by_model）", "调用渠道（by_source）", "Token 消耗（funnel 契约缺口 → 空态/兜底）", "充值趋势（granularity=day）"],
  },
  ads: {
    title: "健康",
    unit: "3.4",
    source: "GET /api/analytics/audit/token（1.5 审计 report）+ 运维指标（暂占位）",
    needs: ["打点健康度（Server 覆盖率 / event_id 完整率 / score）", "Token 审计 report 渲染"],
  },
};

/* ============================ 全局状态 ============================
   state.filters 是「单一事实来源」，所有 Tab 共享；切 Tab 不重置，切筛选触发当前 Tab 重新拉数。 */
const state = {
  page: "overview", // 当前 Tab
  filters: {
    range: 30,            // 预设天数：7 | 30 | 90
    customStart: null,    // 'YYYY-MM-DD' 或 null（自定义区间起，与 range 互斥）
    customEnd: null,      // 自定义区间止
    platforms: [],        // 多选：['Google Ads','Meta Ads','X Ads']；[] = 全部
    countries: [],        // 多选：ISO 3166-1 alpha-2；[] = 全部
    // —— 预留（默认空数组 = 不过滤）——
    utmSources: [],
    utmCampaigns: [],
    registerMethods: [],
    callSources: [],
    creativeId: null,     // 素材下钻筛选（3.2 用）
  },
  filtersCollapsed: (function () {
    try { return sessionStorage.getItem("ptFiltersCollapsed") === "1"; } catch (e) { return false; }
  })(),
};

/* ============================ 工具函数 ============================ */

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function hasCustomRange(f = state.filters) {
  return !!(f.customStart && f.customEnd);
}

/** 有效时间区间 → { from, to }（epoch 毫秒，UTC，两端都含）。
 *  自定义区间优先（与 range 预设互斥）；否则 = 近 range 天（含今天）。 */
function resolveRange(f = state.filters) {
  if (hasCustomRange(f)) {
    const from = Date.parse(f.customStart + "T00:00:00.000Z");
    const to = Date.parse(f.customEnd + "T23:59:59.999Z");
    return { from, to };
  }
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = dayStart + 86400000 - 1;                 // 今天 23:59:59.999 UTC
  const from = dayStart - ((f.range || 30) - 1) * 86400000; // 含今天的近 N 天
  return { from, to };
}

function rangeLabel(f = state.filters) {
  if (hasCustomRange(f)) return f.customStart + " ~ " + f.customEnd;
  return "近 " + (f.range || 30) + " 天";
}

/** 平台多选 → utm_source 集合（设计 3.1 §4.1 映射） */
function platformsToUtmSources(platforms) {
  return (platforms || []).map((p) => PLATFORM_UTM[p] && PLATFORM_UTM[p].source).filter(Boolean);
}

/** 全局筛选 → funnel 请求参数（服务端只传时间 + granularity）。
 *  平台/国家多选走「客户端过滤」——由 3.2/3.3 在渲染层实现（设计 3.2 §2.2 / 3.3 §4.2）。 */
function buildFunnelParams(granularity, f = state.filters) {
  const { from, to } = resolveRange(f);
  return { from, to, granularity };
}

/* ============================ API 对接层 ============================ */

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status; // HTTP 状态码；-1 = 网络层失败
    this.detail = detail;
  }
}

function resolveToken() {
  try {
    const url = new URLSearchParams(window.location.search).get("pt_ro_token");
    if (url) return url;
    const ls = window.localStorage.getItem("pt_ro_token");
    if (ls) return ls;
  } catch (e) { /* 忽略存储/URL 解析异常 */ }
  return CONFIG.READONLY_TOKEN || "";
}

/** 参数序列化：跳过 null/undefined/空串；数组用逗号拼接（event_name 支持逗号多值）。 */
function serializeParams(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      sp.set(k, v.join(","));
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

function statusMessage(status) {
  switch (status) {
    case 401: return "未认证：缺少或无效的只读 token";
    case 403: return "无权限：token 缺少 analytics:read 只读 scope（或误用写侧凭证）";
    case 400: return "请求参数错误（from > to / 非法粒度等）";
    case 404: return "接口不存在（后端未就绪或路径未接线）";
    case 429: return "请求过于频繁（触发限流）";
    default:
      if (status >= 500) return "服务端错误";
      return "请求失败（HTTP " + status + "）";
  }
}

/** 统一 fetch 封装：只读 GET + 只读 token 注入 + 错误处理 + JSON 解析。 */
async function requestJson(path, params) {
  const token = resolveToken();
  const url = CONFIG.API_BASE + path + serializeParams(params);

  let res;
  try {
    res = await fetch(url, {
      method: "GET", // 只读：仅 GET，无 body
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
  } catch (e) {
    throw new ApiError(-1, "网络请求失败，无法连接后端（后端未启动？）", e && e.message);
  }

  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch (e) { /* 忽略 */ }
    if (detail && detail.length > 300) detail = detail.slice(0, 300) + "…";
    throw new ApiError(res.status, statusMessage(res.status), detail);
  }

  try {
    return await res.json();
  } catch (e) {
    throw new ApiError(res.status, "响应不是合法 JSON", e && e.message);
  }
}

const AnalyticsClient = {
  /** GET /api/analytics/events（1.4 已定稿，明细 + since 增量游标） */
  getEvents(params) {
    return requestJson("/api/analytics/events", params);
  },
  /** GET /api/analytics/funnel（2.x，groups + roi_by_entity 双结果集） */
  getFunnel(params) {
    return requestJson("/api/analytics/funnel", params);
  },
  /** GET /api/analytics/audit/token（3.4 §2.3：1.5 审计 report；路径待 1.5/5.1 拍板） */
  getTokenAudit() {
    return requestJson("/api/analytics/audit/token", {});
  },
};

/* ============================ 三态组件 ============================ */

function loadingHtml(msg = "正在加载…") {
  return `<div class="state state-loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <div class="state-title">${escapeHtml(msg)}</div>
    <div class="state-hint muted">正在拉取数据…</div>
  </div>`;
}

function emptyHtml(msg = "当前筛选条件下暂无数据") {
  return `<div class="state state-empty">
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>
    <div class="state-title">${escapeHtml(msg)}</div>
    <div class="state-hint muted">尝试放宽日期、平台或国家筛选</div>
  </div>`;
}

function errorHtml(err) {
  const status = err && err.status != null ? err.status : "?";
  const msg = (err && err.message) || "未知错误";
  const detail = err && err.detail ? String(err.detail) : "";
  const httpTag = status === -1 ? "网络错误" : "HTTP " + status;
  return `<div class="state state-error" role="alert">
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
    <div class="state-title">${escapeHtml(msg)}</div>
    <div class="state-hint muted">${escapeHtml(httpTag)}${detail ? " · " + escapeHtml(detail) : ""}</div>
    <button type="button" class="retry-btn">重试</button>
  </div>`;
}

function dataReadyHtml(contract, data) {
  return `<div class="state state-ready">
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
    <div class="state-title">数据已接入（${escapeHtml(summarizeData(data))}）</div>
    <div class="state-hint muted">真实图表 / 表格由 ${escapeHtml(contract.unit)} 承接；本单元（3.1）只做骨架与对接，不渲染指标、不编造数字。</div>
  </div>`;
}

/** 只回显真实返回的条数（来自 API，不伪造指标）。 */
function summarizeData(data) {
  const parts = [];
  if (data && Array.isArray(data.groups)) parts.push("groups " + data.groups.length + " 组");
  if (data && Array.isArray(data.roi_by_entity)) parts.push("roi_by_entity " + data.roi_by_entity.length + " 条");
  if (data && Array.isArray(data.items)) parts.push("items " + data.items.length + " 条");
  if (data && typeof data === "object" && !Array.isArray(data) && !data.groups && !data.roi_by_entity && !data.items) {
    parts.push("report 已返回");
  }
  return parts.join(" · ") || "已返回";
}

/* ============================ 占位卡片 ============================ */

function contractCardHtml(c) {
  return `<div class="card placeholder-card">
    <div class="placeholder-head">
      <span class="badge badge-zinc">占位 · ${escapeHtml(c.unit)} 承接</span>
      <span class="badge badge-violet">只读 · 不编造数据</span>
    </div>
    <h2 class="section-title">${escapeHtml(c.title)} Tab</h2>
    <div class="contract-rows">
      <div class="contract-row"><span class="contract-label">数据源</span><span class="mono">${escapeHtml(c.source)}</span></div>
      <div class="contract-row"><span class="contract-label">需要字段</span><span>${c.needs.map(escapeHtml).join(" · ")}</span></div>
      <div class="contract-row"><span class="contract-label">本期状态</span><span>占位骨架，真实图表 / 表格由 ${escapeHtml(c.unit)} 填入</span></div>
    </div>
  </div>`;
}

/* ============================ Tab 渲染（占位 + 三态） ============================ */

/** 通用渲染：占位卡片 + 数据状态区（加载 → 空 / 错误 / 就绪）。
 *  状态区用 class 而非 id，并用 container.querySelector 作用域定位，
 *  避免多个 section 里出现同名 id 导致渲染进错误的（隐藏的）section。 */
async function renderTabWithStates(spec) {
  const container = document.getElementById("page-" + state.page);
  if (!container) return;
  container.innerHTML = contractCardHtml(spec.contract) + '<div class="tab-data-state"></div>';
  const el = container.querySelector(".tab-data-state");
  await runDataStates(el, spec);
}

async function runDataStates(el, spec) {
  el.innerHTML = loadingHtml();
  try {
    const data = await spec.fetchData();
    if (spec.isEmpty(data)) {
      el.innerHTML = emptyHtml(spec.emptyMsg);
    } else {
      el.innerHTML = dataReadyHtml(spec.contract, data);
    }
  } catch (err) {
    el.innerHTML = errorHtml(err);
    const retry = el.querySelector(".retry-btn");
    if (retry) retry.addEventListener("click", () => runDataStates(el, spec));
  }
}

async function renderOverview() {
  await renderTabWithStates({
    contract: TAB_CONTRACT.overview,
    fetchData: () => AnalyticsClient.getFunnel(buildFunnelParams("total")),
    isEmpty: (d) => !d || (!(d.groups && d.groups.length) && !(d.roi_by_entity && d.roi_by_entity.length)),
    emptyMsg: "当前筛选条件下暂无漏斗数据",
  });
}

async function renderCreatives() {
  await renderTabWithStates({
    contract: TAB_CONTRACT.creatives,
    fetchData: () => AnalyticsClient.getFunnel(buildFunnelParams("total")),
    isEmpty: (d) => !d || !(d.roi_by_entity && d.roi_by_entity.length),
    emptyMsg: "当前筛选下无素材 ROI 数据",
  });
}

async function renderUsers() {
  await renderTabWithStates({
    contract: TAB_CONTRACT.users,
    fetchData: () => AnalyticsClient.getFunnel(buildFunnelParams("total")),
    isEmpty: (d) => !d || !(d.groups && d.groups.length),
    emptyMsg: "当前筛选条件下暂无用户转化数据",
  });
}

async function renderProduct() {
  await renderTabWithStates({
    contract: TAB_CONTRACT.product,
    fetchData: () => AnalyticsClient.getFunnel(buildFunnelParams("total")),
    isEmpty: (d) => !d || !(d.groups && d.groups.length),
    emptyMsg: "当前筛选条件下暂无产品调用数据",
  });
}

async function renderAdsHealth() {
  await renderTabWithStates({
    contract: TAB_CONTRACT.ads,
    fetchData: () => AnalyticsClient.getTokenAudit(),
    isEmpty: (d) => !d,
    emptyMsg: "暂无审计结果（审计未跑，或 report 为空）",
  });
}

const RENDERERS = {
  overview: renderOverview,
  creatives: renderCreatives,
  users: renderUsers,
  product: renderProduct,
  ads: renderAdsHealth,
};

function renderPage() {
  const renderer = RENDERERS[state.page];
  if (renderer) renderer();
}

/* ============================ 导航 ============================ */

function tabIcon(key) {
  const icons = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    creatives: '<path d="M4 7h16M4 12h10M4 17h14"/><circle cx="18" cy="12" r="2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    product: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
    ads: '<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  };
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${icons[key] || ""}</svg>`;
}

function buildNav() {
  const nav = document.getElementById("tabbar-nav");
  if (!nav) return;
  nav.innerHTML = TABS.map((t) => `
    <button type="button" class="nav-item${t.key === state.page ? " active" : ""}" data-page="${t.key}">
      ${tabIcon(t.key)}
      <span class="nav-label">${escapeHtml(t.label)} <span class="nav-en">${t.en}</span></span>
    </button>`).join("");
  nav.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.page));
  });
}

function buildSections() {
  const main = document.getElementById("main-scroll");
  if (!main) return;
  main.innerHTML = TABS.map((t) => `
    <section id="page-${t.key}" class="page${t.key === state.page ? " active" : ""}"></section>`).join("");
}

function navigate(page) {
  state.page = page;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
  });
  document.querySelectorAll(".page").forEach((el) => {
    el.classList.toggle("active", el.id === "page-" + page);
  });
  renderPage();
}

/* ============================ 全局筛选 UI ============================ */

function dimRow(label, key, options, displayMap) {
  const selected = state.filters[key] || [];
  const allActive = selected.length === 0;
  const chips = [
    `<button type="button" class="tag-chip all-chip${allActive ? " active" : ""}" data-clear="${key}">全部</button>`,
  ];
  options.forEach((opt) => {
    const text = (displayMap && displayMap[opt]) || opt;
    const act = selected.includes(opt);
    chips.push(`<button type="button" class="tag-chip${act ? " active" : ""}" data-dim="${key}" data-val="${escapeHtml(opt)}">${escapeHtml(text)}</button>`);
  });
  return `<div class="filter-row"><span class="filter-label">${escapeHtml(label)}</span>${chips.join("")}</div>`;
}

function renderTagWall() {
  const el = document.getElementById("filter-tag-wall");
  if (!el) return;
  const f = state.filters;
  const customOn = hasCustomRange();

  const presets = [7, 30, 90].map((n) => {
    const act = !customOn && f.range === n;
    return `<button type="button" class="preset-btn${act ? " active" : ""}" data-range="${n}">${n}天</button>`;
  }).join("");

  const customBadge = customOn ? '<span class="custom-mode-badge">自定义区间</span>' : "";
  const timeRow = `<div class="filter-row">
    <span class="filter-label">时间</span>${presets}
    <span class="filter-label" style="min-width:auto;margin-left:8px">自定义</span>
    <input type="date" class="date-input" id="filter-date-start" value="${escapeHtml(f.customStart || "")}" />
    <span class="date-sep">~</span>
    <input type="date" class="date-input" id="filter-date-end" value="${escapeHtml(f.customEnd || "")}" />
    ${customBadge}
  </div>`;

  const reserved = `<div class="reserved-hint">预留筛选：utm_source / utm_campaign / 注册方式 / 调用来源（本期默认不过滤，值集待数据接入后由 3.2/3.3 填充）</div>`;

  el.innerHTML = [
    timeRow,
    dimRow("平台", "platforms", PLATFORMS),
    dimRow("国家", "countries", COUNTRIES),
    reserved,
  ].join("");

  // 预设时间
  el.querySelectorAll(".preset-btn[data-range]").forEach((btn) => {
    btn.addEventListener("click", () => {
      f.range = +btn.dataset.range;
      f.customStart = null;
      f.customEnd = null;
      renderTagWall();
      renderPage();
    });
  });

  // 自定义区间（两端都填才生效；清空则回到预设）
  const applyCustom = () => {
    const s = el.querySelector("#filter-date-start").value;
    const e = el.querySelector("#filter-date-end").value;
    if (s && e) {
      f.customStart = s <= e ? s : e;
      f.customEnd = s <= e ? e : s;
    } else if (!s && !e) {
      f.customStart = null;
      f.customEnd = null;
    } else {
      f.customStart = s || null;
      f.customEnd = e || null;
      return; // 只填一端：暂存，不触发重拉
    }
    renderTagWall();
    renderPage();
  };
  const startInput = el.querySelector("#filter-date-start");
  const endInput = el.querySelector("#filter-date-end");
  if (startInput) startInput.addEventListener("change", applyCustom);
  if (endInput) endInput.addEventListener("change", applyCustom);

  // 全部 / 多选 chip
  el.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filters[btn.dataset.clear] = [];
      renderTagWall();
      renderPage();
    });
  });
  el.querySelectorAll("[data-dim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.dim;
      const val = btn.dataset.val;
      const arr = state.filters[key];
      const i = arr.indexOf(val);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(val);
      renderTagWall();
      renderPage();
    });
  });

  applyFilterCollapseUI();
}

function activeFilterSummary() {
  const f = state.filters;
  const bits = [rangeLabel()];
  if (f.platforms.length) bits.push("平台 " + f.platforms.map((p) => p.replace(" Ads", "")).join("/"));
  if (f.countries.length) bits.push("国家 " + f.countries.join("/"));
  if (f.utmSources.length) bits.push("src " + f.utmSources.join("/"));
  if (f.utmCampaigns.length) bits.push("cmp " + f.utmCampaigns.slice(0, 2).join("/") + (f.utmCampaigns.length > 2 ? "…" : ""));
  if (f.registerMethods.length) bits.push("注册 " + f.registerMethods.join("/"));
  if (f.callSources.length) bits.push("调用 " + f.callSources.join("/"));
  if (f.creativeId) bits.push("素材 " + f.creativeId);
  return bits.join(" · ");
}

function applyFilterCollapseUI() {
  const wall = document.getElementById("filter-tag-wall");
  const summary = document.getElementById("filter-collapsed-summary");
  const btn = document.getElementById("filter-collapse-btn");
  if (!wall || !btn) return;
  const collapsed = !!state.filtersCollapsed;
  wall.classList.toggle("is-collapsed", collapsed);
  btn.textContent = collapsed ? "展开筛选" : "收起筛选";
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (summary) {
    if (collapsed) {
      summary.classList.remove("hidden");
      summary.innerHTML = '<span class="muted">当前：</span>' + escapeHtml(activeFilterSummary());
    } else {
      summary.classList.add("hidden");
      summary.innerHTML = "";
    }
  }
}

function toggleFilterCollapse() {
  state.filtersCollapsed = !state.filtersCollapsed;
  try { sessionStorage.setItem("ptFiltersCollapsed", state.filtersCollapsed ? "1" : "0"); } catch (e) { /* 忽略 */ }
  applyFilterCollapseUI();
}

function bindFilterBar() {
  const btn = document.getElementById("filter-collapse-btn");
  if (btn) btn.addEventListener("click", toggleFilterCollapse);
  const close = document.getElementById("drawer-close");
  if (close) close.addEventListener("click", closeUserDrawer);
  const overlay = document.getElementById("drawer-overlay");
  if (overlay) overlay.addEventListener("click", closeUserDrawer);
}

/* 用户详情抽屉：3.3 承接，本期只留占位（不打开真实数据） */
function closeUserDrawer() {
  const drawer = document.getElementById("user-drawer");
  const overlay = document.getElementById("drawer-overlay");
  if (drawer) { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); }
  if (overlay) { overlay.classList.remove("open"); overlay.setAttribute("aria-hidden", "true"); }
}

/* ============================ 启动 ============================ */

function init() {
  buildNav();
  buildSections();
  bindFilterBar();
  renderTagWall();
  renderPage();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
