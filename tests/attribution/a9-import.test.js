"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createImportService } = require("../../business/attribution/import");
const { createPgCompatPool } = require("../../analytics/lib/db.cjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a9-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a9-state-db-"));
  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });
  const inserted = [];
  const upsertDailyMetric = async (_client, row) => {
    inserted.push(row);
  };
  const svc = createImportService({ storageDir: dir, pool, upsertDailyMetric });
  const ctx = {
    tenantId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "ws_a9",
  };
  const csv = fs.readFileSync(
    path.join(__dirname, "fixtures/providers/meta-ads.csv")
  );

  let blocked = false;
  try {
    await svc.createAndValidate({ tenantId: ctx.tenantId }, { provider: "meta", buffer: csv });
  } catch (e) {
    blocked = e.code === "CONTEXT_REQUIRED";
  }
  assert(blocked, "context required");

  const ready = await svc.createAndValidate(ctx, {
    provider: "meta",
    originalName: "meta-ads.csv",
    buffer: csv,
  });
  assert(ready.status === "ready", "status ready after validate, got " + ready.status);
  assert(ready.provider === "meta", "provider");
  assert(ready.workspaceId === "ws_a9", "workspace from context");
  assert(!("tenantId" in ready), "tenant not in public job");

  const done = await svc.confirmImport(ctx, ready.importId);
  assert(done.status === "completed", "completed got " + done.status);
  assert(done.successRows === 3, "3 rows");
  assert(done.failedRows === 0, "no fails");
  assert(inserted.length === 3, "upsert called 3 times");
  assert(inserted.every((r) => r.level === "creative"), "creative level");
  assert(inserted.some((r) => r.entityId === "ad_9001" && Number(r.spend) === 120.5), "spend mapped");

  const listed = await svc.listJobs(ctx);
  assert(listed.length >= 1, "list");

  // reject client tenant in routes is covered by routes; service ignores body tenant
  console.log(
    JSON.stringify(
      {
        ok: true,
        importId: ready.importId,
        status: done.status,
        successRows: done.successRows,
        upserted: inserted.length,
      },
      null,
      2
    )
  );
  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
