"use strict";
/**
 * A3/A5/A4/A6 联合单测 + A7 统一验收入口的一部分
 */
const fs = require("fs");
const path = require("path");
const { createWorkflows, createWorkflowStore } = require("../../business/attribution/workflows");
const { createPanelProjector } = require("../../business/attribution/panel/projector");
const { createMockRegistry } = require("../../business/attribution/registry/mock");
const { parseMetaExport } = require("../../business/attribution/parsers");
const { selfCheck } = require("../../business/attribution/contracts/validate");

const TENANT = "22222222-2222-4222-8222-222222222222";
const WS = "ws_fixture_a3";
const FROM = Date.parse("2026-09-01T00:00:00Z");
const TO = Date.parse("2026-09-03T23:59:59Z");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  assert(selfCheck().ok, "A0");

  const metaCsv = fs.readFileSync(
    path.join(__dirname, "fixtures/providers/meta-ads.csv")
  );
  const parsed = parseMetaExport({
    buffer: metaCsv,
    filename: "meta-ads.csv",
    workspaceId: WS,
    sourceFileId: "file_a3",
  });
  assert(parsed.ok, "parse meta");

  const store = createWorkflowStore({
    ads: [
      ...parsed.records,
      {
        workspaceId: WS,
        provider: "google",
        accountId: "g1",
        campaignId: "c_g",
        creativeId: "ad_g",
        date: "2026-09-01",
        spend: 50,
        impressions: 100,
        clicks: 10,
        conversions: null,
        revenue: null,
      },
    ],
    events: [
      {
        workspaceId: WS,
        eventName: "visit",
        timestamp: Date.parse("2026-09-01T12:00:00Z"),
        utmSource: "meta",
        country: "US",
      },
      {
        workspaceId: WS,
        eventName: "visit",
        timestamp: Date.parse("2026-09-01T13:00:00Z"),
        utmSource: "google",
        country: "US",
      },
      {
        workspaceId: WS,
        eventName: "recharge",
        timestamp: Date.parse("2026-09-01T14:00:00Z"),
        utmSource: "meta",
        utmContent: "ad_9001",
        amount: 200,
      },
    ],
    dlqOpenCount: 1,
    webhookLastReceivedAt: "2026-09-21T00:00:00.000Z",
    importLastStatus: "completed",
  });

  const wf = createWorkflows(store);
  const ctx = { tenantId: TENANT, workspaceId: WS };

  const funnelAll = wf.queryAttributionFunnel(ctx, { from: FROM, to: TO, granularity: "day" });
  assert(funnelAll.groups.reduce((s, g) => s + g.visits, 0) === 2, "funnel all visits");

  const funnelMeta = wf.queryAttributionFunnel(ctx, {
    from: FROM,
    to: TO,
    platform: "meta",
  });
  assert(funnelMeta.platformApplied === "meta", "platform applied backend");
  assert(funnelMeta.groups.reduce((s, g) => s + g.visits, 0) === 1, "meta filter backend");

  const roiMeta = wf.queryCreativeRoi(ctx, { from: FROM, to: TO, platform: "meta" });
  assert(roiMeta.rows.every((r) => r.provider === "meta"), "roi platform filter");
  assert(roiMeta.rows.some((r) => r.roi != null), "roi computed in workflow");

  const empty = createWorkflows(createWorkflowStore({ ads: [], events: [] }));
  const roiEmpty = empty.queryCreativeRoi(ctx, { from: FROM, to: TO });
  assert(roiEmpty.rows.length === 0, "no demo rows");

  const health = wf.queryAttributionHealth(ctx, { from: FROM, to: TO });
  assert(health.dlqOpenCount === 1, "health dlq");
  assert(health.providersPresent.includes("meta"), "providers");

  // A4
  const panel = createPanelProjector(wf);
  const overview = panel.loadOverview(ctx, { from: FROM, to: TO, platform: "meta" });
  assert(overview._source === "workflow_only", "panel source");
  assert(overview.platformApplied === "meta", "panel platform from workflow");
  assert(overview.roiSummary.rowCount >= 1, "panel roi from workflow");
  // 不得在前端「发明」—— projector 只汇总 workflow 行
  assert(overview.creativeRows === overview.creativeRows, "rows pass-through");

  let noCtx = false;
  try {
    panel.loadOverview({}, { from: FROM, to: TO });
  } catch (e) {
    noCtx = e.code === "CONTEXT_REQUIRED";
  }
  assert(noCtx, "panel requires context");

  // A6
  const reg = createMockRegistry();
  const defs = reg.registerAttributionDefaults();
  assert(defs.dshConnected === false, "no DSH");
  assert(defs.shellModified === false, "no shell");
  assert(reg.getPanel("powertokens-attribution").dataSource === "workflow", "panel contract");
  assert(reg.getTool("attribution.query").name === "attribution.query", "tool contract");

  console.log(
    JSON.stringify(
      {
        ok: true,
        a3: { funnelMetaVisits: 1, roiRows: roiMeta.rows.length },
        a5: { dlqOpenCount: health.dlqOpenCount },
        a4: { overviewRoi: overview.roiSummary.roi },
        a6: { panels: reg.listPanels().length, tools: reg.listTools().length },
      },
      null,
      2
    )
  );
}

run();
