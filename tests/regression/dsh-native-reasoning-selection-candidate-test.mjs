import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { installModelSelection } from "../../shell/node_modules/@deepseek-ai/dsh-agent/lib/index.js";
import {
  KNOWN_REASONING_EFFORTS,
  normalizeModelReasoningMeta,
  validateAndBuildModelSelection,
  createModelSelectionRef,
  transitionModelSelection,
  bindModelSelectionToContext,
} from "../../shell/runtime/dsh-reasoning-selection-candidate.mjs";

test("Reasoning Effort Candidate - Basic metadata normalization", () => {
  // 1. null / undefined / empty
  assert.deepEqual(normalizeModelReasoningMeta(null), { reasoning: false, supportedEfforts: [] });
  assert.deepEqual(normalizeModelReasoningMeta({}), { reasoning: false, supportedEfforts: [] });

  // 2. explicit false
  assert.deepEqual(normalizeModelReasoningMeta({ reasoning: false }), { reasoning: false, supportedEfforts: [] });

  // 3. standard reasoning: true
  const std = normalizeModelReasoningMeta({ reasoning: true });
  assert.equal(std.reasoning, true);
  assert.deepEqual(std.supportedEfforts, ["minimal", "low", "medium", "high"]);

  // 4. thinkingLevelMap
  const tMap = normalizeModelReasoningMeta({
    thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null }
  });
  assert.equal(tMap.reasoning, true);
  assert.deepEqual(tMap.supportedEfforts, ["low", "medium", "high"]);

  // 5. custom efforts array with defaultEffort
  const custom = normalizeModelReasoningMeta({
    efforts: ["low", "high", "max"],
    defaultEffort: "high"
  });
  assert.equal(custom.reasoning, true);
  assert.deepEqual(custom.supportedEfforts, ["low", "high", "max"]);
  assert.equal(custom.defaultEffort, "high");
});

test("Reasoning Effort Candidate - Validation & input enforcement", () => {
  const metaEffort = {
    reasoning: true,
    supportedEfforts: ["low", "medium", "high"]
  };
  const metaStandard = {
    reasoning: false,
    supportedEfforts: []
  };

  // Valid selection with effort
  const sel1 = validateAndBuildModelSelection({
    provider: "powertokens",
    model: "qwen-reasoning",
    reasoningEffort: "high"
  }, metaEffort);
  assert.deepEqual(sel1, {
    provider: "powertokens",
    model: "qwen-reasoning",
    reasoningEffort: "high"
  });
  assert.ok(Object.isFrozen(sel1));

  // Valid selection without effort (unspecified)
  const sel2 = validateAndBuildModelSelection({
    provider: "powertokens",
    model: "qwen-standard"
  }, metaStandard);
  assert.deepEqual(sel2, {
    provider: "powertokens",
    model: "qwen-standard"
  });
  assert.equal("reasoningEffort" in sel2, false);

  // Rejection: Invalid provider
  assert.throws(() => {
    validateAndBuildModelSelection({ provider: "", model: "m" }, metaEffort);
  }, { code: "INVALID_PROVIDER" });

  // Rejection: Invalid model
  assert.throws(() => {
    validateAndBuildModelSelection({ provider: "p", model: " " }, metaEffort);
  }, { code: "INVALID_MODEL" });

  // Rejection: Unknown / unrecognized fields
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "m",
      thinking: "high", // forbidden extra field
    }, metaEffort);
  }, { code: "UNRECOGNIZED_SELECTION_FIELD" });

  // Rejection: Unknown effort value
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "m",
      reasoningEffort: "super_ultra",
    }, metaEffort);
  }, { code: "UNKNOWN_REASONING_EFFORT" });

  // Rejection: Non-string effort
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "m",
      reasoningEffort: 123,
    }, metaEffort);
  }, { code: "INVALID_REASONING_EFFORT_TYPE" });

  // Rejection: Effort supplied on a model that does not support reasoning
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "standard-model",
      reasoningEffort: "high",
    }, metaStandard);
  }, { code: "UNSUPPORTED_REASONING_EFFORT" });

  // Rejection: Effort supplied is not in the model's supported set
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "powertokens",
      model: "low-only-model",
      reasoningEffort: "high",
    }, { reasoning: true, supportedEfforts: ["low"] });
  }, { code: "UNSUPPORTED_REASONING_EFFORT" });
});

test("Reasoning Effort Candidate - Hot session switching A -> B clears reasoningEffort", async () => {
  const metaA = { reasoning: true, supportedEfforts: ["low", "high"] };
  const metaB = { reasoning: false, supportedEfforts: [] };

  const ref = createModelSelectionRef();

  // Step 1: Model A selected with "high"
  transitionModelSelection(ref, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "high"
  }, metaA);

  assert.deepEqual(ref.current, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "high"
  });
  assert.equal(ref.assembled, undefined);

  // Connect to native cordis context and verify prompt assembly & request
  const ctx = new Context();
  installModelSelection(ctx, ref);

  const assembled1 = await ctx.waterfall(
    "system-prompt/assemble",
    { variables: {} },
    {},
    () => Promise.resolve({ variables: {} })
  );
  assert.deepEqual(assembled1.variables, { provider: "powertokens", model: "model-a" });
  assert.deepEqual(ref.assembled, ref.current);

  const req1 = await ctx.waterfall(
    "agent/request",
    { turn: 1, step: 1 },
    () => Promise.resolve({ provider: "base", model: "base" })
  );
  assert.deepEqual(req1, {
    provider: "powertokens",
    model: "model-a",
    reasoningEffort: "high"
  });

  // Step 2: Switch to Model B (standard, no effort)
  transitionModelSelection(ref, {
    provider: "powertokens",
    model: "model-b"
  }, metaB);

  assert.deepEqual(ref.current, {
    provider: "powertokens",
    model: "model-b"
  });
  assert.equal("reasoningEffort" in ref.current, false);
  assert.equal(ref.assembled, undefined); // reset on transition

  const assembled2 = await ctx.waterfall(
    "system-prompt/assemble",
    { variables: {} },
    {},
    () => Promise.resolve({ variables: {} })
  );
  assert.deepEqual(assembled2.variables, { provider: "powertokens", model: "model-b" });
  assert.deepEqual(ref.assembled, ref.current);

  // Crucial invariant: inherited reasoningEffort must NOT leak to model-b!
  const req2 = await ctx.waterfall(
    "agent/request",
    { turn: 2, step: 1 },
    () => Promise.resolve({ provider: "base", model: "base", reasoningEffort: "high" })
  );
  assert.deepEqual(req2, {
    provider: "powertokens",
    model: "model-b"
  });
  assert.equal("reasoningEffort" in req2, false);
});

test("Reasoning Effort Candidate - Model switch between different providers with identical model names", () => {
  const metaProvider1 = { reasoning: true, supportedEfforts: ["high"] };
  const metaProvider2 = { reasoning: false, supportedEfforts: [] };

  const ref = createModelSelectionRef();

  // Provider 1, model "chat"
  transitionModelSelection(ref, {
    provider: "provider-1",
    model: "chat",
    reasoningEffort: "high"
  }, metaProvider1);
  assert.equal(ref.current.provider, "provider-1");
  assert.equal(ref.current.reasoningEffort, "high");

  // Provider 2, same model name "chat" (does NOT support reasoning)
  assert.throws(() => {
    transitionModelSelection(ref, {
      provider: "provider-2",
      model: "chat",
      reasoningEffort: "high"
    }, metaProvider2);
  }, { code: "UNSUPPORTED_REASONING_EFFORT" });

  // When switching cleanly without effort:
  transitionModelSelection(ref, {
    provider: "provider-2",
    model: "chat"
  }, metaProvider2);
  assert.equal(ref.current.provider, "provider-2");
  assert.equal(ref.current.reasoningEffort, undefined);
});

test("Reasoning Effort Candidate - bindModelSelectionToContext parity with DSH installModelSelection", async () => {
  const ctx = new Context();
  const ref = {
    current: { provider: "powertokens", model: "qwen-turbo", reasoningEffort: "medium" },
    assembled: undefined,
  };

  const dispose = bindModelSelectionToContext(ctx, ref);

  const assembled = await ctx.waterfall(
    "system-prompt/assemble",
    { variables: {} },
    {},
    () => Promise.resolve({ variables: {} })
  );
  assert.deepEqual(assembled.variables, { provider: "powertokens", model: "qwen-turbo" });
  assert.deepEqual(ref.assembled, ref.current);

  const req = await ctx.waterfall(
    "agent/request",
    { turn: 1, step: 1 },
    () => Promise.resolve({ provider: "old-p", model: "old-m" })
  );
  assert.deepEqual(req, {
    provider: "powertokens",
    model: "qwen-turbo",
    reasoningEffort: "medium"
  });

  dispose();
});
