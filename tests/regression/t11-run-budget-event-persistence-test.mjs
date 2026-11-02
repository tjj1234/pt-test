import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createSessionScheduler } = require('../../shell/runtime/session-scheduler.cjs');
const { createRunExecutionService } = require('../../shell/tasks/execution.cjs');
const { buildRunBudgetUsage } = require('../../shell/tasks/run-budget-event.cjs');

test('runner budget reaches the RPC result, host projection, and durable run_budget event', { timeout: 15000 }, async (t) => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false,
    'No external PostgreSQL configuration is permitted');

  const source = file => fs.readFileSync(path.join(root, file), 'utf8');
  const runner = source('shell/persistent-runner.mjs');
  const adapter = source('shell/runtime/dsh-adapter.cjs');
  const server = source('shell/server.cjs');
  const execution = source('shell/tasks/execution.cjs');
  const storeSource = source('shell/tasks/store.cjs');

  assert.match(runner, /type: "done"[\s\S]{0,900}budget: safeBudgetSummary\(activeBudget\)/,
    'persistent runner includes the aggregate budget summary in its done RPC frame');
  assert.match(adapter, /case "done"/);
  assert.match(adapter, /budget: frame\.budget && typeof frame\.budget === "object" \? frame\.budget : null/,
    'host adapter preserves the done frame budget in its resolved run result');
  assert.match(server, /require\("\.\/tasks\/run-budget-event\.cjs"\)/,
    'server loads the allowlisted durable event projection');
  assert.match(server, /await taskRun\.emit\("usage", buildRunBudgetUsage\(r\.budget\)\)/,
    'durable chat path emits the projected aggregate budget as a Run usage event');
  assert.match(server, /await handleChat\(null, null, me, \{ \.\.\.durable\.body, conversationId: run\.conversationId \}, taskRun\)/,
    'Run execution passes the durable event emitter into the chat handler');
  assert.match(execution, /await store\.appendEvent\(identity, runId, \{ type, payload, \.\.\.extra, leaseOwner: processId \}\)/,
    'execution persists emitted events before publishing them');
  assert.match(storeSource, /INSERT INTO agent_run_events \(event_id,run_id,seq,event\)/,
    'task store writes the event to the durable event table');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-budget-event-'));
  let storage;
  let scheduler;
  try {
    storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'budget-event-user', password: 'Fixture123456' });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    scheduler = createSessionScheduler({ perUserLimit: 1, globalLimit: 1 });
    const budget = buildRunBudgetUsage({
      configured: true,
      limits: { maxDurationMs: 180_000, maxModelCalls: 1, maxToolCalls: 0, maxRetries: 0, maxOutputTokens: 128 },
      snapshot: { elapsedMs: 42, modelCalls: 1, toolCalls: 0, retries: 0, duplicateToolCalls: 0,
        costStatus: 'unknown', policyStatus: 'configured', clockStatus: 'monotonic' },
    });
    const service = createRunExecutionService({ store, scheduler, executor: async ({ emit }) => {
      await emit('connecting', { phase: 'model' });
      await emit('usage', budget);
      return { ok: true };
    } });
    const submitted = await service.submit(identity, {
      conversationId: conversation.id, idempotencyKey: 'budget-event-proof-1', request: { questionHash: 'fixture' },
    });
    await submitted.execution.result;

    const persisted = await store.eventsAfter(identity, submitted.run.runId, { after: 0, limit: 100 });
    const usageEvents = persisted.events.filter(event => event.type === 'usage' && event.payload?.kind === 'run_budget');
    assert.equal(usageEvents.length, 1, 'the durable run contains exactly one projected run_budget usage event');
    assert.deepEqual(usageEvents[0].payload, budget);
    assert.ok(usageEvents[0].seq < persisted.events.find(event => event.type === 'done').seq,
      'budget usage is durable before the terminal event');
  } finally {
    scheduler?.close();
    await storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
