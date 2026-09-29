"use strict";
/**
 * A20 验收：未修复原始样例回放报告与 diagnosis-baseline §6 一致。
 */
const { runReplay } = require("../../business/attribution/tools/ss-gtm-replay/replay");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const report = await runReplay({ persist: true });
  assert(report.baselineMatched, "报告应与 §6 基线一致");
  assert(report.scenarios.length === 5, "五个缺陷场景");

  const byId = Object.fromEntries(report.scenarios.map((s) => [s.id, s]));

  assert(byId.D1_502_gateway.observed.raw_collect.diagnosis_code === "TARGET_BAD_GATEWAY", "D1");
  assert(byId.D2_event_name_case.observed.raw_collect.accept === false, "D2 raw reject");
  assert(byId.D2_event_name_case.observed.a17_then_collect.accept === true, "D2 a17 accept");
  assert(byId.D2_event_name_case.observed.a17_then_collect.event_name === "visit", "D2 mapped");
  assert(byId.D3_event_id_non_uuid.observed.raw_collect.primaryField === "event_id", "D3 field");
  assert(byId.D3_event_id_non_uuid.observed.a17_then_collect.event_id_source === "adapter_fallback", "D3 fallback");
  assert(byId.D4_missing_timestamp.observed.a17_then_collect.timestamp_source === "received_at_fallback", "D4 ts");
  assert(byId.D5_missing_event_id.observed.a17_then_collect.persisted === true, "D5 ingested");

  console.log(report.text);
  console.log(JSON.stringify({ ok: true, baselineMatched: true, persistedD5: true }, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
