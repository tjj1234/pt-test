"use strict";
const { productionSeedPolicy } = require("../../business/attribution/policy/seed");
const { parseMetaExport } = require("../../business/attribution/parsers");
const { recordValidationFailure } = require("../../business/attribution/persistence");
const { createMockPersistence } = require("../../business/attribution/persistence");
const fs = require("node:fs");
const path = require("node:path");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  assert(productionSeedPolicy({ PT_ENV: "production", PT_ALLOW_DEMO_SEED: "1" }).seedAllowed === false, "prod seed forbidden");
  assert(productionSeedPolicy({ NODE_ENV: "production" }).seedAllowed === false, "node prod forbidden");
  assert(productionSeedPolicy({}).seedAllowed === false, "default off");
  assert(productionSeedPolicy({ PT_ALLOW_DEMO_SEED: "1" }).seedAllowed === true, "explicit non-prod");

  const csv = fs.readFileSync(path.join(__dirname, "fixtures/providers/meta-ads.csv"));
  const parsed = parseMetaExport({
    buffer: csv,
    filename: "meta-ads.csv",
    workspaceId: "ws_part1",
    sourceFileId: "file_part1",
  });
  assert(parsed.ok && parsed.records.length === 3, "export parse kept");
  assert(parsed.records.every((r) => r.rawSource === "csv_export"), "file export not api");

  const repo = createMockPersistence();
  const ctx = {
    tenantId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "ws_part1",
  };
  await recordValidationFailure(repo, ctx, { event_name: "not_allowed", tenant_id: "client-injected" }, [
    { message: "不在白名单" },
  ]);
  const dlq = await repo.listDlq(ctx);
  assert(dlq.length === 1 && dlq[0].tenantId === ctx.tenantId, "collect failure uses context tenant");

  console.log(JSON.stringify({ ok: true, part1: "decisions_reconnected_not_merged" }, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
