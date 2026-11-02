import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(process.env.F1_ROOT, 'shell/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter, CallId }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
].map(load));
const ctx = new Context();
for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
ctx.provide('loader', { await: async () => {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'budget-fixture', model: 'fixture-chat' }) });
ctx.provide('appExit', code => process.exit(code));
class FixtureAdapter extends LlmAdapter {
  calls = 0;
  controlledCalls = new Map();
  async *stream(options) {
    this.calls++;
    process.stdout.write(JSON.stringify({type:"fixture_request_config",maxTokens:options.maxTokens??null})+"\n");
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const input = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block?.type === 'text').map(block => block.text).join('\n');
    const controlledKey=input.includes('wrong-task')?'wrong-task':'controlled';
    const controlledN=(this.controlledCalls.get(controlledKey)||0)+1;
    if(input.includes('controlled-profile'))this.controlledCalls.set(controlledKey,controlledN);
    const answer = input.includes('controlled-profile')
      ? controlledN > 1
        ? { type: 'text', text: 'Controlled fixture complete' }
        : { type: 'tool-call', id: CallId('controlled-' + this.calls), name: 'media_route', arguments: { taskType: input.includes('wrong-task') ? 'image2video' : 'text2image', prompt: 'fixture' } }
      : input.includes('out-of-scope')
      ? { type: 'tool-call', id: CallId('outside-' + this.calls), name: 'media_route', arguments: { taskType: 'image2video', prompt: 'fixture', inputImageUrl: 'https://fixture.invalid/input.png' } }
      : input.includes('plain-chat')
      ? { type: 'text', text: 'Plain reply' }
      : this.calls < 3
      ? { type: 'tool-call', id: CallId('call-' + this.calls), name: 'media_route', arguments: { taskType: 'text2image', prompt: 'fixture' } }
      : { type: 'text', text: 'Fixture media complete' };
    yield { type: 'block-start', index: 0, blockType: answer.type };
    yield { type: 'block-end', index: 0, block: answer };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: answer.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  }
}
ctx.llm.registerAdapter(['budget-fixture'], new FixtureAdapter());
const { apply } = await import(pathToFileURL(path.join(process.env.F1_PROFILE, 'persistent-runner.mjs')));
apply(ctx);
`;

test('same persistent session keeps zero-tool Run closed and accepts a later explicitly budgeted media Run', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-f1-budget-change-'));
  const home = path.join(tmp, 'dsh');
  const profile = path.join(home, 'profiles/run-persistent');
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(path.join(root, 'shell/node_modules'), path.join(profile, 'node_modules'), 'dir');
  for (const [source, target] of [
    ['shell/persistent-runner.mjs', 'persistent-runner.mjs'],
    ['shell/tasks/budget.cjs', 'budget.cjs'],
    ['shell/runtime/usage.cjs', 'usage.cjs'],
    ['shell/runtime/native-image-message.mjs', 'native-image-message.mjs'],
    ['business/media/presets.cjs', 'presets.cjs'],
    ['business/attribution/ga-connector/executor.js', 'ga-query-executor.cjs'],
  ]) fs.copyFileSync(path.join(root, source), path.join(profile, target));
  fs.copyFileSync(path.join(root, 'shell/runtime/run-budget-media.json'), path.join(profile, 'run-budget-media.json'));
  const policyPath = path.join(profile, 'run-budget.json');
  fs.copyFileSync(path.join(root, 'shell/runtime/run-budget.json'), policyPath);
  let stdout = '', stderr = '', closed = false;
  const frames = [], requests = [];
  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: tmp,
    env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DSH_HOME: home, F1_ROOT: root, F1_PROFILE: profile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (!closed) { const exit = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await exit; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  child.once('close', () => { closed = true; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = frame => child.stdin.write(JSON.stringify({ protocolVersion: 1, ...frame }) + '\n');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      frames.push(frame);
      if (frame.type === 'tool_request') {
        requests.push(frame);
        send({ type: 'tool_response', sessionId: frame.sessionId, requestId: frame.requestId, ok: true,
          result: { taskType: 'text2image', label: '文生图', model: 'fixture-image', provider: 'fixture',
            kind: 'image', url: 'https://fixture.invalid/result.png', elapsedMs: 1 } });
      }
    }
  });
  async function wait(predicate, label) {
    const until = Date.now() + 15_000;
    while (!predicate() && !closed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), label + '\n' + stderr + '\n' + JSON.stringify(frames));
  }
  await wait(() => frames.some(frame => frame.type === 'ready'), 'runner ready');
  const task = () => send({ type: 'task', sessionId: 'same-session', tenantId: 'fixture-tenant',
    provider: 'budget-fixture', model: 'fixture-chat', task: 'Generate an image' });
  task();
  await wait(() => frames.filter(frame => frame.type === 'done').length === 1, 'zero-tool Run finished');
  const first = frames.find(frame => frame.type === 'done');
  assert.equal(first.ok, false);
  assert.equal(first.budget.limits.maxToolCalls, 0);
  assert.equal(requests.length, 0, 'zero-tool Run must not reach host RPC or provider POST');

  fs.writeFileSync(policyPath, JSON.stringify({ maxDurationMs: 15_000, maxModelCalls: 2,
    maxToolCalls: 1, maxToolCallsPerKey: 1, maxRetries: 0, maxOutputTokens: 256,
    allowedTools: ['media_route'], allowedMediaTaskTypes: ['text2image'] }));
  task();
  await wait(() => frames.filter(frame => frame.type === 'done').length === 2, 'later budgeted Run finished');
  const second = frames.filter(frame => frame.type === 'done')[1];
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(requests.length, 1, 'only the later Run reaches host RPC');
  assert.equal(second.budget.snapshot.toolCalls, 1);
  assert.equal(second.budget.snapshot.modelCalls, 2);
  assert.equal(second.media[0].url, 'https://fixture.invalid/result.png');
  assert.deepEqual(second.budget.limits.allowedTools, ['media_route']);
  assert.deepEqual(second.budget.limits.allowedMediaTaskTypes, ['text2image']);

  fs.copyFileSync(path.join(root, 'shell/runtime/run-budget.json'), policyPath);
  send({ type: 'task', sessionId: 'plain-session', tenantId: 'fixture-tenant',
    provider: 'budget-fixture', model: 'fixture-chat', task: 'plain-chat: answer in text' });
  await wait(() => frames.filter(frame => frame.type === 'done').length === 3, 'ordinary text Run finished');
  const plain = frames.filter(frame => frame.type === 'done')[2];
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(plain.text, 'Plain reply');
  assert.equal(plain.budget.limits.maxToolCalls, 0);
  assert.equal(requests.length, 1, 'ordinary text Run must not add a host RPC');

  fs.writeFileSync(policyPath, JSON.stringify({ maxDurationMs: 15_000, maxModelCalls: 2,
    maxToolCalls: 1, maxToolCallsPerKey: 1, maxRetries: 0,
    allowedTools: ['media_route'], allowedMediaTaskTypes: ['text2image'] }));
  send({ type: 'task', sessionId: 'outside-session', tenantId: 'fixture-tenant',
    provider: 'budget-fixture', model: 'fixture-chat', task: 'out-of-scope: generate video' });
  await wait(() => frames.filter(frame => frame.type === 'done').length === 4, 'out-of-scope Run finished');
  const outside = frames.filter(frame => frame.type === 'done')[3];
  assert.equal(outside.ok, false);
  assert.equal(requests.length, 1, 'other media task cannot reach host RPC');
  assert.equal(outside.budget.snapshot.toolCalls, 0);

  fs.writeFileSync(policyPath, JSON.stringify({ maxDurationMs: 15_000, maxModelCalls: 2,
    maxToolCalls: 1, maxRetries: 0, allowedMediaTaskTypes: ['text2image'] }));
  send({ type: 'task', sessionId: 'invalid-policy', tenantId: 'fixture-tenant',
    provider: 'budget-fixture', model: 'fixture-chat', task: 'out-of-scope: invalid config' });
  await wait(() => frames.filter(frame => frame.type === 'done').length === 5, 'invalid policy rejected');
  const invalid = frames.filter(frame => frame.type === 'done')[4];
  assert.equal(invalid.code, 'RUN_BUDGET_CONFIG_INVALID');
  assert.equal(requests.length, 1);
  // A separate host-selected profile scopes its task without editing the
  // shipped zero-tool default or leaking this permission into the next turn.
  fs.copyFileSync(path.join(root, 'shell/runtime/run-budget.json'), policyPath);
  send({type:'task',sessionId:'controlled-media-session',tenantId:'fixture-tenant',provider:'budget-fixture',model:'fixture-chat',task:'controlled-profile',budgetProfile:'media:text2image'});
  await wait(()=>frames.filter(frame=>frame.type==='done').length===6,'controlled profile completed');
  const controlled=frames.filter(frame=>frame.type==='done')[5];
  assert.equal(controlled.ok,true,JSON.stringify(controlled));assert.equal(requests.length,2);
  assert.equal(controlled.budget.snapshot.toolCalls,1);assert.equal(controlled.budget.limits.maxRetries,0);
  assert.deepEqual(frames.filter(frame=>frame.type==='fixture_request_config').slice(-2).map(frame=>frame.maxTokens),[512,512]);
  send({type:'task',sessionId:'controlled-wrong-task',tenantId:'fixture-tenant',provider:'budget-fixture',model:'fixture-chat',task:'controlled-profile wrong-task',budgetProfile:'media:text2image'});
  await wait(()=>frames.filter(frame=>frame.type==='done').length===7,'controlled wrong task denied');
  assert.equal(requests.length,2,'other task cannot reach RPC with controlled profile');
  send({type:'task',sessionId:'controlled-media-session',tenantId:'fixture-tenant',provider:'budget-fixture',model:'fixture-chat',task:'plain-chat'});
  await wait(()=>frames.filter(frame=>frame.type==='done').length===8,'default policy restored on warm session');
  assert.equal(frames.filter(frame=>frame.type==='done')[7].budget.limits.maxToolCalls,0);
  assert.equal(frames.filter(frame=>frame.type==='fixture_request_config').at(-1).maxTokens,128,'actual warm provider request uses current Run cap');
  assert.equal(requests.length,2);

});
