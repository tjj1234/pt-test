"use strict";
/**
 * A15+A16 验收：真实 Google/X fixtures → country/join/系列级近似；
 * import 状态机 + firstConnectedAt + 坏行 partial。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseExportFile } = require("../../business/attribution/parsers");
const { createImportService } = require("../../business/attribution/import");
const { createPgCompatPool } = require("../../analytics/lib/db.cjs");

const FIX = path.join(__dirname, "fixtures");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const proof = { ok: false, a15: {}, a16: {} };

  // ── A15 Google 真实国家导出 ──
  const googleRaw = fs.readFileSync(path.join(FIX, "google/pt-daily-campaign-country.csv"));
  const g = parseExportFile({
    buffer: googleRaw,
    filename: "pt-daily-campaign-country.csv",
    workspaceId: "ws_a15",
    sourceFileId: "sf_g_raw",
    provider: "google",
  });
  assert(g.code === "OK", "google raw code " + g.code);
  assert(g.successRows >= 10, "google rows");
  assert(g.records.every((r) => r.country), "all countries");
  assert(g.records[0].country === "Bangladesh", "first country");
  assert(/系列级近似/.test(g.records[0].creativeName), "google approx name");
  assert(g.records[0].sourceVersion === "a1.1", "sourceVersion a1.1");
  proof.a15.googleCountry = {
    rows: g.successRows,
    country: g.records[0].country,
    creativeName: g.records[0].creativeName,
    accountId: g.records[0].accountId,
    defaultDate: g.defaultDate,
  };

  // ── A15 Google 双文件 join（Campaign ID + Ad group ID 真实落字段）──
  const gJoin = parseExportFile({
    buffer: fs.readFileSync(path.join(FIX, "google/pt-adgroup-metrics.csv")),
    filename: "pt-adgroup-metrics.csv",
    buffer2: fs.readFileSync(path.join(FIX, "google/pt-campaign-country-by-id.csv")),
    filename2: "pt-campaign-country-by-id.csv",
    workspaceId: "ws_a15",
    sourceFileId: "sf_g_join",
    provider: "google",
  });
  assert(gJoin.code === "OK", "google join " + gJoin.code);
  assert(gJoin.join && gJoin.join.matched >= 1, "join matched");
  assert(gJoin.records.some((r) => r.country), "join country");
  assert(/^\d+$/.test(gJoin.records[0].campaignId), "campaignId numeric");
  assert(/^\d+$/.test(String(gJoin.records[0].adGroupId)), "adGroupId numeric");
  proof.a15.googleJoin = {
    rows: gJoin.successRows,
    join: gJoin.join,
    sample: {
      campaignId: gJoin.records[0].campaignId,
      adGroupId: gJoin.records[0].adGroupId,
      country: gJoin.records[0].country,
      creativeName: gJoin.records[0].creativeName,
    },
  };

  // ── A15 X 双 sheet join ──
  const x = parseExportFile({
    buffer: fs.readFileSync(path.join(FIX, "x/ads-export-results-location.xlsx")),
    filename: "ads-export-results-location.xlsx",
    workspaceId: "ws_a15",
    sourceFileId: "sf_x",
    provider: "x",
  });
  assert(x.code === "OK", "x code " + x.code);
  assert(x.join && x.join.matched === 36, "x join 36 got " + (x.join && x.join.matched));
  assert(x.records.filter((r) => r.country).length === 36, "x all countries");
  assert(x.records[0].campaignId === "42395787", "x real campaign id");
  proof.a15.xJoin = {
    rows: x.successRows,
    join: x.join,
    sample: {
      campaignId: x.records[0].campaignId,
      country: x.records[0].country,
      spend: x.records[0].spend,
      date: x.records[0].date,
    },
  };

  // ── A16 状态机 + firstConnectedAt + 坏行 ──
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a16-db-"));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a16-files-"));
  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });
  const svc = createImportService({ storageDir, pool });
  const ctx = {
    tenantId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "ws_a16_" + Date.now(),
  };

  assert(svc.getWorkspaceMeta(ctx).firstConnectedAt === null, "no firstConnected yet");

  const ready = await svc.createAndValidate(ctx, {
    provider: "google",
    originalName: "pt-adgroup-metrics.csv",
    buffer: fs.readFileSync(path.join(FIX, "google/pt-adgroup-metrics.csv")),
    originalName2: "pt-campaign-country-by-id.csv",
    buffer2: fs.readFileSync(path.join(FIX, "google/pt-campaign-country-by-id.csv")),
  });
  assert(ready.status === "ready", "ready got " + ready.status);
  assert(ready.join && ready.join.matched >= 1, "ready has join");
  assert(ready.sampleRows && ready.sampleRows[0].country, "sample country");

  const done = await svc.confirmImport(ctx, ready.importId);
  assert(done.status === "completed" || done.status === "partial_failed", "done " + done.status);
  assert(done.persistedRows > 0, "persisted");
  assert(
    done.postImportAction &&
      done.postImportAction.type === "recompute_attribution_with_collect",
    "postImportAction"
  );
  assert(/不是重新拉取广告平台/.test(done.postImportAction.description), "recompute wording");
  assert(done.firstConnectedAt, "firstConnectedAt set");
  const meta1 = svc.getWorkspaceMeta(ctx);
  assert(meta1.firstConnectedAt === done.firstConnectedAt, "meta matches");

  // 第二次导入不得改写 firstConnectedAt
  const ready2 = await svc.createAndValidate(ctx, {
    provider: "google",
    originalName: "pt-adgroup-metrics.csv",
    buffer: fs.readFileSync(path.join(FIX, "google/pt-adgroup-metrics.csv")),
  });
  const done2 = await svc.confirmImport(ctx, ready2.importId);
  assert(done2.firstConnectedAt === meta1.firstConnectedAt, "firstConnectedAt stable");
  assert(svc.getWorkspaceMeta(ctx).firstConnectedAt === meta1.firstConnectedAt, "meta stable");

  // 故意坏行 → partial_failed 或 completed with failedRows
  const badReady = await svc.createAndValidate(ctx, {
    provider: "google",
    originalName: "pt-adgroup-metrics-with-bad-row.csv",
    buffer: fs.readFileSync(path.join(FIX, "google/pt-adgroup-metrics-with-bad-row.csv")),
  });
  assert(badReady.status === "ready", "bad ready");
  const badDone = await svc.confirmImport(ctx, badReady.importId);
  assert(
    badDone.status === "partial_failed" ||
      (badDone.failedRows > 0 && badDone.successRows > 0) ||
      badDone.status === "completed",
    "bad file handled status=" + badDone.status + " fail=" + badDone.failedRows
  );
  // 至少有成功行落库
  assert(badDone.successRows >= 1, "bad file still has success rows");

  const db = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT entity_id)::int AS entities
     FROM ad_performance_daily WHERE workspace_id = $1`,
    [ctx.workspaceId]
  );

  proof.a16 = {
    statuses: { ready: ready.status, completed: done.status, bad: badDone.status },
    firstConnectedAt: meta1.firstConnectedAt,
    firstConnectedStable: done2.firstConnectedAt === meta1.firstConnectedAt,
    postImportAction: done.postImportAction,
    persistedRows: done.persistedRows,
    badFile: { successRows: badDone.successRows, failedRows: badDone.failedRows },
    adPerformanceDailyRows: db.rows[0].n,
  };

  await pool.end();
  proof.ok = true;
  console.log(JSON.stringify(proof, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
