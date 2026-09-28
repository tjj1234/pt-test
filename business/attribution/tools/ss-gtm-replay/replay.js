"use strict";
/**
 * A20 · SS-GTM 五缺陷离线回放
 *
 * 不改生产路径。对每个缺陷样例跑两条链路：
 *   1) raw_collect     — 原始体直打 Collect validate（= 未修复上游）
 *   2) a17_then_collect — A17 适配后再 validate（+ 可选 ingestOne）
 * D1 走 A17 连接测试诊断（模拟 502）。
 *
 * 用法：
 *   node business/attribution/tools/ss-gtm-replay/replay.js
 *   node business/attribution/tools/ss-gtm-replay/replay.js --json
 *   node business/attribution/tools/ss-gtm-replay/replay.js --persist   # 真入库（PGlite）
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SCENARIOS, TS } = require("./scenarios");
const baseline = require("./diagnosis-baseline.json");
const { validateEvent } = require("../../../../analytics/backend/collect/validate");
const { createIngestionAdapter } = require("../../ingestion-adapter");
const { diagnoseHttpStatus, runConnectionTest } = require("../../ingestion-adapter/connection-test");

const WS = "ws_a20_ssgtm_replay";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function loadBaselineById() {
  const map = new Map();
  for (const d of baseline.defects) map.set(d.id, d);
  return map;
}

function summarizeValidate(v) {
  if (v.ok) return { accept: true, errors: [] };
  return {
    accept: false,
    errors: (v.errors || []).map((e) => ({
      field: e.field,
      message: e.message,
    })),
    primaryField: v.errors && v.errors[0] ? v.errors[0].field : null,
  };
}

async function replayConnection(scenario, adapter) {
  const fetch502 = async () => ({
    status: scenario.simulateUpstream.status,
    text: async () => String(scenario.simulateUpstream.body || ""),
  });
  const result = await runConnectionTest({
    collectUrl: "https://collect.example/api/v1/collect/wh_a20",
    secret: "replay-secret",
    event: scenario.probeEvent,
    fetch: fetch502,
  });
  const diag = result.diagnosis || diagnoseHttpStatus(502, "Bad Gateway");
  return {
    kind: "connection",
    raw_collect: {
      accept: false,
      diagnosis_code: diag.code,
      httpStatus: diag.httpStatus || 502,
    },
    a17_then_collect: {
      // A17 无法修复 502，只能诊断
      accept: false,
      diagnosis_code: diag.code,
      title: diag.title,
      hint: diag.hint,
    },
    persisted: null,
  };
}

async function replayEvent(scenario, adapter, opts) {
  const raw = scenario.raw;
  const rawV = summarizeValidate(validateEvent(raw));

  if (scenario.mapping) {
    adapter.putMapping(WS, scenario.mapping);
  }

  const adapted = adapter.adapt(WS, raw, { receivedAtMs: TS });
  let a17 = {
    adapt_ok: adapted.ok,
    ignored: Boolean(adapted.ignored),
    unmapped: Boolean(adapted.quality && adapted.quality.unmapped),
    reason: adapted.reason || null,
    error: adapted.error || null,
    quality: adapted.quality || null,
    accept: false,
    persisted: false,
  };

  if (adapted.ok && adapted.event) {
    const v = summarizeValidate(validateEvent(adapted.event));
    a17.accept = v.accept;
    a17.collect_errors = v.errors;
    a17.event_name = adapted.event.event_name;
    a17.event_id = adapted.event.event_id;
    a17.timestamp = adapted.event.timestamp;
    a17.event_id_source = adapted.quality && adapted.quality.event_id_source;
    a17.timestamp_source = adapted.quality && adapted.quality.timestamp_source;

    if (v.accept && opts.persist && opts.ingestOne && opts.pool) {
      const res = await opts.ingestOne(opts.pool, {
        tenant_id: TENANT,
        webhook_id: "a20_ssgtm_replay",
        event: adapted.event,
      });
      a17.persisted = Boolean(res && res.inserted);
    }
  }

  return {
    kind: "event",
    raw_collect: {
      accept: rawV.accept,
      primaryField: rawV.primaryField,
      errors: rawV.errors,
    },
    a17_then_collect: a17,
  };
}

function compareToBaseline(defectId, observed, baseMap) {
  const base = baseMap.get(defectId);
  if (!base) return { matched: false, reason: "baseline missing" };

  const checks = [];
  const u = base.unrepaired;
  const m = base.platform_mitigated_a17;

  if (defectId === "D1_502_gateway") {
    const rawCode = observed.raw_collect.diagnosis_code;
    const a17Code = observed.a17_then_collect.diagnosis_code;
    checks.push({
      name: "unrepaired.diagnosis_code",
      expected: u.diagnosis_code,
      actual: rawCode,
      ok: rawCode === u.diagnosis_code,
    });
    checks.push({
      name: "platform_mitigated.diagnosis_code",
      expected: m.diagnosis_code,
      actual: a17Code,
      ok: a17Code === m.diagnosis_code,
    });
    checks.push({
      name: "unrepaired.collect_accept",
      expected: u.collect_accept,
      actual: observed.raw_collect.accept,
      ok: observed.raw_collect.accept === u.collect_accept,
    });
  } else {
    checks.push({
      name: "unrepaired.collect_accept",
      expected: u.collect_accept,
      actual: observed.raw_collect.accept,
      ok: observed.raw_collect.accept === u.collect_accept,
    });
    if (u.collect_error_field) {
      checks.push({
        name: "unrepaired.collect_error_field",
        expected: u.collect_error_field,
        actual: observed.raw_collect.primaryField,
        ok: observed.raw_collect.primaryField === u.collect_error_field,
      });
    }
    checks.push({
      name: "platform_mitigated.collect_accept",
      expected: m.collect_accept,
      actual: observed.a17_then_collect.accept,
      ok: observed.a17_then_collect.accept === m.collect_accept,
    });
    if (m.mapped_to) {
      checks.push({
        name: "platform_mitigated.mapped_to",
        expected: m.mapped_to,
        actual: observed.a17_then_collect.event_name,
        ok: observed.a17_then_collect.event_name === m.mapped_to,
      });
    }
    if (m.event_id_source) {
      checks.push({
        name: "platform_mitigated.event_id_source",
        expected: m.event_id_source,
        actual: observed.a17_then_collect.event_id_source,
        ok: observed.a17_then_collect.event_id_source === m.event_id_source,
      });
    }
    if (m.timestamp_source) {
      checks.push({
        name: "platform_mitigated.timestamp_source",
        expected: m.timestamp_source,
        actual: observed.a17_then_collect.timestamp_source,
        ok: observed.a17_then_collect.timestamp_source === m.timestamp_source,
      });
    }
  }

  const matched = checks.every((c) => c.ok);
  return { matched, checks, baselineNotes: { unrepaired: u.note, mitigated: m.note } };
}

function formatTextReport(report) {
  const lines = [];
  lines.push("# SS-GTM 五缺陷离线回放报告（A20）");
  lines.push("");
  lines.push(`生成时间: ${report.generatedAt}`);
  lines.push(`基线对照: diagnosis-baseline.json（§6）`);
  lines.push(`基线匹配: ${report.baselineMatched ? "全部一致 ✓" : "存在偏差 ✗"}`);
  lines.push("");
  lines.push("| 缺陷 | 未修复(raw→Collect) | A17缓解后 | 与§6基线 |");
  lines.push("|---|---|---|---|");
  for (const row of report.scenarios) {
    const raw = row.observed.raw_collect;
    const a17 = row.observed.a17_then_collect;
    let rawCell;
    let a17Cell;
    if (row.kind === "connection") {
      rawCell = `${raw.diagnosis_code} / accept=${raw.accept}`;
      a17Cell = `${a17.diagnosis_code} / accept=${a17.accept}`;
    } else {
      rawCell = raw.accept
        ? "ACCEPT"
        : `REJECT(${raw.primaryField || "?"})`;
      a17Cell = a17.accept
        ? `ACCEPT${a17.persisted ? "+INGESTED" : ""}${a17.event_id_source ? " id=" + a17.event_id_source : ""}${a17.timestamp_source ? " ts=" + a17.timestamp_source : ""}`
        : `REJECT(${a17.reason || (a17.error && a17.error.code) || "?"})`;
    }
    lines.push(
      `| ${row.id} ${row.title} | ${rawCell} | ${a17Cell} | ${row.baseline.matched ? "✓" : "✗"} |`
    );
  }
  lines.push("");
  lines.push("## 说明");
  lines.push("- **未修复**：原始 SS-GTM 样例直打 Collect 三件套（反映上游缺陷现状）");
  lines.push("- **A17 缓解**：经工作区映射 + event_id/timestamp 兜底后再校验（平台侧已具备的能力）");
  lines.push("- **上游修好后**：重跑本工具；当 raw→Collect 也变为 ACCEPT（D1 为 diagnosis OK）即确认修复");
  lines.push("");
  if (!report.baselineMatched) {
    lines.push("## 基线偏差明细");
    for (const row of report.scenarios) {
      if (row.baseline.matched) continue;
      lines.push(`### ${row.id}`);
      for (const c of row.baseline.checks) {
        if (c.ok) continue;
        lines.push(`- ${c.name}: expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`);
      }
    }
  }
  return lines.join("\n");
}

async function runReplay(opts = {}) {
  const mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a20-maps-"));
  const adapter = createIngestionAdapter({ storageDir: mapDir });
  const baseMap = loadBaselineById();

  let pool = null;
  let ingestOne = null;
  if (opts.persist) {
    const { createPgCompatPool } = require("../../../../analytics/lib/db.cjs");
    ingestOne = require("../../../../analytics/backend/collect/ingest").ingestOne;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a20-db-"));
    pool = await createPgCompatPool({
      dataDir,
      migrationsDir: path.join(__dirname, "../../../../analytics/backend/db"),
      deliveryMigrationsDir: path.join(__dirname, "../../../../analytics/schema"),
      recoverStalePidFile: true,
      log: () => {},
    });
  }

  const scenarios = [];
  try {
    for (const sc of SCENARIOS) {
      let observed;
      if (sc.kind === "connection") {
        observed = await replayConnection(sc, adapter);
      } else {
        observed = await replayEvent(sc, adapter, {
          persist: Boolean(opts.persist),
          pool,
          ingestOne,
        });
      }
      const cmp = compareToBaseline(sc.id, observed, baseMap);
      scenarios.push({
        id: sc.id,
        title: sc.title,
        kind: sc.kind,
        observed,
        baseline: cmp,
      });
    }
  } finally {
    if (pool && typeof pool.end === "function") await pool.end().catch(() => {});
  }

  const report = {
    ok: scenarios.every((s) => s.baseline.matched),
    baselineMatched: scenarios.every((s) => s.baseline.matched),
    generatedAt: new Date().toISOString(),
    workspaceId: WS,
    persist: Boolean(opts.persist),
    baselineDoc: baseline.$id,
    scenarios,
  };
  report.text = formatTextReport(report);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const persist = args.includes("--persist");
  const report = await runReplay({ persist });
  if (asJson) {
    const { text, ...rest } = report;
    console.log(JSON.stringify({ ...rest, text }, null, 2));
  } else {
    console.log(report.text);
    console.log("");
    console.log(JSON.stringify({ ok: report.ok, baselineMatched: report.baselineMatched }, null, 2));
  }
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { runReplay, formatTextReport, compareToBaseline, SCENARIOS, baseline };
