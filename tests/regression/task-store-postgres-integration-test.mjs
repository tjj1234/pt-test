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

test('real PostgreSQL: competing pools fence stale lease owners', { timeout: 30000 }, async () => {
  assert.ok(process.env.PT_PG_DSN, 'Set PT_PG_DSN to an isolated disposable PostgreSQL database');
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && key !== 'PT_PG_DSN' && process.env[key]), false,
    'Do not inherit other PostgreSQL settings into this isolated verification');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-pg-lease-'));
  let storageA, storageB, schedulerA, schedulerB;
  try {
    storageA = await createStorage({ dataDir: path.join(dir, 'unused-a'), masterKeyFile: path.join(dir, 'key-a') });
    storageB = await createStorage({ dataDir: path.join(dir, 'unused-b'), masterKeyFile: path.join(dir, 'key-b') });
    const registered = await storageA.repositories.auth.register({ username: 'pg-lease-' + Date.now(), password: 'FixturePass123' });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storageA.repositories.conversations.create(identity.userId);
    const storeA = createTaskStore(storageA.adapter);
    const storeB = createTaskStore(storageB.adapter);
    const created = await storeA.createRun(identity, {
      conversationId: conversation.id,
      idempotencyKey: 'pg-lease-' + Date.now(),
      request: { question: 'controlled lease fixture' },
    });
    const runId = created.run.runId;

    const claims = await Promise.all([
      storeA.acquireLease(identity, runId, 'pg-worker-a', 10000),
      storeB.acquireLease(identity, runId, 'pg-worker-b', 10000),
    ]);
    assert.equal(claims.filter((claim) => claim.acquired).length, 1, 'separate PG pools must serialize competing lease claims');
    const firstOwner = claims.find((claim) => claim.acquired).owner;
    const nextOwner = firstOwner === 'pg-worker-a' ? 'pg-worker-b' : 'pg-worker-a';

    await storageA.adapter.query("UPDATE agent_runs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [runId]);
    assert.equal((await storeB.acquireLease(identity, runId, nextOwner, 10000)).acquired, true, 'another pool can take over an expired lease');
    await assert.rejects(
      storeA.appendEvent(identity, runId, { type: 'connecting', payload: {}, leaseOwner: firstOwner }),
      { code: 'LEASE_LOST' },
      'the former worker cannot persist events after takeover',
    );
    await assert.rejects(storeA.transition(identity, runId, 'running', 0, firstOwner), { code: 'LEASE_LOST' },
      'the former worker cannot transition state after takeover');
    assert.equal((await storeB.transition(identity, runId, 'running', 0, nextOwner)).state, 'running');
    assert.equal((await storeB.appendEvent(identity, runId, { type: 'connecting', payload: {}, leaseOwner: nextOwner })).seq, 3);
    const live = await storeB.getRun(identity, runId);
    await storeB.transition(identity, runId, 'failed', live.revision, nextOwner);

    schedulerA = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
    schedulerB = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
    let workerStarted;
    const workerStartedPromise = new Promise((resolve) => { workerStarted = resolve; });
    const worker = createRunExecutionService({ store: storeA, scheduler: schedulerA, processId: 'pg-worker-active', leaseTtlMs: 3000, executor: ({ signal }) => new Promise((resolve, reject) => {
      workerStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const controller = createRunExecutionService({ store: storeB, scheduler: schedulerB, processId: 'pg-controller', executor: async () => ({ ok: true }) });
    const active = await worker.submit(identity, {
      conversationId: conversation.id,
      idempotencyKey: 'pg-remote-cancel-' + Date.now(),
      request: { question: 'controlled remote cancellation fixture' },
    });
    await workerStartedPromise;
    const requested = await controller.cancel(identity, active.run.runId);
    assert.equal(requested.cancelRequested, true, 'non-owner pool persists a remote cancellation request');
    assert.equal(requested.run.state, 'cancelling');
    await assert.rejects(active.execution.result, { code: 'SCHEDULER_CANCELLED' });
    assert.equal((await storeB.getRun(identity, active.run.runId)).state, 'cancelled', 'lease owner observes and settles remote cancellation');
  } finally {
    await Promise.allSettled([schedulerA?.close(), schedulerB?.close()]);
    await Promise.allSettled([storageA?.close(), storageB?.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
