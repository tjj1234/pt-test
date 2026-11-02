import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-budget-summary-"));
for (const [from, to] of [
  ["shell/persistent-runner.mjs", "persistent-runner.mjs"],
  ["shell/tasks/budget.cjs", "budget.cjs"],
  ["shell/runtime/usage.cjs", "usage.cjs"],
  ["shell/runtime/native-image-message.mjs", "native-image-message.mjs"],
  ["shell/runtime/dsh-native-context-r4-candidate.mjs", "dsh-native-context-r4-candidate.mjs"],
  ["docs/dsh-profile-snapshot/run-persistent/presets.cjs", "presets.cjs"],
]) fs.copyFileSync(path.join(root, from), path.join(profileDir, to));
fs.symlinkSync(path.join(root, "shell/node_modules"), path.join(profileDir, "node_modules"), "dir");
const { safeBudgetSummary } = await import(pathToFileURL(path.join(profileDir, "persistent-runner.mjs")).href);

test.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));

test("runner budget summary keeps invalid usage counters unknown", () => {
  const summary = safeBudgetSummary({
    configured: true,
    limits: { maxDurationMs: 180_000, maxModelCalls: 1, maxToolCalls: 0, maxRetries: 0 },
    budget: { snapshot: () => ({ elapsedMs: 10, modelCalls: 1, toolCalls: Number.NaN, retries: -1, duplicateToolCalls: undefined }) },
  });

  assert.deepEqual(summary.snapshot, {
    elapsedMs: 10,
    modelCalls: 1,
    toolCalls: null,
    retries: null,
    duplicateToolCalls: null,
    costStatus: "unknown",
    policyStatus: "configured",
    clockStatus: "unknown",
  });
});

test("runner budget summary keeps valid zero counters", () => {
  const summary = safeBudgetSummary({
    configured: true,
    limits: {},
    budget: { snapshot: () => ({ elapsedMs: 0, modelCalls: 0, toolCalls: 0, retries: 0, duplicateToolCalls: 0 }) },
  });
  assert.equal(summary.snapshot.modelCalls, 0);
  assert.equal(summary.snapshot.toolCalls, 0);
  assert.equal(summary.snapshot.retries, 0);
  assert.equal(summary.snapshot.duplicateToolCalls, 0);
});
