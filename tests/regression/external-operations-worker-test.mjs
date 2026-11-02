import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const { createTaskStore } = require("../../shell/tasks/store.cjs");
const { createExternalOperationsWorker } = require("../../shell/tasks/external-operations-worker.cjs");
const { createPowerTokensQueryAdapters } = require("../../shell/tasks/provider-adapters.cjs");

const NOW = "2026-10-18T00:00:00.000Z";
const mapping = {
  extractStatus: (data) => data?.status,
  successStatuses: new Set(["complete"]),
  failureStatuses: new Set(["failed"]),
  pendingStatuses: new Set(["running"]),
};

function fakeStore({ candidates = [], claimed, recordError = null } = {}) {
  const calls = { recover: [], submissions: [], list: [], claim: [], record: [] };
  return {
    calls,
    async recoverExpiredQueries(args) { calls.recover.push(args); return []; },
    async recoverExpiredSubmissions(args) { calls.submissions.push(args); return []; },
    async listDue(args) { calls.list.push(args); return candidates; },
    async claimQuery(...args) { calls.claim.push(args); return claimed; },
    async recordQueryResult(...args) {
      calls.record.push(args);
      if (recordError) throw recordError;
      return { status: args[3].outcome };
    },
  };
}

function makeWorker(store, { queryTask = async () => ({ httpStatus: 200, data: { status: "complete" } }), credentialProvider = async () => "fixture-secret", onError = () => {}, owner = "operation-query-worker" } = {}) {
  const errors = [];
  const worker = createExternalOperationsWorker({
    store,
    queryAdapters: { fixture: { ...mapping, queryTask } },
    credentialProvider,
    owner,
    clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
    onError: (entry) => { errors.push(entry); onError(entry); },
  });
  return { worker, errors };
}

function candidate(overrides = {}) {
  const operation = {
    runId: "run-parent-1", operationKey: "image:poster", provider: "fixture", taskId: "task-1",
    ...overrides,
  };
  return { identity: { userId: "user-1", tenantId: "tenant-1" }, operation, nextAttempt: 1 };
}

test("external operation worker uses separate per-operation query lease and persists only under its owner", async () => {
  const store = fakeStore({ candidates: [candidate()], claimed: { acquired: true, attempt: 1, owner: "operation-query-worker", operation: candidate().operation } });
  const requests = [];
  const { worker, errors } = makeWorker(store, { queryTask: async (request) => { requests.push(request); return { httpStatus: 200, data: { status: "complete" } }; } });
  assert.deepEqual(await worker.runOnce(), { processed: 1 });
  assert.deepEqual(store.calls.recover, [{ limit: 50 }]);
  assert.deepEqual(store.calls.submissions, [{ limit: 50 }]);
  assert.equal(store.calls.claim.length, 1);
  assert.deepEqual(store.calls.claim[0], [candidate().identity, "run-parent-1", "image:poster", { owner: "operation-query-worker", ttlMs: 60_000 }]);
  assert.equal(requests.length, 1);
  assert.deepEqual({ provider: requests[0].provider, taskId: requests[0].taskId, credential: requests[0].credential }, { provider: "fixture", taskId: "task-1", credential: "fixture-secret" });
  assert.deepEqual(store.calls.record[0][0], candidate().identity);
  assert.equal(store.calls.record[0][1], "run-parent-1", "parent Run identity remains durable and unchanged");
  assert.equal(store.calls.record[0][2], "image:poster", "operationKey scopes persistence and query fencing");
  assert.equal(store.calls.record[0][3].outcome, "succeeded");
  assert.equal(store.calls.record[0][3].owner, "operation-query-worker");
  assert.deepEqual(errors, []);
});

test("worker never queries without acquiring the operation lease and never submits", async () => {
  let queryCount = 0;
  const store = fakeStore({ candidates: [candidate()], claimed: { acquired: false } });
  const { worker } = makeWorker(store, { queryTask: async () => { queryCount++; return { httpStatus: 200, data: { status: "complete" } }; } });
  await worker.runOnce();
  assert.equal(queryCount, 0);
  assert.equal(store.calls.record.length, 0);
});

test("provider query errors are reduced to safe codes and not persisted", async () => {
  const secret = "provider body and credential must not escape";
  const store = fakeStore({ candidates: [candidate()], claimed: { acquired: true, attempt: 1, operation: candidate().operation } });
  const { worker, errors } = makeWorker(store, { queryTask: async () => { throw Object.assign(new Error(secret), { code: "QUERY_FAILED" }); } });
  await worker.runOnce();
  assert.equal(store.calls.record[0][3].outcome, "query_temporary_failure");
  assert.equal(JSON.stringify(store.calls.record).includes(secret), false);
  assert.equal(JSON.stringify(errors).includes(secret), false);
});

test("stop drains an in-flight query and waits for fenced persistence", async () => {
  let finish, started;
  const startedQuery = new Promise((resolve) => { started = resolve; });
  const pendingQuery = new Promise((resolve) => { finish = resolve; });
  const store = fakeStore({ candidates: [candidate()], claimed: { acquired: true, attempt: 1, operation: candidate().operation } });
  const { worker } = makeWorker(store, { queryTask: async () => { started(); return pendingQuery; } });
  const tick = worker.runOnce();
  await startedQuery;
  let drained = false;
  const draining = worker.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish({ httpStatus: 200, data: { status: "complete" } });
  await Promise.all([tick, draining]);
  assert.equal(store.calls.record.length, 1);
  assert.equal(drained, true);
  assert.deepEqual(await worker.runOnce(), { skipped: true });
});

test("PGlite integration queries one operation without acquiring or changing its parent Run lease", async (t) => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false, "No external PostgreSQL configuration is allowed");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-external-worker-"));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(tmp, "db"), masterKeyFile: path.join(tmp, "key") });
    const runs = createTaskStore(storage.adapter);
    const user = await storage.repositories.auth.register({ username: "external-worker-fixture", password: "FixturePass123" });
    const identity = { userId: user.user.id, tenantId: user.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const runOwner = "parent-run-owner";
    let run = (await runs.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: "external-worker-parent", policyVersion: "fixture",
      request: { question: "create an image", attachments: [] },
    }, { owner: runOwner, ttlMs: 30_000 })).run;
    run = await runs.transition(identity, run.runId, "running", run.revision, runOwner);
    const operations = runs.externalOperations;
    await operations.createIntent(identity, run.runId, { operationKey: "image:poster", provider: "fixture", runLeaseOwner: runOwner });
    await operations.recordTaskId(identity, run.runId, "image:poster", { taskId: "known-task-1", runLeaseOwner: runOwner });
    await runs.releaseLease(identity, run.runId, runOwner);

    const queryCalls = [];
    const worker = createExternalOperationsWorker({
      store: operations,
      queryAdapters: { fixture: { ...mapping, queryTask: async (request) => { queryCalls.push(request); return { httpStatus: 200, data: { status: "complete" } }; } } },
      credentialProvider: async () => "fixture-only",
      owner: "independent-operation-owner",
      clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
    });
    assert.deepEqual(await worker.runOnce(), { processed: 1 });
    const operation = await operations.get(identity, run.runId, "image:poster");
    const persistedRunLease = (await storage.adapter.query("SELECT lease_owner FROM agent_runs WHERE run_id=$1", [run.runId])).rows[0].lease_owner;
    assert.equal(operation.status, "succeeded");
    assert.equal(operation.queryAttempts, 1);
    assert.equal(operation.lastQuery.attempt, 1);
    assert.equal(persistedRunLease, null, "operation reconciliation does not manufacture a parent Run lease");
    const reconciledRun = await runs.getRun(identity, run.runId);
    assert.equal(reconciledRun.state, "running", "successful child reconciliation does not complete its parent Run");
    assert.equal(reconciledRun.reconciliation, "not_required");
    const parentEvents = (await runs.eventsAfter(identity, run.runId)).events;
    assert.equal(parentEvents.some((event) => event.type === "done"), false, "child success does not append a parent done event");
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0].taskId, "known-task-1");

    const terminalOwner = "terminal-parent-owner";
    let terminalRun = (await runs.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: "external-worker-terminal-parent", policyVersion: "fixture",
      request: { question: "create another image", attachments: [] },
    }, { owner: terminalOwner, ttlMs: 30_000 })).run;
    terminalRun = await runs.transition(identity, terminalRun.runId, "running", terminalRun.revision, terminalOwner);
    await operations.createIntent(identity, terminalRun.runId, { operationKey: "image:terminal-parent", provider: "fixture", runLeaseOwner: terminalOwner });
    await operations.recordTaskId(identity, terminalRun.runId, "image:terminal-parent", { taskId: "known-terminal-task", runLeaseOwner: terminalOwner });
    terminalRun = await runs.getRun(identity, terminalRun.runId);
    terminalRun = await runs.transition(identity, terminalRun.runId, "failed", terminalRun.revision, terminalOwner);
    assert.equal(terminalRun.state, "failed");

    assert.deepEqual(await worker.runOnce(), { processed: 1 });
    const terminalOperation = await operations.get(identity, terminalRun.runId, "image:terminal-parent");
    const terminalAfterQuery = await runs.getRun(identity, terminalRun.runId);
    const terminalEvents = (await runs.eventsAfter(identity, terminalRun.runId)).events;
    assert.equal(terminalOperation.status, "succeeded", "known provider task remains reconcilable after parent termination");
    assert.equal(terminalAfterQuery.state, "failed", "provider success does not reopen or complete a terminal parent Run");
    assert.equal(terminalEvents.filter((event) => event.type === "done").length, 1, "child reconciliation does not duplicate the terminal done event");
    await worker.stop();
  } finally {
    if (storage) await storage.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("PGlite unknown HTTP 200 provider state remains manual_check after storage reopen and worker recreation", async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false, "No external PostgreSQL configuration is allowed");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-external-worker-unknown-state-"));
  let storage;
  let worker;
  try {
    storage = await createStorage({ dataDir: path.join(tmp, "db"), masterKeyFile: path.join(tmp, "key") });
    let runs = createTaskStore(storage.adapter);
    const user = await storage.repositories.auth.register({ username: "external-worker-unknown-state", password: "FixturePass123" });
    const identity = { userId: user.user.id, tenantId: user.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const owner = "unknown-state-parent-owner";
    let run = (await runs.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: "external-worker-unknown-state", policyVersion: "fixture",
      request: { question: "create an image", attachments: [] },
    }, { owner, ttlMs: 30_000 })).run;
    run = await runs.transition(identity, run.runId, "running", run.revision, owner);
    let operations = runs.externalOperations;
    await operations.createIntent(identity, run.runId, { operationKey: "image:unknown-state", provider: "fixture", runLeaseOwner: owner });
    await operations.recordTaskId(identity, run.runId, "image:unknown-state", { taskId: "known-task-unknown-status", runLeaseOwner: owner });
    await runs.releaseLease(identity, run.runId, owner);

    const requests = [];
    const queryAdapters = createPowerTokensQueryAdapters({
      baseUrl: "https://fixture.invalid",
      providerMappings: { fixture: { kind: "image", successStatuses: new Set(["complete"]), failureStatuses: new Set(["failed"]), pendingStatuses: new Set() } },
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method });
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ status: "provider-added-a-new-state" }),
        };
      },
    });
    worker = createExternalOperationsWorker({
      store: operations,
      queryAdapters,
      credentialProvider: async () => "fixture-only",
      owner: "unknown-state-query-worker",
      clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
    });

    assert.deepEqual(await worker.runOnce(), { processed: 1 });
    const operation = await operations.get(identity, run.runId, "image:unknown-state");
    assert.equal(operation.status, "manual_check");
    assert.equal(operation.taskId, "known-task-unknown-status", "the known external task ID stays available for manual reconciliation");
    assert.equal(operation.queryAttempts, 1);
    assert.deepEqual(operation.lastQuery, {
      outcome: "provider_state_unknown", observedAt: NOW, providerStatus: null,
      reason: "unrecognized_provider_state", attempt: 1, queried: true,
    });
    await worker.stop();
    worker = null;
    await storage.close();
    storage = await createStorage({ dataDir: path.join(tmp, "db"), masterKeyFile: path.join(tmp, "key") });
    runs = createTaskStore(storage.adapter);
    operations = runs.externalOperations;
    await runs.recoverInterrupted(identity);
    worker = createExternalOperationsWorker({
      store: operations,
      queryAdapters,
      credentialProvider: async () => "fixture-only",
      owner: "recreated-unknown-state-query-worker",
      clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
    });
    assert.deepEqual(await worker.runOnce(), { processed: 0 }, "storage reopen and startup recovery exclude persisted manual_check from query batches");
    assert.deepEqual(requests, [{ url: "https://fixture.invalid/v1/tasks/known-task-unknown-status", method: "GET" }]);
    assert.equal(requests.filter((request) => request.method === "GET").length, 1);
    assert.equal(requests.filter((request) => request.method === "POST").length, 0, "query-only reconciliation never resubmits provider work");
    const after = await runs.getRun(identity, run.runId);
    assert.equal(after.state, "waiting_external", "unknown provider state does not manufacture a Run terminal state");
    assert.equal((await operations.get(identity, run.runId, "image:unknown-state")).status, "manual_check");
    const events = (await runs.eventsAfter(identity, run.runId)).events;
    assert.equal(events.some((event) => event.type === "done"), false);
  } finally {
    if (worker) await worker.stop();
    if (storage) await storage.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("PGlite commit acknowledgment loss does not repeat a terminal provider query", async (t) => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false, "No external PostgreSQL configuration is allowed");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-external-worker-ack-loss-"));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(tmp, "db"), masterKeyFile: path.join(tmp, "key") });
    const runs = createTaskStore(storage.adapter);
    const user = await storage.repositories.auth.register({ username: "external-worker-ack-loss", password: "FixturePass123" });
    const identity = { userId: user.user.id, tenantId: user.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const owner = "ack-loss-parent-owner";
    let run = (await runs.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: "external-worker-ack-loss", policyVersion: "fixture",
      request: { question: "create an image", attachments: [] },
    }, { owner, ttlMs: 30_000 })).run;
    run = await runs.transition(identity, run.runId, "running", run.revision, owner);
    const operations = runs.externalOperations;
    await operations.createIntent(identity, run.runId, { operationKey: "image:ack-loss", provider: "fixture", runLeaseOwner: owner });
    await operations.recordTaskId(identity, run.runId, "image:ack-loss", { taskId: "ack-loss-known-task", runLeaseOwner: owner });
    await runs.releaseLease(identity, run.runId, owner);

    let loseCommitAcknowledgment = true;
    let resultWrites = 0;
    const store = {
      ...operations,
      async recordQueryResult(...args) {
        resultWrites++;
        const committed = await operations.recordQueryResult(...args);
        if (loseCommitAcknowledgment) {
          loseCommitAcknowledgment = false;
          throw Object.assign(new Error("simulated lost commit acknowledgment"), { code: "ACK_LOST" });
        }
        return committed;
      },
    };
    const queryCalls = [];
    const errors = [];
    const worker = createExternalOperationsWorker({
      store,
      queryAdapters: { fixture: { ...mapping, queryTask: async (request) => { queryCalls.push(request); return { httpStatus: 200, data: { status: "complete" } }; } } },
      credentialProvider: async () => "fixture-only",
      owner: "independent-operation-owner",
      clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
      onError: (entry) => errors.push(entry),
    });

    assert.deepEqual(await worker.runOnce(), { processed: 1 });
    const committedOperation = await operations.get(identity, run.runId, "image:ack-loss");
    assert.equal(committedOperation.status, "succeeded", "the underlying result transaction committed before its acknowledgment was lost");
    assert.equal(committedOperation.queryAttempts, 1);
    assert.equal(resultWrites, 1);
    assert.deepEqual(errors, [{ phase: "record_result", code: "ack_lost" }]);
    const firstEvents = (await runs.eventsAfter(identity, run.runId)).events;
    assert.equal(firstEvents.filter((event) => event.payload?.operationKey === "image:ack-loss" && event.payload?.action === "external_operation_query_result").length, 1);
    assert.equal(firstEvents.some((event) => event.type === "done"), false);
    assert.equal((await runs.getRun(identity, run.runId)).state, "running");

    assert.deepEqual(await worker.runOnce(), { processed: 0 }, "terminal operation is no longer due after recovery scan");
    const afterRecovery = await operations.get(identity, run.runId, "image:ack-loss");
    const afterEvents = (await runs.eventsAfter(identity, run.runId)).events;
    assert.equal(queryCalls.length, 1, "known task is queried once; lost acknowledgment does not cause a repeat query");
    assert.equal(resultWrites, 1, "terminal success event is not written again");
    assert.equal(afterRecovery.status, "succeeded");
    assert.equal(afterEvents.filter((event) => event.payload?.operationKey === "image:ack-loss" && event.payload?.action === "external_operation_query_result").length, 1);
    assert.equal(afterEvents.filter((event) => event.type === "done").length, 0);
    assert.equal((await runs.getRun(identity, run.runId)).state, "running", "worker recovery does not complete the parent Run");
    await worker.stop();
  } finally {
    if (storage) await storage.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
