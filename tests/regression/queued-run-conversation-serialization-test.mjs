import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createRunExecutionService } = require('../../shell/tasks/execution.cjs');
const { createSessionScheduler } = require('../../shell/runtime/session-scheduler.cjs');
const { normalizeChatRequest } = require('../../shell/tasks/chat-request.cjs');

test('cross-process recovery preserves same-conversation serialization', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-queued-conversation-'));
  let storage, schedulerA, schedulerB;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0, maxActive = 0, entered = 0;
  let resolveFirstEntered, resolveSecondEntered;
  const firstEntered = new Promise((resolve) => { resolveFirstEntered = resolve; });
  const secondEntered = new Promise((resolve) => { resolveSecondEntered = resolve; });
  const executor = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (++entered === 1) resolveFirstEntered();
    if (entered === 2) resolveSecondEntered();
    await gate;
    active--;
    return { ok: true };
  };
  try {
    storage = await createStorage({ dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'queued-conversation-' + Date.now(), password: 'FixturePass123' });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const storeA = createTaskStore(storage.adapter), storeB = createTaskStore(storage.adapter);
    const input = (key) => ({
      conversationId: conversation.id,
      idempotencyKey: key,
      request: normalizeChatRequest({ message: key }, identity.tenantId),
    });
    await storeA.createRun(identity, input('same-conversation-a'));
    await storeA.createRun(identity, input('same-conversation-b'));
    schedulerA = createSessionScheduler({ globalLimit: 2, perUserLimit: 2 });
    schedulerB = createSessionScheduler({ globalLimit: 2, perUserLimit: 2 });
    const workerA = createRunExecutionService({ store: storeA, scheduler: schedulerA, executor, processId: 'replay-worker-a' });
    const workerB = createRunExecutionService({ store: storeB, scheduler: schedulerB, executor, processId: 'replay-worker-b' });
    const [a, b] = await Promise.all([workerA.dispatchQueued({ limit: 1 }), workerB.dispatchQueued({ limit: 1 })]);
    const launched = [...a, ...b].filter((item) => item.execution);
    assert.equal(launched.length, 2, 'both distinct queued Runs should be atomically claimed across workers');
    await Promise.race([firstEntered, new Promise((resolve) => setTimeout(resolve, 1500))]);
    assert.equal(entered, 1, 'one Run enters the shared conversation first');
    const statesWhileHeld = await Promise.all(launched.map((item) => storeA.getRun(identity, item.run.runId)));
    assert.equal(statesWhileHeld.filter((run) => run.state === 'running').length, 1);
    assert.equal(statesWhileHeld.filter((run) => run.state === 'queued').length, 1, 'contending Run remains queued instead of being failed or discarded');
    release();
    await Promise.race([secondEntered, new Promise((resolve) => setTimeout(resolve, 1500))]);
    assert.equal(entered, 2, 'the queued Run enters after the first releases the conversation lease');
    await Promise.all(launched.map((item) => item.execution.result.catch(() => {})));
    assert.equal(maxActive, 1, 'separate dispatchers must serialize Runs by shared conversation ID');
  } finally {
    release();
    await Promise.allSettled([schedulerA?.close(), schedulerB?.close()]);
    await storage?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
