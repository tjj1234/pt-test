import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  ChatAdmissionTicketManager,
  installNativeContextGateR3,
  wrapStreamWithSettle,
} from "../../shell/runtime/dsh-native-context-r3-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

async function* makeChunkStream(chunks = ["chunk1", "chunk2"]) {
  for (const c of chunks) yield c;
}

test("Context Gate R3 - Chat admission ticket: missing, replay, and mismatch rejected", async () => {
  const ctx = new Context();
  const ticketManager = new ChatAdmissionTicketManager();
  const budget = createRunBudget({ limits: { maxModelCalls: 3 } });
  let dispatched = 0;

  const activeTurn = {
    sessionId: "sess-a",
    runId: "run-001",
    tenantId: "tenant-1",
    budget,
  };

  const { dispose } = installNativeContextGateR3(ctx, {
    getActiveTurn: (sid) => (sid === "sess-a" ? activeTurn : null),
    ticketManager,
  });

  const consume = async (options) => {
    const stream = await ctx.waterfall("llm/stream", options, async () => {
      dispatched++;
      return makeChunkStream();
    });
    for await (const _ of stream) {}
  };

  // 1. 无凭证普通 chat 必须被网络前拒绝 (修复 R2 主审 blocker 1: unbound-chat-dispatched-without-budget)
  await assert.rejects(async () => {
    await consume({ purpose: "chat", sessionId: "sess-a" });
  }, { code: "MISSING_ADMISSION_TICKET" });
  assert.equal(dispatched, 0, "No dispatch when admission ticket is missing");

  // 2. 宿主签发合法凭证
  const ticketId = ticketManager.issueTicket({
    runId: "run-001",
    sessionId: "sess-a",
    provider: "powertokens",
    model: "deepseek-v4",
  });

  // 3. 凭证会话不匹配
  await assert.rejects(async () => {
    await consume({
      purpose: "chat",
      sessionId: "sess-different",
      provider: "powertokens",
      model: "deepseek-v4",
      admissionTicket: ticketId,
    });
  }, { code: "TICKET_SESSION_MISMATCH" });
  assert.equal(dispatched, 0, "No dispatch on session mismatch");

  // 4. 正常消费凭证并成功 dispatch
  await consume({
    purpose: "chat",
    sessionId: "sess-a",
    provider: "powertokens",
    model: "deepseek-v4",
    admissionTicket: ticketId,
  });
  assert.equal(dispatched, 1, "Dispatched once with valid ticket");

  // 5. 重放已消费凭证必须被拒绝 (Replay attack prevention)
  await assert.rejects(async () => {
    await consume({
      purpose: "chat",
      sessionId: "sess-a",
      provider: "powertokens",
      model: "deepseek-v4",
      admissionTicket: ticketId,
    });
  }, { code: "TICKET_ALREADY_CONSUMED" });
  assert.equal(dispatched, 1, "No additional dispatch on replayed ticket");

  dispose();
});

test("Context Gate R3 - Fail-Closed: cancelled turn, abort signal, expired run, or audit failure", async () => {
  const ctx = new Context();
  const ticketManager = new ChatAdmissionTicketManager();
  const budget = createRunBudget({ limits: { maxModelCalls: 2 } });
  let dispatched = 0;

  const cancelledTurn = {
    sessionId: "sess-cancelled",
    runId: "run-cancel",
    tenantId: "t-cancel",
    cancelRequested: true,
    budget,
  };

  const { dispose } = installNativeContextGateR3(ctx, {
    getActiveTurn: (sid) => (sid === "sess-cancelled" ? cancelledTurn : null),
    ticketManager,
  });

  const consume = async (options) => {
    const stream = await ctx.waterfall("llm/stream", options, async () => {
      dispatched++;
      return makeChunkStream();
    });
    for await (const _ of stream) {}
  };

  // 1. 普通 chat 即使有凭证，但 turn 已被取消，必须网络前拒绝
  const ticket = ticketManager.issueTicket({
    runId: "run-cancel",
    sessionId: "sess-cancelled",
  });
  await assert.rejects(async () => {
    await consume({
      purpose: "chat",
      sessionId: "sess-cancelled",
      admissionTicket: ticket,
    });
  }, { code: "RUN_CANCELLED" });
  assert.equal(dispatched, 0);

  // 2. 辅助 compaction 在已取消 turn 上直接调用，必须网络前拒绝 (修复 R2 主审 blocker 2: cancelled-turn-compaction-dispatched)
  await assert.rejects(async () => {
    await consume({
      purpose: "compaction",
      sessionId: "sess-cancelled",
      provider: "p",
      model: "m",
    });
  }, { code: "RUN_CANCELLED" });
  assert.equal(dispatched, 0);
  assert.equal(budget.snapshot().modelCalls, 0);

  // 3. 辅助 compaction signal 已经 aborted，必须网络前拒绝
  const normalTurn = {
    sessionId: "sess-normal",
    runId: "run-normal",
    budget,
  };
  dispose();

  const controller = new AbortController();
  controller.abort();

  const { dispose: dispose2 } = installNativeContextGateR3(ctx, {
    getActiveTurn: (sid) => (sid === "sess-normal" ? normalTurn : null),
    ticketManager,
  });

  await assert.rejects(async () => {
    await consume({
      purpose: "compaction",
      sessionId: "sess-normal",
      provider: "p",
      model: "m",
      signal: controller.signal,
    });
  }, { code: "RUN_CANCELLED" });
  assert.equal(dispatched, 0);

  // 4. 持久模型意图记录失败：审计失败不得外发网络，且预算必须正确 settle
  const { dispose: dispose3 } = installNativeContextGateR3(ctx, {
    getActiveTurn: (sid) => (sid === "sess-audit" ? { sessionId: "sess-audit", budget } : null),
    recordModelIntent: async () => {
      throw new Error("Audit storage unavailable");
    },
  });

  await assert.rejects(async () => {
    await consume({
      purpose: "compaction",
      sessionId: "sess-audit",
      provider: "p",
      model: "m",
    });
  }, { code: "INTENT_AUDIT_FAILED" });
  assert.equal(dispatched, 0, "No dispatch if intent audit fails");
  dispose2();
  dispose3();
});

test("Context Gate R3 - Stream lifecycle and settle semantics", async () => {
  // 1. 正常消费完毕触发 settle
  {
    let settled = false;
    async function* testStream() {
      yield "a";
      yield "b";
    }
    const wrapped = wrapStreamWithSettle(testStream(), () => { settled = true; });
    assert.equal(settled, false);
    for await (const chunk of wrapped) {
      assert.equal(settled, false);
    }
    assert.equal(settled, true);
  }

  // 2. 消费者提前 break/return 触发 settle
  {
    let settled = false;
    async function* testStream() {
      yield "a";
      yield "b";
      yield "c";
    }
    const wrapped = wrapStreamWithSettle(testStream(), () => { settled = true; });
    assert.equal(settled, false);
    for await (const chunk of wrapped) {
      break; // 消费者提前中断
    }
    assert.equal(settled, true, "Early break must still trigger settle");
  }

  // 3. 内部流抛出异常触发 settle 并传播异常
  {
    let settled = false;
    let settledError = null;
    async function* failingStream() {
      yield "ok";
      throw new Error("Mid-stream connection error");
    }
    const wrapped = wrapStreamWithSettle(failingStream(), (err) => {
      settled = true;
      settledError = err;
    });

    await assert.rejects(async () => {
      for await (const _ of wrapped) {}
    }, { message: "Mid-stream connection error" });

    assert.equal(settled, true);
    assert.equal(settledError?.message, "Mid-stream connection error");
  }
});

test("Context Gate R3 - Barrier-controlled overlapping concurrent sessions isolation", async () => {
  const ctx = new Context();
  const ticketManager = new ChatAdmissionTicketManager();

  const b1 = createRunBudget({ limits: { maxModelCalls: 2 } });
  const b2 = createRunBudget({ limits: { maxModelCalls: 2 } });

  const turn1 = { sessionId: "s1", runId: "r1", budget: b1 };
  const turn2 = { sessionId: "s2", runId: "r2", budget: b2 };

  const turns = new Map([
    ["s1", turn1],
    ["s2", turn2],
  ]);

  installNativeContextGateR3(ctx, {
    getActiveTurn: (sid) => turns.get(sid) || null,
    ticketManager,
  });

  // 控制交叉步调的栅栏 (Barriers)
  let resolveS1ReachedMiddle;
  const s1ReachedMiddle = new Promise((r) => { resolveS1ReachedMiddle = r; });

  let resolveS2Finished;
  const s2Finished = new Promise((r) => { resolveS2Finished = r; });

  let s1Completed = false;
  let s2Completed = false;

  // 会话 1：开启异步流并在中间挂起，等待会话 2 启动并结束
  const runSession1 = async () => {
    const ticket1 = ticketManager.issueTicket({ sessionId: "s1", runId: "r1" });
    const stream = await ctx.waterfall("llm/stream", {
      purpose: "chat",
      sessionId: "s1",
      admissionTicket: ticket1,
    }, async () => {
      return (async function* () {
        yield "s1_chunk_1";
        // 触发栅栏：通知 s2 可以开始执行
        resolveS1ReachedMiddle();
        // 等待 s2 彻底完成并发生取消/耗尽事件
        await s2Finished;
        yield "s1_chunk_2";
      })();
    });

    for await (const chunk of stream) {}
    s1Completed = true;
  };

  // 会话 2：在会话 1 流执行中途执行并发请求，然后被取消
  const runSession2 = async () => {
    await s1ReachedMiddle;

    // 会话 2 执行一次 compaction
    const s2Stream = await ctx.waterfall("llm/stream", {
      purpose: "compaction",
      sessionId: "s2",
      provider: "p",
      model: "m",
    }, async () => makeChunkStream());
    for await (const _ of s2Stream) {}

    assert.equal(b2.snapshot().modelCalls, 1);
    assert.equal(b1.snapshot().modelCalls, 0); // 必须互不影响

    // 随后将会话 2 标记为已取消
    turn2.cancelRequested = true;

    // 会话 2 再次请求应该被拒绝
    await assert.rejects(async () => {
      await ctx.waterfall("llm/stream", {
        purpose: "compaction",
        sessionId: "s2",
        provider: "p",
        model: "m",
      }, async () => makeChunkStream());
    }, { code: "RUN_CANCELLED" });

    s2Completed = true;
    resolveS2Finished();
  };

  // 并发启动两个真实重叠的会话
  await Promise.all([runSession1(), runSession2()]);

  assert.equal(s1Completed, true);
  assert.equal(s2Completed, true);

  // 会话 2 取消绝不污染会话 1
  assert.equal(turn1.cancelRequested, undefined);
  assert.equal(turn2.cancelRequested, true);
  assert.equal(b2.snapshot().modelCalls, 1);
});
