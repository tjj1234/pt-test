import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { installNativeContextGateR2 } from "../../shell/runtime/dsh-native-context-r2-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

async function* makeChunkStream(chunks = ["chunk1", "chunk2"]) {
  for (const c of chunks) yield c;
}

test("Context Gate R2 - No double-counting: chat admitted in agent/request, compaction admitted in llm/stream", async () => {
  const ctx = new Context();
  const budget = createRunBudget({
    limits: { maxModelCalls: 2 },
  });

  const turn = {
    sessionId: "sess-1",
    tenantId: "tenant-a",
    runId: "run-001",
    budget,
  };

  // 模拟 Runner 原生 setup：在 agent/request 执行普通 chat 的预算准入
  ctx.on("agent/request", async (_payload, next) => {
    const admission = budget.admit({ type: "model" });
    if (!admission.allowed) throw Object.assign(new Error("Chat budget denied"), { code: admission.code });
    const config = await next();
    admission.settle();
    return config;
  });

  // 安装 R2 门禁
  installNativeContextGateR2(ctx, {
    getActiveTurn: (sid) => (sid === "sess-1" ? turn : null),
  });

  // 1. 发起普通对话请求：
  //    先通过 agent/request 准入
  const callConfig = await ctx.waterfall(
    "agent/request",
    { turn: 1, step: 1 },
    () => Promise.resolve({ provider: "powertokens", model: "deepseek-v4-pro" })
  );
  assert.equal(budget.snapshot().modelCalls, 1);

  //    随后发起 llm/stream (purpose: "chat")
  const stream1 = await ctx.waterfall(
    "llm/stream",
    { ...callConfig, purpose: "chat", sessionId: "sess-1" },
    () => Promise.resolve(makeChunkStream())
  );
  for await (const chunk of stream1) {}

  // 核心核查：普通 chat 在 llm/stream 绝不发生重复扣减！modelCalls 依然为 1
  assert.equal(budget.snapshot().modelCalls, 1);

  // 2. 发起辅助 compaction 请求（直接调用 llm/stream，完全不经过 agent/request）：
  const stream2 = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-1" },
    () => Promise.resolve(makeChunkStream())
  );
  for await (const chunk of stream2) {}

  // 辅助压缩调用被 R2 门禁准入，预算准确增加至 2
  assert.equal(budget.snapshot().modelCalls, 2);

  // 3. 发起第 3 次模型请求（预算耗尽）：
  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-1" },
      () => Promise.resolve(makeChunkStream())
    );
  }, { code: "RUN_MODEL_CALL_LIMIT" });

  assert.equal(budget.snapshot().modelCalls, 2);
});

test("Context Gate R2 - Accurate settle timing across stream consumption", async () => {
  const ctx = new Context();
  let settled = false;
  const mockBudget = {
    admit: () => ({
      allowed: true,
      settle: () => { settled = true; },
    }),
  };

  installNativeContextGateR2(ctx, {
    getActiveTurn: () => ({ budget: mockBudget }),
  });

  const stream = await ctx.waterfall(
    "llm/stream",
    { provider: "p", model: "m", purpose: "compaction", sessionId: "sess-timing" },
    () => Promise.resolve(makeChunkStream(["a", "b"]))
  );

  // 流刚返回时，绝不应该已经 settle！
  assert.equal(settled, false);

  // 遍历流
  for await (const _ of stream) {
    // 迭代进行中依然未 settle
  }

  // 遍历完毕后，settle 触发
  assert.equal(settled, true);
});

test("Context Gate R2 - Fail-Closed when missing active Run or sessionId", async () => {
  const ctx = new Context();
  installNativeContextGateR2(ctx, {
    getActiveTurn: () => null, // 没有活动的 Run
  });

  // 1. 无 sessionId
  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "p", model: "m", purpose: "compaction" },
      () => Promise.resolve(makeChunkStream())
    );
  }, { code: "RUN_NOT_BOUND" });

  // 2. 有 sessionId 但无活动 Run
  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "p", model: "m", purpose: "compaction", sessionId: "unbound-sess" },
      () => Promise.resolve(makeChunkStream())
    );
  }, { code: "RUN_NOT_BOUND" });
});

test("Context Gate R2 - Overlapping sessions isolation", async () => {
  const ctx = new Context();
  const b1 = createRunBudget({ limits: { maxModelCalls: 1 } });
  const b2 = createRunBudget({ limits: { maxModelCalls: 2 } });

  const turns = new Map([
    ["s1", { sessionId: "s1", tenantId: "t1", budget: b1 }],
    ["s2", { sessionId: "s2", tenantId: "t2", budget: b2 }],
  ]);

  installNativeContextGateR2(ctx, {
    getActiveTurn: (sid) => turns.get(sid) || null,
  });

  // s1 消耗 1 次 compaction
  const str1 = await ctx.waterfall(
    "llm/stream",
    { provider: "p", model: "m", purpose: "compaction", sessionId: "s1" },
    () => Promise.resolve(makeChunkStream())
  );
  for await (const _ of str1) {}
  assert.equal(b1.snapshot().modelCalls, 1);
  assert.equal(b2.snapshot().modelCalls, 0);

  // s1 已满
  await assert.rejects(async () => {
    await ctx.waterfall(
      "llm/stream",
      { provider: "p", model: "m", purpose: "compaction", sessionId: "s1" },
      () => Promise.resolve(makeChunkStream())
    );
  }, { code: "RUN_MODEL_CALL_LIMIT" });

  // s2 完全不受影响
  const str2 = await ctx.waterfall(
    "llm/stream",
    { provider: "p", model: "m", purpose: "compaction", sessionId: "s2" },
    () => Promise.resolve(makeChunkStream())
  );
  for await (const _ of str2) {}
  assert.equal(b2.snapshot().modelCalls, 1);
});
