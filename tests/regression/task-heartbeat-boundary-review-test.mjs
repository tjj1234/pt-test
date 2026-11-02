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

test('minimum supported lease survives multiple TTLs through actual persisted heartbeats', { timeout: 20000 }, async () => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false, 'review fixture requires isolated PGlite');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-heartbeat-review-'));
  let storage, scheduler;
  try {
    storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'heartbeat-review', password: 'FixturePass123' });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    const observedStore = Object.create(store), renewals = [];
    observedStore.renewLease = async (...args) => {
      const result = await store.renewLease(...args);
      renewals.push(Date.parse(result.expiresAt));
      return result;
    };
    scheduler = createSessionScheduler();
    const ttlMs = 1000;
    const service = createRunExecutionService({ store: observedStore, scheduler, processId: 'minimum-ttl-review', leaseTtlMs: ttlMs,
      executor: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve({ ok: true }); }, ttlMs * 2 + 300);
        function abort() { clearTimeout(timer); reject(signal.reason); }
        signal.addEventListener('abort', abort, { once: true });
      }),
    });
    const submitted = await service.submit(identity, { conversationId: conversation.id, idempotencyKey: 'minimum-ttl', request: { fixture: 'heartbeat-boundary' } });
    const initial = (await storage.adapter.query('SELECT lease_expires_at FROM agent_runs WHERE run_id=$1', [submitted.run.runId])).rows[0];
    const result = await submitted.execution.result;
    assert.equal(result.ok, true);
    assert.ok(renewals.length >= 2, 'the task must actually renew its persisted lease multiple times');
    assert.ok(renewals.at(-1) > Date.parse(initial.lease_expires_at) + ttlMs, 'renewed lease must advance beyond the original expiry by another TTL');
    assert.equal((await store.getRun(identity, submitted.run.runId)).state, 'completed');
    const events = await store.eventsAfter(identity, submitted.run.runId);
    assert.equal(events.events.at(-1).type, 'done');
    assert.equal(events.events.some(event => event.type === 'error'), false);
  } finally {
    await scheduler?.close();
    await storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remote cancellation keeps both execution leases alive until slow cleanup settles', { timeout: 20000 }, async () => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-cancel-heartbeat-review-'));
  let storage, workerScheduler, controllerScheduler, releaseCleanup;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  try {
    storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'cancel-heartbeat-review', password: 'FixturePass123' });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    workerScheduler = createSessionScheduler(); controllerScheduler = createSessionScheduler();
    const originalCancel = workerScheduler.cancel;
    let cancellationRequests = 0;
    workerScheduler.cancel = (...args) => { cancellationRequests++; return originalCancel(...args); };
    let entered, aborted, cleanupSettled = false;
    const started = new Promise(resolve => { entered = resolve; });
    const abortObserved = new Promise(resolve => { aborted = resolve; });
    const worker = createRunExecutionService({ store, scheduler: workerScheduler, processId: 'slow-cancel-worker', leaseTtlMs: 1000,
      executor: ({ signal }) => new Promise((resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => { aborted(); cleanup.then(() => { cleanupSettled = true; reject(signal.reason); }); }, { once: true });
      }),
    });
    const controller = createRunExecutionService({ store, scheduler: controllerScheduler, processId: 'remote-cancel-controller', executor: async () => ({ ok: true }) });
    const input = key => ({ conversationId: conversation.id, idempotencyKey: key, request: { fixture: 'slow-cancellation' } });
    const submitted = await worker.submit(identity, input('slow-cancel'));
    await started;
    const requested = await controller.cancel(identity, submitted.run.runId);
    assert.equal(requested.cancelRequested, true);
    await abortObserved;
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(cleanupSettled, false, 'the old executor still owns its cleanup lifetime');
    assert.equal(cancellationRequests, 1, 'heartbeats must request cancellation once while continuing to renew both leases');
    assert.equal((await store.acquireLease(identity, submitted.run.runId, 'competing-worker', 1000)).acquired, false, 'another owner must not steal the cancelling Run');
    const competing = await store.createRun(identity, input('same-conversation-contender'), { owner: 'competing-worker', ttlMs: 1000 });
    assert.equal(await store.acquireConversationLease(identity, competing.run.runId, 'competing-worker', 1000), false, 'same-conversation work must wait until cancellation cleanup finishes');
    releaseCleanup();
    await assert.rejects(submitted.execution.result, { code: 'SCHEDULER_CANCELLED' });
    assert.equal(cancellationRequests, 1);
    assert.equal((await store.getRun(identity, submitted.run.runId)).state, 'cancelled');
  } finally {
    releaseCleanup();
    await Promise.allSettled([workerScheduler?.close(), controllerScheduler?.close()]);
    await storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
