"use strict";

// Background status reconciliation for paid operations. This worker never owns
// or edits a Run execution lease and never submits work; the operation store
// provides a separate query lease and fencing token for every lookup.
const { MAX_ATTEMPTS, normalizeMapping, reconcileOnce, retryDelayMs, safeLabel } = require("./provider-reconciliation.cjs");

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_DELAY_MS = 30_000;
const SYSTEM_CLOCK = Object.freeze({
  now: () => new Date().toISOString(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer),
});

function validTimestamp(value) {
  return typeof value === "string" && value.length <= 35 && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function adapterFor(adapters, provider) {
  if (!adapters || typeof provider !== "string" || !provider) return null;
  if (adapters instanceof Map) return adapters.get(provider) || null;
  return Object.hasOwn(adapters, provider) ? adapters[provider] : null;
}

function createExternalOperationsWorker({
  store,
  queryAdapters,
  credentialProvider,
  owner,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = 50,
  leaseTtlMs = 60_000,
  clock = SYSTEM_CLOCK,
  onError = () => {},
} = {}) {
  for (const method of ["listDue", "claimQuery", "recordQueryResult", "recoverExpiredQueries"]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  if (typeof credentialProvider !== "function") throw new TypeError("credentialProvider is required");
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256) throw new TypeError("owner must be a non-empty string up to 256 characters");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) throw new TypeError("intervalMs must be 250ms to 5m");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError("batchSize must be 1 to 500");
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 300_000) throw new TypeError("leaseTtlMs must be 1s to 5m");
  if (!clock || typeof clock.now !== "function" || typeof clock.setInterval !== "function" || typeof clock.clearInterval !== "function") throw new TypeError("clock requires now, setInterval and clearInterval functions");
  if (typeof onError !== "function") throw new TypeError("onError must be a function");

  let timer = null;
  let busy = false;
  let stopped = false;
  const drainWaiters = [];

  function report(error, phase) {
    try { onError({ phase, code: safeLabel(error?.code, 64) }); } catch { /* reporting cannot stop reconciliation */ }
  }

  async function reconcileCandidate(candidate, observedAt) {
    const { identity, operation } = candidate || {};
    if (!identity || !operation?.runId || !operation?.operationKey || !operation?.taskId || !operation?.provider) {
      report(Object.assign(new Error("incomplete external operation"), { code: "EXTERNAL_OPERATION_INVALID" }), "candidate");
      return;
    }

    let claimed;
    try {
      claimed = await store.claimQuery(identity, operation.runId, operation.operationKey, { owner, ttlMs: leaseTtlMs });
    } catch (error) { report(error, "claim"); return; }
    if (!claimed?.acquired) return;

    // Always use the claimed row, not stale scan data. The parent run ID and
    // operation key are retained from durable storage; no synthetic Run IDs or
    // process-local ownership maps are used.
    const current = claimed.operation;
    if (!current?.taskId || current.runId !== operation.runId || current.operationKey !== operation.operationKey) {
      report(Object.assign(new Error("claimed operation identity changed"), { code: "EXTERNAL_OPERATION_IDENTITY_MISMATCH" }), "claim_result");
      return;
    }
    const adapter = adapterFor(queryAdapters, current.provider);
    const mapping = adapter && normalizeMapping(adapter);
    if (!adapter || typeof adapter.queryTask !== "function" || !mapping) {
      try {
        await store.recordQueryResult(identity, current.runId, current.operationKey, {
          owner, outcome: "provider_state_unknown", reason: adapter ? "provider_mapping_invalid" : "provider_adapter_missing", observedAt,
        });
      } catch (error) { report(error, "record_missing_adapter"); }
      return;
    }

    let credential;
    try { credential = await credentialProvider(identity, current); }
    catch (error) {
      report(error, "load_credential");
      try {
        await store.recordQueryResult(identity, current.runId, current.operationKey, {
          owner, outcome: "provider_state_unknown", reason: "provider_credential_unavailable", observedAt,
        });
      } catch (recordError) { report(recordError, "record_missing_credential"); }
      return;
    }
    if (credential === null || credential === undefined || credential === "") {
      try {
        await store.recordQueryResult(identity, current.runId, current.operationKey, {
          owner, outcome: "provider_state_unknown", reason: "provider_credential_unavailable", observedAt,
        });
      } catch (error) { report(error, "record_missing_credential"); }
      return;
    }

    const result = await reconcileOnce({
      externalProvider: current.provider,
      externalTaskId: current.taskId,
      externalOperationKey: current.operationKey,
    }, {
      attempt: claimed.attempt,
      now: () => observedAt,
      extractStatus: mapping.extractStatus,
      successStatuses: mapping.successStatuses,
      failureStatuses: mapping.failureStatuses,
      pendingStatuses: mapping.pendingStatuses,
      // Adapter contract is query-only. Never call the paid submission path.
      queryTask: ({ provider, taskId }) => adapter.queryTask({ provider, taskId, credential, identity, operation: current }),
    });

    let outcome = result.outcome;
    let nextQueryAt = null;
    let reason = result.audit.reason || null;
    if (["provider_pending", "query_temporary_failure"].includes(outcome)) {
      if (claimed.attempt >= MAX_ATTEMPTS) {
        outcome = "query_retry_exhausted";
        reason = reason || "query_attempt_limit_reached";
      } else {
        const delay = Number.isFinite(result.audit.nextDelayMs)
          ? Math.max(1_000, Math.min(MAX_DELAY_MS, result.audit.nextDelayMs))
          : retryDelayMs(claimed.attempt);
        nextQueryAt = new Date(Date.parse(observedAt) + delay).toISOString();
      }
    }
    try {
      await store.recordQueryResult(identity, current.runId, current.operationKey, {
        owner, outcome, providerStatus: result.audit.providerStatus || null, reason,
        observedAt: result.audit.observedAt || observedAt, nextQueryAt,
      });
    } catch (error) {
      // Keep the expired operation query lease recoverable; no Run lease is
      // cleared or recreated by this worker.
      report(error, "record_result");
    }
  }

  async function runOnce() {
    if (busy || stopped) return { skipped: true };
    busy = true;
    let processed = 0;
    try {
      await store.recoverExpiredQueries({ limit: batchSize });
      if (typeof store.recoverExpiredSubmissions === "function") await store.recoverExpiredSubmissions({ limit: batchSize });
      const due = await store.listDue({ limit: batchSize });
      for (const candidate of due) {
        if (stopped) break;
        let observedAt;
        try { observedAt = clock.now(); } catch { observedAt = null; }
        if (!validTimestamp(observedAt)) {
          report(Object.assign(new Error("invalid clock"), { code: "CLOCK_INVALID" }), "clock");
          break;
        }
        await reconcileCandidate(candidate, observedAt);
        processed++;
      }
      return { processed };
    } catch (error) {
      report(error, "scan");
      return { processed, errorCode: safeLabel(error?.code, 64) };
    } finally {
      busy = false;
      drainWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  function start() {
    if (stopped) throw new Error("External operations worker has been stopped");
    if (timer) return false;
    void runOnce();
    timer = clock.setInterval(() => { void runOnce(); }, intervalMs);
    timer?.unref?.();
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) clock.clearInterval(timer);
    timer = null;
    return busy ? new Promise((resolve) => drainWaiters.push(resolve)) : Promise.resolve();
  }

  return { start, stop, runOnce };
}

module.exports = { createExternalOperationsWorker };
