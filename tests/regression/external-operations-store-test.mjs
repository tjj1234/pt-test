import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createExternalOperationsStore, MAX_QUERIES } = require('../../shell/tasks/external-operations-store.cjs');

test('per-Run external operations isolate operation state, provider query leases and tenant ownership', async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false, 'No external PG configuration allowed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-external-operations-'));
  const opts = { dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'key') };
  let storage;
  try {
    storage = await createStorage(opts);
    const runs = createTaskStore(storage.adapter);
    const userA = await storage.repositories.auth.register({ username: 'external-op-a', password: 'FixturePass123' });
    const userB = await storage.repositories.auth.register({ username: 'external-op-b', password: 'FixturePass123' });
    const a = { userId: userA.user.id, tenantId: userA.user.tenant_id };
    const b = { userId: userB.user.id, tenantId: userB.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(a.userId);
    const runOwner = 'run-worker-owner';
    let run = (await runs.createRun(a, { conversationId: conversation.id, idempotencyKey: 'multi-op-run', policyVersion: 'fixture', request: { question: 'make multiple artifacts', attachments: [] } }, { owner: runOwner, ttlMs: 30000 })).run;
    run = await runs.transition(a, run.runId, 'running', run.revision, runOwner);

    const operations = runs.externalOperations;
    const image = await operations.createIntent(a, run.runId, { operationKey: 'image:poster', provider: 'fixture-image', runLeaseOwner: runOwner });
    const video = await operations.createIntent(a, run.runId, { operationKey: 'video:clip', provider: 'fixture-video', runLeaseOwner: runOwner });
    assert.notEqual(image.operationId, video.operationId, 'one Run can durably own multiple independent operations');
    await assert.rejects(operations.createIntent(a, run.runId, { operationKey: 'image:poster', provider: 'fixture-image', runLeaseOwner: runOwner }), { code: 'EXTERNAL_OPERATION_EXISTS' });
    let aggregateRun = await runs.getRun(a, run.runId);
    assert.equal(aggregateRun.state, 'waiting_external', 'first unresolved child moves a running Run to waiting_external');
    assert.equal(aggregateRun.reconciliation, 'needs_reconciliation');
    const operationPage = await operations.list(a, run.runId, { limit: 1 });
    assert.equal(operationPage.operations.length, 1);
    assert.equal(operationPage.hasMore, true);
    const operationTail = await operations.list(a, run.runId, { limit: 1, afterOperationId: operationPage.nextCursor });
    assert.equal(operationTail.operations.length, 1);
    assert.equal(operationTail.hasMore, false);
    assert.notEqual(operationPage.operations[0].operationId, operationTail.operations[0].operationId);
    await assert.rejects(operations.list(b, run.runId), { code: 'NOT_FOUND' }, 'operation listing enforces parent Run tenant ownership');
    await assert.rejects(operations.list(a, run.runId, { limit: 101 }), { code: 'CONTRACT_INVALID' });
    let runEvents = (await runs.eventsAfter(a, run.runId)).events;
    const operationEvents = runEvents.filter((event) => event.payload?.operationKey);
    assert.deepEqual(operationEvents.map((event) => event.payload.operationKey), ['image:poster', 'video:clip']);
    assert.ok(operationEvents.every((event) => event.payload.state === 'waiting_external'), 'private append writes ordered events with the aggregated parent state');

    await assert.rejects(operations.get(b, run.runId, 'image:poster'), { code: 'NOT_FOUND' }, 'operation lookup enforces parent Run tenant ownership');
    const runLeaseBeforeQuery = (await storage.adapter.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1', [run.runId])).rows[0].lease_owner;
    assert.equal(runLeaseBeforeQuery, runOwner);

    let accepted = await operations.recordTaskId(a, run.runId, 'image:poster', { taskId: 'image-task-1', runLeaseOwner: runOwner });
    assert.equal(accepted.status, 'accepted');
    assert.equal((await operations.listDue()).some((item) => item.operation.operationId === image.operationId), false,
      'background query scheduling excludes operations whose parent Run still has an active execution lease');
    assert.equal((await operations.claimQuery(a, run.runId, 'image:poster', { owner: 'query-worker', ttlMs: 5000 })).acquired, false,
      'claim rechecks the parent Run lease while holding its row lock');
    assert.equal(await runs.releaseLease(a, run.runId, runOwner), true);
    let claim = await operations.claimQuery(a, run.runId, 'image:poster', { owner: 'query-worker', ttlMs: 5000 });
    assert.equal(claim.acquired, true);
    assert.equal(claim.attempt, 1);
    assert.equal((await storage.adapter.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1', [run.runId])).rows[0].lease_owner, null,
      'provider query claims leave the already-released Run execution lease untouched');
    await storage.adapter.query("UPDATE run_external_operations SET query_expires_at=now()-interval '1 second' WHERE operation_id=$1", [image.operationId]);
    let recovered = await operations.recoverExpiredQueries();
    assert.equal(recovered.some((item) => item.operationId === image.operationId && item.status === 'pending_query'), true);

    for (let attempt = 2; attempt <= MAX_QUERIES; attempt++) {
      await storage.adapter.query("UPDATE run_external_operations SET next_query_at=now()-interval '1 second' WHERE operation_id=$1", [image.operationId]);
      claim = await operations.claimQuery(a, run.runId, 'image:poster', { owner: 'query-worker', ttlMs: 5000 });
      assert.equal(claim.acquired, true);
      assert.equal(claim.attempt, attempt);
      accepted = await operations.recordQueryResult(a, run.runId, 'image:poster', {
        owner: 'query-worker', outcome: 'provider_pending', providerStatus: 'processing', observedAt: new Date().toISOString(), nextQueryAt: new Date(Date.now() + 1000).toISOString(),
      });
    }
    assert.equal(accepted.status, 'manual_check', 'the eighth pending query is terminal manual review');
    assert.equal(accepted.queryAttempts, 8);
    assert.equal(accepted.lastQuery.outcome, 'query_retry_exhausted');
    assert.equal((await operations.listDue()).some((item) => item.operation.operationId === image.operationId), false);

    assert.equal((await runs.acquireLease(a, run.runId, runOwner, 30000)).acquired, true);
    const unknown = await operations.markUnknownSubmission(a, run.runId, 'video:clip', { reason: 'response_unknown', runLeaseOwner: runOwner, observedAt: new Date().toISOString() });
    assert.equal(unknown.status, 'manual_check');
    assert.equal(unknown.taskId, null);
    assert.equal(unknown.lastQuery.queried, false);
    assert.equal((await operations.listDue()).some((item) => item.operation.operationId === video.operationId), false,
      'unknown submission without a provider task is never queried or resubmitted');
    const lateVideoTask = await operations.recordTaskId(a, run.runId, 'video:clip', { taskId: 'late-video-task', runLeaseOwner: runOwner });
    assert.equal(lateVideoTask.status, 'accepted');
    assert.equal(lateVideoTask.lastQuery.reason, 'response_unknown', 'late task ID persistence retains the earlier ambiguity audit');
    assert.equal((await operations.claimQuery(a, run.runId, 'video:clip', { owner: 'query-worker', ttlMs: 5000 })).acquired, false,
      'a late known task ID remains host-owned while its Run lease is active');
    assert.equal(await runs.releaseLease(a, run.runId, runOwner), true);
    let exhausted;
    for (let attempt = 1; attempt <= MAX_QUERIES; attempt++) {
      if (attempt > 1) await storage.adapter.query("UPDATE run_external_operations SET next_query_at=now()-interval '1 second' WHERE operation_id=$1", [video.operationId]);
      claim = await operations.claimQuery(a, run.runId, 'video:clip', { owner: 'query-worker', ttlMs: 5000 });
      assert.equal(claim.acquired, true);
      assert.equal(claim.attempt, attempt);
      if (attempt === 1) await assert.rejects(operations.recordQueryResult(a, run.runId, 'video:clip', {
        owner: 'query-worker', outcome: 'query_retry_exhausted', reason: 'provider_retry_limit', observedAt: new Date().toISOString(),
      }), { code: 'INVALID_TRANSITION' }, 'retry exhaustion cannot be recorded before the attempt bound');
      if (attempt < MAX_QUERIES) {
        await operations.recordQueryResult(a, run.runId, 'video:clip', {
          owner: 'query-worker', outcome: 'provider_pending', providerStatus: 'processing', observedAt: new Date().toISOString(), nextQueryAt: new Date(Date.now() + 1000).toISOString(),
        });
      } else {
        exhausted = await operations.recordQueryResult(a, run.runId, 'video:clip', {
          owner: 'query-worker', outcome: 'query_retry_exhausted', reason: 'provider_retry_limit', observedAt: new Date().toISOString(),
        });
      }
    }
    assert.equal(exhausted.status, 'manual_check', 'worker can persist the explicit retry-exhausted outcome');
    assert.equal(exhausted.lastQuery.outcome, 'query_retry_exhausted');

    assert.equal((await runs.acquireLease(a, run.runId, runOwner, 30000)).acquired, true);
    const videoFinal = await operations.recordSubmissionResult(a, run.runId, 'video:clip', {
      outcome: 'succeeded', providerStatus: 'completed', queried: true, runLeaseOwner: runOwner, observedAt: new Date().toISOString(),
    });
    assert.equal(videoFinal.status, 'succeeded');
    aggregateRun = await runs.getRun(a, run.runId);
    assert.equal(aggregateRun.state, 'waiting_external', 'one resolved operation does not reopen the Run while another remains unresolved');
    const imageFinal = await operations.recordSubmissionResult(a, run.runId, 'image:poster', {
      outcome: 'succeeded', providerStatus: 'completed', queried: true, runLeaseOwner: runOwner, observedAt: new Date().toISOString(),
    });
    assert.equal(imageFinal.status, 'succeeded');
    aggregateRun = await runs.getRun(a, run.runId);
    assert.equal(aggregateRun.state, 'running', 'all resolved child operations return waiting_external to running, never to completed');
    assert.equal(aggregateRun.reconciliation, 'not_required');
    runEvents = (await runs.eventsAfter(a, run.runId)).events;
    assert.ok(runEvents.some((event) => event.type === 'state' && event.payload?.state === 'running' && event.payload?.action === undefined),
      'the final child result produces a legal Run state transition event');

    const cancelOwner = 'cancel-run-owner';
    let cancellingRun = (await runs.createRun(a, { conversationId: conversation.id, idempotencyKey: 'cancel-late-task', policyVersion: 'fixture', request: { question: 'cancel', attachments: [] } }, { owner: cancelOwner, ttlMs: 30000 })).run;
    cancellingRun = await runs.transition(a, cancellingRun.runId, 'running', cancellingRun.revision, cancelOwner);
    await operations.createIntent(a, cancellingRun.runId, { operationKey: 'video:late', provider: 'fixture-video', runLeaseOwner: cancelOwner });
    cancellingRun = await runs.getRun(a, cancellingRun.runId);
    cancellingRun = await runs.transition(a, cancellingRun.runId, 'cancelling', cancellingRun.revision, cancelOwner);
    await assert.rejects(operations.createIntent(a, cancellingRun.runId, { operationKey: 'video:forbidden', provider: 'fixture-video', runLeaseOwner: cancelOwner }), { code: 'INVALID_TRANSITION' });
    const lateTask = await operations.recordTaskId(a, cancellingRun.runId, 'video:late', { taskId: 'late-task-1', runLeaseOwner: cancelOwner });
    assert.equal(lateTask.status, 'accepted', 'a late known task ID survives Run cancellation for reconciliation');
    assert.equal((await runs.getRun(a, cancellingRun.runId)).state, 'cancelling', 'operation aggregation never reverses cancellation');
    assert.deepEqual(await operations.recordTaskId(a, cancellingRun.runId, 'video:late', { taskId: 'late-task-1', runLeaseOwner: cancelOwner }), lateTask,
      'same task ID persistence is idempotent');
    await assert.rejects(operations.recordTaskId(a, cancellingRun.runId, 'video:late', { taskId: 'different-task', runLeaseOwner: cancelOwner }), { code: 'EXTERNAL_TASK_ID_CONFLICT' });
    const hostFinal = await operations.recordSubmissionResult(a, cancellingRun.runId, 'video:late', {
      outcome: 'succeeded', providerStatus: 'completed', queried: true, reason: 'host_poll_complete', runLeaseOwner: cancelOwner, observedAt: new Date().toISOString(),
    });
    assert.equal(hostFinal.status, 'succeeded', 'host can settle a known provider task under the active Run lease');
    assert.equal((await runs.getRun(a, cancellingRun.runId)).state, 'cancelling', 'provider success never completes or reopens the Run');
    assert.equal(hostFinal.lastQuery.queried, true);
    assert.equal(hostFinal.lastQuery.source, 'host');
    assert.deepEqual(await operations.recordSubmissionResult(a, cancellingRun.runId, 'video:late', {
      outcome: 'succeeded', providerStatus: 'completed', queried: true, reason: 'host_poll_complete', runLeaseOwner: cancelOwner, observedAt: new Date().toISOString(),
    }), hostFinal, 'same terminal outcome is idempotent when the persistence acknowledgement was lost');
    await assert.rejects(operations.recordSubmissionResult(a, cancellingRun.runId, 'video:late', {
      outcome: 'failed', runLeaseOwner: cancelOwner, observedAt: new Date().toISOString(),
    }), { code: 'INVALID_TRANSITION' }, 'a conflicting terminal outcome cannot overwrite durable evidence');

    const staleOwner = 'stale-submission-owner';
    let staleRun = (await runs.createRun(a, { conversationId: conversation.id, idempotencyKey: 'stale-submission', policyVersion: 'fixture', request: { question: 'stale submit', attachments: [] } }, { owner: staleOwner, ttlMs: 30000 })).run;
    staleRun = await runs.transition(a, staleRun.runId, 'running', staleRun.revision, staleOwner);
    await operations.createIntent(a, staleRun.runId, { operationKey: 'stale:submission', provider: 'fixture', runLeaseOwner: staleOwner });
    assert.equal((await operations.recoverExpiredSubmissions()).some((item) => item.runId === staleRun.runId), false, 'live submission lease is not reconciled early');
    assert.equal(await runs.releaseLease(a, staleRun.runId, staleOwner), true);
    assert.equal((await operations.recoverExpiredSubmissions()).some((item) => item.runId === staleRun.runId), true);
    assert.equal((await operations.get(a, staleRun.runId, 'stale:submission')).lastQuery.reason, 'expired_submission_lease');

    const terminalOwner = 'terminal-submission-owner';
    let terminalRun = (await runs.createRun(a, { conversationId: conversation.id, idempotencyKey: 'terminal-submission', policyVersion: 'fixture', request: { question: 'terminal submit', attachments: [] } }, { owner: terminalOwner, ttlMs: 30000 })).run;
    terminalRun = await runs.transition(a, terminalRun.runId, 'running', terminalRun.revision, terminalOwner);
    await operations.createIntent(a, terminalRun.runId, { operationKey: 'terminal:submission', provider: 'fixture', runLeaseOwner: terminalOwner });
    terminalRun = await runs.getRun(a, terminalRun.runId);
    terminalRun = await runs.transition(a, terminalRun.runId, 'failed', terminalRun.revision, terminalOwner);
    const terminalRecovered = await operations.recoverExpiredSubmissions();
    assert.equal(terminalRecovered.some((item) => item.runId === terminalRun.runId), true, 'terminal Run intents are also manually reconciled');
    assert.equal((await runs.getRun(a, terminalRun.runId)).state, 'failed', 'submission recovery does not reopen terminal Runs');

    const rollbackOwner = 'rollback-owner';
    let rollbackRun = (await runs.createRun(a, { conversationId: conversation.id, idempotencyKey: 'event-rollback', policyVersion: 'fixture', request: { question: 'rollback event', attachments: [] } }, { owner: rollbackOwner, ttlMs: 30000 })).run;
    rollbackRun = await runs.transition(a, rollbackRun.runId, 'running', rollbackRun.revision, rollbackOwner);
    const rollbackStore = createExternalOperationsStore(storage.adapter, { appendRunEvent: async () => { throw new Error('event append failed'); } });
    await assert.rejects(rollbackStore.createIntent(a, rollbackRun.runId, { operationKey: 'rollback:op', provider: 'fixture', runLeaseOwner: rollbackOwner }), /event append failed/);
    const noEventStore = createExternalOperationsStore(storage.adapter);
    await noEventStore.createIntent(a, rollbackRun.runId, { operationKey: 'rollback:op', provider: 'fixture', runLeaseOwner: rollbackOwner });
  } finally {
    try { if (storage) await storage.close(); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
});
