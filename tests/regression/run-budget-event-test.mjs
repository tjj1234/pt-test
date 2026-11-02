import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildRunBudgetUsage } = require("../../shell/tasks/run-budget-event.cjs");

test("run budget usage event preserves all configured caps including zero-valued caps", () => {
  const event = buildRunBudgetUsage({
    configured: true,
    limits: {
      maxDurationMs: 180_000,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxToolCallsPerKey: 0,
      maxRetries: 0,
      maxOutputTokens: 8_000,
      maxCost: { amount: 1, currency: "USD" },
      unexpected: 99,
    },
    snapshot: {
      elapsedMs: 120,
      modelCalls: 1,
      toolCalls: 0,
      retries: 0,
      duplicateToolCalls: 0,
      costStatus: "unknown",
      policyStatus: "configured",
      clockStatus: "monotonic",
      spent: { amount: 0, currency: "USD" },
    },
  });

  assert.deepEqual(event.limits, {
    maxDurationMs: 180_000,
    maxModelCalls: 1,
    maxToolCalls: 0,
    maxToolCallsPerKey: 0,
    maxRetries: 0,
    maxOutputTokens: 8_000,
    maxCost: { amount: 1, currency: "USD" },
  });
  assert.deepEqual(event.snapshot, {
    elapsedMs: 120,
    modelCalls: 1,
    toolCalls: 0,
    retries: 0,
    duplicateToolCalls: 0,
    costStatus: "unknown",
    policyStatus: "configured",
    clockStatus: "monotonic",
  });
  assert.equal(event.kind, "run_budget");
  assert.equal(event.configured, true);
  assert.equal(event.status, "configured");
});

test("run budget usage event ignores malformed limits and keeps cost status without amounts", () => {
  const event = buildRunBudgetUsage({
    configured: false,
    limits: { maxToolCalls: -1, maxRetries: 1.5, maxModelCalls: 0, maxDurationMs: "1000" },
    snapshot: { costStatus: "unknown", spent: { amount: 0, currency: "USD" } },
  });
  assert.deepEqual(event.limits, {});
  assert.equal(event.snapshot.costStatus, "unknown");
  assert.equal(Object.hasOwn(event.snapshot, "spent"), false);
});

test("run budget usage event keeps missing, negative, fractional, and overflow counters unknown", () => {
  const event = buildRunBudgetUsage({
    configured: true,
    snapshot: {
      elapsedMs: -1,
      modelCalls: -1,
      toolCalls: 1.5,
      retries: Number.MAX_SAFE_INTEGER + 1,
      duplicateToolCalls: "0",
    },
  });
  assert.deepEqual(event.snapshot, {
    elapsedMs: null,
    modelCalls: null,
    toolCalls: null,
    retries: null,
    duplicateToolCalls: null,
    costStatus: "unknown",
    policyStatus: "configured",
    clockStatus: "unknown",
  });
});
