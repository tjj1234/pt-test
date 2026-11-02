import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createRunExecutionService } = require('../../shell/tasks/execution.cjs');
const { createSessionScheduler } = require('../../shell/runtime/session-scheduler.cjs');
const { normalizeChatRequest } = require('../../shell/tasks/chat-request.cjs');

test('durable queued chat is atomically redispatched; legacy and running work are never replayed', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-queued-recovery-'));
  let storage, schedulerA, schedulerB;
  try {
    storage = await createStorage({ dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'queued-recovery-' + Date.now(), password: 'FixturePass123' });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const storeA = createTaskStore(storage.adapter), storeB = createTaskStore(storage.adapter);
    const makeInput = (key, request) => ({ conversationId: conversation.id, idempotencyKey: key, request });
    const durable = normalizeChatRequest({ message: 'resume once' }, identity.tenantId);
    assert.deepEqual(durable.body, { message: 'resume once' });
    assert.equal(JSON.stringify(durable).includes('apiKey'), false);
    assert.throws(() => normalizeChatRequest({ message: 'secret field is forbidden', apiKey: 'must-not-persist' }, identity.tenantId), { code: 'CHAT_REQUEST_INVALID' });
    const queued = (await storeA.createRun(identity, makeInput('resume-' + Date.now(), durable))).run;
    await storeA.recoverExpiredLeases();
    assert.equal((await storeA.getRun(identity, queued.runId)).state, 'queued', 'startup recovery preserves only the supported durable command');

    const runningReq = normalizeChatRequest({ message: 'must not replay' }, identity.tenantId);
    let running = (await storeA.createRun(identity, makeInput('running-' + Date.now(), runningReq), { owner: 'crashed-worker', ttlMs: 10000 })).run;
    running = await storeA.transition(identity, running.runId, 'running', running.revision, 'crashed-worker');
    await storage.adapter.query("UPDATE agent_runs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [running.runId]);

    const legacy = (await storeA.createRun(identity, makeInput('legacy-' + Date.now(), { operation: 'chat', bodySha256: 'old-descriptor' }))).run;
    const malformed = (await storeA.createRun(identity, makeInput('malformed-' + Date.now(), { kind: 'northstar.chat', schemaVersion: 1, body: { message: 'safe text' }, cookie: 'must-not-replay' }))).run;
    const paidChild = (await storeA.createRun(identity, makeInput('paid-child-' + Date.now(), normalizeChatRequest({ message: 'must not repeat paid operation' }, identity.tenantId)))).run;
    await storage.adapter.query("INSERT INTO run_external_operations (operation_id,run_id,operation_key,provider,status) VALUES ($1,$2,$3,$4,'submitting')", [randomUUID(), paidChild.runId, 'paid-child-op', 'fixture']);
    await storeA.recoverExpiredLeases();
    assert.equal((await storeA.getRun(identity, running.runId)).state, 'interrupted');
    assert.equal((await storeA.getRun(identity, legacy.runId)).state, 'interrupted');
    assert.equal((await storeA.getRun(identity, malformed.runId)).state, 'interrupted', 'malformed versioned requests with credential fields are not replayable');
    assert.equal((await storeA.getRun(identity, paidChild.runId)).state, 'interrupted', 'a child external operation prevents queued replay');

    let calls = 0;
    const executor = async ({ request }) => { calls++; assert.equal(request.kind, 'northstar.chat'); return { ok: true }; };
    schedulerA = createSessionScheduler({ globalLimit: 2, perUserLimit: 2 });
    schedulerB = createSessionScheduler({ globalLimit: 2, perUserLimit: 2 });
    const a = createRunExecutionService({ store: storeA, scheduler: schedulerA, executor, processId: 'queued-worker-a' });
    const b = createRunExecutionService({ store: storeB, scheduler: schedulerB, executor, processId: 'queued-worker-b' });
    const [launchedA, launchedB] = await Promise.all([a.dispatchQueued({ limit: 4 }), b.dispatchQueued({ limit: 4 })]);
    const launched = [...launchedA, ...launchedB].filter((item) => item.execution);
    assert.equal(launched.length, 1, 'separate execution services cannot both claim a queued Run');
    await launched[0].execution.result;
    assert.equal(calls, 1);
    assert.equal((await storeA.getRun(identity, queued.runId)).state, 'completed');
    assert.equal((await storeA.getRun(identity, running.runId)).state, 'interrupted', 'a previously running Run remains non-replayable');
    assert.equal((await storeA.getRun(identity, legacy.runId)).state, 'interrupted', 'legacy descriptors remain conservative');
    assert.equal((await storeA.getRun(identity, malformed.runId)).state, 'interrupted');
    assert.equal((await storeA.getRun(identity, paidChild.runId)).state, 'interrupted');
  } finally {
    await Promise.allSettled([schedulerA?.close(), schedulerB?.close()]);
    await storage?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('invalid queued chat is finalized within the claim batch and cannot starve a later valid Run', { timeout: 20000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-invalid-queued-'));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'invalid-queued-' + Date.now(), password: 'FixturePass123' });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    const invalid = (await store.createRun(identity, {
      conversationId: conversation.id,
      idempotencyKey: 'invalid-' + Date.now(),
      request: { kind: 'northstar.chat', schemaVersion: 1, body: {} },
    })).run;
    const valid = (await store.createRun(identity, {
      conversationId: conversation.id,
      idempotencyKey: 'valid-' + Date.now(),
      request: normalizeChatRequest({ message: 'safe replay' }, identity.tenantId),
    })).run;
    await storage.adapter.query("UPDATE agent_runs SET created_at=clock_timestamp()-interval '1 second' WHERE run_id=$1", [invalid.runId]);

    const firstBatch = await store.claimReplayableQueuedRuns('invalid-first-worker', { limit: 1 });
    assert.equal(firstBatch.length, 1, 'invalid Run does not consume the effective claim limit');
    assert.equal(firstBatch[0].run.runId, valid.runId, 'the same bounded call claims the later valid Run');
    assert.equal((await store.getRun(identity, invalid.runId)).state, 'interrupted');
    const invalidEvents = (await store.eventsAfter(identity, invalid.runId)).events;
    assert.equal(invalidEvents.at(-1)?.type, 'done');
    assert.equal(invalidEvents.at(-1)?.payload?.state, 'interrupted');
    assert.equal(invalidEvents.at(-1)?.payload?.errorCode, 'RUN_REQUEST_NOT_REPLAYABLE');

    assert.equal((await store.getRun(identity, valid.runId)).state, 'queued', 'claim preserves the existing queued execution path');
    const lease = await storage.adapter.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1', [valid.runId]);
    assert.equal(lease.rows[0].lease_owner, 'invalid-first-worker');
    assert.equal((await store.getRun(identity, invalid.runId)).state, 'interrupted');

    const recoveryInvalid = (await store.createRun(identity, {
      conversationId: conversation.id,
      idempotencyKey: 'recovery-invalid-' + Date.now(),
      request: { kind: 'northstar.chat', schemaVersion: 1, body: {} },
    })).run;
    const recoveryValid = (await store.createRun(identity, {
      conversationId: conversation.id,
      idempotencyKey: 'recovery-valid-' + Date.now(),
      request: normalizeChatRequest({ message: 'safe startup replay' }, identity.tenantId),
    })).run;
    await store.recoverExpiredLeases({ limit: 100 });
    assert.equal((await store.getRun(identity, recoveryInvalid.runId)).state, 'interrupted', 'lease recovery does not SQL-filter invalid durable-chat envelopes');
    assert.equal((await store.getRun(identity, recoveryValid.runId)).state, 'queued', 'the same scan preserves valid canonical queued work');
  } finally {
    await storage?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('all-invalid queued scan exits within its independent candidate budget', { timeout: 20000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-invalid-queued-budget-'));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'key') });
    const registered = await storage.repositories.auth.register({ username: 'invalid-budget-' + Date.now(), password: 'FixturePass123' });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter), runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push((await store.createRun(identity, {
        conversationId: conversation.id,
        idempotencyKey: 'invalid-budget-' + i + '-' + Date.now(),
        request: { kind: 'northstar.chat', schemaVersion: 1, body: {} },
      })).run);
    }
    const claims = await store.claimReplayableQueuedRuns('bounded-invalid-worker', { limit: 1 });
    assert.deepEqual(claims, []);
    const states = await Promise.all(runs.map((run) => store.getRun(identity, run.runId)));
    assert.equal(states.filter((run) => run.state === 'interrupted').length, 4, 'limit=1 scans at most four candidates');
    assert.equal(states.filter((run) => run.state === 'queued').length, 1, 'remaining invalid work is left for the next bounded tick');
    await store.claimReplayableQueuedRuns('bounded-invalid-worker', { limit: 1 });
    assert.equal((await Promise.all(runs.map((run) => store.getRun(identity, run.runId)))).filter((run) => run.state === 'interrupted').length, 5);
  } finally {
    await storage?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
