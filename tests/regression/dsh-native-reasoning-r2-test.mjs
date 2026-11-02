import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  KNOWN_REASONING_EFFORTS,
  normalizeAuthoritativeReasoningMeta,
  validateAndBuildModelSelection,
  createModelSelectionRef,
  transitionModelSelection,
  installModelSelection,
} from "../../shell/runtime/dsh-reasoning-selection-r2-candidate.mjs";

test("Reasoning R2 - Strict metadata normalization without speculation", () => {
  // 1. null / undefined / empty
  assert.deepEqual(normalizeAuthoritativeReasoningMeta(null), { reasoning: false, supportedEfforts: [] });
  assert.deepEqual(normalizeAuthoritativeReasoningMeta({}), { reasoning: false, supportedEfforts: [] });

  // 2. CRITICAL R2 FIX: reasoning: true alone MUST NOT speculate levels!
  const booleanOnly = normalizeAuthoritativeReasoningMeta({ reasoning: true });
  assert.equal(booleanOnly.reasoning, false);
  assert.deepEqual(booleanOnly.supportedEfforts, []);

  // 3. Explicit supported efforts list
  const explicit = normalizeAuthoritativeReasoningMeta({
    reasoning: true,
    supportedEfforts: ["low", "high"],
    defaultEffort: "low",
  });
  assert.equal(explicit.reasoning, true);
  assert.deepEqual(explicit.supportedEfforts, ["low", "high"]);
  assert.equal(explicit.defaultEffort, "low");

  // 4. pi-ai thinkingLevelMap
  const mapMeta = normalizeAuthoritativeReasoningMeta({
    thinkingLevelMap: { minimal: null, low: "low", high: "high", max: null },
  });
  assert.equal(mapMeta.reasoning, true);
  assert.deepEqual(mapMeta.supportedEfforts, ["low", "high"]);

  // 5. Contradictory metadata rejected
  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({
      reasoning: false,
      supportedEfforts: ["high"],
    });
  }, { code: "CONTRADICTORY_REASONING_METADATA" });

  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({
      supportedEfforts: ["low"],
      defaultEffort: "high", // default not in supported list
    });
  }, { code: "INVALID_DEFAULT_EFFORT" });
});

test("Reasoning R2 - Validation and boundary protections", () => {
  const metaWithEffort = {
    reasoning: true,
    supportedEfforts: ["low", "high"],
  };

  // Valid with effort
  const sel1 = validateAndBuildModelSelection({
    provider: "powertokens",
    model: "qwen-reasoning",
    reasoningEffort: "high",
  }, metaWithEffort);
  assert.deepEqual(sel1, {
    provider: "powertokens",
    model: "qwen-reasoning",
    reasoningEffort: "high",
  });
  assert.ok(Object.isFrozen(sel1));

  // Valid without effort on boolean-only model (text selection succeeds, effort omitted)
  const sel2 = validateAndBuildModelSelection({
    provider: "powertokens",
    model: "model-without-effort-list",
  }, { reasoning: true });
  assert.deepEqual(sel2, {
    provider: "powertokens",
    model: "model-without-effort-list",
  });
  assert.equal("reasoningEffort" in sel2, false);

  // Rejection: explicit effort on boolean-only model
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "model-without-effort-list",
      reasoningEffort: "high",
    }, { reasoning: true });
  }, { code: "UNSUPPORTED_REASONING_EFFORT" });

  // Rejection: explicit null for reasoningEffort
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "m",
      reasoningEffort: null,
    }, metaWithEffort);
  }, { code: "INVALID_REASONING_EFFORT_TYPE" });

  // Rejection: unknown field
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "m",
      extraField: true,
    }, metaWithEffort);
  }, { code: "UNRECOGNIZED_SELECTION_FIELD" });

  // Rejection: unbounded string (>256 chars)
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "a".repeat(300),
      model: "m",
    }, metaWithEffort);
  }, { code: "INVALID_PROVIDER" });

  // Caller object must not be modified
  const inputObj = { provider: "powertokens", model: "m", reasoningEffort: "high" };
  validateAndBuildModelSelection(inputObj, metaWithEffort);
  assert.deepEqual(Object.keys(inputObj), ["provider", "model", "reasoningEffort"]);
});

test("Reasoning R2 - Atomic transition failure leaves current ref intact", () => {
  const ref = createModelSelectionRef({
    provider: "powertokens",
    model: "model-valid",
    reasoningEffort: "high",
  });

  // Attempt invalid transition
  assert.throws(() => {
    transitionModelSelection(ref, {
      provider: "powertokens",
      model: "model-invalid",
      reasoningEffort: "invalid_effort",
    }, { reasoning: false });
  }, { code: "UNKNOWN_REASONING_EFFORT" });

  // Original state MUST be completely preserved
  assert.deepEqual(ref.current, {
    provider: "powertokens",
    model: "model-valid",
    reasoningEffort: "high",
  });
  assert.equal(ref.assembled, undefined);
});

test("Reasoning R2 - Hot session sequence A(high) -> B(unspecified) -> A(low) using native installModelSelection", async () => {
  const metaA = { reasoning: true, supportedEfforts: ["low", "high"] };
  const metaB = { reasoning: false };

  const ref = createModelSelectionRef();
  const ctx = new Context();

  // Reuse locked native installModelSelection directly!
  installModelSelection(ctx, ref);

  // 1. Step 1: Model A with "high"
  transitionModelSelection(ref, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "high",
  }, metaA);

  const p1 = await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  assert.deepEqual(p1.variables, { provider: "powertokens", model: "model-a" });

  const r1 = await ctx.waterfall("agent/request", { turn: 1, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.deepEqual(r1, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "high",
  });

  // 2. Step 2: Switch to Model B (unspecified effort)
  transitionModelSelection(ref, {
    provider: "powertokens",
    model: "model-b",
  }, metaB);

  const p2 = await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  assert.deepEqual(p2.variables, { provider: "powertokens", model: "model-b" });

  // Native installModelSelection drops inherited reasoningEffort
  const r2 = await ctx.waterfall("agent/request", { turn: 2, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback", reasoningEffort: "high" }));
  assert.deepEqual(r2, {
    provider: "powertokens",
    model: "model-b",
  });
  assert.equal("reasoningEffort" in r2, false);

  // 3. Step 3: Switch back to Model A with "low"
  transitionModelSelection(ref, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "low",
  }, metaA);

  const p3 = await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  assert.deepEqual(p3.variables, { provider: "powertokens", model: "model-a" });

  const r3 = await ctx.waterfall("agent/request", { turn: 3, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.deepEqual(r3, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "low",
  });
});
