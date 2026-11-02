"use strict";

const { MODEL_ROUTING, MEDIA_ADAPTERS } = require("../../business/media/powertokens.cjs");
const { normalizeMapping } = require("./provider-reconciliation.cjs");

// These terminal words are the exact sets currently used by business/media/powertokens.cjs#pollTask.
// That poller does not define a closed pending-state vocabulary, so pendingStatuses defaults empty.
const POLLER_SUCCESS_STATUSES = new Set(["completed", "succeeded", "success", "successful", "finished", "done", "ready", "ok"]);
const POLLER_FAILURE_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "expired", "rejected", "timeout"]);

// Recovery uses the same registered wire contracts as submission. Seedance
// has its own admission identity but shares the query-only video endpoint.
const RECOVERY_ROUTES = [...Object.values(MODEL_ROUTING), ...Object.values(MEDIA_ADAPTERS)];
const DEFAULT_PROVIDER_MAPPINGS = Object.freeze(Object.fromEntries(
  [...new Set(RECOVERY_ROUTES.map(route => route.provider))].map(provider => {
    const routes = RECOVERY_ROUTES.filter(route => route.provider === provider);
    const kinds = new Set(routes.map(route => route.kind === 'seedance' ? 'video' : route.kind));
    if (kinds.size !== 1) throw new TypeError('Provider query contract is ambiguous');
    return [provider, {kind:[...kinds][0],successStatuses:new Set(POLLER_SUCCESS_STATUSES),failureStatuses:new Set(POLLER_FAILURE_STATUSES),pendingStatuses:new Set()}];
  }),
));

function readStatus(data) {
  if (!data || typeof data !== "object") return "";
  const status = data.status
    || data.data?.status
    || data.result?.status
    || data.task?.status
    || data.metadata?.status;
  return typeof status === "string" ? status.trim() : "";
}

function safeError(code, statusCode) {
  const error = new Error("PowerTokens status query failed");
  error.code = code;
  if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) error.statusCode = statusCode;
  return error;
}

function retryAfterMs(response, nowMs = Date.now()) {
  let value;
  try { value = response?.headers?.get?.("retry-after"); } catch { return undefined; }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

function validateBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new TypeError("baseUrl must be injected");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new TypeError("baseUrl must be a valid URL"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.search || parsed.hash) throw new TypeError("baseUrl must use HTTP(S) without query or fragment");
  return parsed.toString().replace(/\/+$/, "");
}

function validateProviderMapping(provider, value) {
  if (!value || !["image", "video"].includes(value.kind)) throw new TypeError(`Provider mapping for ${provider} requires kind=image|video`);
  const mapping = normalizeMapping({
    extractStatus: typeof value.extractStatus === "function" ? value.extractStatus : readStatus,
    successStatuses: value.successStatuses ?? POLLER_SUCCESS_STATUSES,
    failureStatuses: value.failureStatuses ?? POLLER_FAILURE_STATUSES,
    pendingStatuses: value.pendingStatuses ?? new Set(),
  });
  if (!mapping) throw new TypeError(`Provider mapping for ${provider} has invalid or overlapping status sets`);
  return { ...mapping, kind: value.kind };
}

/**
 * Build query-only adapters keyed by MODEL_ROUTING provider (currently seedream and wan).
 * `apiKey` may be supplied once or per request as `credential` by the reconciliation worker.
 * `baseUrl` and `fetchImpl` are injected; this module never reads environment credentials.
 */
function createPowerTokensQueryAdapters({ apiKey = null, baseUrl, fetchImpl, providerMappings = DEFAULT_PROVIDER_MAPPINGS, timeoutMs = 30_000 } = {}) {
  const base = validateBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be injected or available globally");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError("timeoutMs must be 1s to 5m");
  if (!providerMappings || typeof providerMappings !== "object") throw new TypeError("providerMappings must be a provider map");

  const entries = providerMappings instanceof Map ? [...providerMappings.entries()] : Object.entries(providerMappings);
  const adapters = Object.create(null);
  for (const [provider, rawMapping] of entries) {
    if (typeof provider !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(provider)) throw new TypeError("Invalid provider key");
    const mapping = validateProviderMapping(provider, rawMapping);
    const pathForTask = mapping.kind === "image" ? "/v1/tasks/" : "/v1/videos/";
    adapters[provider] = {
      extractStatus: mapping.extractStatus,
      successStatuses: mapping.successStatuses,
      failureStatuses: mapping.failureStatuses,
      pendingStatuses: mapping.pendingStatuses,
      async queryTask({ provider: requestedProvider, taskId, credential } = {}) {
        if (requestedProvider !== provider) throw safeError("PROVIDER_MISMATCH");
        if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 512) throw safeError("TASK_ID_INVALID");
        const token = typeof credential === "string" && credential.trim() ? credential : apiKey;
        if (typeof token !== "string" || !token.trim()) throw safeError("PROVIDER_CREDENTIAL_MISSING");
        const url = base + pathForTask + encodeURIComponent(taskId.trim());
        let response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          let status, name;
          try { status = error?.httpStatus ?? error?.statusCode; name = error?.name; } catch { /* keep only the generic failure code */ }
          throw safeError(name === "TimeoutError" || name === "AbortError" ? "PROVIDER_QUERY_TIMEOUT" : "PROVIDER_QUERY_FAILED", status);
        }
        let bodyText;
        try { bodyText = await response.text(); }
        catch { throw safeError("PROVIDER_QUERY_BODY_FAILED", response.status); }
        let data = null;
        if (typeof bodyText === "string" && bodyText.length <= 1_048_576) {
          try { data = JSON.parse(bodyText); } catch { /* Invalid/empty JSON stays unknown to reconciliation. */ }
        }
        return {
          httpStatus: response.status,
          data,
          retryAfterMs: retryAfterMs(response),
        };
      },
    };
  }
  return adapters;
}

module.exports = {
  DEFAULT_PROVIDER_MAPPINGS,
  POLLER_FAILURE_STATUSES,
  POLLER_SUCCESS_STATUSES,
  createPowerTokensQueryAdapters,
  readStatus,
};
