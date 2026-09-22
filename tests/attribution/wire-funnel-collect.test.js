"use strict";
/**
 * 归因下一刀：真实 parseFunnelParams / serialize* 接到 Workflow。
 * queryFunnelScoped 用假实现，避免起库；断言平台筛选进入既有参数解析（数组），
 * 面板 roi 原样转述，不在前端重算。
 */
const { createAnalyticsWorkflows } = require("../../business/attribution/workflows/engine");
const { createPanelProjector } = require("../../business/attribution/panel/projector");
const { createMockPersistence } = require("../../business/attribution/persistence");

const TENANT = "22222222-2222-4222-8222-222222222222";
const WS = "ws_wire";
const FROM = Date.parse("2026-09-01T00:00:00.000Z");
const TO = Date.parse("2026-09-03T00:00:00.000Z");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const calls = [];
  const persistence = createMockPersistence();
  const ctx = { tenantId: TENANT, workspaceId: WS };

  await persistence.insertDlq({
    tenantId: TENANT,
    workspaceId: WS,
    reason: "bad event",
    errorClass: "validation",
    rawEvent: { event_name: "nope" },
  });

  const wf = createAnalyticsWorkflows(null, {
    persistence,
    async queryFunnelScoped(_pool, tenantId, workspaceId, params) {
      calls.push({ tenantId, workspaceId, params });
      return {
        from: params.from,
        to: params.to,
        groups: [{ visits: "2", signups: "1", bucket: "2026-09-01", utm_source: "meta" }],
        roi: [
          {
            match: "matched",
            platform: "meta",
            entity_id: "ad_1",
            utm_source: "meta",
            utm_campaign: "launch",
            utm_content: "ad_1",
            recharges: 1,
            recharge_amount_usd: 100,
            attr_spend_usd: 10,
            roi: 3.5,
            matched_entities: ["ad_1"],
          },
        ],
        freshness: { events_max_seq: "9", ads_synced_through: "2026-09-02" },
      };
    },
    async queryEventsScoped(_pool, tenantId, filters) {
      calls.push({ events: true, tenantId, filters });
      return [
        { utm_source: "facebook", event_name: "visit", event_id: "7f9c24a0-1111-4111-8111-111111111111" },
        { utm_source: "google", event_name: "visit", event_id: "7f9c24a0-2222-4222-8222-222222222222" },
      ];
    },
  });

  const funnel = await wf.queryAttributionFunnel(ctx, {
    from: FROM,
    to: TO,
    platform: "meta",
    granularity: "day",
  });
  assert(funnel.platformApplied === "meta", "platform applied");
  assert(Array.isArray(calls[0].params.platform) && calls[0].params.platform[0] === "meta", "SQL params platform array");
  assert(calls[0].tenantId === TENANT && calls[0].workspaceId === WS, "context into scoped query");
  assert(funnel.groups[0].funnel.visits === 2, "serialized funnel");

  const roi = await wf.queryCreativeRoi(ctx, { from: FROM, to: TO, platform: "meta" });
  assert(roi.rows.length === 1 && roi.rows[0].roi === 3.5, "roi from SQL row");
  assert(roi.rows[0].spend === 10 && roi.rows[0].revenue === 100, "spend/revenue passthrough");

  const events = await wf.queryEvents(ctx, {
    from: FROM,
    to: TO,
    filters: { platform: "meta" },
  });
  assert(events.items.length === 1 && events.items[0].utm_source === "facebook", "event platform filter");
  assert(events.platformApplied === "meta", "events platform");

  const health = await wf.queryAttributionHealth(ctx, { from: FROM, to: TO });
  assert(health.dlqOpenCount === 1, "collect dlq visible");
  assert(health.adsSyncedThrough === "2026-09-02", "freshness from funnel");

  const panel = createPanelProjector(wf);
  const overview = await panel.loadOverview(ctx, { from: FROM, to: TO, platform: "meta" });
  assert(overview._source === "workflow_only", "panel source");
  assert(overview.roiSummary.roi === 3.5, "panel does not recompute 100/10");
  assert(overview.creativeRows[0].roi === 3.5, "row roi untouched");

  let blocked = false;
  try {
    await wf.queryAttributionFunnel({ tenantId: TENANT }, { from: FROM, to: TO });
  } catch (e) {
    blocked = e.code === "CONTEXT_REQUIRED";
  }
  assert(blocked, "context required");

  const shellDiff = require("node:child_process").spawnSync("git", ["diff", "--stat", "HEAD", "--", "shell", "analytics/backend/ads/funnel.js", "analytics/backend/collect"], {
    cwd: require("node:path").join(__dirname, "..", ".."),
    encoding: "utf8",
  });
  assert((shellDiff.stdout || "").trim() === "", "base files untouched: " + shellDiff.stdout);

  console.log(JSON.stringify({ ok: true, roi: overview.roiSummary.roi, platform: calls[0].params.platform }, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
