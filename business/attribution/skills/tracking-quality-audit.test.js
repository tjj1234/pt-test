"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createIngestionAdapter } = require("../ingestion-adapter");
const { buildTrackingQualityReport, callTrackingQualityAudit, registerTrackingQualityAuditTool, trackingQualityAuditToolDefinition } = require("./tracking-quality-audit");
const shellTools = require("../../../shell/tools/registry.cjs");
const { setDb } = require("../../../shell/permissions/index.cjs");
const dbmod = require("../../../shell/db.cjs");
const { initToolCalls } = require("../../../shell/tool-calls.cjs");
const Ajv = require("../../../analytics/node_modules/ajv");
const addFormats = require("../../../analytics/node_modules/ajv-formats");
const ajv = new Ajv(); addFormats(ajv);
const validReport = ajv.compile(require("../contracts/tracking-quality-report.json"));
const validArgs = ajv.compile(trackingQualityAuditToolDefinition().inputSchema);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill2-audit-"));
const adapter = createIngestionAdapter({ storageDir: path.join(tmp, "mappings") });
function native(event_name) { return { event_name, event_id: crypto.randomUUID(), timestamp: 1750000000000 }; }

// Fixture events flow through the same real adapter used by U6, not fabricated counters.
test("report projects actual adaptation counters and avoids unsupported conclusions", () => {
  const ws = "quality-a"; adapter.putMapping(ws, { noise_ping: "ignore", Registered: "signup" });
  adapter.adaptMany(ws, [native("visit"), { event_name: "model_call" }, { event_name: "unknown" }, { event_name: "noise_ping" }, native("Registered")]);
  const before = adapter.getQualityStats(ws);
  const report = buildTrackingQualityReport(before, ws, "2026-10-08T00:00:00.000Z");
  assert(validReport(report), JSON.stringify(validReport.errors));
  assert.deepEqual(report.source.snapshot, before);
  assert.equal(report.scoreBar.value, 70);
  assert.deepEqual(report.kv.slice(0, 8).map(k => k.value), [5, 3, 1, 1, 2, 1, 1, 1]);
  assert.deepEqual(report.issuesTable.rows.map(i => i.id), ["unmapped_events", "fallback_event_id", "fallback_timestamp"]);
  assert.equal(report.coverage.status, "not_assessed");
  assert(report.recommendations.some(r => r.action.includes("recharge")));
  assert.deepEqual(adapter.getQualityStats(ws), before);
});
test("empty, ignored-only and unmapped-only workspaces do not receive a false healthy score", () => {
  for (const mode of ["empty", "ignored", "unmapped"]) {
    const ws = "quality-" + mode;
    if (mode === "ignored") { adapter.putMapping(ws, { ping: "ignore" }); adapter.adapt(ws, { event_name: "ping" }); }
    if (mode === "unmapped") adapter.adapt(ws, { event_name: "unknown" });
    const r = buildTrackingQualityReport(adapter.getQualityStats(ws), ws);
    assert(validReport(r), JSON.stringify(validReport.errors)); assert.equal(r.scoreBar.value, null);
    assert.equal(r.scoreBar.status, "insufficient_data");
    assert(r.issuesTable.rows.some(i => i.id === "insufficient_data"));
  }
});
test("ignored traffic does not dilute or penalize the score; worst assessed case stays bounded", () => {
  const ws = "quality-healthy"; adapter.putMapping(ws, { ping: "ignore" });
  adapter.adapt(ws, native("signup")); for (let i = 0; i < 20; i++) adapter.adapt(ws, { event_name: "ping" });
  const good = buildTrackingQualityReport(adapter.getQualityStats(ws), ws); assert.equal(good.scoreBar.value, 100); assert.equal(good.issuesTable.rows.length, 0);
  adapter.adapt("quality-bad", { event_name: "visit" });
  const bad = buildTrackingQualityReport(adapter.getQualityStats("quality-bad"), "quality-bad");assert.equal(bad.scoreBar.value, 40);
  assert.equal(good.coverage.status, "not_assessed");
});
test("reject malformed, inconsistent or cross-workspace snapshots and unsupported input", () => {
  const snap = adapter.getQualityStats("quality-a");
  assert.throws(() => buildTrackingQualityReport({ ...snap, eventIdQuality: { ...snap.eventIdQuality, client_native_ratio: 1 } }, snap.workspaceId), { code: "BAD_QUALITY_SNAPSHOT" });
  assert.throws(() => buildTrackingQualityReport(snap, "other"), { code: "QUALITY_SCOPE_MISMATCH" });
  assert.throws(() => buildTrackingQualityReport({ ...snap, totalAdapted: -1 }, snap.workspaceId), { code: "BAD_QUALITY_SNAPSHOT" });
  assert.throws(() => buildTrackingQualityReport({ ...snap, ignored: 50 }, snap.workspaceId), { code: "BAD_QUALITY_SNAPSHOT" });
  assert(validArgs({})); assert(validArgs({ template: "saas_token_marketplace" })); assert(!validArgs({ workspaceId: "other" })); assert(!validArgs({ template: "universal" }));
});
test("real Shell register/execute permissions and call logs use the same live U6 snapshot without panels", async () => {
  process.env.PT_PGLITE_PATH ||= path.resolve(__dirname, "../../../analytics/node_modules/@electric-sql/pglite/dist/index.cjs");
  const { db, close } = await dbmod.open({ dataDir: path.join(tmp, "db") });
  try {
    await dbmod.migrate(db, path.resolve(__dirname, "../../../shell/db-migrations")); setDb(db);
    const tenantId = crypto.randomUUID(), otherTenant = crypto.randomUUID();
    for (const id of [tenantId, otherTenant]) await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [id, id]);
    const analyst = crypto.randomUUID(), viewer = crypto.randomUUID(), foreign = crypto.randomUUID();
    for (const [id, role, tid] of [[analyst, "analyst", tenantId], [viewer, "viewer", tenantId], [foreign, "analyst", otherTenant]]) await db.query("INSERT INTO users(id,tenant_id,username,password_hash,role) VALUES($1,$2,$3,'test-not-used',$4)", [id, tid, id, role]);
    const tc = await initToolCalls(db); shellTools.setToolCallLogger(tc);
    const ws = "quality-a", otherWs = "quality-other-tenant";adapter.adapt(otherWs, native("recharge"));
    const resolveWorkspaceId = async tid => tid === tenantId ? ws : tid === otherTenant ? otherWs : null;
    const opts = { adapter, resolveWorkspaceId, panelRegistry: { registerPanel() { throw Error("must not create panel"); } } };
    const registration = registerTrackingQualityAuditTool(opts);
    assert.equal(registration.tool.outputType, "report");assert.equal(registration.tool.riskLevel, "read");
    const ctx = { tenantId, userId: analyst, workspaceId: "ws_" + tenantId };
    const before = adapter.getQualityStats(ws);
    const list = await shellTools.listToolsForWorkspace(ctx.workspaceId, ctx); assert(list.some(t => t.name === "tracking_quality_audit" && t.outputType === "report"));
    assert(!(await shellTools.listToolsForWorkspace(ctx.workspaceId, { ...ctx, userId: viewer })).some(t => t.name === "tracking_quality_audit"));
    await assert.rejects(shellTools.executeTool("tracking_quality_audit", {}, { ...ctx, userId: viewer }), /工具调用验证失败/);
    const executed = await shellTools.executeTool("tracking_quality_audit", {}, ctx);
    assert.equal(executed.metadata.executed, true); assert(validReport(executed.result), JSON.stringify(validReport.errors));
    assert.deepEqual(executed.result.source.snapshot, before);assert.equal(executed.result.scoreBar.value, 70);
    const calls = await tc.list({ tenantId, workspaceId: ctx.workspaceId, range: "today" });assert.equal(calls.length, 1);assert.equal(calls[0].status, "completed");
    const b = await shellTools.executeTool("tracking_quality_audit", {}, { tenantId: otherTenant, userId: foreign, workspaceId: "ws_" + otherTenant });assert.equal(b.result.source.snapshot.totalAdapted, 1);assert.equal(b.result.workspaceId, otherWs);
    await assert.rejects(callTrackingQualityAudit({ ...ctx, workspaceId: otherWs }, {}, opts), { code: "WORKSPACE_MISMATCH" });
    await assert.rejects(callTrackingQualityAudit(ctx, { workspaceId: otherWs }, opts), { code: "BAD_ARGS" });
    await assert.rejects(callTrackingQualityAudit(ctx, { template: "universal" }, opts), { code: "UNSUPPORTED_TEMPLATE" });
    await assert.rejects(callTrackingQualityAudit(ctx, {}, { resolveWorkspaceId }), { code: "QUALITY_SOURCE_REQUIRED" });
    await assert.rejects(callTrackingQualityAudit(ctx, {}, { adapter }), { code: "WORKSPACE_RESOLVER_REQUIRED" });
    await assert.rejects(callTrackingQualityAudit({ tenantId, workspaceId: ws }, {}, opts), { code: "CONTEXT_REQUIRED" });
    assert.deepEqual(adapter.getQualityStats(ws), before);
    // A new real event changes the next report: the result is not a cached/mock report.
    adapter.adapt(ws, native("key_created"));const changed = await callTrackingQualityAudit(ctx, {}, opts);assert.equal(changed.source.snapshot.totalAdapted, 6);assert.equal(changed.scoreBar.value, 77);
    fs.writeFileSync(path.join(tmp, "real-report.json"), JSON.stringify(changed, null, 2));
    console.log("Skill-2 actual adapter report artifact: " + path.join(tmp, "real-report.json"));
  } finally { shellTools.setToolCallLogger(null); await close(); }
});
