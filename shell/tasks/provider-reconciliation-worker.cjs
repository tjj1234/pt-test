"use strict";

const { MAX_ATTEMPTS, normalizeMapping, reconcileOnce, retryDelayMs, safeLabel } = require("./provider-reconciliation.cjs");
const { createPowerTokensQueryAdapters } = require("./provider-adapters.cjs");

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

function createProviderReconciliationWorker({
  store,
  queryAdapters,
  loadCredential,
  credentialProvider,
  powerTokensAdapterOptions,
  owner,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = 50,
  leaseTtlMs = 60_000,
  clock = SYSTEM_CLOCK,
  onError = () => {},
} = {}) {
  for (const method of ["listDueExternalReconciliations", "claimExternalReconciliation", "recordExternalReconciliation"]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  // Keep the original loadCredential contract; credentialProvider is an alias for
  // new callers. Credentials are fetched per claimed run and never logged.
  const resolveCredential = credentialProvider ?? loadCredential;
  if (typeof resolveCredential !== "function") throw new TypeError("credentialProvider or loadCredential is required");
  let resolvedAdapters = queryAdapters;
  if (resolvedAdapters === undefined && powerTokensAdapterOptions !== undefined) {
    const { providerMappings, ...adapterOptions } = powerTokensAdapterOptions || {};
    const entries = providerMappings instanceof Map ? [...providerMappings.entries()] : Object.entries(providerMappings || {});
    if (!entries.length || entries.some(([, mapping]) => !mapping || !Object.hasOwn(mapping, "pendingStatuses") || !(mapping.pendingStatuses instanceof Set))) {
      throw new TypeError("powerTokensAdapterOptions.providerMappings must explicitly define pendingStatuses as a Set for every provider");
    }
    // Force per-run credential injection, even if adapter options accidentally
    // contain a static key. This keeps key lifecycle with credentialProvider.
    resolvedAdapters = createPowerTokensQueryAdapters({ ...adapterOptions, providerMappings, apiKey: null });
  }
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256) throw new TypeError("owner must be a non-empty string up to 256 characters");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) throw new TypeError("intervalMs must be 250ms to 5m");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError("batchSize must be 1 to 500");
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 300_000) throw new TypeError("leaseTtlMs must be 1s to 5m");
  if (!clock || typeof clock.now !== "function" || typeof clock.setInterval !== "function" || typeof clock.clearInterval !== "function") {
    throw new TypeError("clock requires now, setInterval and clearInterval functions");
  }
  if (typeof onError !== "function") throw new TypeError("onError must be a function");

  let timer = null;
  let busy = false;
  let stopped = false;
  const drainWaiters = [];

  function report(error, phase) {
    try { onError({ phase, code: safeLabel(error?.code, 64) }); } catch { /* logging must not stop reconciliation */ }
  }

  async function saveManual(identity, claimed, observedAt, reason) {
    return store.recordExternalReconciliation(identity, claimed.run.runId, {
      expectedRevision: claimed.run.revision,
      leaseOwner: owner,
      outcome: "provider_state_unknown",
      reason,
      observedAt,
    });
  }

  async function reconcileClaim(candidate, observedAt) {
    const { identity, run } = candidate;
    if (!run?.externalOperationKey || !run?.externalTaskId) {
      report(Object.assign(new Error("incomplete external task record"), { code: "EXTERNAL_RECORD_INVALID" }), "candidate");
      return;
    }
    let claimed;
    try {
      claimed = await store.claimExternalReconciliation(identity, run.runId, owner, leaseTtlMs);
    } catch (error) { report(error, "claim"); return; }
    if (!claimed?.acquired) return;

    const current = { ...candidate, run: claimed.run };
    const adapter = adapterFor(resolvedAdapters, current.run.externalProvider);
    if (!adapter || typeof adapter.queryTask !== "function") {
      try { await saveManual(identity, claimed, observedAt, "provider_adapter_missing"); }
      catch (error) { report(error, "record_missing_adapter"); }
      return;
    }
    const mapping = normalizeMapping(adapter);
    if (!mapping) {
      try { await saveManual(identity, claimed, observedAt, "provider_mapping_invalid"); }
      catch (error) { report(error, "record_invalid_mapping"); }
      return;
    }

    let credential;
    try { credential = await resolveCredential(identity, current.run); }
    catch (error) {
      report(error, "load_credential");
      try { await saveManual(identity, claimed, observedAt, "provider_credential_unavailable"); }
      catch (recordError) { report(recordError, "record_missing_credential"); }
      return;
    }
    if (credential === null || credential === undefined || credential === "") {
      try { await saveManual(identity, claimed, observedAt, "provider_credential_unavailable"); }
      catch (error) { report(error, "record_missing_credential"); }
      return;
    }

    const result = await reconcileOnce(current.run, {
      attempt: claimed.attempt,
      now: () => observedAt,
      extractStatus: mapping.extractStatus,
      successStatuses: mapping.successStatuses,
      failureStatuses: mapping.failureStatuses,
      pendingStatuses: mapping.pendingStatuses,
      // The adapter contract deliberately exposes only a status-query operation.
      queryTask: ({ provider, taskId }) => adapter.queryTask({ provider, taskId, credential, identity, run: current.run }),
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
      await store.recordExternalReconciliation(identity, current.run.runId, {
        expectedRevision: current.run.revision,
        leaseOwner: owner,
        outcome,
        providerStatus: result.audit.providerStatus || null,
        reason: reason || null,
        observedAt: result.audit.observedAt,
        nextQueryAt,
      });
    } catch (error) {
      // Leave an unrecordable claimed query fenced by its lease. Expiry recovery can
      // requeue it (or mark the exhausted attempt for manual review) without resubmitting.
      report(error, "record_result");
    }
  }

  async function runOnce() {
    if (busy || stopped) return { skipped: true };
    busy = true;
    let processed = 0;
    try {
      if (typeof store.recoverExpiredExternalReconciliationClaims === "function") {
        await store.recoverExpiredExternalReconciliationClaims({ limit: batchSize });
      }
      const due = await store.listDueExternalReconciliations({ limit: batchSize });
      for (const candidate of due) {
        if (stopped) break;
        let observedAt;
        try { observedAt = clock.now(); } catch { observedAt = null; }
        // Do not claim a row unless the injected clock can provide a valid audit time.
        if (!validTimestamp(observedAt)) {
          report(Object.assign(new Error("invalid clock"), { code: "CLOCK_INVALID" }), "clock");
          break;
        }
        await reconcileClaim(candidate, observedAt);
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
    if (stopped) throw new Error("Provider reconciliation worker has been stopped");
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

module.exports = { createProviderReconciliationWorker };
