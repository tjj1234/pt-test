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
const { cancelActiveRunsForMemoryChange } = require('../../shell/tasks/memory-run-invalidation.cjs');

test('memory changes cancel active user Runs and reject unconfirmed remote cancellation', { timeout: 15000 }, async (t) => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-memory-run-cancel-'));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
    t.after(async () => { try { await storage.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
    const registered = await storage.repositories.auth.register({ username: 'memory-cancel-user', password: 'Fixture123456' });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    const scheduler = createSessionScheduler({ perUserLimit: 1, globalLimit: 2 });
    t.after(() => scheduler.close());
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const execution = createRunExecutionService({ store, scheduler, processId: 'memory-change-cancel-worker', executor: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const submitted = await execution.submit(identity, {
      conversationId: conversation.id, idempotencyKey: 'memory-edit-active-run',
      request: { questionHash: 'fixture-hash' },
    });
    await startedPromise;
    const queuedConversation = await storage.repositories.conversations.create(identity.userId);
    const queued = await store.createRun(identity, {
      conversationId: queuedConversation.id, idempotencyKey: 'memory-edit-queued-run',
      request: { questionHash: 'queued-fixture-hash' },
    });
    assert.equal(queued.run.state, 'queued');
    const result = await cancelActiveRunsForMemoryChange(store, execution, identity);
    assert.deepEqual(result, { cancelled: 1, failures: [] });
    assert.equal((await store.getRun(identity, submitted.run.runId)).state, 'cancelled');
    assert.equal((await store.getRun(identity, queued.run.runId)).state, 'queued', 'a queued Run has not sent memory upstream and is left intact');
    await assert.rejects(submitted.execution.result, { code: 'SCHEDULER_CANCELLED' });

    const remoteLike = { cancel: async () => ({ stopped: false, cancelRequested: true, run: { state: 'cancelling' } }) };
    const unconfirmed = await cancelActiveRunsForMemoryChange({
      listRuns: async () => ({ runs: [{ runId: 'remote-run', state: 'running' }], hasMore: false }),
    }, remoteLike, identity);
    assert.deepEqual(unconfirmed, { cancelled: 0, failures: ['remote-run'] });
  } finally {
    if (storage) await storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
