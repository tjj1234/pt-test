import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = String.raw`
import { pathToFileURL } from 'node:url';
const { apply } = await import(pathToFileURL(process.env.RUNNER_PATH).href);
const { LlmError } = await import(new URL('./node_modules/@deepseek-ai/dsh-llm/lib/index.js', pathToFileURL(process.env.RUNNER_PATH)).href);
const listeners = new Map();
const agentsBySession = new Map();
const emitEvent = (agent, event) => {
  const stored = { seq: ++agent.session.seq, type: event.type, data: event.data || {} };
  agent.session.events.push(stored);
  for (const listener of listeners.get('session/event') || []) listener(agent.session, event);
};
const modelHooks = new Map();
const validArgs = {
  media_route: { taskType: 'text2image', prompt: 'fixture' },
  ga_query: { metrics: ['sessions'], dateRange: { startDate: '2026-10-01', endDate: '2026-10-02' } },
};
const ctx = {
  get(key) {
    if (key === 'loader') return { await: async () => {} };
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }) };
    if (key === 'agents') return { create: async (options) => {
      const sid = String(options.sessionId).replace(/^session-/, '');
      const tools = new Map();
      const agentCtx = {
        tools: { register: (tool) => tools.set(tool.name, tool) },
        on: (type, listener) => {
          const key = sid + ':' + type;
          const entries = modelHooks.get(key) || [];
          entries.push(listener);
          modelHooks.set(key, entries);
          return () => modelHooks.set(key, (modelHooks.get(key) || []).filter((entry) => entry !== listener));
        },
      };
      options.setup(agentCtx);
      if (sid === 'PLAIN_ERROR') {
        const key = sid + ':agent/request';
        const entries = modelHooks.get(key) || [];
        entries.push(async () => { throw new Error('fixture private request error'); });
        modelHooks.set(key, entries);
      }
      const agent = {
        session: { seq: 0, events: [] },
        cancel() { this.cancelled = true; if (sid === 'SHUTDOWN' && this.releaseShutdown) this.releaseShutdown(); },
        whenIdle() { return this.idle || Promise.resolve(); },
        followup() {
          const turnNumber = (this.session.turnNumber || 0) + 1;
          this.session.turnNumber = turnNumber;
          this.idle = (async () => {
            const waterfall = async (type, payload, initial) => {
              let next = initial;
              for (const hook of [...(modelHooks.get(sid + ':' + type) || [])].reverse()) {
                const downstream = next;
                next = () => type === 'system-prompt/assemble' ? hook(payload, {}, downstream) : hook(payload, downstream);
              }
              return next();
            };
            const assembled = await waterfall('system-prompt/assemble', {}, async () => ({ variables: {} }));
            let modelDispatches = 0;
            let requestConfig;
            try { requestConfig = await waterfall('agent/request', {}, async () => { modelDispatches++; process.stdout.write(JSON.stringify({ type: 'fixture_model_dispatch', sessionId: sid }) + '\n'); return { provider: 'default', model: 'default' }; }); }
            catch (error) {
              if (sid !== 'COST_ONLY' && sid !== 'PLAIN_ERROR') throw error;
              const failure = error instanceof LlmError ? error.failure : { message: error.message, code: 'UNKNOWN' };
              process.stdout.write(JSON.stringify({ type: 'fixture_check', sessionId: sid, modelDispatches, denied: failure.code }) + '\n');
              emitEvent(this, { type: 'turn/start', data: {} });
              emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'error', error: failure } } });
              return;
            }
            if (sid === 'C' || sid === 'COST_ONLY') {
              let denied;
              try {
                await waterfall('agent/request', {}, async () => { modelDispatches++; process.stdout.write(JSON.stringify({ type: 'fixture_model_dispatch', sessionId: sid }) + '\n'); return requestConfig; });
              } catch (error) { denied = error instanceof LlmError ? error.failure.code : 'UNKNOWN'; }
              process.stdout.write(JSON.stringify({ type: 'fixture_check', sessionId: sid, modelDispatches, denied }) + '\n');
              if (denied) {
                emitEvent(this, { type: 'turn/start', data: {} });
                emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: denied, message: 'fixture normalized failure' } } } });
                return;
              }
            }
            this.session.selectedModel = requestConfig.model;
            emitEvent(this, { type: 'turn/start', data: {} });
            if (sid === 'NO_TEXT') {
              emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
              return;
            }
            if (sid === 'ABORTED') {
              emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'aborted', error: Object.assign(new Error('fixture provider interruption'), { code: 'FIXTURE_PROVIDER_ABORT' }) } } });
              return;
            }
            if (sid === 'INCOMPLETE') {
              emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'yielded' } } });
              return;
            }
            if (sid === 'WHITESPACE') {
              emitEvent(this, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '   \n  ' }] } } });
              emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
              return;
            }
            if (sid === 'SHUTDOWN') {
              process.stdout.write(JSON.stringify({ type: 'fixture_started', sessionId: sid }) + '\n');
              await new Promise((resolve) => { this.releaseShutdown = resolve; });
              emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'hook' } } });
              return;
            }
            const mediaCallId = sid + '-' + turnNumber + '-media';
            emitEvent(this, { type: 'tool/call', data: { callId: mediaCallId, name: 'media_route', arguments: validArgs.media_route } });
            const media = await tools.get('media_route').execute(validArgs.media_route);
            emitEvent(this, { type: 'tool/result', data: { message: { source: { callId: mediaCallId }, content: [{ type: 'tool-result', content: [{ text: 'media ' + sid }], isError: false }] } } });
            const reportCallId = sid + '-' + turnNumber + '-report';
            emitEvent(this, { type: 'tool/call', data: { callId: reportCallId, name: 'ga_query', arguments: validArgs.ga_query } });
            const report = await tools.get('ga_query').execute(validArgs.ga_query);
            emitEvent(this, { type: 'tool/result', data: { message: { source: { callId: reportCallId }, content: [{ type: 'tool-result', content: [{ text: 'report ' + sid }], isError: false }] } } });
            const text = 'answer ' + sid + ' ' + turnNumber + ' via ' + this.session.selectedModel;
            emitEvent(this, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, usage: { inputTokens: 1, outputTokens: sid === 'A' ? 11 : 22 } } });
            emitEvent(this, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          })();
        },
      };
      agentsBySession.set(sid, agent);
      return { agent };
    } };
    if (key === 'sessions') return { flush: async () => {} };
    if (key === 'persistentRunnerExecutors') return { gaQuery: async (_args, { tenantId }) => ({ id: 'report-' + tenantId, tenantId }) };
    if (key === 'appExit') return () => {};
    return undefined;
  },
  on(type, listener) { const values = listeners.get(type) || []; values.push(listener); listeners.set(type, values); },
};
apply(ctx);
`;

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test('persistent runner runs distinct sessions concurrently with isolated result, budget, tenant and step state', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-runner-parallel-'));
  const profileDir = path.join(tmp, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const require = createRequire(import.meta.url);
  const { buildRunBudgetUsage } = require(path.join(repoRoot, 'shell/tasks/run-budget-event.cjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/persistent-runner.mjs'), path.join(profileDir, 'persistent-runner.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/tasks/budget.cjs'), path.join(profileDir, 'budget.cjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/runtime/usage.cjs'), path.join(profileDir, 'usage.cjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/runtime/native-image-message.mjs'), path.join(profileDir, 'native-image-message.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/runtime/dsh-native-context-r4-candidate.mjs'), path.join(profileDir, 'dsh-native-context-r4-candidate.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/runtime/published-skill-provider.mjs'), path.join(profileDir, 'published-skill-provider.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'shell/skills/release-snapshot.cjs'), path.join(profileDir, 'skill-release-snapshot.cjs'));
  fs.copyFileSync(path.join(repoRoot, 'business/media/presets.cjs'), path.join(profileDir, 'presets.cjs'));
  fs.copyFileSync(path.join(repoRoot, 'business/attribution/ga-connector/executor.js'), path.join(profileDir, 'ga-query-executor.cjs'));
  fs.symlinkSync(path.join(repoRoot, 'shell/node_modules'), path.join(profileDir, 'node_modules'), 'dir');
  const dshHome = path.join(tmp, 'dsh');
  const budgetDir = path.join(dshHome, 'profiles', 'run-persistent');
  fs.mkdirSync(budgetDir, { recursive: true });
  fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxModelCalls: 1, maxRetries: 0, maxToolCalls: 2, maxDurationMs: 15000 }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: repoRoot,
    env: { ...process.env, RUNNER_PATH: path.join(profileDir, 'persistent-runner.mjs'), DSH_HOME: dshHome, PT_DASH_INTERNAL_KEY: '', DASH_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });
  let output = '';
  let stderr = '';
  const frames = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    let index;
    while ((index = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, index).trim();
      output = output.slice(index + 1);
      if (line) { try { frames.push(JSON.parse(line)); } catch { /* malformed output is caught by missing protocol frames */ } }
    }
  });
  const send = (frame) => child.stdin.write(JSON.stringify({ ...frame, protocolVersion: 1 }) + '\n');
  try { await waitFor(() => frames.some((frame) => frame.type === 'ready'), 'runner ready'); }
  catch (error) { assert.fail(`${error.message}; stderr=${stderr}`); }
  send({ type: 'task', sessionId: 'C', tenantId: 'tenant-C', task: 'budget cap', model: 'model-C' });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'C'), 'model-call cap completion');
  const doneC = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'C');
  const checkC = frames.find((frame) => frame.type === 'fixture_check' && frame.sessionId === 'C');
  assert.equal(checkC.denied, 'RUN_MODEL_CALL_LIMIT');
  assert.equal(checkC.modelDispatches, 1, 'second model request is rejected before dispatch');
  assert.equal(doneC.ok, false);
  assert.equal(doneC.code, 'RUN_MODEL_CALL_LIMIT');
  assert.equal(doneC.canceled, false, 'budget denial is a failed Run, not a user stop');
  assert.match(doneC.error, /model-call budget/);
  assert.equal(doneC.error.includes('fixture private budget detail'), false, 'raw SDK detail is not sent to the user-facing frame');
  assert.equal(doneC.budget.snapshot.modelCalls, 1);
  assert.equal(doneC.budget.snapshot.retries, 0);

  fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxCost: { amount: 1.25, currency: ' USD ' } }));
  send({ type: 'task', sessionId: 'COST_ONLY', tenantId: 'tenant-COST_ONLY', task: 'cost only must fail closed', model: 'model-COST_ONLY' });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'COST_ONLY'), 'cost-only fail-closed completion');
  const doneCostOnly = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'COST_ONLY');
  const checkCostOnly = frames.find((frame) => frame.type === 'fixture_check' && frame.sessionId === 'COST_ONLY');
  assert.equal(checkCostOnly.denied, 'RUN_COST_UNKNOWN');
  assert.equal(checkCostOnly.modelDispatches, 0, 'missing trusted estimate blocks before the model request callback');
  assert.equal(doneCostOnly.code, 'RUN_COST_UNKNOWN');
  assert.equal(doneCostOnly.budget.limits.maxCost.amount, 1.25);
  assert.equal(doneCostOnly.budget.limits.maxCost.currency, 'USD');
  assert.equal(doneCostOnly.budget.snapshot.costStatus, 'unknown');
  assert.equal(Object.hasOwn(doneCostOnly.budget.snapshot, 'reserved'), false);
  assert.equal(Object.hasOwn(doneCostOnly.budget.snapshot, 'spent'), false);
  const projectedCostEvent = buildRunBudgetUsage(doneCostOnly.budget);
  assert.deepEqual(projectedCostEvent.limits.maxCost, { amount: 1.25, currency: 'USD' });
  assert.equal(projectedCostEvent.snapshot.costStatus, 'unknown');

  fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxModelCalls: 1 }));
  send({ type: 'task', sessionId: 'PLAIN_ERROR', tenantId: 'tenant-PLAIN_ERROR', task: 'plain SDK error contrast', model: 'model-PLAIN_ERROR' });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'PLAIN_ERROR'), 'plain SDK error completion');
  const plainErrorCheck = frames.find((frame) => frame.type === 'fixture_check' && frame.sessionId === 'PLAIN_ERROR');
  const plainErrorDone = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'PLAIN_ERROR');
  assert.equal(plainErrorCheck.denied, 'UNKNOWN', 'the SDK normalization contrast maps ordinary Error to UNKNOWN');
  assert.equal(plainErrorCheck.modelDispatches, 0);
  assert.equal(plainErrorDone.code, 'AGENT_TURN_INCOMPLETE', 'runner maps unknown error reason to a failed terminal result');
  assert.equal(plainErrorDone.ok, false);
  assert.equal(plainErrorDone.error.includes('fixture private request error'), false);

  for (const [sessionId, maxCost] of [
    ['COST_BAD_AMOUNT', { amount: '1', currency: 'USD' }],
    ['COST_BAD_CURRENCY', { amount: 1, currency: '   ' }],
  ]) {
    fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxCost }));
    send({ type: 'task', sessionId, tenantId: 'tenant-' + sessionId, task: 'invalid cost config', model: 'model-' + sessionId });
    await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === sessionId), sessionId + ' rejection');
    const invalidCostDone = frames.find((frame) => frame.type === 'done' && frame.sessionId === sessionId);
    assert.equal(invalidCostDone.code, 'RUN_BUDGET_CONFIG_INVALID');
    assert.equal(frames.some((frame) => frame.type === 'tool_request' && frame.sessionId === sessionId), false);
    assert.equal(frames.filter((frame) => frame.type === 'fixture_model_dispatch' && frame.sessionId === sessionId).length, 0,
      'invalid cost configuration is rejected before the fake model dispatch callback');
  }
  fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxModelCalls: 1, maxRetries: 0, maxToolCalls: 2, maxDurationMs: 15000 }));

  send({ type: 'task', sessionId: 'A', tenantId: 'tenant-A', task: 'A work', model: 'model-A1' });
  send({ type: 'task', sessionId: 'B', tenantId: 'tenant-B', task: 'B work', model: 'model-B' });

  try { await waitFor(() => frames.some((frame) => frame.type === 'tool_request' && frame.sessionId === 'A'), 'A parent RPC pending'); }
  catch (error) { assert.fail(`${error.message}; frames=${JSON.stringify(frames)}; stderr=${stderr}`); }
  await waitFor(() => frames.some((frame) => frame.type === 'tool_request' && frame.sessionId === 'B'), 'B runs while A is still awaiting parent RPC');
  send({ type: 'task', sessionId: 'A', tenantId: 'tenant-A', task: 'A second work', model: 'model-A2' });
  const requestB = frames.find((frame) => frame.type === 'tool_request' && frame.sessionId === 'B');
  send({ type: 'tool_response', sessionId: 'B', requestId: requestB.requestId, ok: true, result: { kind: 'image', url: 'https://fixture/B.png', model: 'model-B' } });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'B'), 'B completion before A response');
  assert.equal(frames.some((frame) => frame.type === 'done' && frame.sessionId === 'A'), false, 'A remains in flight while B completes');

  const doneB = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'B');
  assert.equal(doneB.text, 'answer B 1 via model-B');
  assert.equal(doneB.usage.inputTokens, 1);
  assert.equal(doneB.usageEvidence.observedResponses, 1);
  assert.equal(doneB.usageEvidence.coverage, 'complete');
  assert.deepEqual(doneB.media, [{ type: 'image', url: 'https://fixture/B.png' }]);
  assert.deepEqual(doneB.report, [{ id: 'report-tenant-B', tenantId: 'tenant-B' }]);
  assert.equal(doneB.budget.snapshot.toolCalls, 2);
  assert.equal(doneB.budget.snapshot.modelCalls, 1);
  assert.equal(doneB.budget.snapshot.retries, 0);
  assert.equal(doneB.budget.snapshot.costStatus, 'unlimited', 'no-cost-cap requests keep the existing budget behavior');
  assert.equal(doneB.budget.status, 'configured');
  const bMediaStep = frames.find((frame) => frame.type === 'step' && frame.sessionId === 'B' && frame.callId === 'B-1-media' && frame.phase === 'result');
  assert.equal(bMediaStep.modelName, 'model-B');
  assert.equal(bMediaStep.sessionId, 'B');

  assert.equal(frames.some((frame) => frame.type === 'tool_request' && frame.sessionId === 'A' && frame.name === 'media.route' && frame.requestId !== frames.find((item) => item.type === 'tool_request' && item.sessionId === 'A')?.requestId), false, 'same-session second task waits for A first task');
  const requestA = frames.find((frame) => frame.type === 'tool_request' && frame.sessionId === 'A');
  send({ type: 'tool_response', sessionId: 'A', requestId: requestA.requestId, ok: true, result: { kind: 'video', url: 'https://fixture/A.mp4', model: 'model-A' } });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'A'), 'A completion');
  const doneA = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'A');
  assert.equal(doneA.text, 'answer A 1 via model-A1');
  assert.equal(doneA.usage.outputTokens, 11);
  assert.deepEqual(doneA.media, [{ type: 'video', url: 'https://fixture/A.mp4' }]);
  assert.deepEqual(doneA.report, [{ id: 'report-tenant-A', tenantId: 'tenant-A' }]);
  assert.equal(doneA.budget.snapshot.toolCalls, 2);
  assert.equal(doneA.budget.snapshot.modelCalls, 1);
  assert.equal(doneA.budget.snapshot.retries, 0);
  assert.equal(doneA.budget.status, 'configured');
  const aMediaStep = frames.find((frame) => frame.type === 'step' && frame.sessionId === 'A' && frame.callId === 'A-1-media' && frame.phase === 'result');
  assert.equal(aMediaStep.modelName, 'model-A');
  assert.equal(aMediaStep.sessionId, 'A');
  await waitFor(() => frames.some((frame) => frame.type === 'tool_request' && frame.sessionId === 'A' && frame.name === 'media.route' && frame.requestId !== requestA.requestId), 'A second task starts after first finishes');
  const requestA2 = frames.find((frame) => frame.type === 'tool_request' && frame.sessionId === 'A' && frame.requestId !== requestA.requestId);
  send({ type: 'tool_response', sessionId: 'A', requestId: requestA2.requestId, ok: true, result: { kind: 'image', url: 'https://fixture/A2.png', model: 'model-A2' } });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'A' && frame.text === 'answer A 2 via model-A2'), 'same-session second task completion');
  const doneA2 = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'A' && frame.text === 'answer A 2 via model-A2');
  assert.equal(doneA2.usage.outputTokens, 11);
  assert.deepEqual(doneA2.media, [{ type: 'image', url: 'https://fixture/A2.png' }]);
  assert.equal(frames.filter((frame) => frame.type === 'done').length, 8);
  assert.equal(stderr.includes('tenant'), false);

  fs.unlinkSync(path.join(budgetDir, 'run-budget.json'));
  send({ type: 'task', sessionId: 'D', tenantId: 'tenant-D', task: 'missing budget must block', model: 'model-D' });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'D'), 'missing-budget fail-closed response');
  const doneD = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'D');
  assert.match(doneD.error, /Run budget configuration is missing or unreadable/);
  assert.equal(frames.some((frame) => frame.type === 'tool_request' && frame.sessionId === 'D'), false);
  fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxModelCalls: 1, maxRetries: 0, maxToolCalls: 2, maxDurationMs: 15000 }));

  for (const sid of ['NO_TEXT', 'ABORTED', 'INCOMPLETE']) {
    send({ type: 'task', sessionId: sid, tenantId: 'tenant-' + sid, task: 'diagnostic fixture', model: 'model-' + sid });
    await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === sid), sid + ' diagnostic completion');
  }
  const noText = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'NO_TEXT');
  assert.equal(noText.ok, false);
  assert.equal(noText.code, 'EMPTY_ASSISTANT_RESPONSE', JSON.stringify(noText));
  assert.equal(noText.error, 'Agent turn completed without producing assistant text');
  const aborted = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'ABORTED');
  assert.equal(aborted.ok, false);
  assert.equal(aborted.code, 'AGENT_TURN_ABORTED');
  assert.equal(aborted.canceled, false, 'an unexpected SDK abort is a failure, not a user stop');
  assert.match(aborted.error, /details were withheld/);
  assert.equal(aborted.error.includes('fixture provider interruption'), false);
  const incomplete = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'INCOMPLETE');
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'AGENT_TURN_INCOMPLETE');
  assert.match(incomplete.error, /reason=yielded/);
  send({ type: 'task', sessionId: 'WHITESPACE', tenantId: 'tenant-WHITESPACE', task: 'whitespace diagnostic fixture', model: 'model-WHITESPACE' });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'WHITESPACE'), 'whitespace-only response rejection');
  const whitespace = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'WHITESPACE');
  assert.equal(whitespace.ok, false);
  assert.equal(whitespace.code, 'EMPTY_ASSISTANT_RESPONSE');

  send({ type: 'task', sessionId: 'SHUTDOWN', tenantId: 'tenant-SHUTDOWN', task: 'shutdown diagnostic fixture', model: 'model-SHUTDOWN' });
  await waitFor(() => frames.some((frame) => frame.type === 'fixture_started' && frame.sessionId === 'SHUTDOWN'), 'active turn before process shutdown');
  send({ type: 'exit' });
  await waitFor(() => frames.some((frame) => frame.type === 'done' && frame.sessionId === 'SHUTDOWN'), 'shutdown-interrupted Run result');
  const shutdown = frames.find((frame) => frame.type === 'done' && frame.sessionId === 'SHUTDOWN');
  assert.equal(shutdown.ok, false);
  assert.equal(shutdown.code, 'RUN_INTERRUPTED');
  assert.equal(shutdown.canceled, false, 'process shutdown is not reported as a user stop');

  child.stdin.end();
  await waitFor(() => frames.some((frame) => frame.type === 'bye'), 'drained shutdown');
});
