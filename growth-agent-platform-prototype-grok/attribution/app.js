/* PowerTokens Attribution Panel — mock data + interactions */

const PLATFORMS = ["Google Ads", "Meta Ads", "X Ads"];
const COUNTRIES = ["US", "JP", "KR", "DE", "BR", "IN", "SG", "GB", "FR", "AU"];
const REG_METHODS = ["Google", "GitHub", "Email", "Wallet", "Apple"];
const MODELS = ["deepseek-chat", "gpt-4o-mini", "claude-sonnet", "gemini-flash", "qwen-plus", "llama-3.3-70b"];
const API_TOOLS = ["sdk-python", "curl", "langchain", "openclaw", "openai-compat", "vercel-ai"];
const PATHS = ["/", "/playground", "/docs", "/pricing", "/keys", "/models", "/billing", "/docs/api"];

const PLATFORM_UTM = {
  "Google Ads": { source: "google", medium: "cpc" },
  "Meta Ads": { source: "meta", medium: "paid_social" },
  "X Ads": { source: "x", medium: "paid_social" },
};

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const rand = seededRandom(42);

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function randFloat(min, max, digits = 2) {
  return +(min + rand() * (max - min)).toFixed(digits);
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().slice(0, 10);
}

function fmtDateTime(d) {
  const x = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${fmtDate(x)} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtMoney2(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US");
}

function fmtPct(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(digits) + "%";
}

function fmtRoas(n) {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return n.toFixed(2) + "x";
}

/* ---------- Campaigns & Creatives ---------- */
const CAMPAIGNS = [
  { id: "cmp_g1", platform: "Google Ads", name: "PT_Search_Brand_EN", countryFocus: ["US", "GB", "AU"] },
  { id: "cmp_g2", platform: "Google Ads", name: "PT_Search_API_Dev", countryFocus: ["US", "DE", "IN", "SG"] },
  { id: "cmp_g3", platform: "Google Ads", name: "PT_PerfMax_Global", countryFocus: ["US", "JP", "BR", "IN"] },
  { id: "cmp_m1", platform: "Meta Ads", name: "PT_Meta_Conversion_APAC", countryFocus: ["JP", "KR", "SG", "IN"] },
  { id: "cmp_m2", platform: "Meta Ads", name: "PT_Meta_Retarget_US", countryFocus: ["US", "CA", "GB"] },
  { id: "cmp_x1", platform: "X Ads", name: "PT_X_DevCommunity", countryFocus: ["US", "JP", "DE", "GB"] },
  { id: "cmp_x2", platform: "X Ads", name: "PT_X_Launch_Hype", countryFocus: ["US", "BR", "IN", "FR"] },
];

const CREATIVE_TEMPLATES = [
  { title: "一键聚合多模型 API", angle: "value" },
  { title: "比官方更省的 Token 价格", angle: "price" },
  { title: "Playground 秒级体验", angle: "product" },
  { title: "开发者首选聚合网关", angle: "dev" },
  { title: "DeepSeek / GPT / Claude 同价位对比", angle: "compare" },
  { title: "自动充值不中断调用", angle: "billing" },
  { title: "OpenAI 兼容 · 零迁移成本", angle: "compat" },
  { title: "亚洲节点低延迟", angle: "latency" },
  { title: "GitHub 一键登录开玩", angle: "signup" },
  { title: "按量计费 · 透明账单", angle: "billing" },
  { title: "LangChain / SDK 开箱即用", angle: "dev" },
  { title: "限时注册送额度", angle: "promo" },
  { title: "企业级 SLA 即将上线", angle: "enterprise" },
  { title: "多模型路由智能选优", angle: "product" },
  { title: "X 开发者专属优惠", angle: "promo" },
  { title: "从文档到第一行代码 3 分钟", angle: "dev" },
];

function buildCreatives() {
  const creatives = [];
  let idx = 0;
  CAMPAIGNS.forEach((camp, ci) => {
    const count = camp.platform === "Google Ads" ? 3 : camp.platform === "Meta Ads" ? 2 : 2;
    for (let i = 0; i < count; i++) {
      const tpl = CREATIVE_TEMPLATES[idx % CREATIVE_TEMPLATES.length];
      idx++;
      const utm = PLATFORM_UTM[camp.platform];
      const adId = `ad_${camp.platform.slice(0, 1).toLowerCase()}${ci + 1}_${i + 1}`;
      const spend = randFloat(800, 6800, 0);
      const impressions = randInt(45000, 520000);
      const ctr = randFloat(0.008, 0.045, 4);
      const clicks = Math.round(impressions * ctr);
      const cpc = spend / clicks;
      const landingUV = Math.round(clicks * randFloat(0.55, 0.92, 2));
      const registers = Math.max(0, Math.round(landingUV * randFloat(0.04, 0.18, 3)));
      // intentional zero-register creatives for ads health
      const forceZero = (camp.id === "cmp_x2" && i === 1) || (camp.id === "cmp_m2" && i === 0 && rand() < 0.3);
      const regFinal = forceZero ? 0 : registers;
      const keyCreates = Math.round(regFinal * randFloat(0.35, 0.75, 2));
      const activeCallers = Math.round(keyCreates * randFloat(0.45, 0.85, 2));
      const rechargeUsers = Math.round(activeCallers * randFloat(0.15, 0.45, 2));
      const avgRecharge = randFloat(18, 120, 0);
      const rechargeAmount = +(rechargeUsers * avgRecharge * randFloat(0.8, 1.6, 2)).toFixed(0);
      const missingUtm = (camp.id === "cmp_g3" && i === 2) || (camp.id === "cmp_x1" && i === 0);
      const landingPath = pick(["/", "/pricing", "/playground", "/docs"]);
      const landingUrl = missingUtm
        ? `https://powertokens.ai${landingPath}`
        : `https://powertokens.ai${landingPath}?utm_source=${utm.source}&utm_medium=${utm.medium}&utm_campaign=${camp.name}&utm_content=${adId}`;

      const countryPool = camp.countryFocus.filter((c) => COUNTRIES.includes(c));
      const topCountries = [];
      const pool = countryPool.length ? countryPool : COUNTRIES.slice(0, 5);
      let rem = 1;
      for (let k = 0; k < 3; k++) {
        const share = k === 2 ? rem : randFloat(0.15, rem * 0.55, 2);
        rem = Math.max(0, +(rem - share).toFixed(2));
        topCountries.push({ country: pool[k % pool.length], share });
      }

      const typeCycle = ["image", "video", "carousel", "text"];
      const creativeType = typeCycle[idx % typeCycle.length];
      const thumbnailUrl = (creativeType === "image" || creativeType === "video")
        ? `https://picsum.photos/seed/${adId}/96/96`
        : null;

      creatives.push({
        id: adId,
        platform: camp.platform,
        campaignId: camp.id,
        campaignName: camp.name,
        title: tpl.title,
        angle: tpl.angle,
        creativeType,
        thumbnailUrl,
        landingUrl,
        missingUtm,
        utm: missingUtm
          ? { source: "", medium: "", campaign: "", content: adId }
          : { source: utm.source, medium: utm.medium, campaign: camp.name, content: adId },
        spend,
        impressions,
        clicks,
        ctr,
        cpc,
        landingUV,
        registers: regFinal,
        cpa: regFinal > 0 ? spend / regFinal : null,
        keyCreates,
        activeCallers,
        rechargeUsers,
        rechargeAmount,
        roas: spend > 0 ? rechargeAmount / spend : 0,
        topCountries,
        daily: null, // filled later
      });
    }
  });
  return creatives;
}

const CREATIVES = buildCreatives();

/* Daily series for last 90 days */
function buildDailySeries() {
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const date = daysAgo(i);
    const baseSpend = 180 + Math.sin(i / 5) * 40 + randFloat(-30, 50, 0);
    const spend = Math.max(50, baseSpend + (i < 7 ? 40 : 0));
    const registers = Math.max(1, Math.round(spend / randFloat(28, 55, 1)));
    const recharge = +(registers * randFloat(8, 35, 1) * randFloat(0.6, 1.4, 2)).toFixed(0);
    days.push({
      date: fmtDate(date),
      spend: +spend.toFixed(0),
      registers,
      recharge,
      impressions: randInt(8000, 45000),
      clicks: randInt(200, 1800),
    });
  }
  return days;
}

const DAILY = buildDailySeries();

/* Attach per-creative daily spend for anomaly detection */
CREATIVES.forEach((c) => {
  c.daily = DAILY.map((d, i) => {
    const share = c.spend / CREATIVES.reduce((s, x) => s + x.spend, 0);
    let daySpend = +(d.spend * share * randFloat(0.4, 1.8, 2)).toFixed(1);
    // inject anomaly spikes
    if (c.id === "ad_g1_2" && i >= 83 && i <= 85) daySpend *= 3.2;
    if (c.id === "ad_m1_1" && i === 87) daySpend *= 4.5;
    return { date: d.date, spend: daySpend, ctr: c.ctr * randFloat(0.6, 1.5, 3), cpc: c.cpc * randFloat(0.7, 1.4, 2) };
  });
});

/* ---------- Users ---------- */
const FIRST_NAMES = ["Alex", "Yuki", "Minjun", "Hans", "Carlos", "Priya", "Wei", "Emma", "Lucas", "Sofia", "Kenji", "Aisha", "Noah", "Mia", "Diego", "Ananya", "Felix", "Chloe"];
const LAST_NAMES = ["Chen", "Tanaka", "Kim", "Weber", "Silva", "Patel", "Zhang", "Wright", "Müller", "Santos", "Park", "Nguyen", "Brown", "Costa", "Singh", "Yamamoto", "Schmidt", "Lee"];

function buildUserCalls(userIndex, regDayOffset, keyCreatedAt, richness) {
  const hasKey = !!keyCreatedAt;
  const callSourceBias = rand();
  let nCalls = 0;
  if (richness === "full") nCalls = hasKey ? randInt(6, 22) : 0;
  else if (richness === "mid") nCalls = hasKey ? randInt(2, 10) : rand() < 0.1 ? randInt(0, 2) : 0;
  else nCalls = hasKey ? randInt(1, 6) : 0;

  const calls = [];
  const preferredModels = [pick(MODELS), pick(MODELS), pick(MODELS)];
  for (let c = 0; c < nCalls; c++) {
    const isApi = callSourceBias > 0.4 ? rand() < 0.72 : rand() < 0.28;
    const mode = rand() < 0.38 ? "async" : "sync";
    const success = rand() < 0.91;
    const latency = mode === "async"
      ? (isApi ? randInt(400, 5200) : randInt(600, 6800))
      : (isApi ? randInt(180, 2400) : randInt(320, 3800));
    const maxDay = keyCreatedAt ? Math.min(regDayOffset, 40) : regDayOffset;
    const callDay = randInt(0, Math.max(0, maxDay));
    const ts = daysAgo(callDay);
    ts.setHours(randInt(8, 23), randInt(0, 59), randInt(0, 59));
    const model = richness === "full" ? preferredModels[c % preferredModels.length] : pick(MODELS);
    const baseId = `${String(userIndex).padStart(3, "0")}${c}${randInt(100, 999)}`;
    const call = {
      id: mode === "sync" ? `req_${userIndex}_${c}_${randInt(1000, 9999)}` : `task_${userIndex}_${c}_${randInt(1000, 9999)}`,
      mode,
      requestId: mode === "sync" ? `req_${baseId}` : null,
      taskId: mode === "async" ? `task_${baseId}` : null,
      ts: ts.toISOString(),
      model,
      source: isApi ? "api" : "playground",
      toolId: isApi ? pick(API_TOOLS) : null,
      success,
      reqTime: fmtDateTime(ts),
      respTime: fmtDateTime(new Date(ts.getTime() + latency)),
      latencyMs: latency,
    };
    calls.push(call);
  }
  calls.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return calls;
}

function buildUserRecharges(userIndex, regDayOffset, hasKey, richness) {
  const recharges = [];
  const chance = richness === "full" ? 0.55 : richness === "mid" ? 0.35 : 0.2;
  if (!hasKey || rand() >= chance) return recharges;
  const rc = richness === "full" ? randInt(1, 4) : randInt(1, 2);
  for (let r = 0; r < rc; r++) {
    const auto = rand() < 0.35;
    const amount = pick([10, 20, 50, 100, 200]);
    const ts = daysAgo(randInt(0, Math.max(1, regDayOffset)));
    ts.setHours(randInt(9, 22), randInt(0, 59));
    recharges.push({
      id: `rc_${userIndex}_${r}`,
      ts: ts.toISOString(),
      amount,
      currency: "USD",
      auto,
      method: pick(["Stripe", "Crypto", "Alipay", "Card"]),
    });
  }
  recharges.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return recharges;
}

function buildBrowseTrail(registeredAt, landingPath, richness) {
  const trailLen = richness === "full" ? randInt(5, 10) : richness === "mid" ? randInt(3, 7) : randInt(2, 5);
  const trail = [];
  let t = new Date(registeredAt);
  t.setMinutes(t.getMinutes() - randInt(8, 120));
  const sequence = [landingPath || "/"];
  const midPaths = ["/pricing", "/docs", "/models", "/playground", "/docs/api", "/keys", "/billing"];
  while (sequence.length < trailLen) sequence.push(pick(midPaths));
  for (let p = 0; p < trailLen; p++) {
    const dwell = richness === "full" ? randInt(15, 240) : randInt(8, 160);
    trail.push({ path: sequence[p], dwellSec: dwell, enterTime: t.toISOString(), ts: t.toISOString() });
    t = new Date(t.getTime() + dwell * 1000 + randInt(5, 90) * 1000);
  }
  return trail;
}

function buildUsers() {
  const users = [];
  let idx = 0;

  function stateRangeSafe() {
    return 70;
  }

  function pushUser({ creative, organic, richness, funnelTier }) {
    const i = idx++;
    const country = organic
      ? pick(COUNTRIES)
      : (creative.topCountries[Math.floor(rand() * creative.topCountries.length)]?.country || pick(COUNTRIES));
    const regMethod = pick(REG_METHODS);
    const regDayOffset = randInt(0, Math.min(85, stateRangeSafe()));
    const registeredAt = daysAgo(regDayOffset);

    const tier = funnelTier != null
      ? funnelTier
      : (richness === "full" ? pick([1, 2, 2, 3, 3]) : richness === "mid" ? pick([0, 1, 2, 2]) : pick([0, 0, 1, 2]));
    const hasKey = tier >= 1;
    const keyCreatedAt = hasKey
      ? daysAgo(Math.max(0, regDayOffset - randInt(0, Math.min(4, regDayOffset))))
      : null;
    if (keyCreatedAt) keyCreatedAt.setHours(randInt(10, 22), randInt(0, 59));
    const keyPage = hasKey ? pick(["/keys", "/playground", "/docs/api", "/pricing"]) : null;

    const calls = tier >= 2 ? buildUserCalls(i, regDayOffset, keyCreatedAt, richness) : [];
    if (tier >= 2 && !calls.length && keyCreatedAt) {
      const ts = new Date(keyCreatedAt.getTime() + randInt(5, 120) * 60000);
      const forcedMode = rand() < 0.35 ? "async" : "sync";
      const forcedLatency = forcedMode === "async" ? 1600 : 800;
      const forcedSrc = rand() < 0.5 ? "api" : "playground";
      calls.push({
        id: forcedMode === "sync" ? `req_${i}_0_forced` : `task_${i}_0_forced`,
        mode: forcedMode,
        requestId: forcedMode === "sync" ? `req_${String(i).padStart(3, "0")}0f` : null,
        taskId: forcedMode === "async" ? `task_${String(i).padStart(3, "0")}0f` : null,
        ts: ts.toISOString(),
        model: pick(MODELS),
        source: forcedSrc,
        toolId: forcedSrc === "api" ? pick(API_TOOLS) : null,
        success: true,
        reqTime: fmtDateTime(ts),
        respTime: fmtDateTime(new Date(ts.getTime() + forcedLatency)),
        latencyMs: forcedLatency,
      });
    }

    let recharges = tier >= 3 ? buildUserRecharges(i, regDayOffset, true, richness === "full" ? "full" : "mid") : [];
    if (tier >= 3 && !recharges.length) {
      const ts = daysAgo(randInt(0, Math.max(1, regDayOffset - 1)));
      recharges = [{
        id: `rc_${i}_0`,
        ts: ts.toISOString(),
        amount: pick([20, 50, 100]),
        currency: "USD",
        auto: rand() < 0.3,
        method: pick(["Stripe", "Card"]),
      }];
    }

    const landingPath = organic
      ? "/"
      : (creative.landingUrl.split("?")[0].replace("https://powertokens.ai", "") || "/");
    // Demo GAP: some users have no browse events (empty state)
    const trailEmpty = (i % 5 === 0) || (organic && rand() < 0.35);
    const trail = trailEmpty ? [] : buildBrowseTrail(registeredAt, landingPath, richness);

    const emailLocal = `${FIRST_NAMES[i % FIRST_NAMES.length].toLowerCase()}.${LAST_NAMES[i % LAST_NAMES.length].toLowerCase()}${randInt(1, 99)}`;
    users.push({
      id: `usr_${String(i + 1).padStart(3, "0")}`,
      name: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[i % LAST_NAMES.length]}`,
      email: `${emailLocal}@example.com`,
      country,
      registerMethod: regMethod,
      registeredAt: registeredAt.toISOString(),
      creativeId: organic ? null : creative.id,
      platform: organic ? null : creative.platform,
      campaignName: organic ? null : creative.campaignName,
      creativeTitle: organic ? null : creative.title,
      utm: organic
        ? { source: "organic", medium: "none", campaign: "", content: "" }
        : { ...creative.utm },
      landingUrl: organic ? "https://powertokens.ai/" : creative.landingUrl,
      hasKey,
      keyCreatedAt: keyCreatedAt ? keyCreatedAt.toISOString() : null,
      keyPage,
      autoRecharge: recharges.some((r) => r.auto),
      calls,
      recharges,
      trail,
      pageViews: trail,
      totalRecharge: recharges.reduce((s, r) => s + r.amount, 0),
      callCount: calls.length,
      lastActiveAt: calls.length
        ? calls[calls.length - 1].ts
        : recharges.length
          ? recharges[recharges.length - 1].ts
          : registeredAt.toISOString(),
    });
  }

  const withRegs = CREATIVES.filter((c) => c.registers > 0);
  withRegs.forEach((creative) => {
    const target = Math.max(3, Math.min(8, Math.round(creative.registers / 12) || 3));
    for (let k = 0; k < target; k++) {
      const funnelTier = k === 0 ? 3 : k === 1 ? 2 : pick([1, 2, 2, 3]);
      pushUser({ creative, organic: false, richness: "full", funnelTier });
    }
  });

  for (let extra = 0; extra < 18; extra++) {
    const organic = rand() < 0.25;
    const creative = pick(withRegs.length ? withRegs : CREATIVES);
    pushUser({
      creative,
      organic,
      richness: organic ? "mid" : pick(["mid", "full"]),
      funnelTier: organic ? pick([0, 1, 2]) : pick([0, 1, 2, 3]),
    });
  }

  return users;
}

const USERS = buildUsers();

/* ---------- User behavior helpers ---------- */
function userTrail(u) {
  return u.pageViews || u.trail || [];
}

function userTotalDwell(u) {
  return userTrail(u).reduce((s, t) => s + (t.dwellSec || 0), 0);
}

function userAvgDwell(u) {
  const trail = userTrail(u);
  if (!trail.length) return 0;
  return Math.round(userTotalDwell(u) / trail.length);
}

function userModels(u) {
  const set = new Set((u.calls || []).map((c) => c.model).filter(Boolean));
  return [...set];
}

function userFunnel(u) {
  const trail = userTrail(u);
  const firstCall = (u.calls || [])[0];
  const firstRecharge = (u.recharges || [])[0];
  return {
    landing: { done: trail.length > 0, at: trail[0]?.enterTime || trail[0]?.ts || null },
    register: { done: !!u.registeredAt, at: u.registeredAt },
    key: { done: !!u.hasKey && !!u.keyCreatedAt, at: u.keyCreatedAt },
    call: { done: (u.calls || []).length > 0, at: firstCall ? firstCall.ts : null },
    recharge: { done: (u.recharges || []).length > 0, at: firstRecharge ? firstRecharge.ts : null },
  };
}

function funnelBadgesHtml(u) {
  const f = userFunnel(u);
  const steps = [
    { key: "landing", label: "落地" },
    { key: "register", label: "注册" },
    { key: "key", label: "建key" },
    { key: "call", label: "调用" },
    { key: "recharge", label: "充值" },
  ];
  return `<div class="funnel-badges">${steps
    .map((s) => `<span class="funnel-step ${f[s.key].done ? "done" : "pending"}">${s.label}</span>`)
    .join("")}</div>`;
}

function fmtDwell(sec) {
  if (sec == null || isNaN(sec)) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function modelsChipsHtml(models, limit = 4) {
  if (!models || !models.length) return '<span class="muted">—</span>';
  const shown = models.slice(0, limit);
  const more = models.length - shown.length;
  return (
    shown.map((m) => `<span class="model-chip">${m}</span>`).join(" ") +
    (more > 0 ? ` <span class="muted" style="font-size:10px">+${more}</span>` : "")
  );
}

function usersForCreative(creativeId) {
  return USERS.filter((u) => u.creativeId === creativeId);
}

/* ---------- App State ---------- */
const state = {
  page: "overview",
  filters: {
    range: 30,
    customStart: null,
    customEnd: null,
    platforms: [],
    countries: [],
    utmSources: [],
    utmCampaigns: [],
    registerMethods: [],
    callSources: [],
    creativeId: null,
  },
  selectedUserId: null,
  selectedCountry: null,
  selectedCountryStage: null, // register | key | call | recharge
  charts: {},
  filtersCollapsed: sessionStorage.getItem("ptFiltersCollapsed") === "1",
};

function hasCustomRange() {
  return !!(state.filters.customStart && state.filters.customEnd);
}

function getRangeDays() {
  if (hasCustomRange()) {
    const a = new Date(state.filters.customStart + "T00:00:00");
    const b = new Date(state.filters.customEnd + "T00:00:00");
    return Math.max(1, Math.round((b - a) / 86400000) + 1);
  }
  return state.filters.range || 30;
}

function rangeLabel() {
  if (hasCustomRange()) return state.filters.customStart + " ~ " + state.filters.customEnd;
  return "近 " + getRangeDays() + " 天";
}

function dateCutoff() {
  if (hasCustomRange()) {
    const d = new Date(state.filters.customStart + "T00:00:00");
    return d;
  }
  return daysAgo(getRangeDays() - 1);
}

function dateEnd() {
  if (hasCustomRange()) {
    const d = new Date(state.filters.customEnd + "T23:59:59.999");
    return d;
  }
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function inRange(iso) {
  const t = new Date(iso);
  return t >= dateCutoff() && t <= dateEnd();
}

function matchMulti(arr, value) {
  return !arr || !arr.length || arr.includes(value);
}

function filterCreatives(list = CREATIVES) {
  const f = state.filters;
  return list.filter((c) => {
    if (!matchMulti(f.platforms, c.platform)) return false;
    if (!matchMulti(f.utmSources, c.utm.source)) return false;
    if (!matchMulti(f.utmCampaigns, c.utm.campaign)) return false;
    if (f.countries && f.countries.length) {
      const hit = (c.topCountries || []).some((tc) => f.countries.includes(tc.country));
      if (!hit) return false;
    }
    if (f.creativeId && c.id !== f.creativeId) return false;
    return true;
  });
}

function filterUsers(list = USERS) {
  const f = state.filters;
  return list.filter((u) => {
    const regOk = inRange(u.registeredAt);
    const callOk = (u.calls || []).some((c) => inRange(c.ts));
    const rcOk = (u.recharges || []).some((r) => inRange(r.ts));
    if (!regOk && !callOk && !rcOk) return false;
    if (!matchMulti(f.platforms, u.platform)) return false;
    if (!matchMulti(f.countries, u.country)) return false;
    if (!matchMulti(f.utmSources, u.utm.source || "")) return false;
    if (!matchMulti(f.utmCampaigns, u.utm.campaign || "")) return false;
    if (!matchMulti(f.registerMethods, u.registerMethod)) return false;
    if (f.callSources && f.callSources.length) {
      const ok = (u.calls || []).some((c) => f.callSources.includes(c.source));
      if (!ok) return false;
    }
    if (f.creativeId && u.creativeId !== f.creativeId) return false;
    return true;
  });
}


function creativeSpendInRange(c) {
  const cut = fmtDate(dateCutoff());
  const end = fmtDate(dateEnd());
  const series = (c.daily || []).filter((d) => d.date >= cut && d.date <= end);
  if (series.length) return series.reduce((s, d) => s + (d.spend || 0), 0);
  const days = getRangeDays();
  return (c.spend || 0) * (days / 90);
}

function aggregateTrendFromFilters(creatives, users) {
  const start = fmtDate(dateCutoff());
  const end = fmtDate(dateEnd());
  const byDate = {};
  const ensure = (date) => {
    if (!byDate[date]) byDate[date] = { date, spend: 0, registers: 0, recharge: 0 };
    return byDate[date];
  };
  DAILY.forEach((d) => {
    if (d.date >= start && d.date <= end) ensure(d.date);
  });
  creatives.forEach((c) => {
    (c.daily || []).forEach((d) => {
      if (d.date < start || d.date > end) return;
      ensure(d.date).spend += d.spend || 0;
    });
  });
  users.forEach((u) => {
    if (inRange(u.registeredAt)) {
      ensure(fmtDate(u.registeredAt)).registers += 1;
    }
    (u.recharges || []).forEach((r) => {
      if (!inRange(r.ts)) return;
      ensure(fmtDate(r.ts)).recharge += r.amount || 0;
    });
  });
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
    date: d.date,
    spend: +d.spend.toFixed(0),
    registers: d.registers,
    recharge: +d.recharge.toFixed(0),
  }));
}

function filteredDaily() {
  const start = fmtDate(dateCutoff());
  const end = fmtDate(dateEnd());
  return DAILY.filter((d) => d.date >= start && d.date <= end);
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

function makeChart(key, ctx, config) {
  destroyChart(key);
  state.charts[key] = new Chart(ctx, config);
  return state.charts[key];
}

const chartDefaults = {
  color: "#a1a1aa",
  borderColor: "#3f3f46",
  plugins: {
    legend: { labels: { color: "#a1a1aa", boxWidth: 12, font: { size: 11 } } },
  },
  scales: {
    x: {
      ticks: { color: "#71717a", font: { size: 10 }, maxRotation: 0 },
      grid: { color: "rgba(63,63,70,0.4)" },
    },
    y: {
      ticks: { color: "#71717a", font: { size: 10 } },
      grid: { color: "rgba(63,63,70,0.4)" },
    },
  },
};

/* ---------- Navigation ---------- */
function navigate(page, opts = {}) {
  state.page = page;
  if (opts.creativeId !== undefined) state.filters.creativeId = opts.creativeId;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
  });
  document.querySelectorAll(".page").forEach((el) => {
    el.classList.toggle("active", el.id === `page-${page}`);
  });
  renderActiveCreativeChip();
  renderPage();
}

function renderActiveCreativeChip() {
  const el = document.getElementById("creative-filter-chip");
  if (!el) return;
  if (!state.filters.creativeId) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  const c = CREATIVES.find((x) => x.id === state.filters.creativeId);
  const cohort = usersForCreative(state.filters.creativeId);
  const regCount = cohort.length;
  const title = c ? c.title : state.filters.creativeId;
  el.classList.remove("hidden");
  el.innerHTML = `<span class="chip-filter">素材: ${title} · 注册 ${regCount} <button type="button" aria-label="清除" onclick="clearCreativeFilter()">×</button></span>`;
}

window.clearCreativeFilter = function () {
  state.filters.creativeId = null;
  renderActiveCreativeChip();
  renderPage();
};

/* ---------- Filters UI (tag wall) ---------- */
function toggleFilterValue(key, value) {
  const arr = state.filters[key];
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(value);
  if (key === "countries") {
    const allowed = state.filters.countries;
    if (allowed.length && state.selectedCountry && !allowed.includes(state.selectedCountry)) {
      state.selectedCountry = null;
      state.selectedCountryStage = null;
    }
  }
  renderTagWall();
  renderPage();
}

function clearFilterDim(key) {
  state.filters[key] = [];
  if (key === "countries") {
    /* keep selection; all countries allowed again */
  }
  renderTagWall();
  renderPage();
}

function chipHtml(label, active, attrs) {
  return `<button type="button" class="tag-chip${active ? " active" : ""}" ${attrs}>${label}</button>`;
}

function dimRow(label, key, options, displayMap) {
  const selected = state.filters[key] || [];
  const allActive = selected.length === 0;
  const chips = [`<button type="button" class="tag-chip all-chip${allActive ? " active" : ""}" data-clear="${key}">全部</button>`];
  options.forEach((opt) => {
    const text = (displayMap && displayMap[opt]) || opt;
    const act = selected.includes(opt);
    chips.push(`<button type="button" class="tag-chip${act ? " active" : ""}" data-dim="${key}" data-val="${opt}">${text}</button>`);
  });
  return `<div class="filter-row"><span class="filter-label">${label}</span>${chips.join("")}</div>`;
}

function renderTagWall() {
  const el = document.getElementById("filter-tag-wall");
  if (!el) return;
  const sources = [...new Set(CREATIVES.map((c) => c.utm.source).filter(Boolean))].sort();
  const campaigns = [...new Set(CREATIVES.map((c) => c.utm.campaign).filter(Boolean))].sort();
  const customOn = hasCustomRange();
  const range = state.filters.range;
  const presets = [7, 30, 90].map((n) => {
    const act = !customOn && range === n;
    return `<button type="button" class="preset-btn${act ? " active" : ""}" data-range="${n}">${n}天</button>`;
  }).join("");
  const customBadge = customOn ? `<span class="custom-mode-badge">自定义区间</span>` : "";
  const startVal = state.filters.customStart || "";
  const endVal = state.filters.customEnd || "";
  const timeRow = `<div class="filter-row${customOn ? " custom-active" : ""}"><span class="filter-label">时间</span>${presets}<span class="filter-label" style="min-width:auto;margin-left:6px">自定义</span><input type="date" class="date-input" id="filter-date-start" value="${startVal}" /><span class="date-sep">~</span><input type="date" class="date-input" id="filter-date-end" value="${endVal}" />${customBadge}</div>`;
  el.innerHTML = [
    timeRow,
    dimRow("平台", "platforms", PLATFORMS),
    dimRow("国家", "countries", COUNTRIES),
    dimRow("utm_source", "utmSources", sources),
    dimRow("utm_campaign", "utmCampaigns", campaigns),
    dimRow("注册方式", "registerMethods", REG_METHODS),
    dimRow("调用来源", "callSources", ["playground", "api"], { playground: "playground", api: "api" }),
  ].join("");

  el.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filters.range = +btn.dataset.range;
      state.filters.customStart = null;
      state.filters.customEnd = null;
      renderTagWall();
      renderPage();
    });
  });
  const startInput = el.querySelector("#filter-date-start");
  const endInput = el.querySelector("#filter-date-end");
  const applyCustom = () => {
    const s = startInput.value;
    const e = endInput.value;
    if (s && e) {
      state.filters.customStart = s <= e ? s : e;
      state.filters.customEnd = s <= e ? e : s;
      renderTagWall();
      renderPage();
    } else if (!s && !e) {
      state.filters.customStart = null;
      state.filters.customEnd = null;
      renderTagWall();
      renderPage();
    } else {
      state.filters.customStart = s || null;
      state.filters.customEnd = e || null;
    }
  };
  if (startInput) startInput.addEventListener("change", applyCustom);
  if (endInput) endInput.addEventListener("change", applyCustom);
  el.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => clearFilterDim(btn.dataset.clear));
  });
  el.querySelectorAll("[data-dim]").forEach((btn) => {
    btn.addEventListener("click", () => toggleFilterValue(btn.dataset.dim, btn.dataset.val));
  });
  applyFilterCollapseUI();
}


function activeFilterSummary() {
  const f = state.filters;
  const bits = [];
  bits.push(rangeLabel());
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
  const bar = document.querySelector(".filter-bar");
  if (!wall || !btn) return;
  const collapsed = !!state.filtersCollapsed;
  wall.classList.toggle("is-collapsed", collapsed);
  if (bar) bar.classList.toggle("filters-collapsed", collapsed);
  btn.textContent = collapsed ? "展开筛选" : "收起筛选";
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (summary) {
    if (collapsed) {
      summary.classList.remove("hidden");
      summary.innerHTML = `<span class="muted">当前：</span> <span class="filter-summary-text">${activeFilterSummary()}</span>`;
    } else {
      summary.classList.add("hidden");
      summary.innerHTML = "";
    }
  }
}

function toggleFilterCollapse() {
  state.filtersCollapsed = !state.filtersCollapsed;
  try { sessionStorage.setItem("ptFiltersCollapsed", state.filtersCollapsed ? "1" : "0"); } catch (e) {}
  applyFilterCollapseUI();
}

window.toggleFilterCollapse = toggleFilterCollapse;

function populateFilterOptions() {
  renderTagWall();
}

function bindFilters() {
  // tag wall binds itself on each renderTagWall(); kept for init compatibility
}

/* ---------- Empty state ---------- */
function emptyHtml(msg = "当前筛选条件下暂无数据") {
  return `<div class="empty-state">
    <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="24" cy="24" r="18"/><path d="M16 24h16M24 16v16"/></svg>
    <div>${msg}</div>
    <div class="muted" style="margin-top:8px;font-size:12px">尝试放宽日期、平台或 UTM 筛选</div>
  </div>`;
}

/* ---------- Overview ---------- */
function renderOverview() {
  const creatives = filterCreatives();
  const users = filterUsers();

  let spend = 0;
  creatives.forEach((c) => { spend += creativeSpendInRange(c); });
  spend = Math.round(spend);

  const kpiReg = users.filter((u) => inRange(u.registeredAt)).length;
  const kpiKeys = users.filter((u) => u.hasKey && u.keyCreatedAt && inRange(u.keyCreatedAt)).length;
  const kpiCallers = users.filter((u) => collectCalls([u]).length > 0).length;
  const kpiRechargeUsers = users.filter((u) => (u.recharges || []).some((r) => inRange(r.ts))).length;
  const kpiRechargeAmt = users.reduce(
    (s, u) => s + (u.recharges || []).filter((r) => inRange(r.ts)).reduce((a, r) => a + r.amount, 0),
    0
  );
  const hasAdSpend = spend > 0;
  const roas = hasAdSpend ? kpiRechargeAmt / spend : null;
  const cpa = kpiReg > 0 && hasAdSpend ? spend / kpiReg : null;

  document.getElementById("overview-kpis").innerHTML = [
    { label: "投放消耗", value: hasAdSpend ? fmtMoney(spend) : "—", sub: hasAdSpend ? rangeLabel() : "广告未入库" },
    { label: "注册用户", value: fmtNum(kpiReg), sub: cpa != null ? `CPA ${fmtMoney2(cpa)}` : "事件侧" },
    { label: "建 Key", value: fmtNum(kpiKeys), sub: "事件侧" },
    { label: "调用用户", value: fmtNum(kpiCallers), sub: "事件侧 · 窗内有调用" },
    { label: "充值用户", value: fmtNum(kpiRechargeUsers), sub: hasAdSpend ? `额 ${fmtMoney(kpiRechargeAmt)}` : "事件侧" },
    { label: "ROAS", value: hasAdSpend ? fmtRoas(roas) : "—", sub: hasAdSpend ? "充值额 / 消耗" : "广告未入库" },
  ]
    .map(
      (k) => `<div class="kpi-card">
      <div class="muted" style="font-size:12px">${k.label}</div>
      <div style="font-size:24px;font-weight:700;margin:6px 0;letter-spacing:-0.02em">${k.value}</div>
      <div style="font-size:11px"><span class="muted">${k.sub}</span></div>
    </div>`
    )
    .join("");

  const funnelStages = [
    { name: "注册", v: kpiReg },
    { name: "建 Key", v: kpiKeys },
    { name: "调用", v: kpiCallers },
    { name: "充值", v: kpiRechargeUsers },
  ];
  const funnelCtx = document.getElementById("chart-funnel");
  makeChart("funnel", funnelCtx, {
    type: "bar",
    data: {
      labels: funnelStages.map((s) => s.name),
      datasets: [
        {
          label: "用户数",
          data: funnelStages.map((s) => s.v),
          backgroundColor: ["#6366f1", "#a78bfa", "#c084fc", "#f472b6"],
          borderRadius: 6,
        },
      ],
    },
    options: {
      ...chartDefaults,
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { ...chartDefaults.plugins, legend: { display: false } },
    },
  });

  const daily = aggregateTrendFromFilters(creatives, users);
  const trendCardTitle = document.querySelector("#chart-trend")?.closest(".card")?.querySelector(".section-title");
  if (trendCardTitle) trendCardTitle.textContent = "每日趋势：消耗 vs 注册 vs 充值（随筛选）";
  const trendCtx = document.getElementById("chart-trend");
  const labels = daily.map((d) => d.date.slice(5));
  makeChart("trend", trendCtx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "消耗 $",
          data: daily.map((d) => d.spend),
          borderColor: "#818cf8",
          backgroundColor: "rgba(129,140,248,0.15)",
          tension: 0.35,
          fill: true,
          yAxisID: "y",
        },
        {
          label: "注册",
          data: daily.map((d) => d.registers),
          borderColor: "#34d399",
          tension: 0.35,
          yAxisID: "y1",
        },
        {
          label: "充值 $",
          data: daily.map((d) => d.recharge),
          borderColor: "#f472b6",
          tension: 0.35,
          yAxisID: "y",
        },
      ],
    },
    options: {
      ...chartDefaults,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: chartDefaults.scales.x,
        y: { ...chartDefaults.scales.y, position: "left", title: { display: true, text: "$", color: "#71717a" } },
        y1: {
          ...chartDefaults.scales.y,
          position: "right",
          grid: { drawOnChartArea: false },
          title: { display: true, text: "注册", color: "#71717a" },
        },
      },
    },
  });

  const platCtx = document.getElementById("chart-platform");
  const platData = PLATFORMS.map((p) => {
    const list = creatives.filter((c) => c.platform === p);
    const pUsers = users.filter((u) => u.platform === p);
    return {
      platform: p,
      spend: Math.round(list.reduce((s, c) => s + creativeSpendInRange(c), 0)),
      registers: pUsers.filter((u) => inRange(u.registeredAt)).length,
      recharge: pUsers.reduce(
        (s, u) => s + (u.recharges || []).filter((r) => inRange(r.ts)).reduce((a, r) => a + r.amount, 0),
        0
      ),
    };
  });
  makeChart("platform", platCtx, {
    type: "bar",
    data: {
      labels: platData.map((p) => p.platform.replace(" Ads", "")),
      datasets: [
        { label: "消耗", data: platData.map((p) => p.spend), backgroundColor: "#6366f1", borderRadius: 4 },
        { label: "充值", data: platData.map((p) => p.recharge), backgroundColor: "#a855f7", borderRadius: 4 },
        { label: "注册×10", data: platData.map((p) => p.registers * 10), backgroundColor: "#34d399", borderRadius: 4 },
      ],
    },
    options: {
      ...chartDefaults,
      responsive: true,
      maintainAspectRatio: false,
    },
  });
  renderOverviewExtras(users, creatives);
}

function collectCalls(users) {
  let calls = users.flatMap((u) => u.calls || []);
  calls = calls.filter((c) => inRange(c.ts));
  if (state.filters.callSources && state.filters.callSources.length) {
    calls = calls.filter((c) => state.filters.callSources.includes(c.source));
  }
  return calls;
}

function avgLatencyForMode(calls, mode) {
  const list = (calls || []).filter((c) => (c.mode || "sync") === mode);
  if (!list.length) return null;
  return Math.round(list.reduce((s, c) => s + (c.latencyMs || 0), 0) / list.length);
}

function fmtLatencyMs(v) {
  return v == null || isNaN(v) ? "—" : `${fmtNum(v)} ms`;
}

function modelStatsFromCalls(calls) {
  const map = {};
  calls.forEach((c) => {
    if (!map[c.model]) {
      map[c.model] = {
        model: c.model,
        calls: 0,
        success: 0,
        syncCalls: 0,
        asyncCalls: 0,
        syncLatencies: [],
        asyncLatencies: [],
      };
    }
    const m = map[c.model];
    m.calls += 1;
    if (c.success) m.success += 1;
    const mode = c.mode || "sync";
    if (mode === "async") {
      m.asyncCalls += 1;
      m.asyncLatencies.push(c.latencyMs);
    } else {
      m.syncCalls += 1;
      m.syncLatencies.push(c.latencyMs);
    }
  });
  return Object.values(map)
    .map((m) => ({
      model: m.model,
      calls: m.calls,
      successRate: m.calls ? m.success / m.calls : 0,
      syncCalls: m.syncCalls,
      asyncCalls: m.asyncCalls,
      syncAvgLatency: m.syncLatencies.length
        ? Math.round(m.syncLatencies.reduce((s, x) => s + x, 0) / m.syncLatencies.length)
        : null,
      asyncAvgLatency: m.asyncLatencies.length
        ? Math.round(m.asyncLatencies.reduce((s, x) => s + x, 0) / m.asyncLatencies.length)
        : null,
    }))
    .sort((a, b) => b.calls - a.calls);
}

function modelsTableHtml(rows) {
  if (!rows.length) return emptyHtml("暂无模型调用数据");
  return `<table class="data-table"><thead><tr>
    <th>模型</th><th>调用</th><th>成功率</th>
    <th>同步平均延时</th><th>异步平均延时</th>
    <th>同步调用</th><th>异步调用</th>
  </tr></thead><tbody>${rows
    .map((r) => `<tr>
      <td class="mono">${r.model}</td>
      <td>${fmtNum(r.calls)}</td>
      <td>${fmtPct(r.successRate)}</td>
      <td>${fmtLatencyMs(r.syncAvgLatency)}</td>
      <td>${fmtLatencyMs(r.asyncAvgLatency)}</td>
      <td>${fmtNum(r.syncCalls)}</td>
      <td>${fmtNum(r.asyncCalls)}</td>
    </tr>`)
    .join("")}</tbody></table>`;
}

function renderOverviewModels(users) {
  const calls = collectCalls(users); // already respects callSources + time + user filters
  const selectedSources = state.filters.callSources || [];
  const sourceFilterLabel = selectedSources.length
    ? "筛选：调用来源 = " + selectedSources.join(" + ")
    : "筛选：调用来源 = 全部";

  // 1) Update model table FIRST so a chart error cannot block filter feedback
  const tableEl = document.getElementById("overview-models-table");
  const titleHint = document.getElementById("overview-models-filter-hint");
  if (titleHint) titleHint.textContent = sourceFilterLabel + " · 调用 " + fmtNum(calls.length);
  if (tableEl) {
    tableEl.innerHTML = modelsTableHtml(modelStatsFromCalls(calls));
  }

  const pg = calls.filter((c) => c.source === "playground").length;
  const api = calls.filter((c) => c.source === "api").length;

  // Build pie slices only for sources in scope (respect callSources tags)
  const wantPg = !selectedSources.length || selectedSources.includes("playground");
  const wantApi = !selectedSources.length || selectedSources.includes("api");
  const labels = [];
  const data = [];
  const colors = [];
  if (wantPg) { labels.push("Playground"); data.push(pg); colors.push("#a78bfa"); }
  if (wantApi) { labels.push("API"); data.push(api); colors.push("#6366f1"); }

  const chCtx = document.getElementById("chart-overview-channels");
  const chartWrap = chCtx && chCtx.parentElement;
  destroyChart("overviewChannels");
  if (chCtx && chartWrap) {
    const total = data.reduce((s, n) => s + n, 0);
    if (!total) {
      // avoid Chart.js doughnut with all-zero / empty which looks "broken"
      chCtx.style.display = "none";
      let empty = chartWrap.querySelector(".chart-empty");
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "chart-empty empty-state";
        chartWrap.appendChild(empty);
      }
      empty.style.display = "block";
      empty.innerHTML = emptyHtml("当前调用来源筛选下无调用");
    } else {
      chCtx.style.display = "block";
      const empty = chartWrap.querySelector(".chart-empty");
      if (empty) empty.style.display = "none";
      try {
        makeChart("overviewChannels", chCtx, {
          type: "doughnut",
          data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderWidth: 0 }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
              legend: { position: "bottom", labels: { color: "#a1a1aa", boxWidth: 10, font: { size: 11 } } },
            },
          },
        });
      } catch (err) {
        console.warn("overview channel chart failed", err);
        chCtx.style.display = "none";
      }
    }
  }

  const statsEl = document.getElementById("overview-channel-stats");
  if (statsEl) {
    const toolMap = {};
    calls.filter((c) => c.source === "api" && c.toolId).forEach((c) => {
      toolMap[c.toolId] = (toolMap[c.toolId] || 0) + 1;
    });
    const topTools = Object.entries(toolMap).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => k + " " + v).join(" · ") || "—";
    const parts = [];
    if (wantPg) parts.push("Playground " + fmtNum(pg));
    if (wantApi) parts.push("API " + fmtNum(api));
    statsEl.textContent = sourceFilterLabel + " · " + parts.join(" · ") + (wantApi ? " · Tools: " + topTools : "");
  }
}

function countryFunnelRows(users, creatives) {
  const byCountry = {};
  // Strictly respect country tag filter: only show selected countries (empty = all)
  const allowed = (state.filters.countries && state.filters.countries.length)
    ? state.filters.countries.slice()
    : COUNTRIES.slice();
  allowed.forEach((c) => {
    byCountry[c] = { country: c, landingUV: 0, clicks: 0, registers: 0, keys: 0, callers: 0, rechargeUsers: 0, spend: 0, rechargeAmt: 0 };
  });
  const days = getRangeDays();
  const adScale = days / 90;
  creatives.forEach((c) => {
    const tops = c.topCountries && c.topCountries.length ? c.topCountries : [{ country: "US", share: 1 }];
    const hits = tops.filter((t) => byCountry[t.country]);
    const shareSum = hits.reduce((s, t) => s + (t.share || 0), 0) || 0;
    if (!shareSum) return;
    const spendInRange = creativeSpendInRange(c);
    hits.forEach((t) => {
      const w = (t.share || 0) / shareSum;
      byCountry[t.country].spend += spendInRange * w;
      byCountry[t.country].clicks += (c.clicks || 0) * adScale * w;
      byCountry[t.country].landingUV += (c.landingUV || 0) * adScale * w;
    });
  });
  users.forEach((u) => {
    const row = byCountry[u.country];
    if (!row) return;
    if (inRange(u.registeredAt)) row.registers += 1;
    if (u.hasKey && u.keyCreatedAt && inRange(u.keyCreatedAt)) row.keys += 1;
    if (collectCalls([u]).length) row.callers += 1;
    const rcs = (u.recharges || []).filter((r) => inRange(r.ts));
    if (rcs.length) {
      row.rechargeUsers += 1;
      row.rechargeAmt += rcs.reduce((s, r) => s + r.amount, 0);
    }
  });
  return Object.values(byCountry)
    .map((r) => ({
      ...r,
      landingUV: Math.round(r.landingUV),
      clicks: Math.round(r.clicks),
      spend: Math.round(r.spend),
      rechargeAmt: Math.round(r.rechargeAmt),
      roas: r.spend > 0 ? r.rechargeAmt / r.spend : 0,
    }))
    .filter((r) => r.registers || r.landingUV || r.spend || r.keys || r.callers || r.rechargeUsers)
    .sort((a, b) => b.registers - a.registers || b.spend - a.spend);
}


function userChannelLabel(u) {
  const plat = u.platform || "Organic";
  const utm = (u.utm && u.utm.source) || "—";
  return `${plat} / ${utm}`;
}

function stageUsersForCountry(users, country, stage) {
  const cu = users.filter((u) => u.country === country);
  if (stage === "register") return cu.filter((u) => inRange(u.registeredAt));
  if (stage === "key") return cu.filter((u) => u.hasKey && u.keyCreatedAt && inRange(u.keyCreatedAt));
  if (stage === "call") {
    return cu.filter((u) => collectCalls([u]).length > 0);
  }
  if (stage === "recharge") return cu.filter((u) => (u.recharges || []).some((r) => inRange(r.ts)));
  return [];
}

function overviewStageUsersHtml(users, stage) {
  if (!stage) {
    return `<div class="muted text-xs">点击上方漏斗阶段数字，在总览内展开该阶段用户列表</div>`;
  }
  const stageLabels = { register: "注册", key: "建Key", call: "调用用户", recharge: "充值用户" };
  if (!users.length) {
    return `<div class="flex items-center justify-between mb-2"><div class="muted text-xs">阶段用户 · ${stageLabels[stage] || stage}</div></div>${emptyHtml("该阶段暂无用户")}`;
  }

  let head = "";
  let body = "";
  if (stage === "register") {
    head = "<th>user_id</th><th>渠道</th><th>注册方式</th><th>注册时间</th>";
    body = users.map((u) => `<tr>
      <td><button type="button" class="link-user mono" data-user-id="${u.id}">${u.id}</button></td>
      <td>${userChannelLabel(u)}</td>
      <td>${u.registerMethod}</td>
      <td class="muted">${fmtDateTime(u.registeredAt)}</td>
    </tr>`).join("");
  } else if (stage === "key") {
    head = "<th>user_id</th><th>渠道</th><th>注册方式</th><th>注册时间</th><th>创建Key页面</th>";
    body = users.map((u) => `<tr>
      <td><button type="button" class="link-user mono" data-user-id="${u.id}">${u.id}</button></td>
      <td>${userChannelLabel(u)}</td>
      <td>${u.registerMethod}</td>
      <td class="muted">${fmtDateTime(u.registeredAt)}</td>
      <td class="mono">${u.keyPage || "—"}</td>
    </tr>`).join("");
  } else if (stage === "call") {
    head = "<th>user_id</th><th>渠道</th><th>注册方式</th><th>注册时间</th><th>调用次数</th><th>成功率</th><th>同步平均延时</th><th>异步平均延时</th><th>模型个数</th>";
    body = users.map((u) => {
      const calls = collectCalls([u]);
      const ok = calls.filter((c) => c.success).length;
      const rate = calls.length ? ok / calls.length : null;
      const models = new Set(calls.map((c) => c.model).filter(Boolean));
      return `<tr>
        <td><button type="button" class="link-user mono" data-user-id="${u.id}">${u.id}</button></td>
        <td>${userChannelLabel(u)}</td>
        <td>${u.registerMethod}</td>
        <td class="muted">${fmtDateTime(u.registeredAt)}</td>
        <td>${fmtNum(calls.length)}</td>
        <td>${fmtPct(rate)}</td>
        <td>${fmtLatencyMs(avgLatencyForMode(calls, "sync"))}</td>
        <td>${fmtLatencyMs(avgLatencyForMode(calls, "async"))}</td>
        <td>${fmtNum(models.size)}</td>
      </tr>`;
    }).join("");
  } else if (stage === "recharge") {
    head = "<th>user_id</th><th>渠道</th><th>注册方式</th><th>注册时间</th><th>充值金额</th>";
    body = users.map((u) => {
      const amt = (u.recharges || []).filter((r) => inRange(r.ts)).reduce((s, r) => s + r.amount, 0);
      return `<tr>
        <td><button type="button" class="link-user mono" data-user-id="${u.id}">${u.id}</button></td>
        <td>${userChannelLabel(u)}</td>
        <td>${u.registerMethod}</td>
        <td class="muted">${fmtDateTime(u.registeredAt)}</td>
        <td>${fmtMoney(amt)}</td>
      </tr>`;
    }).join("");
  }

  return `<div class="flex items-center justify-between mb-2">
      <div class="muted text-xs">阶段用户 · ${stageLabels[stage] || stage} · ${fmtNum(users.length)} 人</div>
    </div>
    <div class="table-scroll"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function jumpToUserFromOverview(userId) {
  navigate("users");
  // open after users page has rendered
  requestAnimationFrame(() => openUserDrawer(userId));
}

window.jumpToUserFromOverview = jumpToUserFromOverview;

function renderCountryDetail(country, users) {
  const detail = document.getElementById("overview-country-detail");
  if (!detail) return;
  if (!country) {
    detail.classList.add("hidden");
    detail.innerHTML = "";
    state.selectedCountryStage = null;
    destroyChart("countryFunnelMini");
    return;
  }
  const cu = users.filter((u) => u.country === country);
  const stages = [
    { key: "register", name: "注册", v: stageUsersForCountry(users, country, "register").length },
    { key: "key", name: "建 Key", v: stageUsersForCountry(users, country, "key").length },
    { key: "call", name: "调用用户", v: stageUsersForCountry(users, country, "call").length },
    { key: "recharge", name: "充值用户", v: stageUsersForCountry(users, country, "recharge").length },
  ];
  const maxV = Math.max(1, ...stages.map((s) => s.v));
  const activeStage = state.selectedCountryStage;
  const funnelBars = stages.map((s) => {
    const pct = Math.round((s.v / maxV) * 100);
    const active = activeStage === s.key ? " active" : "";
    return `<div class="country-funnel-row${active}" data-stage="${s.key}">
      <span>${s.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <button type="button" class="funnel-stage-count mono" data-stage="${s.key}" title="展开该阶段用户">${fmtNum(s.v)}</button>
    </div>`;
  }).join("");
  const calls = collectCalls(cu);
  const pg = calls.filter((c) => c.source === "playground").length;
  const api = calls.filter((c) => c.source === "api").length;
  const toolMap = {};
  calls.filter((c) => c.source === "api" && c.toolId).forEach((c) => { toolMap[c.toolId] = (toolMap[c.toolId] || 0) + 1; });
  const toolsHtml = Object.entries(toolMap).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `<span class="badge badge-sky">${k} · ${v}</span>`).join(" ") || `<span class="muted">无 API tool 数据</span>`;
  const stageListUsers = activeStage ? stageUsersForCountry(users, country, activeStage) : [];
  detail.classList.remove("hidden");
  detail.innerHTML = `<div class="flex items-center justify-between mb-3"><h3 class="section-title mb-0">国家下钻 · ${country}</h3><button type="button" class="preset-btn" id="close-country-detail">收起</button></div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div class="muted text-xs mb-2">漏斗（点击数字展开阶段用户）</div>
        <div class="country-funnel-bars">${funnelBars}</div>
        <div class="mini-stat-row"><div class="mini-stat">Playground<strong>${fmtNum(pg)}</strong></div><div class="mini-stat">API<strong>${fmtNum(api)}</strong></div></div>
        <div class="muted text-xs mb-2">API Tools</div>
        <div class="flex flex-wrap gap-1">${toolsHtml}</div>
      </div>
      <div>
        <div class="muted text-xs mb-2">模型明细（随调用来源筛选）</div>
        <div class="table-scroll">${modelsTableHtml(modelStatsFromCalls(calls))}</div>
      </div>
    </div>
    <div id="overview-stage-users" class="overview-stage-users mt-4">${overviewStageUsersHtml(stageListUsers, activeStage)}</div>`;

  const closeBtn = document.getElementById("close-country-detail");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      state.selectedCountry = null;
      state.selectedCountryStage = null;
      renderPage();
    });
  }
  detail.querySelectorAll(".funnel-stage-count").forEach((btn) => {
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const stage = btn.dataset.stage;
      state.selectedCountryStage = state.selectedCountryStage === stage ? null : stage;
      renderCountryDetail(country, users);
    });
  });
  detail.querySelectorAll(".link-user").forEach((btn) => {
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      jumpToUserFromOverview(btn.dataset.userId);
    });
  });
}

function renderOverviewCountries(users, creatives) {
  const rows = countryFunnelRows(users, creatives);
  const wrap = document.getElementById("overview-countries-table");
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = emptyHtml("当前筛选下无国家数据");
    renderCountryDetail(null, users);
    return;
  }
  wrap.innerHTML = `<table class="data-table country-funnel-table">
    <thead>
      <tr>
        <th rowspan="2">国家</th>
        <th colspan="3" class="th-ad-side">广告侧</th>
        <th colspan="4" class="th-event-side">事件侧</th>
        <th colspan="2" class="th-mixed">交叉</th>
      </tr>
      <tr>
        <th class="th-ad-side">落地UV</th><th class="th-ad-side">点击</th><th class="th-ad-side">消耗</th>
        <th class="th-event-side">注册</th><th class="th-event-side">建Key</th><th class="th-event-side">调用用户</th><th class="th-event-side">充值用户</th>
        <th>充值额</th><th>ROAS</th>
      </tr>
    </thead>
    <tbody>${rows.map((r) => {
    const sel = state.selectedCountry === r.country ? " selected" : "";
    return `<tr class="country-row${sel}" data-country="${r.country}">
      <td><strong>${r.country}</strong></td>
      <td class="col-ad">${fmtNum(r.landingUV)}</td><td class="col-ad">${fmtNum(r.clicks)}</td><td class="col-ad">${fmtMoney(r.spend)}</td>
      <td class="col-event">${fmtNum(r.registers)}</td><td class="col-event">${fmtNum(r.keys)}</td><td class="col-event">${fmtNum(r.callers)}</td><td class="col-event">${fmtNum(r.rechargeUsers)}</td>
      <td>${fmtMoney(r.rechargeAmt)}</td><td>${fmtRoas(r.roas)}</td>
    </tr>`;
  }).join("")}</tbody></table>
  <p class="table-hint">广告侧列来自广告同步入库（消耗/点击/落地UV）；事件侧列来自 SS-GTM→Collect（注册/Key/调用/充值）。ROAS = 充值额/消耗。</p>`;
  wrap.querySelectorAll("tr.country-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const c = tr.dataset.country;
      if (state.selectedCountry === c) {
        state.selectedCountry = null;
        state.selectedCountryStage = null;
      } else {
        state.selectedCountry = c;
        state.selectedCountryStage = null;
      }
      renderOverviewCountries(users, creatives);
    });
  });
  renderCountryDetail(state.selectedCountry, users);
}

function renderOverviewExtras(users, creatives) {
  renderOverviewModels(users);
  renderOverviewCountries(users, creatives);
}

/* ---------- Creatives ---------- */
function drillToCreativeUsers(creativeId, evt) {
  if (evt) {
    evt.preventDefault();
    evt.stopPropagation();
  }
  const c = CREATIVES.find((x) => x.id === creativeId);
  if (!c) return;
  if (!(c.registers > 0) && usersForCreative(creativeId).length === 0) return;
  state.filters.creativeId = creativeId;
  navigate("users");
}

window.drillToCreativeUsers = drillToCreativeUsers;

function creativeTypeLabel(t) {
  return ({ image: "图片", video: "视频", carousel: "轮播", text: "文案" })[t] || t || "—";
}

function creativeThumbHtml(c) {
  const type = c.creativeType || "image";
  const label = creativeTypeLabel(type);
  if (c.thumbnailUrl) {
    const play = type === "video" ? '<span class="thumb-play" aria-hidden="true">▶</span>' : "";
    return `<div class="creative-thumb" title="${label}"><img src="${c.thumbnailUrl}" alt="" loading="lazy" width="52" height="52" />${play}</div>`;
  }
  return `<div class="creative-thumb creative-thumb-empty" title="${label}"><span class="thumb-type-badge">${label}</span></div>`;
}

function renderCreatives() {
  const creatives = filterCreatives();
  const wrap = document.getElementById("creatives-table-wrap");
  if (!creatives.length) {
    wrap.innerHTML = emptyHtml("没有匹配的素材");
    return;
  }

  wrap.innerHTML = `<p class="muted text-xs mb-2">缩略图来自广告同步入库的 thumbnail_url（Demo 为占位图）</p>
  <div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th>预览</th><th>类型</th>
          <th>平台</th><th>计划</th><th>素材</th><th>落地页 / UTM</th>
          <th>消耗</th><th>曝光</th><th>点击</th><th>CTR</th><th>CPC</th>
          <th>落地 UV</th><th>注册数</th><th>CPA</th><th>Key</th><th>活跃调用</th>
          <th>充值用户</th><th>充值额</th><th>ROAS</th><th>国家 Top3</th>
        </tr>
      </thead>
      <tbody>
        ${creatives
          .map((c) => {
            const spend = Math.round(creativeSpendInRange(c));
            const days = getRangeDays();
            const adScale = days / 90;
            const imps = Math.round((c.impressions || 0) * adScale);
            const clicks = Math.round((c.clicks || 0) * adScale);
            const cohortN = usersForCreative(c.id).length;
            const regs = cohortN > 0 ? cohortN : (c.registers > 0 ? Math.round(c.registers * adScale) : 0);
            const keys = Math.round((c.keyCreates || 0) * adScale);
            const callers = Math.round((c.activeCallers || 0) * adScale);
            const rcUsers = Math.round((c.rechargeUsers || 0) * adScale);
            const rcAmt = Math.round((c.rechargeAmount || 0) * adScale);
            const roas = spend > 0 ? rcAmt / spend : 0;
            const cpa = regs > 0 ? spend / regs : null;
            const selected = state.filters.creativeId === c.id ? "selected" : "";
            const canDrill = cohortN > 0 || c.registers > 0;
            const regBtn =
              canDrill
                ? `<button type="button" class="reg-link" data-drill-creative="${c.id}" title="查看该素材归因用户行为">注册 ${fmtNum(cohortN || regs)}${cohortN ? ` · ${cohortN}人` : ""}</button>`
                : `<span class="reg-link is-zero">0</span>`;
            return `<tr class="${selected}" data-creative-id="${c.id}">
              <td>${creativeThumbHtml(c)}</td>
              <td><span class="badge badge-zinc">${creativeTypeLabel(c.creativeType)}</span></td>
              <td><span class="badge badge-indigo">${c.platform.replace(" Ads", "")}</span></td>
              <td class="muted">${c.campaignName}</td>
              <td style="max-width:160px;white-space:normal;font-weight:500">${c.title}</td>
              <td style="max-width:220px;white-space:normal">
                <div class="mono muted" title="${c.landingUrl}">${c.landingUrl.length > 48 ? c.landingUrl.slice(0, 48) + "…" : c.landingUrl}</div>
                ${c.missingUtm ? '<span class="badge badge-rose">缺少 UTM</span>' : `<span class="badge badge-zinc">${c.utm.content}</span>`}
              </td>
              <td>${fmtMoney(spend)}</td>
              <td>${fmtNum(imps)}</td>
              <td>${fmtNum(clicks)}</td>
              <td>${fmtPct(c.ctr)}</td>
              <td>${fmtMoney2(c.cpc)}</td>
              <td>${fmtNum(Math.round((c.landingUV || 0) * adScale))}</td>
              <td>${regBtn}</td>
              <td>${cpa != null ? fmtMoney2(cpa) : "—"}</td>
              <td>${fmtNum(keys)}</td>
              <td>${fmtNum(callers)}</td>
              <td>${fmtNum(rcUsers)}</td>
              <td>${fmtMoney(rcAmt)}</td>
              <td><span style="color:${roas >= 1 ? "#6ee7b7" : "#fda4af"}">${fmtRoas(roas)}</span></td>
              <td>${c.topCountries.map((t) => `${t.country} ${Math.round(t.share * 100)}%`).join(" · ")}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>
  <p class="table-hint">点击「注册数」按钮 → 跳转「用户行为」并按该素材（utm_content）筛选用户；注册数优先展示下钻 cohort 人数。点击其他单元格可选中素材行。</p>`;

  wrap.querySelectorAll("[data-drill-creative]").forEach((btn) => {
    btn.addEventListener("click", (e) => drillToCreativeUsers(btn.dataset.drillCreative, e));
  });
  wrap.querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-drill-creative]")) return;
      const id = tr.dataset.creativeId;
      state.filters.creativeId = id;
      renderActiveCreativeChip();
      wrap.querySelectorAll("tbody tr").forEach((r) => r.classList.toggle("selected", r.dataset.creativeId === id));
    });
  });
}

/* ---------- Users ---------- */
function renderCohortSummary(users) {
  const el = document.getElementById("users-cohort-summary");
  if (!el) return;
  if (!state.filters.creativeId) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const c = CREATIVES.find((x) => x.id === state.filters.creativeId);
  const n = users.length;
  const keyRate = n ? users.filter((u) => u.hasKey).length / n : 0;
  const callRate = n ? users.filter((u) => (u.calls || []).length > 0).length / n : 0;
  const rechargeRate = n ? users.filter((u) => (u.recharges || []).length > 0).length / n : 0;
  const avgPages = n ? +(users.reduce((s, u) => s + userTrail(u).length, 0) / n).toFixed(1) : 0;
  const avgSession = n ? Math.round(users.reduce((s, u) => s + userTotalDwell(u), 0) / n) : 0;
  const modelCount = {};
  users.forEach((u) => userModels(u).forEach((m) => { modelCount[m] = (modelCount[m] || 0) + 1; }));
  const topModels = Object.entries(modelCount).sort((a, b) => b[1] - a[1]).slice(0, 6);

  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-2 flex-wrap">
      <div class="text-sm text-zinc-200 font-medium">队列概览 · ${c ? c.title : state.filters.creativeId}
        <span class="muted text-xs font-normal ml-2">${c ? c.platform + " · " + c.utm.content : ""}</span>
      </div>
      <button type="button" class="preset-btn" onclick="clearCreativeFilter()">清除素材筛选</button>
    </div>
    <div class="cohort-strip">
      <div class="cohort-item"><div class="cohort-label">注册数</div><div class="cohort-value">${fmtNum(n)}</div></div>
      <div class="cohort-item"><div class="cohort-label">建 Key 率</div><div class="cohort-value">${fmtPct(keyRate)}</div></div>
      <div class="cohort-item"><div class="cohort-label">调用率</div><div class="cohort-value">${fmtPct(callRate)}</div></div>
      <div class="cohort-item"><div class="cohort-label">充值率</div><div class="cohort-value">${fmtPct(rechargeRate)}</div></div>
      <div class="cohort-item"><div class="cohort-label">人均浏览页数</div><div class="cohort-value">${avgPages}</div></div>
      <div class="cohort-item"><div class="cohort-label">人均会话停留</div><div class="cohort-value">${fmtDwell(avgSession)}</div></div>
      <div class="cohort-models">
        <span class="muted text-xs mr-1">Top 模型</span>
        ${topModels.length ? topModels.map(([m, cnt]) => `<span class="model-chip">${m} · ${cnt}</span>`).join("") : '<span class="muted text-xs">暂无调用</span>'}
      </div>
    </div>`;
}

function renderUsers() {
  const users = filterUsers().sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
  const listEl = document.getElementById("users-list");
  const countEl = document.getElementById("users-count");
  countEl.textContent = `${users.length} 位用户`;
  renderCohortSummary(users);

  if (!users.length) {
    listEl.innerHTML = emptyHtml("没有匹配的用户");
    return;
  }

  listEl.innerHTML = `<div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th>用户 ID</th><th>国家</th><th>注册方式 / 时间</th><th>来源</th>
          <th>浏览页</th><th>总停留</th><th>页均停留</th>
          <th>个人漏斗</th>
          <th>建 Key 页</th><th>调用</th><th>模型</th><th>充值</th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map((u) => {
            const pages = userTrail(u).length;
            const totalDwell = userTotalDwell(u);
            const avgDwell = userAvgDwell(u);
            const models = userModels(u);
            const sourceLabel = u.platform
              ? `${u.platform.replace(" Ads", "")}${u.utm?.source ? " / " + u.utm.source : ""}`
              : (u.utm?.source || "organic");
            return `<tr data-user-id="${u.id}">
              <td>
                <div class="mono" style="font-weight:600">${u.id}</div>
                <div class="muted" style="font-size:11px">${u.name}</div>
              </td>
              <td><span class="badge badge-zinc">${u.country}</span></td>
              <td>
                <span class="badge badge-sky">${u.registerMethod}</span>
                <div class="muted" style="font-size:11px;margin-top:3px">${fmtDateTime(u.registeredAt)}</div>
              </td>
              <td class="wrap-cell">
                <div>${sourceLabel}</div>
                <div class="mono muted" style="font-size:10px">${u.utm?.content || "—"}</div>
              </td>
              <td>${pages}</td>
              <td class="dwell-cell">${fmtDwell(totalDwell)}</td>
              <td class="dwell-cell">${fmtDwell(avgDwell)}</td>
              <td>${funnelBadgesHtml(u)}</td>
              <td>${u.keyPage ? `<span class="mono badge badge-violet">${u.keyPage}</span>` : '<span class="muted">—</span>'}</td>
              <td>${u.callCount}</td>
              <td class="wrap-cell">${modelsChipsHtml(models, 3)}</td>
              <td>${u.totalRecharge ? fmtMoney(u.totalRecharge) : "—"}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>
  <p class="table-hint">点击用户行打开行为详情抽屉（漏斗 / 归因 / 浏览 / Key / 调用 / 充值）</p>`;

  listEl.querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", () => openUserDrawer(tr.dataset.userId));
  });
}

function openUserDrawer(userId) {
  const u = USERS.find((x) => x.id === userId);
  if (!u) return;
  state.selectedUserId = userId;
  const creative = CREATIVES.find((c) => c.id === u.creativeId);
  const overlay = document.getElementById("drawer-overlay");
  const drawer = document.getElementById("user-drawer");
  overlay.classList.add("open");
  drawer.classList.add("open");
  document.body.classList.add("drawer-open");
  drawer.setAttribute("aria-hidden", "false");

  document.getElementById("drawer-title").textContent = `${u.name} · 行为详情`;
  document.getElementById("drawer-subtitle").textContent = `${u.email} · ${u.id} · ${u.country}`;

  const funnel = userFunnel(u);
  const funnelSteps = [
    { key: "landing", label: "落地 / 浏览" },
    { key: "register", label: "注册" },
    { key: "key", label: "建 Key" },
    { key: "call", label: "首次调用" },
    { key: "recharge", label: "充值" },
  ];
  const trail = userTrail(u);
  const totalDwell = userTotalDwell(u);
  const avgDwell = userAvgDwell(u);
  const models = userModels(u);
  const modelSummary = {};
  (u.calls || []).forEach((c) => {
    modelSummary[c.model] = (modelSummary[c.model] || 0) + 1;
  });

  document.getElementById("drawer-body").innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <h3 class="section-title">个人行为漏斗</h3>
      <div class="behavior-funnel">
        ${funnelSteps
          .map((s) => {
            const step = funnel[s.key];
            return `<div class="behavior-funnel-step ${step.done ? "done" : ""}">
              <div class="step-name">${s.label}</div>
              <div class="step-status">${step.done ? '<span class="badge badge-emerald">已完成</span>' : '<span class="badge badge-zinc">未到达</span>'}</div>
              <div class="step-time">${step.done && step.at ? fmtDateTime(step.at) : "—"}</div>
            </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 class="section-title">来源归因（末触 UTM）</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
        <div><div class="muted">平台</div><div>${u.platform || "Organic"}</div></div>
        <div><div class="muted">计划 / Campaign</div><div>${u.campaignName || "—"}</div></div>
        <div style="grid-column:1/-1"><div class="muted">素材标题</div><div>${creative ? creative.title : u.creativeTitle || "—"}</div></div>
        <div><div class="muted">utm_source</div><div class="mono">${u.utm.source || "—"}</div></div>
        <div><div class="muted">utm_medium</div><div class="mono">${u.utm.medium || "—"}</div></div>
        <div><div class="muted">utm_campaign</div><div class="mono">${u.utm.campaign || "—"}</div></div>
        <div><div class="muted">utm_content / creativeId</div><div class="mono">${u.utm.content || u.creativeId || "—"}</div></div>
        <div style="grid-column:1/-1"><div class="muted">落地 URL</div><div class="mono" style="word-break:break-all">${u.landingUrl}</div></div>
        <div><div class="muted">注册方式</div><div>${u.registerMethod}</div></div>
        <div><div class="muted">注册时间</div><div>${fmtDateTime(u.registeredAt)}</div></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 class="section-title">浏览轨迹</h3>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;font-size:12px">
        <span class="badge badge-zinc">页数 ${trail.length}</span>
        <span class="badge badge-indigo">总停留 ${fmtDwell(totalDwell)}</span>
        <span class="badge badge-violet">页均 ${fmtDwell(avgDwell)}</span>
      </div>
      ${
        trail.length
          ? trail
              .map(
                (t) => `<div class="timeline-item">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <span class="mono">${t.path}</span>
              <span class="muted" style="font-size:11px">停留 ${t.dwellSec}s</span>
            </div>
            <div class="muted" style="font-size:11px">进入 ${fmtDateTime(t.enterTime || t.ts)}</div>
          </div>`
              )
              .join("")
          : `<div class="empty-gap-state">暂无浏览事件（GAP）<div class="muted" style="margin-top:6px;font-size:11px">Demo：部分用户故意无 page_view / page_leave，用于演示接入缺口空态</div></div>`
      }
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 class="section-title">Key</h3>
      ${
        u.hasKey
          ? `<div style="font-size:12px;display:grid;gap:6px">
              <div>是否创建：<span class="badge badge-emerald">是</span></div>
              <div>created_at：<strong>${fmtDateTime(u.keyCreatedAt)}</strong></div>
              <div>created_page：<span class="mono badge badge-violet">${u.keyPage}</span></div>
              <div>auto_recharge：${u.autoRecharge ? '<span class="badge badge-emerald">on</span>' : '<span class="badge badge-zinc">off</span>'}</div>
            </div>`
          : `<div class="muted" style="font-size:12px">尚未创建 Key（created = false）</div>`
      }
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 class="section-title">调用明细 <span class="muted" style="font-weight:400">（不含请求体）</span></h3>
      <div style="margin-bottom:8px;font-size:12px">
        <span class="muted">模型汇总：</span>
        ${models.length ? models.map((m) => `<span class="model-chip">${m} ×${modelSummary[m] || 0}</span>`).join(" ") : '<span class="muted">无</span>'}
      </div>
      ${
        u.calls.length
          ? `<div class="table-scroll" style="max-height:280px;overflow:auto">
            <table class="data-table">
              <thead><tr>
                <th>mode</th><th>id</th><th>model</th><th>source</th><th>tool/client</th>
                <th>request_time</th><th>response_time</th><th>latency_ms</th><th>success</th>
              </tr></thead>
              <tbody>
                ${u.calls
                  .slice()
                  .reverse()
                  .map(
                    (c) => `<tr style="cursor:default">
                    <td><span class="badge ${(c.mode || "sync") === "async" ? "badge-sky" : "badge-violet"}">${c.mode || "sync"}</span></td>
                    <td class="mono">${(c.mode || "sync") === "async" ? (c.taskId || c.id) : (c.requestId || c.id)}</td>
                    <td class="mono">${c.model}</td>
                    <td><span class="badge ${c.source === "api" ? "badge-indigo" : "badge-violet"}">${c.source}</span></td>
                    <td>${c.toolId ? `<span class="badge badge-sky">${c.toolId}</span>` : '<span class="muted">—</span>'}</td>
                    <td class="muted">${c.reqTime}</td>
                    <td class="muted">${c.respTime}</td>
                    <td>${c.latencyMs}</td>
                    <td><span class="badge ${c.success ? "badge-emerald" : "badge-rose"}">${c.success ? "true" : "false"}</span></td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
          : `<div class="muted" style="font-size:12px">暂无调用记录</div>`
      }
    </div>

    <div class="card">
      <h3 class="section-title">充值记录</h3>
      ${
        u.recharges.length
          ? `<table class="data-table"><thead><tr><th>时间</th><th>金额</th><th>币种</th><th>方式</th><th>自动</th></tr></thead>
            <tbody>${u.recharges
              .map(
                (r) => `<tr style="cursor:default">
                <td>${fmtDateTime(r.ts)}</td>
                <td>${fmtMoney(r.amount)}</td>
                <td>${r.currency || "USD"}</td>
                <td>${r.method}</td>
                <td>${r.auto ? '<span class="badge badge-emerald">是</span>' : "否"}</td>
              </tr>`
              )
              .join("")}</tbody></table>
            <div class="muted" style="font-size:11px;margin-top:8px">合计 ${fmtMoney(u.totalRecharge)}</div>`
          : `<div class="muted" style="font-size:12px">暂无充值</div>`
      }
    </div>
  `;
}

function closeUserDrawer() {
  document.getElementById("drawer-overlay").classList.remove("open");
  const drawer = document.getElementById("user-drawer");
  drawer.classList.remove("open");
  document.body.classList.remove("drawer-open");
  drawer.setAttribute("aria-hidden", "true");
  state.selectedUserId = null;
}

/* ---------- Product ---------- */
function renderProduct() {
  const users = filterUsers();
  const content = document.getElementById("product-content");
  const empty = document.getElementById("product-empty");
  if (!users.length) {
    ["regMethod", "keyPage", "callSource", "models", "tools", "recharge"].forEach(destroyChart);
    if (content) content.style.display = "none";
    if (empty) { empty.style.display = "block"; empty.innerHTML = emptyHtml(); }
    return;
  }
  if (empty) { empty.style.display = "none"; empty.innerHTML = ""; }
  if (content) content.style.display = "block";

  // Register method — users registered in window
  const regMap = {};
  users.filter((u) => inRange(u.registeredAt)).forEach((u) => {
    regMap[u.registerMethod] = (regMap[u.registerMethod] || 0) + 1;
  });
  makeChart("regMethod", document.getElementById("chart-reg-method"), {
    type: "doughnut",
    data: {
      labels: Object.keys(regMap),
      datasets: [{ data: Object.values(regMap), backgroundColor: ["#6366f1", "#a855f7", "#34d399", "#f59e0b", "#38bdf8"], borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: "#a1a1aa", boxWidth: 10, font: { size: 11 } } } } },
  });

  // Key create page — keys created in window
  const keyMap = {};
  users.filter((u) => u.hasKey && u.keyCreatedAt && inRange(u.keyCreatedAt)).forEach((u) => {
    keyMap[u.keyPage || "unknown"] = (keyMap[u.keyPage || "unknown"] || 0) + 1;
  });
  makeChart("keyPage", document.getElementById("chart-key-page"), {
    type: "bar",
    data: {
      labels: Object.keys(keyMap),
      datasets: [{ label: "创建数", data: Object.values(keyMap), backgroundColor: "#818cf8", borderRadius: 4 }],
    },
    options: { ...chartDefaults, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });

  // Calls aggregation — same path as overview (time + callSources)
  const filteredCalls = collectCalls(users);

  const pg = filteredCalls.filter((c) => c.source === "playground").length;
  const api = filteredCalls.filter((c) => c.source === "api").length;
  makeChart("callSource", document.getElementById("chart-call-source"), {
    type: "doughnut",
    data: {
      labels: ["Playground", "API"],
      datasets: [{ data: [pg, api], backgroundColor: ["#a78bfa", "#6366f1"], borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: "#a1a1aa" } } } },
  });

  const modelMap = {};
  filteredCalls.forEach((c) => {
    modelMap[c.model] = (modelMap[c.model] || 0) + 1;
  });
  const modelEntries = Object.entries(modelMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
  makeChart("models", document.getElementById("chart-models"), {
    type: "bar",
    data: {
      labels: modelEntries.map((e) => e[0]),
      datasets: [{ label: "调用次数", data: modelEntries.map((e) => e[1]), backgroundColor: "#34d399", borderRadius: 4 }],
    },
    options: { ...chartDefaults, indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });

  const toolMap = {};
  filteredCalls.filter((c) => c.source === "api" && c.toolId).forEach((c) => {
    toolMap[c.toolId] = (toolMap[c.toolId] || 0) + 1;
  });
  const toolEntries = Object.entries(toolMap).sort((a, b) => b[1] - a[1]);
  makeChart("tools", document.getElementById("chart-tools"), {
    type: "bar",
    data: {
      labels: toolEntries.map((e) => e[0]),
      datasets: [{ label: "API Tool", data: toolEntries.map((e) => e[1]), backgroundColor: "#38bdf8", borderRadius: 4 }],
    },
    options: { ...chartDefaults, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });

  const successRate = filteredCalls.length ? filteredCalls.filter((c) => c.success).length / filteredCalls.length : 0;
  const syncAvg = avgLatencyForMode(filteredCalls, "sync");
  const asyncAvg = avgLatencyForMode(filteredCalls, "async");
  document.getElementById("product-call-stats").innerHTML = `
    <div class="kpi-card"><div class="muted" style="font-size:12px">调用成功率</div><div style="font-size:22px;font-weight:700;margin-top:6px">${fmtPct(successRate)}</div></div>
    <div class="kpi-card"><div class="muted" style="font-size:12px">同步平均延时</div><div style="font-size:22px;font-weight:700;margin-top:6px">${fmtLatencyMs(syncAvg)}</div></div>
    <div class="kpi-card"><div class="muted" style="font-size:12px">异步平均延时</div><div style="font-size:22px;font-weight:700;margin-top:6px">${fmtLatencyMs(asyncAvg)}</div></div>
    <div class="kpi-card"><div class="muted" style="font-size:12px">总调用次数</div><div style="font-size:22px;font-weight:700;margin-top:6px">${fmtNum(filteredCalls.length)}</div></div>
  `;

  // Recharge — same time window as overview
  const amounts = [10, 20, 50, 100, 200];
  const rcAll = users.flatMap((u) => (u.recharges || []).filter((r) => inRange(r.ts)));
  const rcDist = amounts.map((a) => rcAll.filter((r) => r.amount === a).length);
  const autoRate = users.filter((u) => u.hasKey).length
    ? users.filter((u) => u.autoRecharge).length / users.filter((u) => u.hasKey).length
    : 0;
  document.getElementById("auto-recharge-rate").textContent = fmtPct(autoRate);
  makeChart("recharge", document.getElementById("chart-recharge"), {
    type: "bar",
    data: {
      labels: amounts.map((a) => "$" + a),
      datasets: [{ label: "笔数", data: rcDist, backgroundColor: "#f472b6", borderRadius: 4 }],
    },
    options: { ...chartDefaults, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
}

/* ---------- Ads Health ---------- */
function renderAdsHealth() {
  const creatives = filterCreatives();
  const page = document.getElementById("page-ads");
  if (!page) return;

  const missingUtm = creatives.filter((c) => c.missingUtm);
  const zeroReg = creatives.filter((c) => c.registers === 0 && c.spend > 0);
  const missingPct = creatives.length ? missingUtm.length / creatives.length : 0;

  // Secondary note metrics (de-emphasized)
  let anomalyCount = 0;
  let ctrVolCount = 0;
  let cpcVolCount = 0;
  creatives.forEach((c) => {
    const cut = fmtDate(dateCutoff());
    const series = (c.daily || []).filter((d) => d.date >= cut);
    if (series.length < 3) return;
    const avg = series.reduce((s, d) => s + d.spend, 0) / series.length;
    series.forEach((d) => {
      if (avg > 0 && d.spend > avg * 2.5 && d.spend > 30) anomalyCount += 1;
    });
    const ctrs = series.map((d) => d.ctr);
    const ctrAvg = ctrs.reduce((a, b) => a + b, 0) / ctrs.length;
    const variance = ctrs.reduce((s, v) => s + Math.pow(v - ctrAvg, 2), 0) / ctrs.length;
    const cv = ctrAvg > 0 ? Math.sqrt(variance) / ctrAvg : 0;
    if (cv > 0.35) ctrVolCount += 1;
    const cpcs = series.map((d) => d.cpc);
    const cpcAvg = cpcs.reduce((a, b) => a + b, 0) / cpcs.length;
    const cpcCv = cpcAvg > 0 ? Math.sqrt(cpcs.reduce((s, v) => s + Math.pow(v - cpcAvg, 2), 0) / cpcs.length) / cpcAvg : 0;
    if (cpcCv > 0.3) cpcVolCount += 1;
  });
  const secondaryScore = Math.max(
    20,
    100 - anomalyCount * 4 - zeroReg.length * 10 - missingPct * 35 - (ctrVolCount + cpcVolCount) * 2
  );

  const deliveryAlerts = [
    ...missingUtm.map((c) => ({
      severity: "med",
      type: "UTM 缺失",
      title: c.title,
      detail: `落地页未携带完整 UTM：${c.landingUrl}`,
      platform: c.platform,
    })),
    ...zeroReg.map((c) => ({
      severity: "high",
      type: "有消耗零注册",
      title: c.title,
      detail: `窗内消耗约 $${Math.round(creativeSpendInRange(c))}，注册为 0 — 建议检查落地页/定向`,
      platform: c.platform,
    })),
  ];

  const auditRows = [
    { severity: "high", type: "缺 event_id", title: "api_call · usr_014", detail: "Collect 事件缺少 event_id，无法幂等去重（Demo）" },
    { severity: "med", type: "缺 Server 充值", title: "recharge · usr_027", detail: "仅有前端 beacon，未见 Server 充值事件（Demo）" },
    { severity: "med", type: "缺 Server api_call", title: "playground · usr_008", detail: "Playground 调用未伴随 Server api_call 校验（Demo）" },
    { severity: "low", type: "缺 event_id", title: "page_leave · usr_003", detail: "浏览离开事件 event_id 为空（Demo）" },
  ];

  const alertsHtml = (list, emptyMsg) => {
    if (!list.length) return emptyHtml(emptyMsg);
    return list
      .map(
        (a) => `<div class="alert-row severity-${a.severity}">
      <div style="min-width:88px"><span class="badge badge-${a.severity === "high" ? "rose" : a.severity === "med" ? "amber" : "sky"}">${a.type}</span></div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:550;font-size:13px">${a.title}${a.platform ? ` <span class="muted">· ${a.platform}</span>` : ""}</div>
        <div class="muted" style="font-size:12px;margin-top:2px">${a.detail}</div>
      </div>
    </div>`
      )
      .join("");
  };

  page.innerHTML = `
    <div class="health-section card mb-4">
      <h2 class="section-title">1. 投放问题</h2>
      <p class="muted text-xs mb-3">主看 UTM 缺失与有消耗零注册；CTR/CPC 综合分仅作次要参考。</p>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <div class="kpi-card"><div class="muted" style="font-size:12px">缺少 UTM</div><div style="font-size:22px;font-weight:700;margin-top:6px">${missingUtm.length}</div><div class="muted" style="font-size:11px">占比 ${fmtPct(missingPct)}</div></div>
        <div class="kpi-card"><div class="muted" style="font-size:12px">有消耗零注册</div><div style="font-size:22px;font-weight:700;margin-top:6px">${zeroReg.length}</div></div>
        <div class="kpi-card"><div class="muted" style="font-size:12px">素材数（筛选后）</div><div style="font-size:22px;font-weight:700;margin-top:6px">${creatives.length}</div></div>
        <div class="kpi-card health-secondary"><div class="muted" style="font-size:12px">次要 · 综合健康分</div><div style="font-size:18px;font-weight:600;margin-top:6px;color:#a1a1aa">${Math.round(secondaryScore)}</div><div class="muted" style="font-size:10px">含 CTR/CPC 波动 · 非主指标</div></div>
      </div>
      <div id="health-delivery-alerts">${alertsHtml(deliveryAlerts, "当前筛选下无主要投放问题")}</div>
      <p class="muted text-xs mt-2">参考：消耗突增 ${anomalyCount} · CTR 波动素材 ${ctrVolCount} · CPC 波动素材 ${cpcVolCount}</p>
    </div>

    <div class="health-section card mb-4">
      <h2 class="section-title">2. 接入状态</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
        <div class="status-tile"><div class="muted text-xs">Collect 延迟</div><div class="status-value">~2.4s</div><div class="muted text-xs">P95 占位</div></div>
        <div class="status-tile"><div class="muted text-xs">双写状态</div><div class="status-value"><span class="badge badge-emerald">正常</span></div><div class="muted text-xs">GTM → Collect + Warehouse</div></div>
        <div class="status-tile"><div class="muted text-xs">广告同步</div><div class="status-value"><span class="badge badge-emerald">已落库</span></div><div class="muted text-xs">最近同步 · Demo</div></div>
        <div class="status-tile status-tile-warn"><div class="muted text-xs">MCP 只读风险</div><div class="status-value text-sm">只读</div><div class="muted text-xs">数据来自落库同步，面板不直查 MCP</div></div>
      </div>
      <p class="muted text-xs">占位：真实延迟 / 双写水位需接运维指标；此处仅演示信息架构。</p>
    </div>

    <div class="health-section card mb-4">
      <h2 class="section-title">3. Token 最小审计</h2>
      <p class="muted text-xs mb-3">样本告警（非完整四维审计）：缺 event_id、缺 Server 充值 / api_call。</p>
      <div id="health-audit-alerts">${alertsHtml(auditRows, "暂无审计告警")}</div>
    </div>
  `;
}

/* ---------- Render router ---------- */
function renderPage() {
  const page = state.page;
  if (page === "overview") renderOverview();
  else if (page === "creatives") renderCreatives();
  else if (page === "users") renderUsers();
  else if (page === "product") renderProduct();
  else if (page === "ads") renderAdsHealth();
}

/* ---------- Init ---------- */
function init() {
  populateFilterOptions();
  bindFilters();
  const collapseBtn = document.getElementById("filter-collapse-btn");
  if (collapseBtn) collapseBtn.addEventListener("click", toggleFilterCollapse);
  applyFilterCollapseUI();

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });

  document.getElementById("drawer-overlay").addEventListener("click", closeUserDrawer);
  document.getElementById("drawer-close").addEventListener("click", closeUserDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeUserDrawer();
  });

  navigate("overview");
}

document.addEventListener("DOMContentLoaded", init);
