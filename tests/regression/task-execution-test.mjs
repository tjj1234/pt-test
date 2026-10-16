import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createSessionScheduler } = require('../../shell/runtime/session-scheduler.cjs');
const { createRunExecutionService } = require('../../shell/tasks/execution.cjs');

test('run execution persists ordered events, deduplicates before execution, and settles cancellation', async (t) => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false, 'No external PG configuration allowed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-run-execution-'));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
    t.after(async () => { try { await storage.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
    const reg = await storage.repositories.auth.register({ username: 'run-exec-user', password: 'Fixture123456' });
    const identity = { userId: reg.user.id, tenantId: reg.user.tenant_id };
    const conv = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    const scheduler = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
    t.after(() => scheduler.close());
    let calls = 0;
    const service = createRunExecutionService({ store, scheduler, executor: async ({ emit, signal }) => {
      calls++;
      if (signal.reason) throw signal.reason;
      await emit('connecting', { phase: 'model' });
      await Promise.all([emit('delta', { text: 'A' }), emit('delta', { text: 'B' })]);
      return { ok: true };
    } });
    const input = { conversationId: conv.id, idempotencyKey: 'request-1', request: { questionHash: 'redacted-fixture' } };
    const first = await service.submit(identity, input);
    const replay = await service.submit(identity, input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.runId, first.run.runId);
    await first.execution.result;
    assert.equal(calls, 1, 'idempotent replay must not invoke the executor again');
    const persisted = await store.eventsAfter(identity, first.run.runId);
    assert.deepEqual(persisted.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(persisted.events.filter((event) => event.type === 'delta').map((event) => event.payload.text), ['A', 'B']);
    assert.equal((await store.getRun(identity, first.run.runId)).state, 'completed');

    const cancelInput = { ...input, idempotencyKey: 'request-2' };
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const cancellable = createRunExecutionService({ store, scheduler, executor: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const run = await cancellable.submit(identity, cancelInput);
    await startedPromise;
    const stopped = await cancellable.cancel(identity, run.run.runId);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.run.state, 'cancelled');

    let failDelta = true;
    const flakyStore = Object.create(store);
    flakyStore.appendEvent = (...args) => {
      if (failDelta && args[2]?.type === 'delta') { failDelta = false; return Promise.reject(Object.assign(new Error('injected event write failure'), { code: 'STORAGE_FAILED' })); }
      return store.appendEvent(...args);
    };
    const failureService = createRunExecutionService({ store: flakyStore, scheduler, executor: ({ emit }) => {
      emit('delta', { text: 'not durable' }); // mimic a synchronous runtime callback that ignores its promise
      return { ok: true };
    } });
    const failedRun = await failureService.submit(identity, { ...input, idempotencyKey: 'request-3' });
    await assert.rejects(failedRun.execution.result, { code: 'STORAGE_FAILED' });
    assert.equal((await store.getRun(identity, failedRun.run.runId)).state, 'failed', 'event persistence failure must not leave a false successful/running task');

    let releaseLate;
    let lateStarted;
    const lateStartedPromise = new Promise((resolve) => { lateStarted = resolve; });
    const lateSuccessService = createRunExecutionService({ store, scheduler, executor: () => new Promise((resolve) => { releaseLate = resolve; lateStarted(); }) });
    const lateRun = await lateSuccessService.submit(identity, { ...input, idempotencyKey: 'request-4' });
    await lateStartedPromise;
    const cancelPending = lateSuccessService.cancel(identity, lateRun.run.runId);
    await new Promise((resolve) => setImmediate(resolve));
    releaseLate({ ok: true }); // executor did not confirm cancellation; completion wins truthfully
    const lateCancel = await cancelPending;
    assert.equal(lateCancel.stopped, false);
    assert.equal(lateCancel.run.state, 'completed');
  } finally {
    if (storage) await storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
