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

test('run execution persists ordered events, deduplicates before execution, and settles cancellation', { timeout: 15000 }, async (t) => {
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
    const replayedEvents = [];
    const replayWithListener = await service.submit(identity, input, {}, { onEvent: (event) => replayedEvents.push(event.seq) });
    assert.equal(replayWithListener.replayed, true);
    assert.deepEqual(replayedEvents, [1, 2, 3, 4, 5, 6, 7], 'each new subscriber receives the full durable prefix');

    const finalized = await service.submit(identity, { ...input, idempotencyKey: 'request-finalize' }, {}, {
      executor: async () => ({ ok: true }),
      finalize: async (_result, { emit }) => { await emit('usage', { totalTokens: 1 }); return { ok: true }; },
    });
    await finalized.execution.result;
    const finalizedEvents = (await store.eventsAfter(identity, finalized.run.runId)).events;
    assert.deepEqual(finalizedEvents.slice(-3).map((event) => event.type), ['usage', 'state', 'done'], 'finalizer events are durable before terminal events');

    const interrupted = await service.submit(identity, { ...input, idempotencyKey: 'request-interrupted' }, {}, {
      executor: async () => ({ ok: false, code: 'RUN_INTERRUPTED' }),
      finalize: async (result) => ({ runOutcome: result, completionPayload: { ok: false, code: result.code, error: 'Runner shutdown interrupted this Run' } }),
    });
    await interrupted.execution.result;
    assert.equal((await store.getRun(identity, interrupted.run.runId)).state, 'interrupted', 'runner shutdown must persist the interrupted terminal state');
    const interruptedEvents = (await store.eventsAfter(identity, interrupted.run.runId)).events;
    assert.equal(interruptedEvents.at(-1).type, 'done');
    assert.equal(interruptedEvents.at(-1).payload.code, 'RUN_INTERRUPTED', 'terminal event retains the runner interruption diagnostic');

    const cancelInput = { ...input, idempotencyKey: 'request-2' };
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const cancellable = createRunExecutionService({ store, scheduler, processId: 'worker-cancel-test', executor: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const run = await cancellable.submit(identity, cancelInput);
    await startedPromise;
    const liveLease = (await storage.adapter.query('SELECT lease_owner,lease_expires_at FROM agent_runs WHERE run_id=$1', [run.run.runId])).rows[0];
    assert.equal(liveLease.lease_owner, 'worker-cancel-test');
    assert.ok(liveLease.lease_expires_at);
    assert.equal((await store.acquireLease(identity, run.run.runId, 'competing-worker', 10000)).acquired, false);
    const stopped = await cancellable.cancel(identity, run.run.runId);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.run.state, 'cancelled');
    assert.equal((await storage.adapter.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1', [run.run.runId])).rows[0].lease_owner, null, 'terminal transition releases its worker lease');

    const remoteControllerScheduler = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
    t.after(() => remoteControllerScheduler.close());
    const remoteController = createRunExecutionService({ store, scheduler: remoteControllerScheduler, processId: 'remote-controller', executor: async () => ({ ok: true }) });
    let remoteStarted;
    const remoteStartedPromise = new Promise((resolve) => { remoteStarted = resolve; });
    const remoteWorker = createRunExecutionService({ store, scheduler, processId: 'remote-worker', leaseTtlMs: 3000, executor: ({ signal }) => new Promise((resolve, reject) => {
      remoteStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const remoteRun = await remoteWorker.submit(identity, { ...input, idempotencyKey: 'request-remote-cancel' });
    await remoteStartedPromise;
    const remoteCancel = await remoteController.cancel(identity, remoteRun.run.runId);
    assert.equal(remoteCancel.stopped, false);
    assert.equal(remoteCancel.cancelRequested, true, 'controller without the scheduler persists a cancellation request');
    assert.equal(remoteCancel.run.state, 'cancelling');
    await assert.rejects(remoteRun.execution.result, { code: 'SCHEDULER_CANCELLED' });
    assert.equal((await store.getRun(identity, remoteRun.run.runId)).state, 'cancelled', 'lease owner observes remote cancellation and settles it');

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

    // Adversarial scheduler race: queued cancellation's CAS overlaps queue promotion.
    const raceScheduler = createSessionScheduler({ perUserLimit: 2, globalLimit: 1 });
    t.after(() => raceScheduler.close());
    const secondConv = await storage.repositories.conversations.create(identity.userId);
    let releaseFirst, firstStarted, secondStarted, allowCancelCas;
    const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
    const secondStartedPromise = new Promise((resolve) => { secondStarted = resolve; });
    const casPaused = new Promise((resolve) => { allowCancelCas = resolve; });
    let cancelAtCas;
    const cancelAtCasPromise = new Promise((resolve) => { cancelAtCas = resolve; });
    let raceFirst = true;
    const racingStore = Object.create(store);
    let racingRunId;
    racingStore.transition = async (...args) => {
      if (args[1] === racingRunId && args[2] === 'cancelled') { cancelAtCas(); await casPaused; }
      return store.transition(...args);
    };
    const racingService = createRunExecutionService({ store: racingStore, scheduler: raceScheduler, executor: ({ run, signal }) => {
      if (raceFirst) { raceFirst = false; firstStarted(); return new Promise((resolve) => { releaseFirst = resolve; }); }
      secondStarted();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    const firstRace = await racingService.submit(identity, { ...input, idempotencyKey: 'cancel-race-first' });
    await firstStartedPromise;
    const secondRace = await racingService.submit(identity, { ...input, conversationId: secondConv.id, idempotencyKey: 'cancel-race-second' });
    racingRunId = secondRace.run.runId;
    const cancelRace = racingService.cancel(identity, racingRunId);
    await cancelAtCasPromise;
    releaseFirst({ ok: true });
    await secondStartedPromise;
    allowCancelCas();
    const raceResult = await cancelRace;
    assert.equal(raceResult.stopped, true, 'cancel retries against promoted running revision and aborts the executor');
    assert.equal(raceResult.run.state, 'cancelled');
    await firstRace.execution.result;

    const closedScheduler = createSessionScheduler({ perUserLimit: 1, globalLimit: 1 });
    await closedScheduler.close();
    const rejectedService = createRunExecutionService({ store, scheduler: closedScheduler, executor: async () => ({ ok: true }) });
    await assert.rejects(rejectedService.submit(identity, { ...input, idempotencyKey: 'request-scheduler-rejected' }), { code: 'SCHEDULER_CLOSED' });
    const rejectedRuns = await store.listRuns(identity, { limit: 100 });
    const rejectedRun = rejectedRuns.runs.find((item) => item.state === 'failed' && item.conversationId === conv.id);
    assert.ok(rejectedRun, 'scheduler rejection leaves no permanently queued run');
  } finally {
    if (storage) await storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
