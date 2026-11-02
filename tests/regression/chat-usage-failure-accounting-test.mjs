import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function freePort() {
  const listener = createNetServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function waitForClose(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not exit")), timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(true); });
  });
}

test("successful, failed and stopped model runs preserve observed usage evidence", { timeout: 30_000 }, async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false, "No external PostgreSQL configuration is allowed");
  const runtimeWorkspaces = path.join(root, "shell/runtime/workspaces");
  let temp;
  let dbDir;
  let masterKeyFile;
  let port;
  let origin;
  let shutdownToken;
  let child;
  let storage;
  let tenantId;
  let output = "";
  try {
    temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "northstar-chat-failure-usage-"));
    dbDir = path.join(temp, "db");
    masterKeyFile = path.join(temp, "master.key");
    port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    shutdownToken = `fixture-${crypto.randomBytes(16).toString("hex")}`;
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({ username: `failure-usage-${crypto.randomUUID()}`, password: "FixturePass123" });
    assert.equal(registered.ok, true);
    const user = registered.user;
    tenantId = user.tenant_id;
    const workspacePaths = [path.join(runtimeWorkspaces, tenantId), path.join(runtimeWorkspaces, `ws_${tenantId}`)];
    assert.ok(workspacePaths.every((entry) => !fs.existsSync(entry)), "fixture tenant workspace paths must not pre-exist");
    const token = crypto.randomBytes(32).toString("hex");
    await storage.db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", [
      user.id,
      crypto.createHash("sha256").update(token).digest("hex"),
      new Date(Date.now() + 120_000).toISOString(),
    ]);
    const conversation = await storage.repositories.conversations.create(user.id);
    await require("../../shell/usage/price-catalog-store.cjs").createTextPriceCatalogStore(storage.db).importCatalog({
      reviewed: true, sourceEvidence: "Offline integration fixture; not a real price capture.",
      snapshots: [{ sourceUrl: "https://powertokens.ai/pricing", model: "fixture-model", version: "http-fixture-v1",
        capturedAt: "2020-01-01T00:00:00Z", effectiveFrom: "2020-01-01T00:00:00Z", effectiveUntil: null,
        currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 1 }],
    });
    await storage.close();
    storage = null;

    const preload = path.join(temp, "fixture-preload.cjs");
    const usageRetryMarker = path.join(temp, "usage-retry.injected");
    const usageAckLossMarker = path.join(temp, "usage-ack-loss.injected");
    const providerRunCallsFile = path.join(temp, "provider-run-calls.log");
    const persistentUsageFailureFile = path.join(temp, "usage-persistent-failure.log");
    const logDir = path.join(temp, "logs");
    fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load; let fixtureRun=0,usageFailureInjected=false,usageAckLossInjected=false;
Module._load=function(name,parent){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>["fixture-model"]};

if(parent?.filename.endsWith('/server.cjs')&&name==='./tool-calls.cjs')return {...loaded,initToolCalls:async(...args)=>{const instance=await loaded.initToolCalls(...args);return {...instance,logUsage:async(entry)=>{if(process.env.PT_TEST_USAGE_FAIL_ONCE_FILE&&!usageFailureInjected&&entry.runId&&entry.usageEvidence){usageFailureInjected=true;require('node:fs').writeFileSync(process.env.PT_TEST_USAGE_FAIL_ONCE_FILE,'injected');throw Object.assign(new Error('fixture transient storage interruption'),{code:'08006'});}if(process.env.PT_TEST_USAGE_ACK_LOSS_FILE&&!usageAckLossInjected&&entry.usageEvidence?.responses?.some(row=>row.responseSeq===23)){usageAckLossInjected=true;await instance.logUsage(entry);require('node:fs').writeFileSync(process.env.PT_TEST_USAGE_ACK_LOSS_FILE,'commit-succeeded-ack-lost');throw Object.assign(new Error('fixture commit acknowledgement lost'),{code:'08006'});}if(entry.usageEvidence?.responses?.some(row=>row.responseSeq===29)){require('node:fs').appendFileSync(process.env.PT_TEST_USAGE_PERSISTENT_FILE,'failed-attempt\\n');throw Object.assign(new Error('fixture persistent storage interruption'),{code:'08006'});}return instance.logUsage(entry);}}}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...loaded,getCatalog:async()=>({models:[{id:'fixture-model',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],availability:{status:'available',modelIds:['fixture-model']},syncedAt:Date.now()}),routeModelFor:()=> 'fixture-model',pickDefaultModel:()=> 'fixture-model'};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async(userId,question,options)=>{fixtureRun++;if(process.env.PT_TEST_RUN_CALLS_FILE)require('node:fs').appendFileSync(process.env.PT_TEST_RUN_CALLS_FILE,'provider-run\\n');if(fixtureRun===1)return {ok:false,error:'fixture model failed after tools',code:'FIXTURE_MODEL_FAILED',text:'',steps:[{name:'fixture.success',args:{},result:{ok:true},isError:false,modelName:'fixture-model'},{name:'fixture.failure',args:{},result:'controlled tool failure',isError:true,modelName:'fixture-model'}],usage:{inputTokens:7,outputTokens:2,totalTokens:9},usageEvidence:{observedResponses:1,coverage:'partial',responses:[{responseSeq:17,usage:{inputTokens:7,outputTokens:2,cacheReadTokens:null,cacheWriteTokens:null}}]}};if(fixtureRun===2)return {ok:false,stopped:true,stopReason:'timeout',error:'fixture timeout',text:'',steps:[{name:'fixture.stop_success',args:{},result:{ok:true},isError:false,modelName:'fixture-model'},{name:'fixture.stop_failure',args:{},result:'controlled tool failure',isError:true,modelName:'fixture-model'}]};const responseSeq=fixtureRun===3?23:29;const responses=fixtureRun===3?[{responseSeq:23,usage:{inputTokens:11,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:1}},{responseSeq:25,usage:{inputTokens:13,outputTokens:5,cacheReadTokens:3,cacheWriteTokens:2}}]:[{responseSeq,usage:{inputTokens:11,outputTokens:4,cacheReadTokens:null,cacheWriteTokens:null}}];if(fixtureRun===3)for(const step of [1,2])await options.onToolRequest({name:'northstar.model_request_intent',requestId:require('node:crypto').randomUUID(),args:{model:'fixture-model',provider:'fixture',turn:1,step,maxTokens:128}});return {ok:true,modelIdentity:{responses:responses.map((row,index)=>({responseSeq:row.responseSeq,configuredModelId:'fixture-model',providerReportedModelId:null,turn:1,step:index+1}))},text:'fixture success',steps:[],usage:{inputTokens:fixtureRun===3?24:11,outputTokens:fixtureRun===3?9:4,totalTokens:fixtureRun===3?41:15},usageEvidence:{totalSemantics:'dsh_pi_ai_disjoint_0_1_1_rc_2',observedResponses:responses.length,coverage:fixtureRun===3?'complete':'partial',responses}}}};
return loaded;};`);
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: path.join(temp, "home"),
      TMPDIR: path.join(temp, "tmp"),
      TEMP: path.join(temp, "tmp"),
      TMP: path.join(temp, "tmp"),
      LANG: "C",
      PT_DB_DIR: dbDir,
      PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: logDir,
      PT_SHELL_PORT: String(port),
      PT_LISTEN_HOST: "127.0.0.1",
      PT_TEST_SHUTDOWN_TOKEN: shutdownToken,
      PT_TEST_USAGE_FAIL_ONCE_FILE: usageRetryMarker,
      PT_TEST_USAGE_ACK_LOSS_FILE: usageAckLossMarker,
      PT_TEST_RUN_CALLS_FILE: providerRunCallsFile,
      PT_TEST_USAGE_PERSISTENT_FILE: persistentUsageFailureFile,
      PT_KEY_LIVE_VERIFY: "0",
      PT_RUNS_GLOBAL: "1",
      PT_RUNS_PER_USER: "1",
      PT_HEARTBEAT_ENABLED: "0",
    };
    for (const directory of [env.HOME, env.TMPDIR, env.PT_LOG_DIR]) fs.mkdirSync(directory, { recursive: true });
    child = spawn(process.execPath, ["--require", preload, "shell/server.cjs", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        if ((await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
      } catch { /* wait for the loopback server */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, `fixture server did not start: ${output.slice(-2500)}`);

    const headers = { Cookie: `pt_session=${token}`, "Content-Type": "application/json" };
    const keyResponse = await fetch(origin + "/api/auth/key", { method: "POST", headers, body: JSON.stringify({ key: "fixture-no-provider-key" }) });
    assert.equal(keyResponse.status, 200, await keyResponse.text());
    const response = await fetch(origin + "/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: conversation.id, idempotencyKey: "failure-accounting-run", message: "controlled failure accounting" }),
    });
    assert.equal(response.status, 200, output.slice(-2500));
    const runId = response.headers.get("x-agent-run-id");
    assert.ok(runId, "durable chat response identifies the Run");
    const frames = await response.text();
    assert.match(frames, /"done":true/);
    assert.match(frames, /"ok":false/);

    const stoppedResponse = await fetch(origin + "/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: conversation.id, idempotencyKey: "interrupted-accounting-run", message: "controlled timeout accounting" }),
    });
    assert.equal(stoppedResponse.status, 200, output.slice(-2500));
    const stoppedRunId = stoppedResponse.headers.get("x-agent-run-id");
    assert.ok(stoppedRunId, "interrupted chat response identifies the Run");
    const stoppedFrames = await stoppedResponse.text();
    assert.match(stoppedFrames, /"stopped":true/);

    const successResponse = await fetch(origin + "/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: conversation.id, idempotencyKey: "successful-accounting-run", message: "controlled successful usage accounting" }),
    });
    assert.equal(successResponse.status, 200, output.slice(-2500));
    const successRunId = successResponse.headers.get("x-agent-run-id");
    assert.ok(successRunId, "successful chat response identifies the Run");
    assert.match(await successResponse.text(), /"done":true/);
    assert.equal(fs.readFileSync(usageRetryMarker, "utf8"), "injected", "fixture injected one transient usage persistence failure");
    assert.equal(fs.readFileSync(usageAckLossMarker, "utf8"), "commit-succeeded-ack-lost", "fixture committed usage before simulating a lost database acknowledgement");
    assert.equal(fs.readFileSync(providerRunCallsFile, "utf8").trim().split("\n").length, 3, "usage persistence retry must not repeat the provider Run");

    const usageResponse = await fetch(`${origin}/api/runs/${successRunId}/usage`, { headers });
    assert.equal(usageResponse.status, 200);
    const usagePage = await usageResponse.json();
    assert.deepEqual(usagePage.responses.map(row => [row.costCoverage, row.costBasis, row.providerReportedModel]),
      [["estimated", "requested_model", null], ["estimated", "requested_model", null]]);
    for (const [index, expected] of [0.0000202, 0.0000253].entries())
      assert.ok(Math.abs(usagePage.responses[index].cost - expected) < 1e-15);
    assert.ok(usagePage.responses.every(row => row.priceVersion === "http-fixture-v1"));
    const csvResponse = await fetch(`${origin}/api/runs/${successRunId}/usage-all.csv`, { headers });
    assert.equal(csvResponse.status, 200);
    const csv = await csvResponse.text();
    assert.match(csv, /cost_basis/);
    assert.equal((csv.match(/requested_model/g) || []).length, 2);

    const persistentFailureResponse = await fetch(origin + "/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: conversation.id, idempotencyKey: "persistent-usage-failure-run", message: "controlled persistent usage failure" }),
    });
    assert.equal(persistentFailureResponse.status, 200);
    const persistentFailureRunId = persistentFailureResponse.headers.get("x-agent-run-id");
    assert.ok(persistentFailureRunId);
    assert.match(await persistentFailureResponse.text(), /"done":true/, "persistent usage failure does not cause a provider replay or false chat failure");
    assert.equal(fs.readFileSync(persistentUsageFailureFile, "utf8").trim().split("\n").length, 2, "usage persistence makes exactly two bounded attempts");
    assert.equal(fs.readFileSync(providerRunCallsFile, "utf8").trim().split("\n").length, 4, "persistent usage failure still does not repeat the provider Run");

    const stop = await fetch(origin + "/__test_shutdown", { method: "POST", headers: { "x-shutdown-token": shutdownToken } });
    assert.equal(stop.status, 200);
    await waitForClose(child);

    const serviceLogs = fs.readdirSync(logDir).filter(name => name.endsWith(".log")).map(name => fs.readFileSync(path.join(logDir, name), "utf8")).join("\n");
    assert.match(serviceLogs, /"event":"chat_usage\.log_failed"/);
    assert.match(serviceLogs, /"attempts":2/);

    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const toolRows = (await storage.db.query(
      "SELECT tool_name,status FROM tool_calls WHERE tenant_id=$1 ORDER BY tool_name",
      [tenantId],
    )).rows;
    assert.deepEqual(toolRows, [
      { tool_name: "fixture.failure", status: "failed" },
      { tool_name: "fixture.stop_failure", status: "failed" },
      { tool_name: "fixture.stop_success", status: "completed" },
      { tool_name: "fixture.success", status: "completed" },
    ]);
    const usageRows = (await storage.db.query(
      "SELECT run_id,response_seq,prompt_tokens,completion_tokens,total_tokens,coverage,cost_amount,cost_currency,cost_coverage FROM chat_usage WHERE run_id=$1",
      [runId],
    )).rows;
    assert.equal(usageRows.length, 1);
    assert.equal(String(usageRows[0].run_id), runId);
    assert.equal(Number(usageRows[0].response_seq), 17);
    assert.equal(Number(usageRows[0].prompt_tokens), 7);
    assert.equal(Number(usageRows[0].completion_tokens), 2);
    assert.equal(usageRows[0].total_tokens, null, "missing cache evidence prevents deriving a total from input and output alone");
    assert.equal(usageRows[0].coverage, "partial");
    assert.equal(usageRows[0].cost_amount, null);
    assert.equal(usageRows[0].cost_currency, null);
    assert.equal(usageRows[0].cost_coverage, "unknown");
    const successUsageRows = (await storage.db.query(
      "SELECT run_id,response_seq,prompt_tokens,completion_tokens,total_tokens,cache_read_tokens,cache_write_tokens,coverage FROM chat_usage WHERE run_id=$1",
      [successRunId],
    )).rows;
    successUsageRows.sort((a, b) => Number(a.response_seq) - Number(b.response_seq));
    assert.equal(successUsageRows.length, 2, "commit-then-ACK-loss retry persists each observed response exactly once");
    const estimateEvents = (await storage.db.query(
      "SELECT event FROM agent_run_events WHERE run_id=$1 AND event->'payload'->>'kind'='text_response_estimates'", [successRunId],
    )).rows;
    assert.equal(estimateEvents.length, 1, "a persisted estimate projection precedes terminal completion");
    assert.deepEqual(estimateEvents[0].event.payload.responses.map(row => row.coverage), ['estimated', 'estimated']);
    assert.equal(estimateEvents[0].event.payload.responses.every(row => row.basis === "requested_model" && row.providerReportedModel === null), true,
      "persisted estimates retain requested-model basis without inventing upstream identity");
    assert.deepEqual(successUsageRows.map(row => ({
      runId: String(row.run_id), responseSeq: Number(row.response_seq), prompt: Number(row.prompt_tokens),
      completion: Number(row.completion_tokens), total: Number(row.total_tokens), cacheRead: Number(row.cache_read_tokens),
      cacheWrite: Number(row.cache_write_tokens), coverage: row.coverage,
    })), [
      { runId: successRunId, responseSeq: 23, prompt: 11, completion: 4, total: 18, cacheRead: 2, cacheWrite: 1, coverage: "complete" },
      { runId: successRunId, responseSeq: 25, prompt: 13, completion: 5, total: 23, cacheRead: 3, cacheWrite: 2, coverage: "complete" },
    ]);
    const toolCalls = await require("../../shell/tool-calls.cjs").initToolCalls(storage.db);
    const reopenedUsage = await toolCalls.usageByRun({ tenantId, workspaceId: `ws_${tenantId}`, userId: user.id, runId: successRunId });
    assert.deepEqual(reopenedUsage.responses, usagePage.responses, "database reopen preserves bound rates, estimate basis and identity uncertainty");
    const priceStore = require("../../shell/usage/price-catalog-store.cjs").createTextPriceCatalogStore(storage.db);
    await priceStore.importCatalog({
      reviewed: true, sourceEvidence: "Later offline fixture capture with changed rates; not an official price.",
      snapshots: [{ sourceUrl: "https://powertokens.ai/pricing", model: "fixture-model", version: "http-fixture-v2",
        capturedAt: "2020-01-01T00:00:00Z", effectiveFrom: "2020-01-01T00:00:00Z", effectiveUntil: null,
        currency: "USD", inputUsdPerMillion: 10, outputUsdPerMillion: 20, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 10 }],
    });
    assert.equal((await priceStore.selectNow("fixture-model")).snapshot.version, "http-fixture-v2",
      "a new call would bind the updated catalog");
    const historicalUsage = await toolCalls.usageByRun({ tenantId, workspaceId: `ws_${tenantId}`, userId: user.id, runId: successRunId });
    assert.deepEqual(historicalUsage.responses, usagePage.responses,
      "a later catalog with tenfold rates must not reprice historical Run evidence");
    await assert.rejects(toolCalls.logUsage({
      tenantId, workspaceId: `ws_${tenantId}`, userId: user.id, model: "fixture-model", runId: successRunId,
      usageEvidence: { responses: [{ responseSeq: 23, usage: { inputTokens: 999, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 } }] },
    }), error => error?.code === "USAGE_EVIDENCE_CONFLICT", "same Run response key with different token evidence is rejected");
    const persistentFailureRows = (await storage.db.query("SELECT id FROM chat_usage WHERE run_id=$1", [persistentFailureRunId])).rows;
    assert.equal(persistentFailureRows.length, 0, "persistent database failure remains an explicitly unrecorded usage gap");
    const run = (await storage.db.query("SELECT state FROM agent_runs WHERE run_id=$1", [runId])).rows[0];
    assert.equal(run.state, "failed");
    const stoppedRun = (await storage.db.query("SELECT state FROM agent_runs WHERE run_id=$1", [stoppedRunId])).rows[0];
    assert.equal(stoppedRun.state, "cancelled", "execution.cjs maps any stopped run outcome to the cancelled terminal state");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForClose(child).catch(() => child.kill("SIGKILL"));
    }
    if (storage) await storage.close();
    if (tenantId) {
      for (const entry of [path.join(runtimeWorkspaces, tenantId), path.join(runtimeWorkspaces, `ws_${tenantId}`)]) {
        if (!fs.existsSync(entry)) continue;
        const stat = fs.lstatSync(entry);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "refusing cleanup outside fixture workspace directories");
        fs.rmSync(entry, { recursive: true, force: true });
      }
    }
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
});
