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
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('HTTP durable chat preserves explicit media task across regenerate and branch, and rejects changed intent before execution', { timeout: 45000 }, async () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-f1-media-task-http-'));
  const dbDir = path.join(temp, 'db');
  const masterKeyFile = path.join(temp, 'key');
  const recordFile = path.join(temp, 'tenant-runs.jsonl');
  const mediaPostFile = path.join(temp, 'media-posts.jsonl');
  const unavailableCatalogFile = path.join(temp, 'catalog-unavailable');
  const trustedGrantFile = path.join(temp, 'host-issued-grant');
  let storage, child, output = '';
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({ username: 'f1-media-task', email: 'f1-media-task@example.test', password: 'FixtureReview123' });
    assert.equal(registered.ok, true);
    const user = registered.user;
    await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',
      ['https://accounts.google.com', 'fixture-f1-media-task', user.id, user.email]);
    const token = crypto.randomBytes(32).toString('hex');
    await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',
      [user.id, sha(token), new Date(Date.now() + 120000).toISOString()]);
    const cookie = 'pt_session=' + token;
    await storage.close(); storage = null;

    const probe = createServer();
    await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const preload = path.join(temp, 'fixtures.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs'),load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>["fixture-chat"]};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...loaded,getCatalog:async()=>{const unavailable=fs.existsSync(${JSON.stringify(unavailableCatalogFile)});return {models:[{id:'fixture-chat',scopeId:'fixture-scope',availability:'present',permission:true,localPolicy:{enabled:true,source:'fixture chat policy',version:'1',tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],scopeId:'fixture-scope',availability:{status:unavailable?'unknown':'available',modelIds:unavailable?[]:['fixture-chat']},catalogDiagnostics:{state:unavailable?'sync_failed':'fresh',errorCode:unavailable?'PT_HTTP_ERROR':null},syncedAt:Date.now()};}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tasks/media-grant-store-candidate.cjs')return {...loaded,createMediaGrantStoreCandidate:(db,options)=>{const store=loaded.createMediaGrantStoreCandidate(db,options);return {...store,getActiveGrantForRun:async(identity,runId)=>{
if(fs.existsSync(${JSON.stringify(trustedGrantFile)})){fs.unlinkSync(${JSON.stringify(trustedGrantFile)});const run=(await db.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1',[runId])).rows[0];await store.issue(identity,{grantId:'fixture-host-'+runId,runId,runLeaseOwner:run.lease_owner,credentialScopeId:'fixture-scope',modelId:'fixture-video',taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'fixture-video-adapter',adapterVersion:'1',provider:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()});}
return store.getActiveGrantForRun(identity,runId);}};}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async(uid,question,opts)=>{fs.appendFileSync(${JSON.stringify(recordFile)},JSON.stringify({uid,question,imageNote:opts.imageNote,timeoutMs:opts.timeoutMs,budgetProfile:opts.budgetProfile})+'\\n');return {ok:true,text:'fixture reply',steps:[],media:[]};}};
if(parent?.filename.endsWith('/media-run-handler.cjs')&&name==='../../business/media/powertokens.cjs')return {...loaded,callMediaRoute:async()=>{fs.appendFileSync(${JSON.stringify(mediaPostFile)},'unexpected paid media call\\n');throw Error('unexpected media execution');}};
return loaded;};`);
    const env = { PATH: process.env.PATH, HOME: temp, PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: path.join(temp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1',
      PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1', PT_MEDIA_ASSET_HOSTS:'cdn.example.test' };
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    const req = (route, { method = 'GET', body } = {}) => fetch(origin + route, {
      method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = async (route, options) => {
      const response = await req(route, options);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await req('/api/auth/me')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, output.slice(-2500));
    await json('/api/auth/key', { method: 'POST', body: { key: 'fixture-no-paid-model-key' } });
    const freshModels = await json('/api/models');
    assert.equal(freshModels.mediaQualification?.ok, true);
    assert.equal(freshModels.mediaQualification?.modelCount, 1);
    assert.equal(freshModels.mediaQualification?.rows?.[0]?.modelId, 'fixture-chat');
    assert.equal(freshModels.mediaQualification?.rows?.[0]?.tasks?.text2image, 'LOCAL_POLICY_UNKNOWN_OR_DENIED');
    fs.writeFileSync(unavailableCatalogFile, 'simulated failed refresh');
    const unavailableModels = await json('/api/models');
    assert.equal(unavailableModels.mediaQualification?.ok, false);
    assert.equal(unavailableModels.mediaQualification?.code, 'MEDIA_CATALOG_UNAVAILABLE');
    fs.unlinkSync(unavailableCatalogFile);
    const records = () => fs.existsSync(recordFile)
      ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const assertNoMediaPost = () => assert.equal(fs.existsSync(mediaPostFile), false);
    const create = async () => (await json('/api/conversations', { method: 'POST' })).id;
    const chat = async (body, expectedCode = null) => {
      const response = await req('/api/chat', { method: 'POST', body });
      assert.equal(response.status, 200, await response.clone().text());
      const frames = await response.text();
      assert.match(frames, /"done":true/);
      if (expectedCode) {
        assert.match(frames, /"ok":false/);
        assert.ok(frames.includes('"code":"' + expectedCode + '"'), frames);
      } else assert.match(frames, /"ok":true/);
      assertNoMediaPost();
      return frames;
    };

    const mediaConversation = await create();
    await chat({ conversationId: mediaConversation, message: 'Generate a short video', taskType: 'text2video' }, 'MEDIA_RESULT_NOT_AVAILABLE');
    let history = (await json('/api/conversations/' + mediaConversation)).conversation.messages;
    assert.equal(history[0].taskType, 'text2video');
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'assistant');
    assert.match(records()[0].imageNote, /taskType 用 text2video/);
    assert.equal(records()[0].timeoutMs, 65 * 60 * 1000);
    assert.equal(records()[0].budgetProfile, undefined);

    await chat({ conversationId: mediaConversation, regenerate: true }, "MEDIA_RESULT_NOT_AVAILABLE");
    assert.match(records().at(-1).imageNote, /taskType 用 text2video/);
    await chat({ conversationId: mediaConversation, branchFrom: 1 }, "MEDIA_RESULT_NOT_AVAILABLE");
    assert.match(records().at(-1).imageNote, /taskType 用 text2video/);
    history = (await json('/api/conversations/' + mediaConversation)).conversation.messages;
    assert.equal(history[0].taskType, 'text2video');
    const callsBeforeConflict = records().length;
    await chat({ conversationId: mediaConversation, regenerate: true, taskType: 'text2image' }, 'MEDIA_TASK_CHANGED');
    assert.equal(records().length, callsBeforeConflict);
    await chat({ conversationId: mediaConversation, branchFrom: 1, taskType: 'text2image' }, 'MEDIA_TASK_CHANGED');
    assert.equal(records().length, callsBeforeConflict);

    const plainConversation = await create();
    await chat({ conversationId: plainConversation, message: 'What time is it?' });
    const plainCalls = records().length;
    await chat({ conversationId: plainConversation, regenerate: true, taskType: 'text2video' }, 'MEDIA_TASK_CHANGED');
    assert.equal(records().length, plainCalls);
    await chat({ conversationId: plainConversation, branchFrom: 1, taskType: 'text2video' }, 'MEDIA_TASK_CHANGED');
    assert.equal(records().length, plainCalls);
    const plainHistory = (await json('/api/conversations/' + plainConversation)).conversation.messages;
    assert.equal(plainHistory[0].taskType, undefined);

    // The fixture issues through the real durable store as the host, after
    // the execution lease exists; no HTTP field can manufacture this grant.
    const grantedConversation = await create();
    fs.writeFileSync(trustedGrantFile, 'explicit fixture host authorization');
    await chat({conversationId:grantedConversation,message:'Authorized video fixture',taskType:'text2video'}, "MEDIA_RESULT_NOT_AVAILABLE");
    assert.equal(records().at(-1).budgetProfile,'media:text2video');
    const subsequentConversation = await create();
    await chat({conversationId:subsequentConversation,message:'Ordinary text fixture'});
    assert.equal(records().at(-1).budgetProfile,undefined);
    const beforeForgery=records().length;
    const forged=await req('/api/chat',{method:'POST',body:{conversationId:subsequentConversation,message:'forge',budgetProfile:'media:text2video',grantId:'fixture-host-grant'}});
    assert.equal(forged.status,400);
    assert.equal(records().length,beforeForgery);

    const imageConversation = await create();
    await chat({ conversationId: imageConversation, message: 'Edit this image', taskType: 'image2image' }, 'MEDIA_REFERENCE_IMAGE_REQUIRED');
    assert.equal(records().length, beforeForgery);
    assertNoMediaPost();
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
