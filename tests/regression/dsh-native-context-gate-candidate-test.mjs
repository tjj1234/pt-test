import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { installNativeContextGate } from "../../shell/runtime/dsh-native-context-gate-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

test("Context Gate Candidate - Validation of installation options", () => {
  const ctx = new Context();
  assert.throws(() => installNativeContextGate(ctx, null), { code: "INVALID_GATE_OPTIONS" });
  assert.throws(() => installNativeContextGate(ctx, {}), { code: "INVALID_GATE_OPTIONS" });
  assert.throws(() => installNativeContextGate(ctx, { getActiveTurn: "not-a-func" }), { code: "INVALID_GATE_OPTIONS" });
});

test("Context Gate Candidate - Fail-Closed when model call has no active Run bound", async () => {
  const ctx = new Context();
  installNativeContextGate(ctx, {
    getActiveTurn: () => null, // No active turn
  });

  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "powertokens", model: "m", purpose: "compaction", sessionId: "orphan-session" },
      () => Promise.resolve("stream-result")
    );
  }, { code: "RUN_NOT_BOUND" });
});

test("Context Gate Candidate - Compaction call admitted within budget and settled", async () => {
  const ctx = new Context();
  const budget = createRunBudget({
    limits: { maxModelCalls: 2 },
  });

  const admittedEvents = [];
  const turn = {
    sessionId: "sess-1",
    tenantId: "tenant-a",
    runId: "run-101",
    budget,
    recordEvent: (e) => admittedEvents.push(e),
  };

  installNativeContextGate(ctx, {
    getActiveTurn: (sid) => (sid === "sess-1" ? turn : null),
  });

  // 1. First model call (compaction purpose)
  let streamCalled = 0;
  const res1 = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-1" },
    () => { streamCalled++; return Promise.resolve("stream-chunk-1"); }
  );

  assert.equal(res1, "stream-chunk-1");
  assert.equal(streamCalled, 1);
  assert.equal(budget.snapshot().modelCalls, 1);
  assert.equal(admittedEvents.length, 1);
  assert.equal(admittedEvents[0].purpose, "compaction");

  // 2. Second model call (chat purpose)
  const res2 = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "chat", sessionId: "sess-1" },
    () => { streamCalled++; return Promise.resolve("stream-chunk-2"); }
  );
  assert.equal(res2, "stream-chunk-2");
  assert.equal(streamCalled, 2);
  assert.equal(budget.snapshot().modelCalls, 2);

  // 3. Third model call (compaction purpose) -> should be rejected by budget limit
  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-1" },
      () => { streamCalled++; return Promise.resolve("stream-chunk-3"); }
    );
  }, { code: "RUN_MODEL_CALL_LIMIT" });

  // Crucial check: downstream stream provider was NOT called for rejected call
  assert.equal(streamCalled, 2);
});

test("Context Gate Candidate - Two sessions isolation & no crosstalk", async () => {
  const ctx = new Context();
  const budget1 = createRunBudget({ limits: { maxModelCalls: 1 } });
  const budget2 = createRunBudget({ limits: { maxModelCalls: 5 } });

  const turns = new Map([
    ["sess-1", { sessionId: "sess-1", tenantId: "tenant-1", budget: budget1 }],
    ["sess-2", { sessionId: "sess-2", tenantId: "tenant-2", budget: budget2 }],
  ]);

  installNativeContextGate(ctx, {
    getActiveTurn: (sid) => turns.get(sid) || null,
  });

  // Call on Session 1 (consumes 1)
  await ctx.waterfall(
    "llm/stream",
    { provider: "p", model: "m", purpose: "compaction", sessionId: "sess-1" },
    () => Promise.resolve("ok")
  );

  // Session 1 is now exhausted
  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "p", model: "m", purpose: "compaction", sessionId: "sess-1" },
      () => Promise.resolve("ok")
    );
  }, { code: "RUN_MODEL_CALL_LIMIT" });

  // Session 2 should remain completely uninhibited and isolated
  assert.equal(budget2.snapshot().modelCalls, 0);
  const res2 = await ctx.waterfall(
    "llm/stream",
    { provider: "p", model: "m", purpose: "compaction", sessionId: "sess-2" },
    () => Promise.resolve("ok-sess2")
  );
  assert.equal(res2, "ok-sess2");
  assert.equal(budget2.snapshot().modelCalls, 1);
});

test("Context Gate Candidate - Lifecycle audit observation", async () => {
  const ctx = new Context();
  const observed = [];
  const dispose = installNativeContextGate(ctx, {
    getActiveTurn: () => ({ budget: { admit: () => ({ allowed: true }) } }),
    onCompactionEvent: (e) => observed.push(e),
  });

  // Emit mock native compaction lifecycle events
  ctx.emit("compaction/start", { sessionId: "s1", span: { start: 0, end: 10 } });
  ctx.emit("compaction/summary", { sessionId: "s1", summaryTokens: 250 });
  ctx.emit("compaction/end", { sessionId: "s1", success: true });

  assert.equal(observed.length, 3);
  assert.deepEqual(observed.map(o => o.event), ["compaction/start", "compaction/summary", "compaction/end"]);

  dispose();
});
