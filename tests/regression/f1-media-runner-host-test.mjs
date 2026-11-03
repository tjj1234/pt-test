/** Real locked SDK + shipped runner + host RBAC + PGlite + media executor.
 * Both model and provider transports are deterministic fixtures: no real PT.
 * This does not exercise browser/chat admission or production plugin loading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createMediaRunHandler } = require('../../shell/tasks/media-run-handler.cjs');
const { createHostToolHandler } = require('../../shell/tasks/host-tool-handler.cjs');
const permissions = require('../../shell/permissions/index.cjs');
const registry = require('../../shell/tools/registry.cjs');
const { mediaRouteToolDefinition } = require('../../business/media/registry/tool.js');
const types = ['text2image', 'image2image', 'text2video', 'image2video'];
const sdkHarness = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(process.env.F1_ROOT, 'shell/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter, CallId }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
 '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
].map(load));
const ctx = new Context();
for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
ctx.provide('loader', { await: async () => {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'f1-fixture', model: 'fixture-chat' }) });
ctx.provide('appExit', code => process.exit(code));
class FixtureAdapter extends LlmAdapter {
 counts = new Map();
 async *stream(options) {
  const sid = String(options.sessionId), n = (this.counts.get(sid) || 0) + 1; this.counts.set(sid, n);
  const taskType = ['text2image', 'image2image', 'text2video', 'image2video'].find(x => sid.endsWith(x));
  if (!taskType) throw Error('unexpected fixture session');
  const args = { taskType, prompt: 'F1 controlled output' };
  if (taskType.startsWith('image2')) args.inputImageUrl = 'https://fixture.invalid/input.png';
  const answer = n === 1 ? { type: 'tool-call', id: CallId('call-' + sid), name: 'media_route', arguments: args } : { type: 'text', text: 'Fixture completed ' + taskType };
  yield { type: 'block-start', index: 0, blockType: answer.type };
  yield { type: 'block-end', index: 0, block: answer };
  yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } };
  yield { type: 'finish', reason: { kind: answer.type === 'tool-call' ? 'tool-calls' : 'stop' } };
 }
}
ctx.llm.registerAdapter(['f1-fixture'], new FixtureAdapter());
const { apply } = await import(pathToFileURL(path.join(process.env.F1_PROFILE, 'persistent-runner.mjs')));
apply(ctx);
`;

async function fixture(t, policy, {controlled = false} = {}) {
  assert.equal(Object.keys(process.env).some(k => k.startsWith('PT_PG_') && process.env[k]), false, 'fixture must not use a configured PostgreSQL');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-f1-media-'));
  const home = path.join(tmp, 'dsh'), profile = path.join(home, 'profiles/run-persistent');
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(path.join(root, 'shell/node_modules'), path.join(profile, 'node_modules'), 'dir');
  for (const [source, destination] of [
    ['shell/persistent-runner.mjs', 'persistent-runner.mjs'], ['shell/tasks/budget.cjs', 'budget.cjs'],
    ['shell/runtime/usage.cjs', 'usage.cjs'], ['business/media/presets.cjs', 'presets.cjs'],
    ['shell/runtime/native-image-message.mjs', 'native-image-message.mjs'],
    ['shell/runtime/dsh-native-context-r4-candidate.mjs', 'dsh-native-context-r4-candidate.mjs'],
    ['shell/runtime/published-skill-provider.mjs', 'published-skill-provider.mjs'],
    ['shell/skills/release-snapshot.cjs', 'skill-release-snapshot.cjs'],
    ['business/attribution/ga-connector/executor.js', 'ga-query-executor.cjs'],
  ]) fs.copyFileSync(path.join(root, source), path.join(profile, destination));
  fs.writeFileSync(path.join(profile, 'run-budget.json'), JSON.stringify(policy));
  fs.copyFileSync(path.join(root,'shell/runtime/run-budget-media.json'),path.join(profile,'run-budget-media.json'));
  const storage = await createStorage({ dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'key') });
  const auth = await storage.repositories.auth.register({ username: 'f1-fixture', password: 'Fixture123456' });
  const identity = { userId: auth.user.id, tenantId: auth.user.tenant_id };
  permissions.setDb(storage.adapter);
  registry.registerTool({ ...mediaRouteToolDefinition(), execute: async () => { throw Error('must use durable media handler'); } });
  const store = createTaskStore(storage.adapter), frames = [], posts = [], hosts = new Map(), runs = new Map(), dispatches = [];
  let stdout = '', stderr = '', closed = false;
  const child = spawn(process.execPath, ['--input-type=module', '-e', sdkHarness], {
    cwd: tmp,
    env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DSH_HOME: home, F1_ROOT: root, F1_PROFILE: profile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const send = frame => child.stdin.write(JSON.stringify({ ...frame, protocolVersion: 1 }) + '\n');
  child.once('close', () => { closed = true; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      frames.push(frame);
      if (frame.type === 'tool_request') dispatches.push((async () => {
        try {
          const result = await hosts.get(frame.sessionId).handle(frame);
          send({ type: 'tool_response', sessionId: frame.sessionId, requestId: frame.requestId, ok: true, result });
        } catch (error) {
          send({ type: 'tool_response', sessionId: frame.sessionId, requestId: frame.requestId, ok: false, code: error.code || 'FIXTURE_HOST_FAILED', error: 'fixture host rejected' });
        }
      })());
    }
  });
  t.after(async () => {
    if (!closed) {
      const exited = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await exited;
    }
    await Promise.allSettled(dispatches);
    for (const host of hosts.values()) await host.drain();
    permissions.setDb(null);
    await storage.close(); fs.rmSync(tmp, { recursive: true, force: true });
  });
  async function wait(predicate, label) {
    const until = Date.now() + 15000;
    while (!predicate() && !closed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), label + '\n' + stderr + '\n' + JSON.stringify(frames));
  }
  await wait(() => frames.some(f => f.type === 'ready'), 'real SDK runner ready');
  async function start(taskType) {
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const owner = 'f1-owner-' + taskType;
    let run = (await store.createRun(identity, { conversationId: conversation.id, idempotencyKey: taskType, request: {} }, { owner, ttlMs: 30000 })).run;
    run = await store.transition(identity, run.runId, 'running', run.revision, owner);
    runs.set(taskType, run);
    const kind=taskType.endsWith('image')?'image':'video';
    const route={schemaVersion:1,scopeId:'fixture-current-key-scope',model:'fixture-'+taskType,taskType,capabilityRevision:'a'.repeat(64),adapterId:kind==='image'?'pt-image-generations-v1':'pt-video-generations-v1',adapterVersion:'1',endpoint:kind==='image'?'openai-images-generations':'openai-videos',provider:'powertokens-'+kind,kind};
    let controlledOptions={};
    if(controlled){
      const {createMediaGrantStoreCandidate}=require('../../shell/tasks/media-grant-store-candidate.cjs');
      const grants=createMediaGrantStoreCandidate(storage.adapter,{recordIntent:({tx,identity,runId,...data})=>store.externalOperations.createIntentInTransaction(tx,identity,runId,data)});
      const grant=await grants.issue(identity,{grantId:'grant-'+taskType,runId:run.runId,runLeaseOwner:owner,credentialScopeId:route.scopeId,modelId:route.model,taskType,capabilityRevision:route.capabilityRevision,adapterId:route.adapterId,adapterVersion:route.adapterVersion,provider:route.provider,expiresAt:new Date(Date.now()+60000).toISOString()});
      controlledOptions={loadControlledGrant:(identity,runId)=>grants.getGrant(identity,runId,grant.grantId),reserveControlledAttempt:(identity,entry)=>grants.reserveAttempt(identity,entry),resolveRoute:async input=>{assert.deepEqual(input.selection,{mode:'manual',modelId:route.model});return route;}};
    }
    const mediaHandler = createMediaRunHandler({ store, identity,
      ...controlledOptions,
      taskRun: { runId: run.runId, leaseOwner: owner, signal: new AbortController().signal },
      loadCredential: async () => 'synthetic-f1-key',
      fetchImpl: async (url, init) => {
        assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body);
        const intent = (await store.externalOperations.list(identity, run.runId)).operations;
        assert.equal(intent.length, 1, 'durable intent exists before provider submission');
        posts.push({ taskType, url, body });
        const data = taskType.endsWith('image') ? { data: [{ url: 'https://fixture.invalid/' + taskType + '.png' }] } : { video_url: 'https://fixture.invalid/' + taskType + '.mp4' };
        return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data };
      },
    });
    hosts.set(taskType, createHostToolHandler({ registry, context: { ...identity, workspaceId: 'ws_' + identity.tenantId }, mediaHandler }));
    send({ type: 'task', sessionId: taskType, tenantId: identity.tenantId, provider: 'f1-fixture', model: 'fixture-chat', task: 'Generate ' + taskType, ...(controlled?{budgetProfile:'media:'+taskType}:{}) });
  }
  return { frames, posts, start, wait, store, identity, runs, storage };
}

test('F1 four media tasks traverse actual SDK/runner/host/store/executor with fixture transports', async t => {
  const f = await fixture(t, { maxDurationMs: 15000, maxModelCalls: 2, maxToolCalls: 1, maxToolCallsPerKey: 1, maxRetries: 0, maxOutputTokens: 256 });
  for (const type of types) await f.start(type);
  await f.wait(() => types.every(type => f.frames.some(x => x.type === 'done' && x.sessionId === type)), 'all four task completions');
  assert.equal(f.posts.length, 4);
  for (const type of types) {
    const done = f.frames.find(x => x.type === 'done' && x.sessionId === type);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.match(done.text, new RegExp('Fixture completed ' + type));
    assert.equal(done.media.length, 1);
    assert.match(done.media[0].url, new RegExp('/' + type + '\\.'));
    assert.equal(done.budget.snapshot.modelCalls, 2);
    assert.equal(done.budget.snapshot.toolCalls, 1);
    const post = f.posts.find(x => x.taskType === type);
    assert.equal(new URL(post.url).pathname, type.endsWith('image') ? '/v1/images/generations' : '/v1/videos');
    if (type === 'image2image') assert.equal(post.body.image, 'https://fixture.invalid/input.png');
    if (type === 'image2video') assert.equal(post.body.media[0].url, 'https://fixture.invalid/input.png');
    const operations = (await f.store.externalOperations.list(f.identity, f.runs.get(type).runId)).operations;
    assert.equal(operations.length, 1);
    assert.equal(operations[0].status, 'succeeded');
  }
});

test('F1 shipped zero-tool trial policy refuses media before host RPC or provider submission', async t => {
  const f = await fixture(t, JSON.parse(fs.readFileSync(path.join(root, 'shell/runtime/run-budget.json'), 'utf8')));
  await f.start('text2image');
  await f.wait(() => f.frames.some(x => x.type === 'done'), 'zero-tool completion');
  assert.equal(f.posts.length, 0);
  assert.equal(f.frames.filter(x => x.type === 'tool_request').length, 0);
  assert.equal(f.frames.find(x => x.type === 'done').ok, false);
});

test('F1 one-model policy cannot finish a successful media tool followed by summary', async t => {
  const f = await fixture(t, { maxDurationMs: 15000, maxModelCalls: 1, maxToolCalls: 1, maxToolCallsPerKey: 1, maxRetries: 0 });
  await f.start('text2image');
  await f.wait(() => f.frames.some(x => x.type === 'done'), 'one-model completion');
  assert.equal(f.posts.length, 1, 'media was generated once before next model admission');
  const done = f.frames.find(x => x.type === 'done');
  assert.equal(done.ok, false);
  assert.equal(done.budget.snapshot.modelCalls, 1);
  const operations = (await f.store.externalOperations.list(f.identity, f.runs.get('text2image').runId)).operations;
  assert.equal(operations[0].status, 'succeeded', 'later model denial must not rewrite the successful external step');
});

test('controlled profile and durable grants traverse SDK host lifecycle for all four tasks',async t=>{
 const f=await fixture(t,JSON.parse(fs.readFileSync(path.join(root,'shell/runtime/run-budget.json'),'utf8')),{controlled:true});
 for(const type of types)await f.start(type);
 await f.wait(()=>types.every(type=>f.frames.some(x=>x.type==='done'&&x.sessionId===type)),'controlled four-task completion');
 assert.equal(f.posts.length,4);
 for(const type of types){
  const done=f.frames.find(x=>x.type==='done'&&x.sessionId===type);assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.budget.snapshot.toolCalls,1);assert.equal(done.budget.snapshot.modelCalls,2);assert.equal(done.budget.limits.maxRetries,0);assert.deepEqual(done.budget.limits.allowedMediaTaskTypes,[type]);
  const grant=(await f.storage.adapter.query('SELECT consumed_at FROM controlled_media_grants WHERE grant_id=$1',['grant-'+type])).rows[0];assert.ok(grant.consumed_at);
  const operations=(await f.store.externalOperations.list(f.identity,f.runs.get(type).runId)).operations;assert.equal(operations.length,1);assert.equal(operations[0].status,'succeeded');
 }
 assert.equal((await f.storage.adapter.query('SELECT * FROM controlled_media_reservations')).rows.length,4);
});
