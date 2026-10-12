"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createPgCompatPool, sha256Hex } = require("../../../analytics/lib/db.cjs");
const { buildUnifiedServer } = require("../../../analytics/backend/server");
const { insertAuditLogs } = require("../../../analytics/lib/deps.cjs");
const { createIngestionAdapter } = require("../ingestion-adapter");
const { createEventMappingStore } = require("../ingestion-adapter/mapping-store");
const { runConnectionTest } = require("../ingestion-adapter/connection-test");
const { createQualityService, qualityWindow } = require("./service");
const { buildAttributionQualityExecutor, attributionQualityToolDefinition } = require("./index");
const A = "22222222-2222-4222-8222-222222222222", B = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-12T12:00:00Z");
test("quality uses persistent tenant-scoped data, authenticated HTTP and public executor", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-quality-db-"));
  const mappingStore = createEventMappingStore({ storageDir: fs.mkdtempSync(path.join(os.tmpdir(), "pt-quality-map-")) });
  const adapter = createIngestionAdapter({ mappingStore });
  const dbOpts = { dataDir, migrationsDir: path.resolve(__dirname, "../../../analytics/backend/db"), deliveryMigrationsDir: path.resolve(__dirname, "../../../analytics/schema"), log: () => {} };
  let pool = await createPgCompatPool(dbOpts), app;
  const internalKey = "test-internal-key", secret = "quality-test-secret";
  const token = tenant => crypto.createHmac("sha256", internalKey).update(tenant).digest("hex");
  async function insert(tenant, name, user, ts = NOW) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      await client.query("INSERT INTO pt_events(tenant_id,event_id,event_name,timestamp,user_id) VALUES($1,$2,$3,$4,$5)", [tenant, crypto.randomUUID(), name, ts, user]); await client.query("COMMIT");
    } finally { client.release(); }
  }
  try {
    await insert(A, "visit", null); await insert(A, "signup", "user-A"); await insert(A, "model_call", null);
    await insert(A, "recharge", "outside-window", NOW - 40 * 86400000);
    await insert(B, "recharge", "secret-user-B");
    const eid = crypto.randomUUID();
    await insertAuditLogs(pool, A, [{event_name:"sign_up",event_id:eid,timestamp:NOW},{event_name:"sign_up",event_id:eid.toUpperCase(),timestamp:NOW},{event_name:"page_view",timestamp:NOW}]);
    await insertAuditLogs(pool, B, [{event_name:"recharge",event_id:crypto.randomUUID(),timestamp:NOW}]);
    app = buildUnifiedServer({ pool, now: () => NOW, logger: false, adapter,
      verifyAnalyticsToken: async raw => raw === "expired" ? { tenant_id:A,expires_at:NOW,scopes:["analytics:read"] } : raw === "no-scope" ? { tenant_id:A,scopes:[] } : raw === token(A) || raw === token(B) ? {tenant_id:raw === token(A)?A:B,scopes:["analytics:read"]} : null,
      resolveWorkspaceId: async tenant => "ws_" + tenant,
      loadAuditLogs: async () => [], loadConfigFindings: async () => [],
      resolveEndpoint: async id => id === "wh_quality" ? {webhook_id:id,tenant_id:A,status:"active",secret_hash:sha256Hex(secret)} : null,
      enqueue: async () => true,
    });
    const url = "/api/attribution/quality";
    for (const [raw,status] of [[null,401],["bad",403],["expired",401],["no-scope",403]]) assert.equal((await app.inject({url,headers:raw?{authorization:"Bearer "+raw}:{}})).statusCode,status);
    const headers = {authorization:"Bearer "+token(A)};
    for (const query of ["?tenantId="+B,"?from=2026-02-30","?from=2026-01-01&to=2026-10-12","?from=2026-10-13&to=2026-10-12"]) assert.equal((await app.inject({url:url+query,headers})).statusCode,400);
    const response=await app.inject({url,headers}); assert.equal(response.statusCode,200,response.body);
    const report=response.json(); assert.equal(report.outputType,"report"); assert.equal(report.schemaVersion,"report.v1");
    assert.equal(report.score.value,50); assert.equal(report.evidence.identityTotal,2); assert.equal(report.evidence.identityPresent,1);
    assert.deepEqual(report.evidence.eventCounts,{model_call:1,signup:1,visit:1});
    assert.equal(report.evidence.duplicateExtra,1); assert.equal(report.evidence.logValid,2); assert.equal(report.evidence.logTotal,3);
    assert.equal(report.stats.find(r=>r[0]==="sGTM 日志有效 ID 重复率")[1],"50.0%");
    assert.ok(report.table.rows.every(r=>r.length===4));assert.ok(report.suggestions.length);
    const renderer=require("../../../shell/public/report-render.js");
    const html=renderer.renderReportHTML(report);assert.match(html,/50/);assert.match(html,/关键事件类型覆盖率/);assert.match(html,/缺少 user_id/);
    assert.doesNotMatch(JSON.stringify(report),/secret-user-B|outside-window/);
    // 业务公开 executor → 真实统一服务 HTTP → 真实数据库（不是返回常量的接口桩）。
    await app.listen({host:"127.0.0.1",port:0});
    const dashPort=app.server.address().port;
    const execute=buildAttributionQualityExecutor({internalKey,dashPort});
    const byHttp=await execute({}, {tenantId:A});assert.equal(byHttp.score.value,50);
    const other=await execute({}, {tenantId:B});assert.deepEqual(other.evidence.eventCounts,{recharge:1});assert.equal(other.evidence.duplicateExtra,0);
    await assert.rejects(execute({tenantId:B},{tenantId:A}),/只支持/);
    await assert.rejects(execute({},{}),/trusted tenant/);
    assert.equal(attributionQualityToolDefinition().name,"attribution.quality");
    // 实际连接测试对真实 Collect：正确 secret 应通过，错误 secret 应失败。
    const probe={event_name:"visit",event_id:crypto.randomUUID(),timestamp:NOW};
    const oldHeaders=await app.inject({method:"POST",url:"/api/v1/collect/wh_quality",headers:{authorization:"Bearer "+secret,"x-webhook-secret":secret},payload:probe});assert.equal(oldHeaders.statusCode,401,"original settings headers fail against real collect");
    const good=await runConnectionTest({collectUrl:`http://127.0.0.1:${dashPort}/api/v1/collect/wh_quality`,secret,event:probe});
    assert.equal(good.ok,true,JSON.stringify(good));
    const bad=await runConnectionTest({collectUrl:`http://127.0.0.1:${dashPort}/api/v1/collect/wh_quality`,secret:"wrong",event:probe});assert.equal(bad.ok,false);assert.equal(bad.httpStatus,403);
    const raw=await runConnectionTest({collectUrl:`http://127.0.0.1:${dashPort}/api/v1/raw-collect/wh_quality`,secret,event:{event_name:"sign_up",timestamp:NOW,user_id:"u"}});assert.equal(raw.ok,true,JSON.stringify(raw));
    await app.close();app=null;
    await pool.end();pool=await createPgCompatPool(dbOpts);
    const restarted=await createQualityService({pool,now:()=>NOW})({tenantId:A,workspaceId:"ws_"+A});assert.equal(restarted.score.value,50);assert.equal(restarted.evidence.duplicateExtra,1);
    const empty=await createQualityService({pool,now:()=>NOW})({tenantId:A,workspaceId:"ws_"+A},{from:"2026-09-05",to:"2026-09-06"});assert.equal(empty.score.value,null,JSON.stringify(empty.evidence));assert.equal(empty.evidence.logTotal,0);assert.equal(empty.stats.find(r=>r[0]==="sGTM 日志有效 ID 重复率")[1],"未评估");
  } finally { if(app)await app.close();await pool.end(); }
});
test("quality date bounds and missing source fail closed",async()=>{
  assert.throws(()=>qualityWindow({from:"2026-02-30"},NOW),/日期无效/);
  await assert.rejects(createQualityService({})({tenantId:A,workspaceId:"ws"}),/未接线/);
});
test("scoring covers full template, visits-only sample, and log-only sample",()=>{
  const { buildQualityReport }=require('./service');
  const names=require('../contracts/invariants').EVENT_NAMES;
  const logs={total:0,valid_ids:0,duplicate_extra:0},window=qualityWindow({},NOW);
  const complete=buildQualityReport(names.map(event_name=>({event_name,total:1,identity_total:event_name==='visit'?0:1,identity_present:event_name==='visit'?0:1})),logs,window,new Date(NOW).toISOString());
  assert.equal(complete.score.value,100);assert.equal(complete.stats.find(r=>r[0]==='sGTM 日志有效 ID 重复率')[1],'未评估');
  const visit=buildQualityReport([{event_name:'visit',total:1,identity_total:0,identity_present:0}],logs,window,new Date(NOW).toISOString());assert.equal(visit.score.value,17);assert.equal(visit.stats.find(r=>r[0]==='登录后事件 user_id 完整率')[1],'未评估');
  const logOnly=buildQualityReport([],{total:2,valid_ids:2,duplicate_extra:1},window,new Date(NOW).toISOString());assert.equal(logOnly.score.value,null);
});
