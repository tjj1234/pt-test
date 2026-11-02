import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('HTTP conversation model preferences isolate owners, survive reload and bind queued execution', { timeout: 45000 }, async () => {
  assert.equal(Object.keys(process.env).some(k => k.startsWith('PT_PG_') && process.env[k]), false, 'fixture must not use a configured external database');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-conversation-model-http-'));
  const dbDir = path.join(temp, 'db'); const masterKeyFile = path.join(temp, 'key');
  const recordFile = path.join(temp, 'executed.jsonl');
  const actualCatalogModeFile = path.join(temp, 'use-real-catalog-path');
  const catalogInternalFailureFile = path.join(temp, 'catalog-internal-failure');
  const logPath = path.join(temp, 'logs');
  let storage, child; let output = ''; const tenants = [];
  const cookies = [];
  const stop = async () => { if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; } child = null; };
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    for (let i = 0; i < 2; i++) {
      const r = await storage.repositories.auth.register({ username: 'model-http-' + i, email: `model-${i}@example.test`, password: 'FixtureReview123' });
      assert.equal(r.ok, true); tenants.push(r.user.tenant_id);
      await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)', ['https://accounts.google.com', 'fixture-model-' + i, r.user.id, r.user.email]);
      const token = crypto.randomBytes(32).toString('hex');
      await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [r.user.id, crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 120000).toISOString()]);
      cookies.push('pt_session=' + token);
    }
    await storage.close(); storage = null;
    const listener = createServer(); await new Promise((r,j) => listener.once('error',j).listen(0,'127.0.0.1',r));
    const port = listener.address().port; await new Promise(r => listener.close(r));
    const origin = 'http://127.0.0.1:' + port;
    const preload = path.join(temp, 'fixtures.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs');const load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>["fixture-a", "fixture-b", "fixture-unverified", "fixture-no-text-chat", "fixture-endpoint-mismatch", "fixture-listed-partial"]};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs'){const fixture=async()=>{const models=['fixture-a','fixture-b'].map(id=>({id,chat:true,capabilityStatus:'supported',runtimeStatus:'verified',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}})).concat([{id:'fixture-unverified',chat:null,capabilityStatus:'unknown',runtimeStatus:'unadapted',availability:'present'},{id:'fixture-no-text-chat',chat:false,capabilityStatus:'unsupported',runtimeStatus:'adapted_unverified',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:false}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,verified:false}}},{id:'fixture-endpoint-mismatch',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:false,verified:false}}}]);if(fs.existsSync(${JSON.stringify(path.join(temp, 'deny-fixture-a'))}))models[0].permission=false;return {models,availability:{status:'available',modelIds:models.map(m=>m.id)},syncedAt:Date.now()};};return {...loaded,getCatalog:async opts=>{if(fs.existsSync(${JSON.stringify(catalogInternalFailureFile)})){const stage=fs.readFileSync(${JSON.stringify(catalogInternalFailureFile)},'utf8').trim();if(stage)opts.onCatalogStage?.(stage);throw Object.assign(new TypeError('fixture secret must not leak'),{code:'SECRET_UNSAFE_CODE'});}if(!fs.existsSync(${JSON.stringify(actualCatalogModeFile)}))return fixture();return loaded.getCatalog({...opts,fetchImpl:async()=>({ok:true,headers:{get:()=>null},json:async()=>({data:[{id:'fixture-listed-partial',supported_endpoint_types:['anthropic']}],has_more:true})})});}};}
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async(uid,q,opts)=>{fs.appendFileSync(${JSON.stringify(recordFile)},JSON.stringify({question:q,model:opts.model})+'\\n');if(q==='hold worker')await new Promise(r=>setTimeout(r,1800));return loaded.runDshForUser(uid,q,opts);}};
return loaded;};`);
    const env = { PATH: process.env.PATH, HOME: temp, PT_RUNTIME_DIR: path.join(temp,'runtime'), PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: logPath, PT_SHELL_PORT: String(port), PT_LISTEN_HOST:'127.0.0.1', PT_KEY_LIVE_VERIFY:'0', PT_CHAT_DRYRUN:'1', PT_RUNS_GLOBAL:'1' };
    async function start() {
      output = ''; child = spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
      for(let i=0;i<150;i++){ if(child.exitCode!==null)throw Error(output); try { if((await fetch(origin+'/api/auth/me',{headers:{Cookie:cookies[0]}})).status===200)return; }catch{} await new Promise(r=>setTimeout(r,50)); }
      throw Error('server did not start: '+output.slice(-2500));
    }
    async function req(route,{user=0,method='GET',body,key}={}) { return fetch(origin+route,{method,headers:{Cookie:cookies[user],...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})}); }
    const json = async (route,opts) => { const r=await req(route,opts);assert.equal(r.status,200,await r.clone().text());return r.json(); };
    const select = (model,conversationId) => json('/api/models/select',{method:'POST',body:{model,...(conversationId?{conversationId}:{})}});
    const current = async cid => (await json('/api/models'+(cid?'?conversationId='+encodeURIComponent(cid):''))).current;
    const create = async () => (await json('/api/conversations',{method:'POST'})).id;
    const chat = async (cid,message,key) => { const r=await req('/api/chat',{method:'POST',body:{conversationId:cid,message},key});if(r.status!==200)assert.fail(await r.text());assert.ok(r.headers.get('x-agent-run-id'));return r; };
    await start();
    await json('/api/auth/key',{method:'POST',body:{key:'fixture-no-paid-model-key'}});
    const failureStages = ['scope','qualification','cache_read','fetch_or_parse','merge','local_update','cache_write','projection','fallback_projection'];
    for (const failureStage of failureStages) {
      fs.writeFileSync(catalogInternalFailureFile, failureStage);
      const internalFailure = await json('/api/models');
      assert.equal(internalFailure.catalogDiagnostics?.state, 'internal_error');
      assert.equal(internalFailure.catalogDiagnostics?.errorCode, 'MODEL_CATALOG_INTERNAL_TYPE_ERROR', 'internal failures expose a bounded error class');
      assert.equal(internalFailure.catalogDiagnostics?.failureStage, failureStage, 'only the fixed stage enum is exposed');
      assert.equal(internalFailure.catalogDiagnostics?.failureCount, null, 'failure count is unknown when getCatalog rejected');
      assert.equal(internalFailure.catalogDiagnostics?.failureCountKnown, false);
      assert.doesNotMatch(JSON.stringify(internalFailure), /fixture secret|SECRET_UNSAFE_CODE/, 'internal exception detail never reaches the API');
    }
    assert.doesNotMatch(output, /fixture secret|SECRET_UNSAFE_CODE/, 'internal exception detail never reaches logs');
    const logEntries = fs.readdirSync(path.join(temp, 'logs')).filter(name => name.endsWith('.log')).flatMap(name => fs.readFileSync(path.join(temp, 'logs', name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const internalEvents = logEntries.filter(entry => entry.event === 'model_catalog_internal_failed');
    assert.deepEqual(internalEvents.slice(-failureStages.length).map(entry => entry.failureStage), failureStages, 'security log uses the same fixed stage enum');
    const internalStatus = logEntries.filter(entry => entry.event === 'model_catalog_status' && entry.state === 'internal_error').slice(-failureStages.length);
    assert.ok(internalStatus.every(entry => entry.failureCount === null && entry.failureCountKnown === false), 'logs do not misreport unknown failure count as zero');
    fs.unlinkSync(catalogInternalFailureFile);
    await select('fixture-a'); const a=await create(), b=await create();
    await select('fixture-b',a);
    assert.equal(await current(a),'fixture-b'); assert.equal(await current(b),'fixture-a','A selection cannot change B');
    assert.equal(await current(),'fixture-a','conversation selection cannot change user default');
    await select('fixture-b'); const d=await create();
    assert.equal(await current(d),'fixture-b','new conversation snapshots default');assert.equal(await current(b),'fixture-a','default update cannot change existing B');
    assert.equal((await req('/api/models?conversationId='+a,{user:1})).status,404);
    assert.equal((await req('/api/models/select',{user:1,method:'POST',body:{conversationId:a,model:'fixture-a'}})).status,404);
    for(const [model,status] of [['does-not-exist',400],['fixture-unverified',409]])assert.equal((await req('/api/models/select',{method:'POST',body:{conversationId:a,model}})).status,status);
    const unsupportedSelection = await req('/api/models/select',{method:'POST',body:{conversationId:a,model:'fixture-no-text-chat'}});
    assert.equal(unsupportedSelection.status,409);
    assert.deepEqual((await unsupportedSelection.json()).reasonCodes,['TASK_UNSUPPORTED'],'selection rejection identifies the exact textChat mismatch');
    const endpointMismatch = await req('/api/models/select',{method:'POST',body:{conversationId:a,model:'fixture-endpoint-mismatch'}});
    assert.equal(endpointMismatch.status,409);
    const endpointMismatchBody = await endpointMismatch.json();
    assert.deepEqual(endpointMismatchBody.reasonCodes,['ADAPTER_ENDPOINT_MISMATCH']);
    assert.match(endpointMismatchBody.error,/端点与本地聊天接口不匹配/);
    assert.equal(await current(a),'fixture-b','rejected selection leaves persisted preference intact');
    await stop(); await start();
    assert.equal(await current(a),'fixture-b');assert.equal(await current(b),'fixture-a');assert.equal(await current(d),'fixture-b','reload preserves independent preferences');
    const stale = await create(); await select('fixture-a',stale);
    fs.writeFileSync(path.join(temp,'deny-fixture-a'),'changed permission snapshot');
    const staleChat = await req('/api/chat',{method:'POST',body:{conversationId:stale,message:'permission changed after selection'},key:'model-permission-changed-after-selection'});
    assert.equal(staleChat.status,200);
    const staleFrames = await staleChat.text();
    assert.match(staleFrames, /"code":"MODEL_NOT_EXECUTABLE"/);
    assert.match(staleFrames, /"reasonCodes":\["PERMISSION_UNKNOWN_OR_DENIED"\]/,'execution-time rejection reports the exact reason without contacting DSH');
    fs.unlinkSync(path.join(temp,'deny-fixture-a'));
    const hold = await chat(a,'hold worker'); const heldFrames=hold.text();
    for(let i=0;i<50;i++){if(fs.existsSync(recordFile)&&fs.readFileSync(recordFile,'utf8').includes('hold worker'))break;await new Promise(r=>setTimeout(r,20));}
    assert.match(fs.readFileSync(recordFile,'utf8'),/hold worker/);
    const queuedKey = 'conversation-model-queued-snapshot';
    const queued = await chat(b,'queued snapshot',queuedKey); const queuedFrames=queued.text();
    const queuedId=queued.headers.get('x-agent-run-id');
    assert.equal((await json('/api/runs/'+queuedId)).run.state,'queued','fixture must actually queue before switching B');
    await select('fixture-b',b);
    assert.match(await heldFrames,/"done":true/);assert.match(await queuedFrames,/"done":true/);
    const executed=fs.readFileSync(recordFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(executed.find(r=>r.question==='queued snapshot')?.model,'fixture-a','queued request retains server captured selection');
    assert.equal(await current(b),'fixture-b','new selection remains for subsequent requests');
    const replay = await chat(b,'queued snapshot',queuedKey);
    assert.equal(replay.headers.get('x-agent-run-id'),queuedId,'preference change cannot change the idempotent Run identity');
    assert.match(await replay.text(),/"done":true/);
    const afterReplay=fs.readFileSync(recordFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(afterReplay.filter(r=>r.question==='queued snapshot').length,1,'replay cannot execute a second model call');
    const history=await json('/api/conversations/'+b);
    assert.equal(history.conversation.messages.filter(m=>m.role==='user').length,1,'replay cannot append another user turn');
    assert.equal((await req('/api/chat',{method:'POST',body:{conversationId:b,message:'different intent'},key:queuedKey})).status,409,'real client intent changes still conflict under an existing key');

    fs.writeFileSync(actualCatalogModeFile, 'use production catalog service with paginated fake PT response');
    const partialCatalog = await json('/api/models');
    assert.equal(partialCatalog.availability?.status, 'available', 'model list API exposes the catalog-level routing state');
    assert.equal(partialCatalog.catalogDiagnostics?.state, 'fresh', 'model list API exposes a bounded successful sync state');
    assert.equal(partialCatalog.catalogDiagnostics?.errorCode, null, 'successful sync has no diagnostic error code');
    const listed = partialCatalog.models.find(model => model.id === 'fixture-listed-partial');
    assert.ok(listed, 'production catalog service must ingest the model ID returned on the current PT page');
    assert.equal(listed.permission, true, 'each returned model ID is authorized for the current user key');
    assert.equal(listed.localPolicy?.enabled, true, 'user-confirmed textChat routing policy is enabled for the listed ID');
    assert.equal(listed.tasks?.textChat?.value, true, 'PT anthropic endpoint type maps to textChat');
    assert.equal(partialCatalog.eligibility['fixture-listed-partial']?.ok, true, 'manual eligibility passes for the listed ID');
    assert.equal(partialCatalog.eligibility['fixture-listed-partial']?.verificationRequired, true, 'first real call is surfaced as required verification');
    assert.ok(!partialCatalog.models.some(model => model.id === 'fixture-a'), 'cached IDs absent from this partial response are not kept executable');
    await select('fixture-listed-partial', a);
    const partialChat = await chat(a, 'partial PT catalog manual route fixture', 'partial-catalog-manual-route');
    const partialFrames = await partialChat.text();
    assert.match(partialFrames, /"done":true/);
    const partialExecuted = fs.readFileSync(recordFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(partialExecuted.find(row => row.question.includes('partial PT catalog'))?.model, 'fixture-listed-partial', 'selected paginated ID reaches the execution boundary');

    await stop();
    fs.rmSync(logPath, { recursive: true, force: true });
    fs.writeFileSync(logPath, 'ordinary file blocks log directory creation');
    fs.writeFileSync(catalogInternalFailureFile, 'projection');
    await start();
    const loggerUnavailable = await req('/api/models');
    assert.equal(loggerUnavailable.status, 200);
    const loggerUnavailableBody = await loggerUnavailable.json();
    assert.equal(loggerUnavailableBody.catalogDiagnostics?.state, 'internal_error');
    assert.equal(loggerUnavailableBody.catalogDiagnostics?.failureStage, 'projection');
    assert.equal(loggerUnavailableBody.catalogDiagnostics?.failureCount, null);
    assert.equal(loggerUnavailableBody.catalogDiagnostics?.failureCountKnown, false);
  } finally {
    await stop();if(storage)await storage.close();
    for(const tenant of tenants){for(const part of ['workspaces','tenants'])fs.rmSync(path.join(root,'runtime',part,tenant),{recursive:true,force:true});}
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
