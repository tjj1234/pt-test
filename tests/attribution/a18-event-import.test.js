"use strict";
/**
 * A18 验收：含正确行 + 故意出错行的 CSV → 校验+导入；
 * 错误行有清晰原因；正确行经 A17 映射后落库可查。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPgCompatPool } = require("../../analytics/lib/db.cjs");
const { createEventImportService } = require("../../business/attribution/import");
const { createIngestionAdapter } = require("../../business/attribution/ingestion-adapter");

const TENANT = "33333333-3333-4333-8333-333333333333";
const WS = "ws_a18";
const FIX = path.join(__dirname, "fixtures/events/sample-mixed.csv");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a18-db-"));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a18-files-"));
  const mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a18-maps-"));

  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });

  const adapter = createIngestionAdapter({ storageDir: mapDir });
  adapter.putMapping(WS, {
    page_view: "visit",
    CompleteRegistration: "signup",
  });

  const svc = createEventImportService({
    pool,
    storageDir,
    adapter,
  });

  const ctx = { tenantId: TENANT, workspaceId: WS, actorId: "a18-test" };
  const buf = fs.readFileSync(FIX);

  const preview = await svc.createAndValidate(ctx, {
    originalName: "sample-mixed.csv",
    buffer: buf,
  });
  assert(preview.status === "ready", "preview ready got " + preview.status);
  assert(preview.rowCount === 7, "7 data rows got " + preview.rowCount);
  assert(preview.failedRows >= 2, "结构失败行（空 event_name / 空 user_id / 坏时间）");
  assert(
    (preview.errorDetails || []).some((e) => e.field === "event_name" || /event_name/.test(e.reason)),
    "空 event_name 有原因"
  );
  assert(
    (preview.errorDetails || []).some((e) => e.field === "user_id" || /user_id/.test(e.reason)),
    "空 user_id 有原因"
  );
  assert(
    (preview.errorDetails || []).some((e) => e.field === "event_time" || /event_time/.test(e.reason)),
    "坏 event_time 有原因"
  );

  const confirmed = await svc.confirmImport(ctx, preview.importId);
  assert(
    confirmed.status === "partial_failed" || confirmed.status === "completed",
    "confirm status " + confirmed.status
  );
  assert(confirmed.persistedRows >= 3, "至少 3 行落库（visit/signup/recharge），got " + confirmed.persistedRows);
  assert(
    (confirmed.errorDetails || []).some(
      (e) => /未映射|UNMAPPED|weird_custom/i.test(e.reason || "")
    ),
    "未映射事件名应出现在错误详情（走 A17）"
  );

  const client = await pool.connect();
  let rows;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
    const res = await client.query(
      `SELECT event_name, user_id, utm_content
       FROM pt_events
       WHERE tenant_id = $1::uuid
       ORDER BY timestamp ASC`,
      [TENANT]
    );
    rows = res.rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const names = rows.map((r) => r.event_name);
  assert(names.includes("visit"), "page_view → visit via A17");
  assert(names.includes("signup"), "CompleteRegistration → signup via A17");
  assert(names.includes("recharge"), "recharge persisted");
  assert(!names.includes("page_view"), "raw page_view 不应原样入库");
  assert(!names.includes("weird_custom"), "未映射不得入库");

  console.log(
    JSON.stringify(
      {
        ok: true,
        preview: {
          status: preview.status,
          rowCount: preview.rowCount,
          successRows: preview.successRows,
          failedRows: preview.failedRows,
          errorFields: [...new Set((preview.errorDetails || []).map((e) => e.field))],
        },
        confirm: {
          status: confirmed.status,
          persistedRows: confirmed.persistedRows,
          failedRows: confirmed.failedRows,
          ignoredRows: confirmed.ignoredRows,
        },
        dbEventNames: names,
      },
      null,
      2
    )
  );

  await pool.end().catch(() => {});
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
