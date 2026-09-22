"use strict";
/**
 * A4 · Panel 只消费 Workflow 输出；禁止本地算 ROI / 填演示数
 */
/** 只转述 Workflow 已经算好的 roi。多行不在面板再除一次。 */
function summarizeRoi(rows) {
  if (!rows || !rows.length) {
    return { spend: null, revenue: null, roi: null, rowCount: 0 };
  }
  const spendVals = rows.map((r) => r.spend).filter((v) => v != null);
  const revVals = rows.map((r) => r.revenue).filter((v) => v != null);
  const rois = rows.map((r) => r.roi).filter((v) => v != null);
  return {
    spend: spendVals.length ? spendVals.reduce((s, v) => s + v, 0) : null,
    revenue: revVals.length ? revVals.reduce((s, v) => s + v, 0) : null,
    roi: rois.length === 1 ? rois[0] : null,
    rowCount: rows.length,
  };
}

function buildOverview(context, funnel, roi, health) {
  const view = {
    tab: "overview",
    workspaceId: context.workspaceId,
    platformApplied: funnel.platformApplied,
    funnelGroups: funnel.groups,
    dataFreshness: funnel.data_freshness,
    roiSummary: summarizeRoi(roi.rows),
    creativeRows: roi.rows,
    healthStrip: {
      adsSyncedThrough: health.adsSyncedThrough,
      dlqOpenCount: health.dlqOpenCount,
      missingUtmCount: health.missingUtmCount,
    },
    _source: "workflow_only",
  };
  assertNoDemoMetrics(view);
  return view;
}

function assertNoDemoMetrics(payload) {
  const banned = ["DEMO_ROI", "demo_spend", "__fill__"];
  const s = JSON.stringify(payload || {});
  for (const b of banned) {
    if (s.includes(b)) {
      throw Object.assign(new Error("禁止演示指标污染 Panel"), { code: "DEMO_LEAK" });
    }
  }
}

/**
 * @param {object} workflows createWorkflows() 返回值
 */
function createPanelProjector(workflows) {
  if (!workflows) throw new Error("workflows 必填");

  return {
    loadOverview(context, range) {
      if (!context || !context.tenantId || !context.workspaceId) {
        throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
      }
      const funnel = workflows.queryAttributionFunnel(context, {
        from: range.from,
        to: range.to,
        granularity: range.granularity || "day",
        platform: range.platform,
      });
      const roi = workflows.queryCreativeRoi(context, {
        from: range.from,
        to: range.to,
        platform: range.platform,
      });
      const health = workflows.queryAttributionHealth(context, {
        from: range.from,
        to: range.to,
      });
      if ([funnel, roi, health].some((p) => p && typeof p.then === "function")) {
        return Promise.all([funnel, roi, health]).then(([f, r, h]) =>
          buildOverview(context, f, r, h)
        );
      }
      return buildOverview(context, funnel, roi, health);
    },

    loadHealth(context, range) {
      const report = workflows.queryAttributionHealth(context, range);
      if (report && typeof report.then === "function") {
        return report.then((r) => {
          assertNoDemoMetrics(r);
          return { tab: "health", report: r, _source: "workflow_only" };
        });
      }
      assertNoDemoMetrics(report);
      return { tab: "health", report, _source: "workflow_only" };
    },
  };
}

module.exports = { createPanelProjector, assertNoDemoMetrics, summarizeRoi };
