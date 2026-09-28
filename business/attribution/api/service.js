"use strict";
/**
 * A19 · 归因查询服务：包装 createAnalyticsWorkflows，供 REST 调用。
 */
const { createAnalyticsWorkflows } = require("../workflows/engine");

function createAttributionApi(opts = {}) {
  if (!opts.pool) {
    throw new Error("createAttributionApi 需要 pool");
  }
  const workflows =
    opts.workflows ||
    createAnalyticsWorkflows(opts.pool, {
      persistence: opts.persistence,
      sourcePlatformRules: opts.sourcePlatformRules,
      queryFunnelScoped: opts.queryFunnelScoped,
      queryEventsScoped: opts.queryEventsScoped,
    });

  function requireContext(context) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
  }

  async function funnel(context, query) {
    requireContext(context);
    return workflows.queryFunnelPanel(context, {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
      platform: query.platform,
      country: query.country,
      conversion_window_days: query.conversion_window_days,
      limit: query.limit,
    });
  }

  /** 素材 Tab：与 funnel 同口径，默认 granularity=total，只强调 roi_by_entity */
  async function creatives(context, query) {
    requireContext(context);
    const panel = await workflows.queryFunnelPanel(context, {
      from: query.from,
      to: query.to,
      granularity: query.granularity || "total",
      platform: query.platform,
      country: query.country,
      conversion_window_days: query.conversion_window_days,
      limit: query.limit,
    });
    return {
      from: panel.from,
      to: panel.to,
      granularity: panel.granularity,
      platform: panel.platform,
      country: panel.country,
      roi_by_entity: panel.roi_by_entity,
      data_freshness: panel.data_freshness,
      workspaceId: panel.workspaceId,
      _engine: panel._engine,
      _via: panel._via,
    };
  }

  async function events(context, query) {
    requireContext(context);
    return workflows.queryEvents(context, {
      from: query.from,
      to: query.to,
      limit: query.limit,
      filters: {
        eventName: query.event_name || query.eventName,
        platform: query.platform,
      },
    });
  }

  async function health(context, query) {
    requireContext(context);
    return workflows.queryAttributionHealth(context, {
      from: query.from,
      to: query.to,
      platform: query.platform,
      granularity: query.granularity || "day",
    });
  }

  /** 合约形 ROI 行（AttributionResult[]），供非面板调用 */
  async function creativeRoi(context, query) {
    requireContext(context);
    return workflows.queryCreativeRoi(context, {
      from: query.from,
      to: query.to,
      platform: query.platform,
    });
  }

  return {
    workflows,
    funnel,
    creatives,
    events,
    health,
    creativeRoi,
  };
}

module.exports = { createAttributionApi };
