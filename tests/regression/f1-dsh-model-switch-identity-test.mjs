import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { normalizeModelIdentity } = require('../../shell/runtime/usage.cjs');
const harness = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(process.env.F1_ROOT, 'shell/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
 '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
 '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
].map(load));
const ctx = new Context();
for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
ctx.provide('loader', { await: async () => {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'identity-fixture', model: 'requested-a' }) });
ctx.provide('appExit', code => process.exit(code));
class FixtureAdapter extends LlmAdapter {
 async *stream(options) {
  const model = String(options.model);
  const answer = { type: 'text', text: 'fixture response for ' + model };
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'block-end', index: 0, block: answer };
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } };
  const response = { kind: 'pi-ai', version: 2, model,
    ...(model === 'requested-a' ? { responseModel: 'provider-reported-a' } : {}) };
  yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response, blocks: [{ type: 'text' }] } };
 }
}
ctx.llm.registerAdapter(['identity-fixture'], new FixtureAdapter());
const { apply } = await import(pathToFileURL(path.join(process.env.F1_PROFILE, 'persistent-runner.mjs')));
apply(ctx);
`;

const wait = async (predicate, label, diagnostics) => {
  const until = Date.now() + 15_000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), label + '\n' + diagnostics());
};

async function runnerFrames(tmp) {
  const home = path.join(tmp, 'runner-home');
  const profile = path.join(home, 'profiles/run-persistent');
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(path.join(root, 'shell/node_modules'), path.join(profile, 'node_modules'), 'dir');
  for (const [source, target] of [
    ['shell/persistent-runner.mjs', 'persistent-runner.mjs'], ['shell/tasks/budget.cjs', 'budget.cjs'],
    ['shell/runtime/usage.cjs', 'usage.cjs'], ['business/media/presets.cjs', 'presets.cjs'],
    ['shell/runtime/native-image-message.mjs', 'native-image-message.mjs'],
    ['shell/runtime/dsh-native-context-r4-candidate.mjs', 'dsh-native-context-r4-candidate.mjs'],
    ['business/attribution/ga-connector/executor.js', 'ga-query-executor.cjs'],
  ]) fs.copyFileSync(path.join(root, source), path.join(profile, target));
  fs.writeFileSync(path.join(profile, 'run-budget.json'), JSON.stringify({
    maxDurationMs: 10_000, maxModelCalls: 1, maxToolCalls: 0, maxToolCallsPerKey: 0, maxRetries: 0,
  }));
  const child = realSpawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DSH_HOME: home, F1_ROOT: root, F1_PROFILE: profile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = []; let stdout = '', stderr = '', closed = false;
  child.once('close', () => { closed = true; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      try { frames.push(JSON.parse(line)); } catch { /* diagnostic noise stays out of assertions */ }
    }
  });
  const diagnostics = () => stderr + '\n' + JSON.stringify(frames);
  await wait(() => frames.some(frame => frame.type === 'ready') || closed, 'runner ready', diagnostics);
  assert.equal(closed, false, diagnostics());
  const send = (model, task) => child.stdin.write(JSON.stringify({ protocolVersion: 1, type: 'task', sessionId: 'same-session',
    tenantId: 'fixture-tenant', provider: 'identity-fixture', model, task }) + '\n');
  send('requested-a', 'first fixture turn');
  await wait(() => frames.filter(frame => frame.type === 'done').length >= 1, 'first done', diagnostics);
  send('requested-b', 'second fixture turn');
  await wait(() => frames.filter(frame => frame.type === 'done').length >= 2, 'second done', diagnostics);
  const done = frames.filter(frame => frame.type === 'done');
  child.stdin.write(JSON.stringify({ protocolVersion: 1, type: 'exit' }) + '\n');
  await new Promise(resolve => { if (closed) resolve(); else child.once('close', resolve); });
  return done;
}

class FakeChild extends EventEmitter {
  constructor(outputFd) {
    super(); this.outputFd = outputFd; this.exitCode = null; this.killed = false; this.messages = [];
    this.stdin = { write: line => { try { this.messages.push(JSON.parse(String(line))); } catch {} return true; } };
    queueMicrotask(() => this.send({ type: 'ready', runner: 'persistent-runner',
      capabilities: ['task-v1', 'tool-rpc-v1', 'abort-v1'] }));
  }
  send(frame) { fs.writeSync(this.outputFd, JSON.stringify({ protocolVersion: 1, ...frame }) + '\n'); }
  kill() { if (this.killed) return; this.killed = true; this.exitCode = 0; this.emit('close', 0, null); }
}

test('same-session A to B records provider-reported identity only where DSH replay contains it', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-f1-identity-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const done = await runnerFrames(tmp);
  assert.equal(done[0].ok, true, JSON.stringify(done[0]));
  assert.equal(done[1].ok, true, JSON.stringify(done[1]));
  assert.match(done[0].text, /requested-a/);
  assert.match(done[1].text, /requested-b/);
  assert.deepEqual(done.map(frame => frame.modelIdentity.coverage), ['reported', 'unknown']);
  assert.equal(done[0].modelIdentity.responses[0].configuredModelId, 'requested-a');
  assert.equal(done[0].modelIdentity.responses[0].providerReportedModelId, 'provider-reported-a');
  assert.equal(done[1].modelIdentity.responses[0].configuredModelId, 'requested-b');
  assert.equal(done[1].modelIdentity.responses[0].providerReportedModelId, null);
  assert.equal(JSON.stringify(done.map(frame => frame.modelIdentity)).includes('fixture response'), false);

  const originalSpawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = (_command, _args, options) => {
    const child = new FakeChild(options.stdio[1]); children.push(child); return child;
  };
  const { createDshRuntime } = require('../../shell/runtime/dsh-adapter.cjs');
  const runtime = createDshRuntime({ dshHome: path.join(tmp, 'adapter-home'), settingsTemplate: path.join(root, 'shell/dsh-settings.yaml'),
    persistentRunner: path.join(root, 'shell/persistent-runner.mjs'), tmpDir: path.join(tmp, 'logs'), idleMs: 60_000, taskTimeoutMs: 3_000 });
  t.after(() => { runtime.close(); childProcess.spawn = originalSpawn; for (const child of children) child.kill(); });
  for (let index = 0; index < 2; index++) {
    const requested = index === 0 ? 'requested-a' : 'requested-b';
    const run = runtime.run({ sessionKey: 'same-conversation', tenantId: 'fixture-tenant', userId: 'fixture-user',
      workspace: tmp, apiKey: 'fixture-key', model: requested, question: 'fixture turn' });
    await wait(() => children.length && children[0].messages.filter(frame => frame.type === 'task').length > index,
      'adapter task ' + index, () => JSON.stringify(children.map(child => child.messages)));
    const child = children[0], task = child.messages.filter(frame => frame.type === 'task')[index];
    assert.equal(task.model, requested, 'task frame is a request, not provider identity');
    child.send({ ...done[index], sessionId: task.sessionId });
    const result = await run;
    assert.equal(result.ok, true);
    assert.deepEqual(result.modelIdentity, normalizeModelIdentity(done[index].modelIdentity));
  }
});
