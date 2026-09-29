"use strict";
/**
 * A19：REST 包装层与 engine.queryFunnelPanel 数字一致；
 * 用 PGlite 塞真实广告日指标 + pt_events 再比对。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPgCompatPool } = require("../../analytics/lib/db.cjs");
const { createAnalyticsWorkflows } = require("../../business/attribution/workflows/engine");
const { createAttributionApi } = require("../../business/attribution/api");
const { upsertDailyMetric } = require("../../analytics/backend/ads/ingest");

const TENANT = "22222222-2222-4222-8222-222222222222";
const WS = "ws_a19";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function uuidFrom(seed) {
  const h = crypto.createHash("sha1").update(String(seed)).digest();
  const b = Buffer.from(h.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function seed(pool) {
  const { ingestOne } = require("../../analytics/backend/collect/ingest");
  const client = await pool.connect();
  try {
    await upsertDailyMetric(client, {
      workspaceId: WS,
      platform: "meta",
      accountId: "act_a19",
      entityId: "ad_a19_1",
      level: "creative",
      date: "2026-09-10",
      localDate: "2026-09-10",
      spend: "50.000000",
      impressions: 1000,
      clicks: 40,
      conversions: "0.000000",
      ctr: null,
      cpm: null,
      cpc: null,
      roas: null,
      currency: "USD",
      amountUsd: "50.000000",
      fxRate: null,
      fxDate: null,
      dataSource: "csv_export",
      idempotencyKey: "a19-seed-1",
    });
  } finally {
    client.release();
  }

  const day = Date.parse("2026-09-10T12:00:00.000Z");
  const events = [
    { name: "visit", ts: day, user: null },
    { name: "signup", ts: day + 60000, user: "usr_a19" },
    { name: "key_created", ts: day + 120000, user: "usr_a19" },
    { name: "recharge", ts: day + 300000, user: "usr_a19", amount: 99 },
  ];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    await ingestOne(pool, {
      tenant_id: TENANT,
      webhook_id: "a19_seed",
      event: {
        event_id: uuidFrom("a19-ev-" + i),
        event_name: e.name,
        timestamp: e.ts,
        visitor_id: "vis_a19",
        user_id: e.user,
        utm_source: "facebook",
        utm_medium: "cpc",
        utm_campaign: "camp_a19",
        utm_content: "ad_a19_1",
        amount: e.amount,
        currency: e.amount != null ? "USD" : undefined,
        status: e.name === "recharge" ? "success" : undefined,
      },
    });
  }
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a19-db-"));
  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });

  await seed(pool);

  const ctx = { tenantId: TENANT, workspaceId: WS };
  const from = String(Date.parse("2026-09-10T00:00:00.000Z"));
  const to = String(Date.parse("2026-09-10T23:59:59.999Z"));
  const query = { from, to, granularity: "total", platform: "meta" };

  const wf = createAnalyticsWorkflows(pool);
  const api = createAttributionApi({ pool, workflows: wf });

  const enginePanel = await wf.queryFunnelPanel(ctx, query);
  const apiPanel = await api.funnel(ctx, query);

  assert(enginePanel.groups.length === apiPanel.groups.length, "groups length");
  assert(
    JSON.stringify(enginePanel.groups) === JSON.stringify(apiPanel.groups),
    "groups deep equal"
  );
  assert(
    JSON.stringify(enginePanel.roi_by_entity) === JSON.stringify(apiPanel.roi_by_entity),
    "roi_by_entity deep equal"
  );

  const creatives = await api.creatives(ctx, query);
  assert(
    JSON.stringify(creatives.roi_by_entity) === JSON.stringify(apiPanel.roi_by_entity),
    "creatives alias"
  );

  // 至少有 funnel 或 roi 数字（真实查询路径，非 mock）
  const visits = (apiPanel.groups[0] && apiPanel.groups[0].funnel && apiPanel.groups[0].funnel.visits) || 0;
  const recharges =
    (apiPanel.groups[0] && apiPanel.groups[0].funnel && apiPanel.groups[0].funnel.recharges) || 0;
  assert(visits >= 1, "seeded visit visible got " + visits);
  assert(recharges >= 1, "seeded recharge visible got " + recharges);

  const health = await api.health(ctx, query);
  assert(health.workspaceId === WS, "health workspace");

  await pool.end();
  console.log(
    JSON.stringify(
      {
        ok: true,
        engineEqualsApi: true,
        groups: apiPanel.groups.length,
        roi: apiPanel.roi_by_entity.length,
        sampleFunnel: apiPanel.groups[0] && apiPanel.groups[0].funnel,
        sampleRoi: apiPanel.roi_by_entity[0] && {
          entity_id: apiPanel.roi_by_entity[0].entity_id,
          attr_spend_usd: apiPanel.roi_by_entity[0].attr_spend_usd,
          recharges: apiPanel.roi_by_entity[0].recharges,
          roi: apiPanel.roi_by_entity[0].roi,
        },
      },
      null,
      2
    )
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
