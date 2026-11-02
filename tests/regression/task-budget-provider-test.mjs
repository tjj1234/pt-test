import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");
const { reconcileOnce, MAX_ATTEMPTS } = require("../../shell/tasks/provider-reconciliation.cjs");
const { createProviderReconciliationWorker } = require("../../shell/tasks/provider-reconciliation-worker.cjs");
const { createPowerTokensQueryAdapters } = require("../../shell/tasks/provider-adapters.cjs");

const NOW = "2026-10-18T00:00:00.000Z";
const mapping = {
  extractStatus: (data) => data?.status,
  successStatuses: new Set(["complete"]),
  failureStatuses: new Set(["failed"]),
  pendingStatuses: new Set(["running"]),
};

function externalRun(overrides = {}) {
  return {
    runId: "run-1",
    revision: 4,
    externalOperationKey: "op-1",
    externalProvider: "sample",
    externalTaskId: "task-1",
    ...overrides,
  };
}

function fakeStore({ candidates = [], claim = { acquired: false }, onRecover = () => {}, onRecord = () => {} } = {}) {
  const calls = { sequence: [], recover: [], list: [], claim: [], record: [] };
  return {
    calls,
    async recoverExpiredExternalReconciliationClaims(args) { calls.sequence.push("recover"); calls.recover.push(args); return onRecover(args); },
    async listDueExternalReconciliations(args) { calls.sequence.push("list"); calls.list.push(args); return candidates; },
    async claimExternalReconciliation(...args) { calls.sequence.push("claim"); calls.claim.push(args); return typeof claim === "function" ? claim(...args) : claim; },
    async recordExternalReconciliation(...args) { calls.sequence.push("record"); calls.record.push(args); return onRecord(...args); },
  };
}

function makeWorker(store, { queryTask = async () => ({ httpStatus: 200, data: { status: "running" } }), attempt = 1, onError = () => {} } = {}) {
  const errors = [];
  const adapter = { ...mapping, queryTask };
  const worker = createProviderReconciliationWorker({
    store,
    queryAdapters: { sample: adapter },
    credentialProvider: async () => "test-credential",
    owner: "worker-test",
    clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
    onError: (entry) => { errors.push(entry); onError(entry); },
  });
  // Candidate's claimed attempt is controlled by the store fixture.
  return { worker, errors, attempt };
}

test("budget admission is synchronous under concurrent callers", async () => {
  const budget = createRunBudget({ limits: { maxToolCalls: 1 }, startedAt: 10, now: () => 10 });
  const admissions = await Promise.all(Array.from({ length: 32 }, async () => budget.admit({ type: "tool", key: "same" })));
  assert.equal(admissions.filter((entry) => entry.allowed).length, 1);
  assert.equal(admissions.filter((entry) => entry.code === "RUN_TOOL_CALL_LIMIT").length, 31);
  assert.equal(budget.snapshot().toolCalls, 1);
});

test("model requests and retries stop at explicit per-run limits", () => {
  const budget = createRunBudget({ limits: { maxModelCalls: 1, maxRetries: 0 }, startedAt: 10, now: () => 10 });
  const first = budget.admit({ type: "model" });
  assert.equal(first.allowed, true);
  first.settle();
  assert.equal(budget.admit({ type: "model" }).code, "RUN_MODEL_CALL_LIMIT");
  assert.equal(budget.admit({ type: "retry" }).code, "RUN_RETRY_LIMIT");
  assert.equal(budget.snapshot().modelCalls, 1);
  assert.equal(budget.snapshot().retries, 0);
});

test("budget fails closed when settlement has no actual cost evidence", () => {
  let now = 100;
  const budget = createRunBudget({ limits: { maxCost: { amount: 2, currency: "USD" } }, startedAt: 100, now: () => now });
  const admitted = budget.admit({ type: "model", estimatedCost: { amount: 1, currency: "USD" } });
  assert.equal(admitted.allowed, true);
  admitted.settle();
  assert.equal(budget.snapshot().costStatus, "unknown");
  assert.equal(budget.admit({ type: "tool", key: "k", estimatedCost: { amount: 0, currency: "USD" } }).code, "RUN_COST_UNKNOWN");
});

test("budget stops admission after monotonic clock rollback", () => {
  let now = 20;
  const budget = createRunBudget({ limits: { maxDurationMs: 100 }, startedAt: 20, now: () => now });
  assert.equal(budget.admit({ type: "model" }).allowed, true);
  now = 19;
  const denied = budget.admit({ type: "model" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "RUN_CLOCK_UNKNOWN");
  assert.equal(budget.snapshot().clockStatus, "unknown");
});

test("query adapter sends only GET to kind-specific endpoint with injected credential", async () => {
  const requests = [];
  const adapters = createPowerTokensQueryAdapters({
    baseUrl: "https://provider.invalid/api/",
    apiKey: null,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: "surprise" }) };
    },
    providerMappings: {
      sampleImage: { kind: "image", ...mapping },
      sampleVideo: { kind: "video", ...mapping },
    },
  });
  const imageResult = await adapters.sampleImage.queryTask({ provider: "sampleImage", taskId: "id /1", credential: "injected-secret" });
  await adapters.sampleVideo.queryTask({ provider: "sampleVideo", taskId: "video-2", credential: "injected-secret" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://provider.invalid/api/v1/tasks/id%20%2F1");
  assert.equal(requests[1].url, "https://provider.invalid/api/v1/videos/video-2");
  for (const { options } of requests) {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer injected-secret");
    assert.equal(options.headers.Accept, "application/json");
  }
  const mapped = await reconcileOnce(externalRun({ externalProvider: "sampleImage" }), {
    queryTask: ({ provider, taskId }) => adapters[provider].queryTask({ provider, taskId, credential: "injected-secret" }),
    ...mapping,
    now: () => NOW,
  });
  assert.equal(imageResult.httpStatus, 200);
  assert.equal(mapped.action, "manual_check");
  assert.equal(mapped.outcome, "provider_state_unknown");
  assert.equal(mapped.audit.reason, "unrecognized_provider_state");
});

test("reconciliation does not query when atomic claim was not acquired", async () => {
  let queryCount = 0;
  const store = fakeStore({ candidates: [{ identity: { userId: "u1" }, run: externalRun() }], claim: { acquired: false } });
  const { worker, errors } = makeWorker(store, { queryTask: async () => { queryCount++; return { httpStatus: 200, data: { status: "complete" } }; } });
  const result = await worker.runOnce();
  assert.deepEqual(result, { processed: 1 });
  assert.equal(store.calls.claim.length, 1);
  assert.equal(queryCount, 0);
  assert.equal(store.calls.record.length, 0);
  assert.deepEqual(errors, []);
});

test("worker recovers expired claims before listing and querying due work", async () => {
  let queryCount = 0;
  const candidate = { identity: { userId: "u1" }, run: externalRun() };
  const store = fakeStore({
    candidates: [],
    onRecover() { store.candidates = [candidate]; return 1; },
    claim: { acquired: true, attempt: 2, run: externalRun({ revision: 5 }) },
  });
  // The list fixture reads the simulated recovery queue after recovery runs.
  store.candidates = [];
  store.listDueExternalReconciliations = async (args) => {
    store.calls.sequence.push("list");
    store.calls.list.push(args);
    return store.candidates;
  };
  const { worker } = makeWorker(store, { queryTask: async () => { queryCount++; return { httpStatus: 200, data: { status: "complete" } }; } });
  await worker.runOnce();
  assert.deepEqual(store.calls.recover, [{ limit: 50 }]);
  assert.deepEqual(store.calls.list, [{ limit: 50 }]);
  assert.deepEqual(store.calls.sequence, ["recover", "list", "claim", "record"]);
  assert.equal(queryCount, 1);
  assert.equal(store.calls.record[0][2].outcome, "succeeded");
});

test("worker records exhausted eighth query for manual review without leaking provider errors", async () => {
  let queryCount = 0;
  const secretText = "private key and provider response body";
  const claimedRun = externalRun({ revision: 5 });
  const store = fakeStore({
    candidates: [{ identity: { userId: "u1" }, run: externalRun() }],
    claim: { acquired: true, attempt: MAX_ATTEMPTS, run: claimedRun },
  });
  const { worker, errors } = makeWorker(store, {
    queryTask: async () => { queryCount++; throw Object.assign(new Error(secretText), { code: "TEMPORARY_PROVIDER_FAILURE" }); },
  });
  const result = await worker.runOnce();
  assert.deepEqual(result, { processed: 1 });
  assert.equal(queryCount, 1);
  assert.equal(store.calls.record.length, 1);
  const persisted = store.calls.record[0][2];
  assert.equal(persisted.outcome, "query_retry_exhausted");
  assert.equal(persisted.nextQueryAt, null);
  assert.equal(persisted.reason, "query_error");
  assert.equal(JSON.stringify(store.calls.record).includes(secretText), false);
  assert.equal(JSON.stringify(errors).includes(secretText), false);
  assert.deepEqual(errors, []);
});

test("transient retries use bounded delays and only status queries", async () => {
  const run = externalRun();
  const seen = [];
  const result = await reconcileOnce(run, {
    ...mapping,
    attempt: 7,
    now: () => NOW,
    queryTask: async (request) => { seen.push(request); return { httpStatus: 503, data: { status: "ignored" }, retryAfterMs: 999_999 }; },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { provider: "sample", taskId: "task-1" });
  assert.equal(result.action, "retry_query");
  assert.equal(result.audit.nextDelayMs, 30_000);
  const exhausted = await reconcileOnce(run, { ...mapping, attempt: 8, now: () => NOW, queryTask: async () => ({ httpStatus: 503 }) });
  assert.equal(exhausted.action, "manual_check");
  assert.equal(exhausted.outcome, "query_retry_exhausted");
});

test("worker stop drains an in-flight lookup before allowing database shutdown", async () => {
  let finishLookup, lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  const lookup = new Promise((resolve) => { finishLookup = resolve; });
  const store = fakeStore({ candidates: [{ identity: { userId: "u1" }, run: externalRun() }], claim: { acquired: true, attempt: 1, run: externalRun() } });
  const { worker } = makeWorker(store, { queryTask: async () => { lookupStarted(); return lookup; } });
  const tick = worker.runOnce();
  await started;
  let drained = false;
  const stopping = worker.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finishLookup({ httpStatus: 200, data: { status: "complete" } });
  await Promise.all([tick, stopping]);
  assert.equal(store.calls.record.length, 1);
  assert.equal(drained, true);
  assert.deepEqual(await worker.runOnce(), { skipped: true });
});

