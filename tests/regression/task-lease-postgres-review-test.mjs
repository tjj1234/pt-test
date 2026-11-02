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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error('Condition did not settle within bounded real PostgreSQL probe');
}
test('real PostgreSQL review: conversation lease takeover, delayed renew and execution heartbeat/cancel fencing', { timeout: 30000 }, async t => {
  assert.ok(process.env.PT_PG_DSN, 'Set PT_PG_DSN to an isolated disposable PostgreSQL database');
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && key !== 'PT_PG_DSN' && process.env[key]), false);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-pg-review-'));
  let a, b; const schedulers = [];
  try {
    a = await createStorage({ dataDir: path.join(dir, 'a'), masterKeyFile: path.join(dir, 'a-key') });
    b = await createStorage({ dataDir: path.join(dir, 'b'), masterKeyFile: path.join(dir, 'b-key') });
    const registered = await a.repositories.auth.register({ username: 'lease-review-' + Date.now(), password: 'FixturePass123' }); assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const storeA = createTaskStore(a.adapter), storeB = createTaskStore(b.adapter);
    const createRun = async (store, conversationId, suffix, owner) => (await store.createRun(identity, { conversationId, idempotencyKey: 'review-' + suffix + '-' + Date.now(), request: { question: 'controlled postgres review' } }, { owner, ttlMs: 10000 })).run;
    await t.test('different run owners compete for one conversation and old owner cannot renew/save/release successor', async () => {
      const conversation = await a.repositories.conversations.create(identity.userId);
      const first = await createRun(storeA, conversation.id, 'first', 'owner-a');
      const second = await createRun(storeB, conversation.id, 'second', 'owner-b');
      const claims = await Promise.all([storeA.acquireConversationLease(identity, first.runId, 'owner-a', 10000), storeB.acquireConversationLease(identity, second.runId, 'owner-b', 10000)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const [oldRun, oldOwner, oldStore, newRun, newOwner, newStore] = claims[0] ? [first, 'owner-a', storeA, second, 'owner-b', storeB] : [second, 'owner-b', storeB, first, 'owner-a', storeA];
      await a.adapter.query("UPDATE agent_conversation_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE conversation_id=$1", [conversation.id]);
      assert.equal(await newStore.acquireConversationLease(identity, newRun.runId, newOwner, 10000), true);
      await assert.rejects(oldStore.renewConversationLease(identity, oldRun.runId, oldOwner, 10000), { code: 'LEASE_LOST' });
      await oldStore.transition(identity, oldRun.runId, 'running', 0, oldOwner);
      await assert.rejects(oldStore.saveConversationMessages(identity, oldRun.runId, oldOwner, conversation.id, [{ role: 'user', text: 'stale write' }]), { code: 'LEASE_LOST' });
      assert.equal(await oldStore.releaseConversationLease(identity, oldRun.runId, oldOwner), false);
      assert.equal(await newStore.renewConversationLease(identity, newRun.runId, newOwner, 10000), true);
      const lease = await b.adapter.query('SELECT run_id FROM agent_conversation_leases WHERE conversation_id=$1', [conversation.id]); assert.equal(lease.rows[0].run_id, newRun.runId);
      await a.adapter.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1", [newRun.runId]);
      await assert.rejects(newStore.renewConversationLease(identity, newRun.runId, newOwner, 10000), { code: 'LEASE_LOST' });
    });
    await t.test('renew transaction blocked past real expiry cannot revive an expired conversation lease', async () => {
      const conversation = await a.repositories.conversations.create(identity.userId);
      const run = await createRun(storeA, conversation.id, 'delayed', 'delayed-owner');
      assert.equal(await storeA.acquireConversationLease(identity, run.runId, 'delayed-owner', 1000), true);
      let pending;
      await a.adapter.transaction(async tx => {
        await tx.query('SELECT run_id FROM agent_runs WHERE run_id=$1 FOR UPDATE', [run.runId]);
        pending = storeB.renewConversationLease(identity, run.runId, 'delayed-owner', 10000);
        pending.catch(() => {});
        await tx.query('SELECT pg_sleep(1.3)');
      });
      await assert.rejects(pending, { code: 'LEASE_LOST' });
    });
    await t.test('heartbeat survives original TTL; waiting peer cancels without entering executor; remote active cancel settles', async () => {
      const conversation = await a.repositories.conversations.create(identity.userId);
      const schedulerA = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
      const schedulerB = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 }); schedulers.push(schedulerA, schedulerB);
      let firstStarted = false, secondExecutions = 0;
      const workerA = createRunExecutionService({ store: storeA, scheduler: schedulerA, processId: 'review-worker-a', leaseTtlMs: 3000, executor: ({ signal }) => new Promise((resolve, reject) => { firstStarted = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
      const workerB = createRunExecutionService({ store: storeB, scheduler: schedulerB, processId: 'review-worker-b', leaseTtlMs: 3000, executor: async () => { secondExecutions++; return { ok: true }; } });
      const first = await workerA.submit(identity, { conversationId: conversation.id, idempotencyKey: 'review-heartbeat-first-' + Date.now(), request: { question: 'first controlled worker' } });
      first.execution.result.catch(() => {}); await until(() => firstStarted);
      const second = await workerB.submit(identity, { conversationId: conversation.id, idempotencyKey: 'review-heartbeat-second-' + Date.now(), request: { question: 'second controlled worker' } });
      second.execution.result.catch(() => {});
      await delay(3400);
      const leases = await b.adapter.query('SELECT r.lease_expires_at>clock_timestamp() AS run_live, l.lease_expires_at>clock_timestamp() AS conversation_live FROM agent_runs r JOIN agent_conversation_leases l ON l.run_id=r.run_id WHERE r.run_id=$1', [first.run.runId]);
      assert.equal(leases.rows[0].run_live, true); assert.equal(leases.rows[0].conversation_live, true); assert.equal(secondExecutions, 0);
      await workerB.cancel(identity, second.run.runId);
      await assert.rejects(second.execution.result, { code: 'SCHEDULER_CANCELLED' }); assert.equal(secondExecutions, 0);
      assert.equal((await storeA.getRun(identity, second.run.runId)).state, 'cancelled');
      assert.equal((await storeA.getRun(identity, first.run.runId)).state, 'running');
      const remote = await workerB.cancel(identity, first.run.runId); assert.equal(remote.cancelRequested, true);
      await assert.rejects(first.execution.result, { code: 'SCHEDULER_CANCELLED' });
      assert.equal((await storeB.getRun(identity, first.run.runId)).state, 'cancelled');
      const remaining = await b.adapter.query('SELECT run_id FROM agent_conversation_leases WHERE conversation_id=$1', [conversation.id]); assert.equal(remaining.rows.length, 0);
    });
  } finally {
    await Promise.allSettled(schedulers.map(scheduler => scheduler.close()));
    await Promise.allSettled([a?.close(), b?.close()]); fs.rmSync(dir, { recursive: true, force: true });
  }
});
