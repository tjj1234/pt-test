"use strict";
/**
 * 把 analytics 里已有的 funnel / events 查询接到 Workflow。
 * 不改 funnel.js、不改 collect/ingest.js、不改 shell。
 * tenantId / workspaceId 只来自 AttributionContext，再传给既有 scoped 查询。
 */
const { assertAttributionResult, PROVIDERS } = require("../contracts/validate");
const { normalizePlatform, mapUtmToPlatform } = require("./index");

function mapMatch(match) {
  if (match === "matched" || match === "exact") return "matched";
  if (match === "ambiguous_name") return "ambiguous_name";
  if (match === "no_match") return "no_match";
  if (match === "partial") return "partial";
  return "partial";
}

function toResultRow(ctx, from, to, entity) {
  const provider =
    entity.platform && PROVIDERS.includes(entity.platform) ? entity.platform : null;
  const row = {
    workspaceId: ctx.workspaceId,
    attributionModel: "last_touch",
    from,
    to,
    provider,
    campaignId: entity.utm_campaign || null,
    creativeId: entity.entity_id || entity.utm_content || null,
    utmSource: entity.utm_source || null,
    utmCampaign: entity.utm_campaign || null,
    utmContent: entity.utm_content || null,
    eventName: "recharge",
    conversions: Number(entity.recharges) || 0,
    revenue: entity.recharge_amount_usd == null ? null : Number(entity.recharge_amount_usd),
    spend: entity.attr_spend_usd == null ? null : Number(entity.attr_spend_usd),
    roi: entity.roi == null ? null : Number(entity.roi),
    confidence: mapMatch(entity.match),
    unmatchedReason: entity.match === "no_match" ? "no_match" : null,
    matchedEntities: Array.isArray(entity.matched_entities) ? entity.matched_entities.map(String) : [],
  };
  const errs = assertAttributionResult(row, []);
  if (errs.length) {
    throw Object.assign(new Error(errs.join("; ")), { code: "CONTRACT" });
  }
  return row;
}

function createEngineWorkflows(engine) {
  if (!engine || typeof engine.queryFunnelScoped !== "function") {
    throw new Error("engine.queryFunnelScoped 必填（复用 analytics funnel，不重写 SQL）");
  }
  if (typeof engine.parseFunnelParams !== "function") {
    throw new Error("engine.parseFunnelParams 必填");
  }
  if (typeof engine.serializeFunnelGroup !== "function" || typeof engine.serializeRoiEntity !== "function") {
    throw new Error("engine 序列化函数必填");
  }

  async function queryAttributionFunnel(context, input) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    const platform = normalizePlatform(input && input.platform);
    const parsed = engine.parseFunnelParams({
      from: String(input.from),
      to: String(input.to),
      granularity: (input && input.granularity) || "day",
      platform: platform || "",
      country: (input && input.country) || "",
    });
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.message || "funnel 参数非法"), { code: "BAD_RANGE" });
    }
    const raw = await engine.queryFunnelScoped(
      engine.pool,
      context.tenantId,
      context.workspaceId,
      parsed.params
    );
    const granularity = parsed.params.granularity;
    const groups = (raw.groups || []).map((g) => engine.serializeFunnelGroup(g, granularity));
    return {
      workspaceId: context.workspaceId,
      from: raw.from,
      to: raw.to,
      granularity,
      platformApplied: platform,
      groups,
      data_freshness: {
        events_max_ts: raw.freshness ? raw.freshness.events_max_seq : null,
        ads_synced_through: raw.freshness ? raw.freshness.ads_synced_through : null,
      },
      _engine: "analytics.funnel",
    };
  }

  async function queryCreativeRoi(context, input) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    const platform = normalizePlatform(input && input.platform);
    const parsed = engine.parseFunnelParams({
      from: String(input.from),
      to: String(input.to),
      granularity: "total",
      platform: platform || "",
    });
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.message || "roi 参数非法"), { code: "BAD_RANGE" });
    }
    const raw = await engine.queryFunnelScoped(
      engine.pool,
      context.tenantId,
      context.workspaceId,
      parsed.params
    );
    const rows = (raw.roi || []).map((r) =>
      toResultRow(context, raw.from, raw.to, engine.serializeRoiEntity(r, "total"))
    );
    return {
      workspaceId: context.workspaceId,
      platformApplied: platform,
      rows,
      _engine: "analytics.funnel",
    };
  }

  async function queryEvents(context, input) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    if (typeof engine.queryEventsScoped !== "function" || typeof engine.parseEventFilters !== "function") {
      throw new Error("engine.queryEventsScoped / parseEventFilters 必填");
    }
    const platform = normalizePlatform(input && input.filters && input.filters.platform);
    const query = {
      from: String(input.from),
      to: String(input.to),
    };
    if (input.filters && input.filters.eventName) query.event_name = input.filters.eventName;
    if (input.limit != null) query.limit = String(input.limit);
    const parsed = engine.parseEventFilters(query);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.message || "event 参数非法"), { code: "BAD_RANGE" });
    }
    const sqlRows = await engine.queryEventsScoped(engine.pool, context.tenantId, parsed.filters);
    let items = sqlRows || [];
    if (platform) {
      items = items.filter((e) => mapUtmToPlatform(e.utm_source || e.utmSource) === platform);
    }
    return {
      workspaceId: context.workspaceId,
      platformApplied: platform,
      items,
      total: items.length,
      _engine: "analytics.events",
    };
  }

  async function queryAttributionHealth(context, input) {
    const funnel = await queryAttributionFunnel(context, input);
    let dlqOpenCount = 0;
    if (engine.persistence && typeof engine.persistence.listDlq === "function") {
      const open = await engine.persistence.listDlq(context, { openOnly: true, limit: 200 });
      dlqOpenCount = open.length;
    }
    return {
      workspaceId: context.workspaceId,
      from: Number(input.from),
      to: Number(input.to),
      generatedAt: new Date().toISOString(),
      adsSyncedThrough: funnel.data_freshness.ads_synced_through,
      eventsMaxSeq: funnel.data_freshness.events_max_ts,
      unmatchedEventCount: 0,
      ambiguousCreativeCount: 0,
      missingUtmCount: 0,
      badEventIdCount: 0,
      webhookLastReceivedAt: null,
      webhookReceiveLagMs: null,
      adsLagDays: null,
      importLastStatus: null,
      dlqOpenCount,
      providersPresent: [],
      notes: ["wired_to_analytics_funnel_and_collect_dlq"],
    };
  }

  return {
    queryAttributionFunnel,
    queryCreativeRoi,
    queryEvents,
    queryAttributionHealth,
    _engine: true,
  };
}

module.exports = { createEngineWorkflows, createAnalyticsWorkflows, toResultRow };

function createAnalyticsWorkflows(pool, extras = {}) {
  const funnel = require("../../../analytics/backend/ads/funnel");
  const events = require("../../../analytics/backend/events/query");
  return createEngineWorkflows({
    pool,
    persistence: extras.persistence,
    parseFunnelParams: funnel.parseFunnelParams,
    queryFunnelScoped: extras.queryFunnelScoped || funnel.queryFunnelScoped,
    serializeFunnelGroup: funnel.serializeFunnelGroup,
    serializeRoiEntity: funnel.serializeRoiEntity,
    parseEventFilters: events.parseEventFilters,
    queryEventsScoped: extras.queryEventsScoped || events.queryEventsScoped,
  });
}
