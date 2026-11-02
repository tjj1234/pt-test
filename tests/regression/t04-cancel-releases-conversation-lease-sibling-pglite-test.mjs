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

test('cancel cleanup holds the conversation lease until settle, then admits its waiting sibling', { timeout: 20000 }, async (t) => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false,
    'this probe must use its isolated local PGlite database');
  const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-t04-cancel-sibling-'));
  let storage;
  const schedulers = [];
  t.after(async () => {
    await Promise.allSettled(schedulers.map((scheduler) => scheduler.close()));
    await storage?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  storage = await createStorage({
    dataDir: path.join(tempRoot, 'db'),
    masterKeyFile: path.join(tempRoot, 'master-key'),
  });
  const registered = await storage.repositories.auth.register({
    username: 't04-cancel-sibling', password: 'FixturePass123',
  });
  assert.equal(registered.ok, true);
  const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
  const conversation = await storage.repositories.conversations.create(identity.userId);
  const baseStore = createTaskStore(storage.adapter);
  let firstRunId = null, releaseObservation = null;
  const aStore = Object.create(baseStore);
  aStore.releaseConversationLease = async (leaseIdentity, runId, owner) => {
    if (runId === firstRunId) {
      const run = await baseStore.getRun(leaseIdentity, runId);
      const lease = (await storage.adapter.query(
        'SELECT run_id,lease_owner FROM agent_conversation_leases WHERE conversation_id=$1', [conversation.id],
      )).rows[0] || null;
      releaseObservation = { state: run.state, leaseRunId: lease?.run_id || null, leaseOwner: lease?.lease_owner || null };
    }
    const released = await baseStore.releaseConversationLease(leaseIdentity, runId, owner);
    if (runId === firstRunId && releaseObservation) releaseObservation.released = released;
    return released;
  };
  let resolveAStarted, resolveAAborted, resolveBWaited, releaseCleanup;
  const aStarted = new Promise((resolve) => { resolveAStarted = resolve; });
  const aAborted = new Promise((resolve) => { resolveAAborted = resolve; });
  const bWaited = new Promise((resolve) => { resolveBWaited = resolve; });
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  let bEntered = false;
  const bStore = Object.create(baseStore);
  bStore.acquireConversationLease = async (...args) => {
    const acquired = await baseStore.acquireConversationLease(...args);
    if (!acquired) resolveBWaited();
    return acquired;
  };
  const schedulerA = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
  const schedulerB = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
  schedulers.push(schedulerA, schedulerB);
  const workerA = createRunExecutionService({
    store: aStore, scheduler: schedulerA, processId: 'cancel-sibling-worker-a', leaseTtlMs: 1000,
    executor: ({ signal }) => new Promise((resolve, reject) => {
      resolveAStarted();
      signal.addEventListener('abort', () => {
        resolveAAborted();
        cleanup.then(() => reject(signal.reason));
      }, { once: true });
    }),
  });
  const workerB = createRunExecutionService({
    store: bStore, scheduler: schedulerB, processId: 'cancel-sibling-worker-b', leaseTtlMs: 1000,
    executor: async () => { bEntered = true; return { ok: true, text: 'sibling entered after cancellation cleanup' }; },
  });
  const input = (key) => ({ conversationId: conversation.id, idempotencyKey: key, request: { fixture: key } });
  const first = await workerA.submit(identity, input('cancel-holds-conversation'));
  firstRunId = first.run.runId;
  await aStarted;
  const sibling = await workerB.submit(identity, input('sibling-waits-for-conversation'));
  await bWaited;
  assert.equal(bEntered, false, 'sibling cannot enter while the first executor still owns cleanup');
  assert.equal((await baseStore.getRun(identity, sibling.run.runId)).state, 'queued');

  let cancellationSettled = false;
  const cancellation = workerA.cancel(identity, first.run.runId).then((result) => {
    cancellationSettled = true;
    return result;
  });
  await aAborted;
  assert.equal(cancellationSettled, false, 'cancel waits for executor cleanup to settle');
  assert.equal((await baseStore.getRun(identity, first.run.runId)).state, 'cancelling',
    'the Run remains nonterminal while the executor cleanup barrier is held');
  assert.equal(bEntered, false, 'abort signal alone does not transfer the conversation lease');
  const held = (await storage.adapter.query(
    'SELECT run_id,lease_owner FROM agent_conversation_leases WHERE conversation_id=$1', [conversation.id],
  )).rows[0];
  assert.equal(held.run_id, first.run.runId);
  assert.equal(held.lease_owner, 'cancel-sibling-worker-a');

  releaseCleanup();
  const cancelled = await cancellation;
  assert.equal(cancelled.stopped, true);
  await assert.rejects(first.execution.result, { code: 'SCHEDULER_CANCELLED' });
  assert.deepEqual(releaseObservation, {
    state: 'cancelled',
    leaseRunId: first.run.runId,
    leaseOwner: 'cancel-sibling-worker-a',
    released: true,
  }, 'terminal state is persisted before the owning conversation lease is released');
  const siblingResult = await sibling.execution.result;
  assert.equal(bEntered, true, 'sibling enters after terminal cancellation cleanup releases the lease');
  assert.equal(siblingResult.text, 'sibling entered after cancellation cleanup');
  assert.equal((await baseStore.getRun(identity, first.run.runId)).state, 'cancelled');
  assert.equal((await baseStore.getRun(identity, sibling.run.runId)).state, 'completed');
  const remaining = await storage.adapter.query(
    'SELECT run_id FROM agent_conversation_leases WHERE conversation_id=$1', [conversation.id],
  );
  assert.equal(remaining.rows.length, 0, 'the completed sibling also releases its conversation lease');
});
