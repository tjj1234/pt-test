/** Locked SDK and shipped runner with deterministic model transport and real CSV host handler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCsvRunHandler } from '../../shell/tasks/csv-run-handler.cjs';
import { createModelIntentHandler, RPC_NAME } from '../../shell/usage/model-intent-handler.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(process.env.F2_ROOT, 'shell/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter, CallId }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
].map(load));
const ctx = new Context();
for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
ctx.provide('loader', { await: async () => {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'f2-fixture', model: 'fixture-chat' }) });
ctx.provide('appExit', code => process.exit(code));
class FixtureAdapter extends LlmAdapter {
  counts = new Map();
  async *stream(options) {
    const sid = String(options.sessionId);
    const n = (this.counts.get(sid) || 0) + 1; this.counts.set(sid, n);
    const block = n === 1
      ? { type: 'tool-call', id: CallId('call-' + sid), name: 'csv_analyze', arguments: JSON.parse(process.env.F2_SELECTOR) }
      : { type: 'text', text: 'CSV sum completed' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  }
}
ctx.llm.registerAdapter(['f2-fixture'], new FixtureAdapter());
const { apply } = await import(pathToFileURL(path.join(process.env.F2_PROFILE, 'persistent-runner.mjs')));
apply(ctx);
`;

test('real locked SDK traverses CSV Run tool, emits durable artifact and completes with bounded policy', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-f2-sdk-'));
  const profile = path.join(tmp, 'dsh', 'profiles', 'run-persistent');
  const uploadsRoot = path.join(tmp, 'uploads');
  const workspaceRoot = path.join(tmp, 'workspaces');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(workspaceRoot);
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const sourceRef = `/uploads/${tenantId}/sample.csv`;
  const bytes = Buffer.from('amount\n0\n2\n2\n');
  const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(path.join(uploadsRoot, tenantId), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, tenantId, 'sample.csv'), bytes);
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
  fs.copyFileSync(path.join(root, 'shell/runtime/run-budget.json'), path.join(profile, 'run-budget.json'));
  fs.copyFileSync(path.join(root, 'shell/runtime/run-budget-csv.json'), path.join(profile, 'run-budget-csv.json'));
  const args = { sourceRef, sourceSha256, operation: 'sum', column: 1, startRow: 2 };
  const emitted = [];
  const intents = [];
  const modelIntent = createModelIntentHandler({ selectedModel: 'fixture-chat',
    priceStore: { selectNow: async () => ({ requestedAt: new Date().toISOString(), catalogId: null,
      sourceSha256: null, snapshot: null, coverage: 'unknown', reasonCode: 'NO_RECORDED_CATALOG' }) },
    emit: async (...event) => intents.push(event),
  });
  const handler = createCsvRunHandler({ uploadsRoot, workspaceRoot, runId,
    identity: { userId: 'user-a', tenantId }, documentRefs: [sourceRef],
    attachmentEvidence: [{ ref: sourceRef, sha256: sourceSha256, size: bytes.length }],
    confirmedSelections: [{ sourceRef, sourceSha256, headerRow: 1, startRow: 2, column: 1 }],
    emit: async (...event) => emitted.push(event),
  });
  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DSH_HOME: path.join(tmp, 'dsh'),
      F2_ROOT: root, F2_PROFILE: profile, F2_SELECTOR: JSON.stringify(args) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false, stdout = '', stderr = '';
  const frames = [];
  child.once('close', () => { closed = true; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      frames.push(frame);
      if (frame.type === 'tool_request') {
        Promise.resolve().then(() => {
          if (frame.sessionId === 'f3-ledger-denied') throw Object.assign(new Error('fixture storage unavailable'), { code: 'LEDGER_UNAVAILABLE' });
          return frame.name === RPC_NAME ? modelIntent.handle(frame) : handler.handle({ args: frame.args });
        }).then(
          result => child.stdin.write(JSON.stringify({ type: 'tool_response', protocolVersion: 1,
            sessionId: frame.sessionId, requestId: frame.requestId, ok: true, result }) + '\n'),
          error => child.stdin.write(JSON.stringify({ type: 'tool_response', protocolVersion: 1,
            sessionId: frame.sessionId, requestId: frame.requestId, ok: false,
            code: error.code || 'CSV_TEST_ERROR', error: 'CSV fixture failed' }) + '\n'),
        );
      }
    }
  });
  t.after(async () => {
    if (!closed) { const exited = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate() && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), `${label}\n${stderr}\n${JSON.stringify(frames)}`);
  };
  await wait(() => frames.some(frame => frame.type === 'ready'), 'runner ready');
  child.stdin.write(JSON.stringify({ type: 'task', protocolVersion: 1, sessionId: 'f2-csv',
    tenantId, provider: 'f2-fixture', model: 'fixture-chat', budgetProfile: 'csv', recordModelIntents: true, task: 'Sum selected CSV column' }) + '\n');
  await wait(() => frames.some(frame => frame.type === 'done'), 'runner done');
  const done = frames.find(frame => frame.type === 'done');
  assert.equal(done.ok, true, `${JSON.stringify(done)}\n${stderr}`);
  assert.match(done.text, /CSV sum completed/);
  assert.equal(done.budget.snapshot.modelCalls, 2);
  assert.equal(done.budget.snapshot.toolCalls, 1);
  assert.equal(frames.filter(frame => frame.type === 'tool_request' && frame.name !== RPC_NAME).length, 1);
  assert.equal(intents.length, 2, 'both actual SDK model requests are admitted through the host ledger');
  assert.equal(intents.every(event => event[1].action === 'model_request_intent' && event[1].price.coverage === 'unknown'), true);
  assert.notEqual(intents[0][1].step, intents[1][1].step);
  assert.equal(done.modelIdentity.responses.length, 2);
  assert.equal(done.modelIdentity.responses.every(row => Number.isSafeInteger(row.turn) && Number.isSafeInteger(row.step)), true,
    'response coordinates survive collection for exact call-to-response matching');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'artifact');
  const rel = emitted[0][1].artifact.rel;
  assert.match(fs.readFileSync(path.join(workspaceRoot, tenantId, rel), 'utf8'), /summary/);
  child.stdin.write(JSON.stringify({ type: 'task', protocolVersion: 1, sessionId: 'f2-default',
    tenantId, provider: 'f2-fixture', model: 'fixture-chat', task: 'Try CSV without confirmed profile' }) + '\n');
  await wait(() => frames.some(frame => frame.type === 'done' && frame.sessionId === 'f2-default'), 'default run denied');
  const defaultDone = frames.find(frame => frame.type === 'done' && frame.sessionId === 'f2-default');
  assert.equal(defaultDone.ok, false);
  assert.equal(defaultDone.budget.snapshot.modelCalls, 1);
  assert.equal(defaultDone.budget.snapshot.toolCalls, 0);
  assert.equal(frames.filter(frame => frame.type === 'tool_request' && frame.name !== RPC_NAME).length, 1);
  child.stdin.write(JSON.stringify({ type: 'task', protocolVersion: 1, sessionId: 'f3-ledger-denied',
    tenantId, provider: 'f2-fixture', model: 'fixture-chat', recordModelIntents: true, task: 'Do not call without a durable intent' }) + '\n');
  await wait(() => frames.some(frame => frame.type === 'done' && frame.sessionId === 'f3-ledger-denied'), 'ledger failure closes the Run');
  const ledgerFailure = frames.find(frame => frame.type === 'done' && frame.sessionId === 'f3-ledger-denied');
  assert.equal(ledgerFailure.ok, false);
  assert.equal(ledgerFailure.usageEvidence.observedResponses, 0, 'no model response exists when intent persistence was rejected');
  assert.equal(frames.some(frame => frame.sessionId === 'f3-ledger-denied' && frame.type === 'step'), false);
});
