"use strict";

const { performance } = require("node:perf_hooks");

// In-memory, injected Run guard. Call admit() immediately before each model,
// tool, or retry operation. The caller owns persistence, cancellation, and
// reconciliation; this module deliberately invents no product limits.
function createRunBudget({ limits, startedAt, now = () => performance.now(), allowUnconfigured = false } = {}) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new TypeError("explicit limits are required");
  const allowed = new Set(["maxDurationMs", "maxModelCalls", "maxToolCalls", "maxToolCallsPerKey", "maxRetries", "maxCost"]);
  for (const key of Object.keys(limits)) if (!allowed.has(key)) throw new TypeError(`unknown budget limit: ${key}`);
  const copied = { ...limits };
  if (copied.maxCost != null) {
    const maxCost = copied.maxCost;
    let amount, currency;
    try { amount = maxCost.amount; currency = maxCost.currency; }
    catch { throw new TypeError("maxCost must be readable data"); }
    copied.maxCost = Object.freeze({ amount, currency });
  }
  const normalizedLimits = Object.freeze(copied);
  const positive = (key) => normalizedLimits[key] == null || (Number.isSafeInteger(normalizedLimits[key]) && normalizedLimits[key] > 0);
  for (const key of ["maxDurationMs", "maxModelCalls"]) {
    if (!positive(key)) throw new TypeError(`${key} must be a positive safe integer`);
  }
  for (const key of ["maxToolCalls", "maxToolCallsPerKey"]) {
    const value = normalizedLimits[key];
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`${key} must be a non-negative safe integer`);
  }
  if (normalizedLimits.maxRetries != null && (!Number.isSafeInteger(normalizedLimits.maxRetries) || normalizedLimits.maxRetries < 0)) throw new TypeError("maxRetries must be a non-negative safe integer");
  if (normalizedLimits.maxCost != null && (!Number.isFinite(normalizedLimits.maxCost.amount) || normalizedLimits.maxCost.amount < 0 || typeof normalizedLimits.maxCost.currency !== "string" || !normalizedLimits.maxCost.currency.trim())) {
    throw new TypeError("maxCost requires a non-negative amount and explicit currency");
  }
  const configured = ["maxDurationMs", "maxModelCalls", "maxToolCalls", "maxToolCallsPerKey", "maxRetries", "maxCost"].some((key) => normalizedLimits[key] != null);
  if (!configured && allowUnconfigured !== true) throw new TypeError("at least one finite limit is required");
  if (typeof now !== "function") throw new TypeError("a monotonic clock is required");
  const baseline = startedAt === undefined ? now() : startedAt;
  if (!Number.isFinite(baseline)) throw new TypeError("valid monotonic startedAt is required");

  let modelCalls = 0, toolCalls = 0, retries = 0, spent = 0, reserved = 0, costUnknown = false, clockUnknown = false, lastClock = baseline;
  const tools = new Map();
  const costLimited = normalizedLimits.maxCost != null;

  function elapsedNow() {
    if (clockUnknown) return null;
    let current;
    try { current = now(); } catch { clockUnknown = true; return null; }
    if (!Number.isFinite(current) || current < lastClock) { clockUnknown = true; return null; }
    lastClock = current;
    return current - baseline;
  }

  function snapshot() {
    const elapsedMs = elapsedNow();
    return Object.freeze({ elapsedMs, modelCalls, toolCalls, retries,
      duplicateToolCalls: [...tools.values()].reduce((sum, n) => sum + n, 0),
      reserved: costLimited && !costUnknown ? { amount: reserved, currency: normalizedLimits.maxCost.currency } : null,
      spent: costLimited && !costUnknown ? { amount: spent, currency: normalizedLimits.maxCost.currency } : null,
      costStatus: !costLimited ? "unlimited" : costUnknown ? "unknown" : "known",
      policyStatus: configured ? "configured" : "unconfigured",
      clockStatus: clockUnknown ? "unknown" : "monotonic" });
  }

  function admit(action) {
    if (!action || typeof action !== "object") throw new TypeError("action is required");
    const elapsed = elapsedNow();
    if (elapsed === null) return { allowed: false, code: "RUN_CLOCK_UNKNOWN", snapshot: snapshot() };
    if (normalizedLimits.maxDurationMs != null && elapsed >= normalizedLimits.maxDurationMs) return { allowed: false, code: "RUN_DURATION_LIMIT", snapshot: snapshot() };
    if (costLimited && costUnknown) return { allowed: false, code: "RUN_COST_UNKNOWN", snapshot: snapshot() };
    let type;
    try { type = action.type; } catch { throw new TypeError("action.type must be readable"); }
    if (!["model", "tool", "retry"].includes(type)) throw new TypeError("action.type must be model, tool, or retry");
    let estimateAmount = 0;
    const estimateCurrency = costLimited ? normalizedLimits.maxCost.currency : null;
    if (costLimited) {
      let estimate, currency, amount;
      try {
        estimate = action.estimatedCost;
        currency = estimate?.currency;
        amount = estimate?.amount;
      } catch {
        return { allowed: false, code: "RUN_COST_UNKNOWN", snapshot: snapshot() };
      }
      if (!estimate || currency !== estimateCurrency || !Number.isFinite(amount) || amount < 0) {
        return { allowed: false, code: "RUN_COST_UNKNOWN", snapshot: snapshot() };
      }
      estimateAmount = amount;
      if (spent + reserved + estimateAmount > normalizedLimits.maxCost.amount) return { allowed: false, code: "RUN_COST_LIMIT", snapshot: snapshot() };
    }
    if (type === "model" && normalizedLimits.maxModelCalls != null && modelCalls >= normalizedLimits.maxModelCalls) return { allowed: false, code: "RUN_MODEL_CALL_LIMIT", snapshot: snapshot() };
    if (type === "tool" && normalizedLimits.maxToolCalls != null && toolCalls >= normalizedLimits.maxToolCalls) return { allowed: false, code: "RUN_TOOL_CALL_LIMIT", snapshot: snapshot() };
    if (type === "retry" && normalizedLimits.maxRetries != null && retries >= normalizedLimits.maxRetries) return { allowed: false, code: "RUN_RETRY_LIMIT", snapshot: snapshot() };
    let toolKey;
    if (type === "tool") {
      try { toolKey = action.key; } catch { throw new TypeError("action.key must be readable"); }
      if (typeof toolKey !== "string" || !toolKey) throw new TypeError("tool action requires a stable key");
      if (normalizedLimits.maxToolCallsPerKey != null && (tools.get(toolKey) || 0) >= normalizedLimits.maxToolCallsPerKey) return { allowed: false, code: "RUN_DUPLICATE_TOOL_LIMIT", snapshot: snapshot() };
    }
    // Count on admission, so concurrent callers cannot exceed a cap. Failed
    // external operations remain charged conservatively; retries are explicit.
    if (type === "model") modelCalls++;
    if (type === "tool") toolCalls++;
    if (type === "retry") retries++;
    if (type === "tool") tools.set(toolKey, (tools.get(toolKey) || 0) + 1);
    if (costLimited) reserved += estimateAmount;
    let settled = false;
    return { allowed: true, snapshot: snapshot(), settle: (evidence = {}) => {
      if (settled) throw new Error("budget admission already settled");
      settled = true;
      if (!costLimited) return snapshot();
      reserved -= estimateAmount;
      let actual, currency, amount;
      try {
        actual = evidence?.actualCost;
        currency = actual?.currency;
        amount = actual?.amount;
      } catch {
        costUnknown = true;
        return snapshot();
      }
      if (!actual || currency !== estimateCurrency || !Number.isFinite(amount) || amount < 0) {
        costUnknown = true;
        return snapshot();
      }
      spent += amount;
      if (spent > normalizedLimits.maxCost.amount) costUnknown = true; // Provider charge exceeded the preflight estimate/cap.
      return snapshot();
    } };
  }

  return Object.freeze({ admit, snapshot });
}

module.exports = { createRunBudget };
