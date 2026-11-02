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
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('memory POST and DELETE cancel active Runs, retain queued Runs, and fail closed when cancellation is unconfirmed', { timeout: 45000 }, async t => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false,
    'fixture must not inherit external PostgreSQL settings');
  let assertions = 1;
  const eq = (actual, expected, message) => { assertions++; assert.equal(actual, expected, message); };
  const deepEq = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
  const ok = (actual, message) => { assertions++; assert.ok(actual, message); };
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-memory-cancel-'));
  const dbDir = path.join(temp, 'db'), masterKeyFile = path.join(temp, 'key');
  const scenarioFile = path.join(temp, 'scenario.json'), runLog = path.join(temp, 'cancel.jsonl');
  let storage, child, output = '';
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({
      username: 'memory-cancel-http', email: 'memory-cancel-http@example.test', password: 'FixtureReview123',
    });
    eq(registered.ok, true, 'PGlite fixture user registered');
    const user = registered.user;
    await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)', [
      'https://accounts.google.com', 'fixture-memory-cancel-http', user.id, user.email,
    ]);
    const token = crypto.randomBytes(32).toString('hex');
    await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [
      user.id, sha(token), new Date(Date.now() + 120000).toISOString(),
    ]);
    await storage.close(); storage = null;

    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const preload = path.join(temp, 'fixtures.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs'),load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./tasks/store.cjs')return {...loaded,createTaskStore:db=>{const store=loaded.createTaskStore(db),seen=new Set(),byKey=new Map(),list=store.listRuns.bind(store);store.listRuns=async(identity,opts)=>{if(fs.existsSync(${JSON.stringify(scenarioFile)})){const scenario=JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)},'utf8'));if(!seen.has(scenario.batch)){seen.add(scenario.batch);for(const spec of scenario.runs){const made=await store.createRun(identity,{conversationId:spec.conversationId,idempotencyKey:spec.key,request:{question:spec.key,attachments:[]}});let run=made.run;if(spec.state==='running')run=await store.transition(identity,run.runId,'running',run.revision);byKey.set(spec.key,run.runId);fs.appendFileSync(${JSON.stringify(runLog)},JSON.stringify({type:'seed',key:spec.key,runId:run.runId,state:run.state})+'\\n');}}}return list(identity,opts);};store.__fixtureRunForKey=key=>byKey.get(key);return store;}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tasks/execution.cjs')return {...loaded,createRunExecutionService:options=>{const service=loaded.createRunExecutionService(options),store=options.store;return {...service,cancel:async(identity,runId)=>{const run=await store.getRun(identity,runId);fs.appendFileSync(${JSON.stringify(runLog)},JSON.stringify({type:'cancel',runId,state:run.state})+'\\n');if(run.state==='running')await store.transition(identity,runId,'cancelling',run.revision);const current=await store.getRun(identity,runId);const scenario=fs.existsSync(${JSON.stringify(scenarioFile)})?JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)},'utf8')):{};if(scenario.unconfirmedKey&&store.__fixtureRunForKey(scenario.unconfirmedKey)===runId)return {stopped:false,cancelRequested:true,run:current};const cancelled=await store.transition(identity,runId,'cancelled',current.revision);return {stopped:true,run:cancelled};}};}};
return loaded;};`);
    const env = {
      PATH: process.env.PATH, HOME: temp,
      PT_RUNTIME_DIR: path.join(temp, 'runtime'), PT_DB_DIR: dbDir,
      PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: path.join(temp, 'logs'),
      PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1',
    };
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    async function req(route, { method = 'GET', body } = {}) {
      return fetch(origin + route, {
        method,
        headers: { Cookie: 'pt_session=' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }
    async function json(route, options) {
      const response = await req(route, options);
      assert.equal(response.status, 200, await response.clone().text()); assertions++;
      return response.json();
    }
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await req('/api/auth/me')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    eq(ready, true, `authenticated server ready; ${output.slice(-2000)}`);
    const conv1 = (await json('/api/conversations', { method: 'POST' })).id;
    const conv2 = (await json('/api/conversations', { method: 'POST' })).id;
    const conv3 = (await json('/api/conversations', { method: 'POST' })).id;
    const readRuns = () => fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const runIdFor = key => readRuns().find(row => row.type === 'seed' && row.key === key)?.runId;
    const getRun = async runId => (await json(`/api/runs/${encodeURIComponent(runId)}`)).run;

    fs.writeFileSync(scenarioFile, JSON.stringify({ batch: 'post-active-plus-queued', runs: [
      { key: 'post-active', conversationId: conv1, state: 'running' },
      { key: 'post-queued', conversationId: conv2, state: 'queued' },
    ] }));
    const post = await req('/api/memory', { method: 'POST', body: { key: 'preference', value: 'updated' } });
    eq(post.status, 200, await post.clone().text());
    const postBody = await post.json();
    eq(postBody.cancelledRuns, 1, 'POST reports one confirmed active cancellation');
    const activeRunId = runIdFor('post-active'), queuedRunId = runIdFor('post-queued');
    ok(activeRunId && queuedRunId, 'scenario seeded durable Run rows in PGlite');
    eq((await getRun(activeRunId)).state, 'cancelled', 'POST leaves active Run cancelled in the real store');
    eq((await getRun(queuedRunId)).state, 'queued', 'POST leaves a queued Run untouched');
    deepEq(readRuns().filter(row => row.type === 'cancel').map(row => row.runId), [activeRunId], 'POST calls cancellation only for active Run');

    fs.writeFileSync(scenarioFile, JSON.stringify({ batch: 'delete-active', runs: [
      { key: 'delete-active', conversationId: conv3, state: 'running' },
    ] }));
    const deleted = await req('/api/memory?key=preference', { method: 'DELETE' });
    eq(deleted.status, 200, await deleted.clone().text());
    eq((await deleted.json()).cancelledRuns, 1, 'DELETE reports one confirmed active cancellation');
    const deleteRunId = runIdFor('delete-active');
    eq((await getRun(deleteRunId)).state, 'cancelled', 'DELETE leaves active Run cancelled in the real store');
    deepEq((await json('/api/memory')).memories, [], 'GET immediately after successful DELETE confirms memory is gone');

    fs.writeFileSync(scenarioFile, JSON.stringify({ batch: 'delete-unconfirmed', unconfirmedKey: 'delete-unconfirmed', runs: [
      { key: 'delete-unconfirmed', conversationId: conv1, state: 'running' },
    ] }));
    const failedDelete = await req('/api/memory?key=missing-key', { method: 'DELETE' });
    eq(failedDelete.status, 503, 'DELETE fails closed when cancellation is unconfirmed');
    deepEq(await failedDelete.json(), {
      ok: false, memoryDeleted: true, code: 'MEMORY_CONTEXT_INVALIDATION_FAILED',
      error: '记忆已删除，但未能确认所有现有对话上下文已刷新。请重新打开相关对话后再继续。',
    }, 'DELETE 503 identifies persisted deletion and failed invalidation');
    const unconfirmedRunId = runIdFor('delete-unconfirmed');
    eq((await getRun(unconfirmedRunId)).state, 'cancelling', 'unconfirmed cancellation records real Run state as cancelling');
    deepEq((await json('/api/memory')).memories, [], 'DELETE 503 still reflects the completed memory deletion');
    eq(readRuns().filter(row => row.type === 'cancel' && row.runId === unconfirmedRunId).length, 1,
      'failure is specifically the cancellation service reporting an unconfirmed stop');
    t.diagnostic(`assertions=${assertions}; real HTTP routes, PGlite Run store, cancellation implementation stubbed at execution-service boundary; no provider/model call`);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      let timer;
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
      ]);
      clearTimeout(timer);
      if (!graceful && child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
