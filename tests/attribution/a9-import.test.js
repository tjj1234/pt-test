"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createImportService } = require("../../business/attribution/import");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a9-"));
  // 轻量 pool：把 upsert 写入收集器，避免本用例依赖真库；落库真表见 a9-import-persist.test.js
  const inserted = [];
  const pool = {
    async connect() {
      return {
        async query() {
          return { rows: [] };
        },
        release() {},
      };
    },
    async query() {
      return { rows: [] };
    },
  };
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

  const listed = svc.listJobs(ctx);
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
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
