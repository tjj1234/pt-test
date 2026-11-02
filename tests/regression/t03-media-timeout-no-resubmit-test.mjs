import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { callMediaRoute } = require('../../business/media/powertokens.cjs');
const { createMediaRunHandler } = require('../../shell/tasks/media-run-handler.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
const { createStorage } = require('../../shell/storage/index.cjs');
const { createExternalOperationsWorker } = require('../../shell/tasks/external-operations-worker.cjs');
const { createPowerTokensQueryAdapters } = require('../../shell/tasks/provider-adapters.cjs');

const SUCCESS = new Set(['completed', 'succeeded', 'success', 'successful', 'finished', 'done', 'ready', 'ok']);
const FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled', 'expired', 'rejected', 'timeout']);
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('image poll timeout preserves the known task for query-only recovery without another POST', { timeout: 30_000 }, async (t) => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false,
    'fixture must not inherit PostgreSQL configuration');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't03-media-timeout-reconcile-'));
  let storage;
  t.after(async () => {
    try { await storage?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  storage = await createStorage({
    dataDir: path.join(root, 'db'),
    masterKeyFile: path.join(root, 'master.key'),
    defaultAdmin: false,
  });

  const registered = await storage.repositories.auth.register({ username: 'media-timeout-fixture', password: 'Fixture123456' });
  const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
  const conversation = await storage.repositories.conversations.create(identity.userId);
  const store = createTaskStore(storage.adapter);
  const owner = 'media-timeout-fixture';
  let run = (await store.createRun(identity, {
    conversationId: conversation.id,
    idempotencyKey: randomUUID(),
    request: { message: 'controlled synthetic media timeout' },
  }, { owner, ttlMs: 30_000 })).run;
  run = await store.transition(identity, run.runId, 'running', run.revision, owner);

  const calls = [];
  const taskId = 'synthetic-task-timeout-1';
  const pendingFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ phase: 'submission', method, url: String(url) });
    if (method === 'POST') return response(200, { task_id: taskId });
    return response(200, { status: 'processing', progress: 10 });
  };
  const mediaHandler = createMediaRunHandler({
    store,
    identity,
    taskRun: { runId: run.runId, leaseOwner: owner, signal: new AbortController().signal },
    loadCredential: async () => 'synthetic-fixture-credential',
    fetchImpl: pendingFetch,
    executeMedia: (context, args, opts) => callMediaRoute(context, args, {
      ...opts,
      baseUrl: 'https://fixture.invalid',
      timeoutMs: 1,
    }),
  });
  const requestId = randomUUID();
  await assert.rejects(mediaHandler.handle({
    requestId,
    name: 'media.route',
    args: { taskType: 'text2image', prompt: 'synthetic timeout fixture' },
  }), /本地轮询守护超时/);
  await mediaHandler.drain();

  assert.equal(calls.filter((call) => call.method === 'POST').length, 1, 'initial submission is issued exactly once');
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.endsWith(`/v1/tasks/${taskId}`)), 'local poll queried the known task');
  const operationKey = `${run.runId}:${requestId}`;
  let operation = await store.externalOperations.get(identity, run.runId, operationKey);
  assert.equal(operation.status, 'accepted', 'poll timeout does not falsely mark the provider task failed');
  assert.equal(operation.taskId, taskId, 'task ID is durably recorded before polling');
  assert.equal(operation.provider, 'seedream');
  const intentEvents = (await store.eventsAfter(identity, run.runId)).events;
  assert.ok(intentEvents.some((event) => event.payload?.action === 'external_operation_intent'));
  assert.ok(intentEvents.some((event) => event.payload?.action === 'external_operation_task_id'));

  // A terminal local Run makes its already-known external task eligible for the
  // recovery worker. The worker receives only a query adapter; the fake adapter
  // uses the same GET-only PowerTokens adapter contract, with no network access.
  run = await store.getRun(identity, run.runId);
  await store.transition(identity, run.runId, 'failed', run.revision, owner);
  const queryAdapter = createPowerTokensQueryAdapters({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      calls.push({ phase: 'recovery', method, url: String(url) });
      assert.equal(method, 'GET', 'reconciliation adapter is query-only');
      return response(200, { status: 'completed' });
    },
    providerMappings: {
      seedream: {
        kind: 'image',
        successStatuses: SUCCESS,
        failureStatuses: FAILURE,
        pendingStatuses: new Set(),
      },
    },
  });
  const worker = createExternalOperationsWorker({
    store: store.externalOperations,
    queryAdapters: queryAdapter,
    credentialProvider: async () => 'synthetic-fixture-credential',
    owner: 'media-query-worker-fixture',
    clock: {
      now: () => new Date().toISOString(),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    },
  });
  const recovery = await worker.runOnce();
  assert.equal(recovery.processed, 1, 'worker reconciles the known operation');
  operation = await store.externalOperations.get(identity, run.runId, operationKey);
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.taskId, taskId);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1, 'recovery never resubmits generation');
  const recoveryCalls = calls.filter((call) => call.phase === 'recovery');
  assert.equal(recoveryCalls.length, 1);
  assert.deepEqual(recoveryCalls.map((call) => call.method), ['GET']);
  assert.match(recoveryCalls[0].url, new RegExp(`/v1/tasks/${taskId}$`));
});
