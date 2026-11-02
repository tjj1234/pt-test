"use strict";

const LIMIT_KEYS = Object.freeze([
  "maxDurationMs",
  "maxModelCalls",
  "maxToolCalls",
  "maxToolCallsPerKey",
  "maxRetries",
  "maxOutputTokens",
  "contextModelCalls",
]);
const ZERO_ALLOWED = new Set(["maxToolCalls", "maxToolCallsPerKey", "maxRetries", "contextModelCalls"]);
const STATUS_VALUES = Object.freeze({
  costStatus: new Set(["unlimited", "unknown", "known"]),
  policyStatus: new Set(["configured", "unconfigured"]),
  clockStatus: new Set(["monotonic", "unknown"]),
});
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function buildRunBudgetUsage(source) {
  const input = source && typeof source === "object" ? source : {};
  const raw = input.snapshot && typeof input.snapshot === "object" ? input.snapshot : {};
  const rawLimits = input.limits && typeof input.limits === "object" ? input.limits : {};
  let maxCost = null;
  try {
    const value = rawLimits.maxCost;
    if (value && typeof value === "object" && !Array.isArray(value) &&
        Number.isFinite(value.amount) && value.amount >= 0 &&
        typeof value.currency === "string" && value.currency.trim() &&
        Object.keys(value).every((key) => key === "amount" || key === "currency")) {
      maxCost = { amount: value.amount, currency: value.currency.trim() };
    }
  } catch { /* malformed budget evidence is omitted */ }
  const snapshot = {
    elapsedMs: Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0 ? raw.elapsedMs : null,
    modelCalls: nonNegativeInteger(raw.modelCalls),
    toolCalls: nonNegativeInteger(raw.toolCalls),
    retries: nonNegativeInteger(raw.retries),
    duplicateToolCalls: nonNegativeInteger(raw.duplicateToolCalls),
    costStatus: maxCost ? "unknown" : (STATUS_VALUES.costStatus.has(raw.costStatus) ? raw.costStatus : "unknown"),
    policyStatus: STATUS_VALUES.policyStatus.has(raw.policyStatus) ? raw.policyStatus : (input.configured === true ? "configured" : "unconfigured"),
    clockStatus: STATUS_VALUES.clockStatus.has(raw.clockStatus) ? raw.clockStatus : "unknown",
  };
  const limits = Object.fromEntries(LIMIT_KEYS.filter((key) => {
    const value = rawLimits[key];
    return Number.isSafeInteger(value) && (ZERO_ALLOWED.has(key) ? value >= 0 : value > 0);
  }).map((key) => [key, rawLimits[key]]));
  if (maxCost) limits.maxCost = maxCost;
  const configured = input.configured === true;
  return { kind: "run_budget", configured, status: configured ? "configured" : "unconfigured", limits, snapshot };
}

module.exports = { buildRunBudgetUsage };
