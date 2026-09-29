"use strict";
/**
 * A3/A5 Workflow 实现（业务线）
 * - tenant/workspace 只认 AttributionContext
 * - platform 筛选在本层后端完成（Mock）或下推 SQL（adapter）
 * - 禁止返回演示填空 ROI；无数据时 roi=null / 空数组
 */
const { PROVIDERS, assertAttributionResult } = require("../contracts/validate");

function requireContext(ctx) {
  if (!ctx || !ctx.tenantId || !ctx.workspaceId) {
    throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
  }
  return ctx;
}

function normalizePlatform(p) {
  if (p == null || p === "" || p === "all") return null;
  const v = String(p).toLowerCase();
  if (!PROVIDERS.includes(v)) {
    throw Object.assign(new Error(`platform 非法: ${p}`), { code: "BAD_PLATFORM" });
  }
  return v;
}

function computeRoi(revenue, spend) {
  if (revenue == null || spend == null) return null;
  if (!(spend > 0)) return null;
  return revenue / spend;
}

/** 内存数据面：A3/A5 单测与无库验收 */
function createWorkflowStore(seed = {}) {
  return {
    ads: Array.isArray(seed.ads) ? seed.ads.slice() : [],
    events: Array.isArray(seed.events) ? seed.events.slice() : [],
    dlqOpenCount: seed.dlqOpenCount || 0,
    webhookLastReceivedAt: seed.webhookLastReceivedAt || null,
    importLastStatus: seed.importLastStatus || null,
  };
}

function inRange(dateStr, fromMs, toMs) {
  const t = Date.parse(dateStr + "T00:00:00.000Z");
  return t >= fromMs && t <= toMs;
}

/**
 * queryAttributionFunnel — 平台过滤在后端
 */
function queryAttributionFunnel(context, input, store) {
  const ctx = requireContext(context);
  const from = Number(input.from);
  const to = Number(input.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw Object.assign(new Error("from/to 非法"), { code: "BAD_RANGE" });
  }
  const platform = normalizePlatform(input.platform);
  const granularity = input.granularity || "day";

  let events = store.events.filter(
    (e) => e.workspaceId === ctx.workspaceId && e.timestamp >= from && e.timestamp <= to
  );
  if (platform) {
    events = events.filter((e) => mapUtmToPlatform(e.utmSource) === platform);
  }
  if (input.country) {
    events = events.filter((e) => e.country === input.country);
  }

  const buckets = new Map();
  for (const e of events) {
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    const key = granularity === "total" ? "1970-01-01" : day;
    const g = buckets.get(key) || {
      bucket: key,
      visits: 0,
      signups: 0,
      keyCreated: 0,
      modelCalls: 0,
      recharges: 0,
    };
    if (e.eventName === "visit") g.visits += 1;
    else if (e.eventName === "signup") g.signups += 1;
    else if (e.eventName === "key_created") g.keyCreated += 1;
    else if (e.eventName === "model_call") g.modelCalls += 1;
    else if (e.eventName === "recharge") g.recharges += 1;
    buckets.set(key, g);
  }

  const groups = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    workspaceId: ctx.workspaceId,
    from,
    to,
    granularity,
    platformApplied: platform,
    groups,
    data_freshness: {
      events_max_ts: events.length
        ? Math.max(...events.map((e) => e.timestamp))
        : null,
      ads_synced_through: latestAdDate(store.ads, ctx.workspaceId, platform),
    },
  };
}

function mapUtmToPlatform(utm) {
  const s = String(utm || "").toLowerCase();
  if (/google/.test(s)) return "google";
  if (/meta|facebook|fb|instagram|ig/.test(s)) return "meta";
  if (/(^|[^a-z])x([^a-z]|$)|twitter/.test(s)) return "x";
  return null;
}

function latestAdDate(ads, workspaceId, platform) {
  let best = null;
  for (const a of ads) {
    if (a.workspaceId !== workspaceId) continue;
    if (platform && a.provider !== platform) continue;
    if (!best || a.date > best) best = a.date;
  }
  return best;
}

/**
 * queryCreativeRoi — ROI 只在本函数计算；无数据不填演示数
 */
function queryCreativeRoi(context, input, store) {
  const ctx = requireContext(context);
  const from = Number(input.from);
  const to = Number(input.to);
  const platform = normalizePlatform(input.platform);

  let ads = store.ads.filter(
    (a) => a.workspaceId === ctx.workspaceId && inRange(a.date, from, to)
  );
  if (platform) ads = ads.filter((a) => a.provider === platform);
  if (input.campaignId) ads = ads.filter((a) => a.campaignId === input.campaignId);
  if (input.creativeId) ads = ads.filter((a) => a.creativeId === input.creativeId);

  // 按 creative 聚合 spend
  const byCreative = new Map();
  for (const a of ads) {
    const key = `${a.provider}|${a.campaignId}|${a.creativeId}`;
    const row = byCreative.get(key) || {
      provider: a.provider,
      campaignId: a.campaignId,
      creativeId: a.creativeId,
      spend: 0,
      revenue: 0,
      conversions: 0,
    };
    row.spend += Number(a.spend) || 0;
    if (a.revenue != null) row.revenue += Number(a.revenue) || 0;
    if (a.conversions != null) row.conversions += Number(a.conversions) || 0;
    byCreative.set(key, row);
  }

  // 行为侧收入：同平台 utm 的 recharge amount（简化 last_touch 日汇总）
  let events = store.events.filter(
    (e) =>
      e.workspaceId === ctx.workspaceId &&
      e.timestamp >= from &&
      e.timestamp <= to &&
      e.eventName === "recharge"
  );
  if (platform) {
    events = events.filter((e) => mapUtmToPlatform(e.utmSource) === platform);
  }

  const rows = [];
  for (const row of byCreative.values()) {
    const matchedRevenue =
      row.revenue > 0
        ? row.revenue
        : events
            .filter((e) => !e.utmContent || e.utmContent === row.creativeId)
            .reduce((s, e) => s + (typeof e.amount === "number" ? e.amount : 0), 0);
    const revenue = matchedRevenue > 0 ? matchedRevenue : row.revenue > 0 ? row.revenue : null;
    const spend = row.spend;
    const roi = computeRoi(revenue, spend);
    const out = {
      workspaceId: ctx.workspaceId,
      attributionModel: "last_touch",
      from,
      to,
      provider: row.provider,
      campaignId: row.campaignId,
      creativeId: row.creativeId,
      utmSource: null,
      utmCampaign: null,
      utmContent: row.creativeId,
      eventName: "recharge",
      conversions: row.conversions,
      revenue,
      spend,
      roi,
      confidence: revenue != null ? "matched" : "partial",
      unmatchedReason: revenue == null ? "no_recharge_matched" : null,
      matchedEntities: [row.creativeId],
    };
    const errs = assertAttributionResult(out, []);
    if (errs.length) throw new Error(errs.join("; "));
    rows.push(out);
  }

  return {
    workspaceId: ctx.workspaceId,
    platformApplied: platform,
    rows,
  };
}

/**
 * queryEvents — 事件列表；过滤在后端
 */
function queryEvents(context, input, store) {
  const ctx = requireContext(context);
  const from = Number(input.from);
  const to = Number(input.to);
  const platform = normalizePlatform(input.filters && input.filters.platform);
  let events = store.events.filter(
    (e) => e.workspaceId === ctx.workspaceId && e.timestamp >= from && e.timestamp <= to
  );
  if (platform) {
    events = events.filter((e) => mapUtmToPlatform(e.utmSource) === platform);
  }
  if (input.filters && input.filters.eventName) {
    events = events.filter((e) => e.eventName === input.filters.eventName);
  }
  const limit = Math.min(Number(input.limit) || 100, 500);
  return {
    workspaceId: ctx.workspaceId,
    platformApplied: platform,
    items: events.slice(0, limit),
    total: events.length,
  };
}

/**
 * A5 queryAttributionHealth
 */
function queryAttributionHealth(context, input, store) {
  const ctx = requireContext(context);
  const from = Number(input.from);
  const to = Number(input.to);
  const ads = store.ads.filter((a) => a.workspaceId === ctx.workspaceId);
  const events = store.events.filter(
    (e) => e.workspaceId === ctx.workspaceId && e.timestamp >= from && e.timestamp <= to
  );
  const missingUtm = events.filter((e) => !e.utmSource).length;
  const providersPresent = [...new Set(ads.map((a) => a.provider))].filter((p) =>
    PROVIDERS.includes(p)
  );
  const adsSyncedThrough = latestAdDate(ads, ctx.workspaceId, null);
  let adsLagDays = null;
  if (adsSyncedThrough) {
    const lag = Math.floor((Date.now() - Date.parse(adsSyncedThrough + "T00:00:00Z")) / 86400000);
    adsLagDays = lag >= 0 ? lag : 0;
  }

  return {
    workspaceId: ctx.workspaceId,
    from,
    to,
    generatedAt: new Date().toISOString(),
    adsSyncedThrough,
    eventsMaxSeq: events.length ? String(events.length) : null,
    unmatchedEventCount: events.filter((e) => !mapUtmToPlatform(e.utmSource)).length,
    ambiguousCreativeCount: 0,
    missingUtmCount: missingUtm,
    badEventIdCount: 0,
    webhookLastReceivedAt: store.webhookLastReceivedAt,
    webhookReceiveLagMs: null,
    adsLagDays,
    importLastStatus: store.importLastStatus,
    dlqOpenCount: store.dlqOpenCount || 0,
    providersPresent,
    notes: [],
  };
}

function createWorkflows(store) {
  const s = store || createWorkflowStore();
  return {
    store: s,
    queryAttributionFunnel: (ctx, input) => queryAttributionFunnel(ctx, input, s),
    queryCreativeRoi: (ctx, input) => queryCreativeRoi(ctx, input, s),
    queryEvents: (ctx, input) => queryEvents(ctx, input, s),
    queryAttributionHealth: (ctx, input) => queryAttributionHealth(ctx, input, s),
  };
}

module.exports = {
  createWorkflowStore,
  createWorkflows,
  queryAttributionFunnel,
  queryCreativeRoi,
  queryEvents,
  queryAttributionHealth,
  computeRoi,
  normalizePlatform,
  mapUtmToPlatform,
};
