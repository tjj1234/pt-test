"use strict";

// Reconciliation policy only. Persistence, provider credentials, and HTTP are injected.
// In particular, this module never submits/re-submits external work.
const RETRYABLE_HTTP = new Set([408, 425, 429]);
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;

function safeLabel(value, max = 64) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, max);
  return cleaned || null;
}

function normalizeStatuses(value) {
  if (!(value instanceof Set)) return null;
  const result = new Set();
  try {
    for (const item of value) {
      if (typeof item !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(item.trim())) return null;
      result.add(item.trim().toLowerCase());
    }
  } catch { return null; }
  return result;
}

function normalizeMapping(mapping) {
  if (typeof mapping?.extractStatus !== "function") return null;
  const successStatuses = normalizeStatuses(mapping.successStatuses);
  const failureStatuses = normalizeStatuses(mapping.failureStatuses);
  const pendingStatuses = normalizeStatuses(mapping.pendingStatuses);
  if (!successStatuses || !failureStatuses || !pendingStatuses) return null;
  for (const status of successStatuses) if (failureStatuses.has(status) || pendingStatuses.has(status)) return null;
  for (const status of failureStatuses) if (pendingStatuses.has(status)) return null;
  return { extractStatus: mapping.extractStatus, successStatuses, failureStatuses, pendingStatuses };
}

function mapProviderResult(result, { extractStatus, successStatuses, failureStatuses, pendingStatuses } = {}) {
  const mapping = normalizeMapping({ extractStatus, successStatuses, failureStatuses, pendingStatuses });
  if (!mapping) {
    return { state: "unknown", reason: "provider_mapping_required" };
  }
  if (!result || !Number.isInteger(result.httpStatus)) return { state: "unknown", reason: "invalid_query_result" };
  if (RETRYABLE_HTTP.has(result.httpStatus) || (result.httpStatus >= 500 && result.httpStatus <= 599)) return { state: "retry", reason: result.httpStatus === 429 ? "rate_limited" : "provider_server_error", httpStatus: result.httpStatus };
  if (result.httpStatus !== 200) return { state: "unknown", reason: "unexpected_http_status", httpStatus: result.httpStatus };
  let rawStatus;
  try { rawStatus = mapping.extractStatus(result.data); } catch { return { state: "unknown", reason: "provider_status_extraction_failed" }; }
  const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
  if (status && mapping.successStatuses.has(status)) return { state: "succeeded", providerStatus: safeLabel(status) };
  if (status && mapping.failureStatuses.has(status)) return { state: status === "cancelled" || status === "canceled" ? "cancelled" : "failed", providerStatus: safeLabel(status) };
  if (status && mapping.pendingStatuses.has(status)) return { state: "pending", providerStatus: safeLabel(status) };
  return { state: "unknown", reason: "unrecognized_provider_state" };
}

function retryDelayMs(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("attempt must be a positive integer");
  return Math.min(BASE_DELAY_MS * (2 ** Math.min(attempt - 1, 20)), MAX_DELAY_MS);
}

/**
 * Make exactly one reconciliation decision. A known task ID can only be queried;
 * an unknown submission outcome is surfaced for manual review and never replayed.
 * queryTask({ provider, taskId }) must perform a status lookup only and return
 * { httpStatus, data }. No raw response body/error message is copied to the audit.
 */
async function reconcileOnce(run, { queryTask, attempt = 1, now = () => new Date().toISOString(), extractStatus, successStatuses, failureStatuses, pendingStatuses } = {}) {
  if (!run || typeof run !== "object") throw new TypeError("run is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("attempt must be a positive integer");
  let observedAt;
  try { observedAt = now(); } catch { observedAt = null; }
  if (typeof observedAt !== "string" || observedAt.length > 35 || !/^\d{4}-\d\d-\d\dT.*Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) observedAt = null;
  const audit = { provider: safeLabel(run.externalProvider, 80), taskId: safeLabel(run.externalTaskId, 128), attempt, observedAt };
  if (observedAt === null) return { action: "manual_check", outcome: "audit_clock_invalid", audit };
  if (!run.externalOperationKey) return { action: "none", outcome: "not_external", audit };
  if (!run.externalTaskId) return { action: "manual_check", outcome: "unknown_submission", audit };
  if (typeof queryTask !== "function") throw new TypeError("queryTask is required when taskId is known");
  const statusMapping = normalizeMapping({ extractStatus, successStatuses, failureStatuses, pendingStatuses });
  if (!statusMapping) {
    return { action: "manual_check", outcome: "provider_mapping_required", audit };
  }

  let mapped;
  try {
    const query = await queryTask({ provider: run.externalProvider, taskId: run.externalTaskId });
    mapped = mapProviderResult(query, statusMapping);
    let retryAfterMs;
    try { retryAfterMs = query?.retryAfterMs; } catch { retryAfterMs = undefined; }
    if (mapped.state === "retry" && Number.isFinite(retryAfterMs)) {
      mapped.retryAfterMs = Math.max(1_000, Math.min(MAX_DELAY_MS, retryAfterMs));
    }
  } catch (error) {
    let code, status;
    try { code = error?.code; status = error?.httpStatus ?? error?.statusCode; } catch { code = null; status = null; }
    if (Number.isInteger(status) && status >= 400 && status < 500 && !RETRYABLE_HTTP.has(status)) {
      mapped = { state: "unknown", reason: "query_rejected", httpStatus: status, errorCode: safeLabel(code, 64) };
    } else {
      mapped = { state: "retry", reason: "query_error", errorCode: safeLabel(code, 64) };
    }
  }
  if (mapped.providerStatus) mapped.providerStatus = safeLabel(mapped.providerStatus);
  Object.assign(audit, mapped);
  if (mapped.state === "retry") {
    if (attempt >= MAX_ATTEMPTS) return { action: "manual_check", outcome: "query_retry_exhausted", audit };
    audit.nextDelayMs = mapped.retryAfterMs ?? retryDelayMs(attempt);
    return { action: "retry_query", outcome: "query_temporary_failure", audit };
  }
  if (mapped.state === "unknown") return { action: "manual_check", outcome: "provider_state_unknown", audit };
  if (mapped.state === "pending") return { action: "query_later", outcome: "provider_pending", audit };
  return { action: "record_result", outcome: mapped.state, audit };
}

module.exports = { MAX_ATTEMPTS, mapProviderResult, normalizeMapping, reconcileOnce, retryDelayMs, safeLabel };
