import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { normalizeChatRequest } = require('../../shell/tasks/chat-request.cjs');

test('crash during cancellation leaves known provider task queryable and never marks it cancelled', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-t03-cancel-recovery-'));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
    const registered = await storage.repositories.auth.register({ username: 't03-cancel-recovery', password: 'FixturePass123' });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    const input = normalizeChatRequest({ message: 'fixture only' }, identity.tenantId);
    let run = (await store.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: 'cancel-crash', request: input,
    }, { owner: 'dead-worker', ttlMs: 30000 })).run;
    run = await store.transition(identity, run.runId, 'running', run.revision, 'dead-worker');
    run = await store.recordExternalIntent(identity, run.runId, {
      provider: 'fixture-provider', operationKey: 'video:fixture', expectedRevision: run.revision, leaseOwner: 'dead-worker',
    });
    await store.externalOperations.createIntent(identity, run.runId, {
      operationKey: 'video:fixture', provider: 'fixture-provider', runLeaseOwner: 'dead-worker',
    });
    run = await store.recordExternalTaskId(identity, run.runId, {
      taskId: 'fixture-task-1', expectedRevision: run.revision, leaseOwner: 'dead-worker',
    });
    await store.externalOperations.recordTaskId(identity, run.runId, 'video:fixture', {
      taskId: 'fixture-task-1', runLeaseOwner: 'dead-worker',
    });
    run = await store.transition(identity, run.runId, 'cancelling', run.revision, 'dead-worker');
    await storage.adapter.query("UPDATE agent_runs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [run.runId]);

    await store.recoverExpiredLeases();

    const recovered = await store.getRun(identity, run.runId);
    assert.equal(recovered.state, 'interrupted', 'recovery must not claim cancellation completed when the worker died');
    assert.equal(recovered.externalTaskId, 'fixture-task-1');
    assert.equal(recovered.reconciliation, 'needs_reconciliation');
    const due = await store.externalOperations.listDue();
    assert.equal(due.length, 1, 'the existing provider task remains eligible for bounded read-only reconciliation');
    assert.equal(due[0].operation.taskId, 'fixture-task-1', 'recovery retains the original task ID instead of submitting again');
    assert.equal(due[0].operation.status, 'accepted');
  } finally {
    await storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
