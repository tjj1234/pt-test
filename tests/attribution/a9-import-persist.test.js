"use strict";
/**
 * A9-fix：confirm 后 ad_performance_daily 必须有对应行（不只测内存 job 状态）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fastify = require("../../analytics/node_modules/fastify");
const { createImportService } = require("../../business/attribution/import");
const { createImportStore } = require("../../business/attribution/import/store");
const { registerImportRoutes } = require("../../business/attribution/import/routes");
const { parseAuthorization } = require("../../analytics/backend/events/query.js");
const { toDailyMetricRow } = require("../../business/attribution/import/toDailyMetricRow");
const { createPgCompatPool } = require("../../analytics/lib/db.cjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function approx(a, b, eps = 0.0001) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a9-db-"));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a9-files-"));
  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });

  const ctx = {
    tenantId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "ws_a9_persist",
  };
  const csv = fs.readFileSync(
    path.join(__dirname, "fixtures/providers/meta-ads.csv")
  );

  // 映射冒烟：creative 粒度
  const mapped = toDailyMetricRow({
    workspaceId: ctx.workspaceId,
    provider: "meta",
    accountId: "act_8812999",
    campaignId: "campaign:x",
    creativeId: "ad_9001",
    date: "2026-09-01",
    currency: "USD",
    spend: 120.5,
    impressions: 18500,
    clicks: 420,
    rawSource: "csv_export",
    sourceFileId: "sf1",
    sourceRowNumber: 1,
  });
  assert(mapped.level === "creative", "level creative");
  assert(mapped.entityId === "ad_9001", "entityId");
  assert(approx(mapped.spend, 120.5), "spend map");
  assert(approx(mapped.amountUsd, 120.5), "amount_usd for USD");

  const svc = createImportService({ storageDir, pool });
  const ready = await svc.createAndValidate(ctx, {
    provider: "meta",
    originalName: "meta-ads.csv",
    buffer: csv,
  });
  assert(ready.status === "ready", "ready got " + ready.status);

  const done = await svc.confirmImport(ctx, ready.importId);
  assert(done.status === "completed", "completed got " + done.status);
  assert(done.successRows === 3, "successRows 3 got " + done.successRows);
  assert(done.persistedRows === 3, "persistedRows 3");

  const res = await pool.query(
    `SELECT platform, account_id, entity_id, level, date::text AS date,
            spend::float8 AS spend, impressions::bigint AS impressions,
            clicks::bigint AS clicks, currency, amount_usd::float8 AS amount_usd,
            data_source
     FROM ad_performance_daily
     WHERE workspace_id = $1
     ORDER BY date, entity_id`,
    [ctx.workspaceId]
  );
  assert(res.rows.length === 3, "db rows 3 got " + res.rows.length);

  const byKey = Object.fromEntries(
    res.rows.map((r) => [`${r.date}|${r.entity_id}`, r])
  );
  const r1 = byKey["2026-09-01|ad_9001"];
  assert(r1, "row ad_9001 day1");
  assert(r1.platform === "meta", "platform");
  assert(r1.account_id === "act_8812999", "account");
  assert(r1.level === "creative", "db level");
  assert(approx(r1.spend, 120.5), "spend 120.50 got " + r1.spend);
  assert(Number(r1.impressions) === 18500, "impressions");
  assert(Number(r1.clicks) === 420, "clicks");
  assert(r1.currency === "USD", "currency");
  assert(approx(r1.amount_usd, 120.5), "amount_usd");
  assert(r1.data_source === "csv_export", "data_source");

  const r2 = byKey["2026-09-01|ad_9002"];
  assert(r2 && approx(r2.spend, 88), "ad_9002 spend");
  const r3 = byKey["2026-09-02|ad_9001"];
  assert(r3 && approx(r3.spend, 95.25), "day2 spend");

  // 无 pool → failed，避免再静默假成功
  const noPoolStorage = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a9-np-"));
  const svcNoPool = createImportService({
    storageDir: noPoolStorage,
    store: createImportStore({ storageDir: noPoolStorage, pool }),
  });
  const ready2 = await svcNoPool.createAndValidate(ctx, {
    provider: "meta",
    originalName: "meta-ads.csv",
    buffer: csv,
  });
  const failed = await svcNoPool.confirmImport(ctx, ready2.importId);
  assert(failed.status === "failed", "no pool must fail");
  assert(/pool/i.test(failed.errorMessage || ""), "pool error message");

  await pool.end();
  const restartedPool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });
  const restartedService = createImportService({ storageDir, pool: restartedPool });
  const afterRestart = await restartedService.getJob(ctx, ready.importId);
  assert(afterRestart && afterRestart.status === "completed", "job survives database/service restart");
  const listedAfterRestart = await restartedService.listJobs(ctx);
  assert(listedAfterRestart.some((job) => job.importId === ready.importId), "GET jobs survives restart");
  const app = fastify({ logger: false });
  registerImportRoutes(app, {
    pool: restartedPool,
    importService: restartedService,
    verifyAnalyticsToken: async (token) =>
      token === "a22-restart-token" ? { tenant_id: ctx.tenantId, label: "a22-test" } : null,
    resolveWorkspaceId: async () => ctx.workspaceId,
    parseAuthorization,
  });
  const jobsResponse = await app.inject({
    method: "GET",
    url: "/api/business/attribution/import/jobs",
    headers: { authorization: "Bearer a22-restart-token" },
  });
  assert(jobsResponse.statusCode === 200, "GET /jobs after restart returns 200");
  assert(
    jobsResponse.json().jobs.some((job) => job.importId === ready.importId),
    "GET /jobs after restart includes completed import"
  );
  await app.close();
  await restartedPool.end();
  console.log(
    JSON.stringify(
      {
        ok: true,
        importId: ready.importId,
        dbRows: res.rows.length,
        survivesRestart: afterRestart.status,
        httpJobsAfterRestart: jobsResponse.statusCode,
        sample: { spend: r1.spend, entity_id: r1.entity_id, date: r1.date },
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
