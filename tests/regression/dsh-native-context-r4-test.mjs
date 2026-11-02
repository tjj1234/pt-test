import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  ChatAdmissionTicketManager,
  installNativeContextGateR4,
  MAX_TICKET_CAPACITY,
} from "../../shell/runtime/dsh-native-context-r4-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

async function* makeChunkStream(chunks = ["chunk1", "chunk2"]) {
  for (const c of chunks) yield c;
}

test("Context Gate R4 - Review Blockers 1 & 2: Chat bound to authoritative active Run and client runId override rejected", async () => {
  const ctx = new Context();
  const ticketManager = new ChatAdmissionTicketManager();
  const budget = createRunBudget({ limits: { maxModelCalls: 3 } });
  let dispatched = 0;

  // 1. 无活动 Run 的 Chat 请求必须被直接拒绝 (关闭 blocker 1: chat-ticket-without-active-run)
  const ticketWithoutRun = ticketManager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true},
    runId: "run-001",
    sessionId: "sess-no-run",
    provider: "p",
    model: "m",
  });

  const { dispose } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => null, // 无活动 Run
    ticketManager,
  });

  await assert.rejects(async () => {
    const stream = ctx.waterfall("llm/stream", {
      purpose: "chat",
      sessionId: "sess-no-run",
      provider: "p",
      model: "m",
      admissionTicket: ticketWithoutRun,
    }, async () => {
      dispatched++;
      return makeChunkStream();
    });
    for await (const _ of stream) {}
  }, { code: "RUN_NOT_BOUND" });
  assert.equal(dispatched, 0, "No dispatch when active turn is null");

  dispose();

  // 2. 客户端自报 runId 试图覆盖权威活动 Run (关闭 blocker 2: chat-ticket-old-run-client-overrides-active-run)
  const activeTurn = {
    sessionId: "sess-bound",
    runId: "authoritative-run-002",
    tenantId: "tenant-a",
    budget,
  };

  const oldTicket = ticketManager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true},
    runId: "old-run-client-override",
    sessionId: "sess-bound",
    provider: "p",
    model: "m",
  });

  const { dispose: dispose2 } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => (sid === "sess-bound" ? activeTurn : null),
    ticketManager,
  });

  await assert.rejects(async () => {
    const stream = ctx.waterfall("llm/stream", {
      purpose: "chat",
      sessionId: "sess-bound",
      runId: "old-run-client-override", // 客户端自报旧 Run
      provider: "p",
      model: "m",
      admissionTicket: oldTicket,
    }, async () => {
      dispatched++;
      return makeChunkStream();
    });
    for await (const _ of stream) {}
  }, { code: "TICKET_RUN_MISMATCH" });
  assert.equal(dispatched, 0, "No dispatch on run mismatch");

  dispose2();
});

test("Context Gate R4 - Review Blockers 3, 4 & 5: Required intent recorder, cancellation during await, and cancellation before consume", async () => {
  const ctx = new Context();
  const ticketManager = new ChatAdmissionTicketManager();
  const budget = createRunBudget({ limits: { maxModelCalls: 5 } });
  let dispatched = 0;

  const activeTurn = {
    sessionId: "sess-aux",
    runId: "run-aux-001",
    tenantId: "tenant-aux",
    budget,
    cancelRequested: false,
  };

  // 3. 辅助调用缺失持久模型意图记录器必须被拒绝 (关闭 blocker 3: auxiliary-missing-required-intent-recorder)
  const { dispose } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => (sid === "sess-aux" ? activeTurn : null),
    ticketManager,
    // 未提供 recordModelIntent!
  });

  await assert.rejects(async () => {
    const stream = ctx.waterfall("llm/stream", {
      purpose: "compaction",
      sessionId: "sess-aux",
      provider: "p",
      model: "m",
    }, async () => {
      dispatched++;
      return makeChunkStream();
    });
    for await (const _ of stream) {}
  }, { code: "MISSING_INTENT_RECORDER" });
  assert.equal(dispatched, 0, "No dispatch without required intent recorder");

  dispose();

  // 4. await 意图持久化期间发生取消 (关闭 blocker 4: auxiliary-canceled-while-awaiting-intent)
  const { dispose: dispose2 } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => (sid === "sess-aux" ? activeTurn : null),
    ticketManager,
    recordModelIntent: async () => {
      // 在异步审计期间被外部取消
      activeTurn.cancelRequested = true;
    },
  });

  await assert.rejects(async () => {
    const stream = ctx.waterfall("llm/stream", {
      purpose: "compaction",
      sessionId: "sess-aux",
      provider: "p",
      model: "m",
    }, async () => {
      dispatched++;
      return makeChunkStream();
    });
    for await (const _ of stream) {}
  }, { code: "RUN_CANCELLED" });
  assert.equal(dispatched, 0, "No dispatch when turn is cancelled while awaiting intent");

  dispose2();

  // 5. 流创建后但在真正消费前发生取消 (关闭 blocker 5: auxiliary-canceled-after-stream-created-before-consume)
  activeTurn.cancelRequested = false;
  const { dispose: dispose3 } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => (sid === "sess-aux" ? activeTurn : null),
    ticketManager,
    recordModelIntent: async () => {},
  });

  const streamCreated = ctx.waterfall("llm/stream", {
    purpose: "compaction",
    sessionId: "sess-aux",
    provider: "p",
    model: "m",
  }, async () => {
    dispatched++;
    return makeChunkStream();
  });

  // 在消费前将 turn 标记为取消
  activeTurn.cancelRequested = true;

  await assert.rejects(async () => {
    for await (const _ of streamCreated) {}
  }, { code: "RUN_CANCELLED" });
  assert.equal(dispatched, 0, "No dispatch when turn is cancelled before consumption begins");

  dispose3();
});

test("Context Gate R4 - Secure Ticket Manager: Crypto random IDs, capacity limits, and TTL pruning", () => {
  const manager = new ChatAdmissionTicketManager({ defaultTtlMs: 100, maxCapacity: 5 });

  // 1. 生成加密随机 UUID
  const t1 = manager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true},
    sessionId: "s",
    runId: "r",
    provider: "p",
    model: "m",
  });
  assert.ok(t1.startsWith("ticket_"));
  const uuidPart = t1.slice("ticket_".length);
  assert.equal(uuidPart.length, 36, "Ticket ID must contain valid UUID");

  // 2. 容量上限防爆
  for (let i = 2; i <= 5; i++) {
    manager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true}, sessionId: "s", runId: "r" });
  }

  assert.throws(() => {
    manager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true}, sessionId: "s", runId: "r" });
  }, { code: "TICKET_CAPACITY_EXCEEDED" });

  // 3. 过期与自动修剪
  return new Promise((resolve) => {
    setTimeout(() => {
      // 150ms 后 tickets 已过期，消费抛出 EXPIRED
      assert.throws(() => {
        manager.consumeTicket(t1, { sessionId: "s", runId: "r",provider:"p",model:"m" });
      }, { code: "EXPIRED_ADMISSION_TICKET" });

      // 再次签发应自动清理过期项并成功签发
      const tNew = manager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true}, sessionId: "s", runId: "r" });
      assert.ok(tNew.startsWith("ticket_"));
      resolve();
    }, 120);
  });
});

test("Context Gate R4 - Barrier-controlled overlapping concurrent sessions isolation", async () => {
  const ctx = new Context();
  const ticketManager = new ChatAdmissionTicketManager();

  const b1 = createRunBudget({ limits: { maxModelCalls: 2 } });
  const b2 = createRunBudget({ limits: { maxModelCalls: 2 } });

  const turn1 = { sessionId: "s1", runId: "r1", tenantId: "t1", budget: b1 };
  const turn2 = { sessionId: "s2", runId: "r2", tenantId: "t2", budget: b2 };

  const turns = new Map([
    ["s1", turn1],
    ["s2", turn2],
  ]);

  const { dispose } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => turns.get(sid) || null,
    ticketManager,
    recordModelIntent: async () => {},
  });

  let resolveS1Mid;
  const s1Mid = new Promise((r) => { resolveS1Mid = r; });

  let resolveS2Done;
  const s2Done = new Promise((r) => { resolveS2Done = r; });

  let s1Finished = false;
  let s2Finished = false;

  const run1 = async () => {
    const t1 = ticketManager.issueTicket({ provider: "p", model: "m", budgetAdmission: {allowed:true}, sessionId: "s1", runId: "r1" });
    const stream = ctx.waterfall("llm/stream", {
      purpose: "chat",provider:"p",model:"m",
      sessionId: "s1",
      admissionTicket: t1,
    }, async () => {
      return (async function* () {
        yield "c1";
        resolveS1Mid();
        await s2Done;
        yield "c2";
      })();
    });

    for await (const _ of stream) {}
    s1Finished = true;
  };

  const run2 = async () => {
    await s1Mid;

    // s2 发起 compaction
    const s2Stream = ctx.waterfall("llm/stream", {
      purpose: "compaction",
      sessionId: "s2",
      provider: "p",
      model: "m",
    }, async () => makeChunkStream());
    for await (const _ of s2Stream) {}

    assert.equal(b2.snapshot().modelCalls, 1);
    assert.equal(b1.snapshot().modelCalls, 0);

    // s2 取消
    turn2.cancelRequested = true;

    await assert.rejects(async () => {
      const s = ctx.waterfall("llm/stream", {
        purpose: "compaction",
        sessionId: "s2",
        provider: "p",
        model: "m",
      }, async () => makeChunkStream());
      for await (const _ of s) {}
    }, { code: "RUN_CANCELLED" });

    s2Finished = true;
    resolveS2Done();
  };

  await Promise.all([run1(), run2()]);

  assert.equal(s1Finished, true);
  assert.equal(s2Finished, true);
  assert.equal(turn1.cancelRequested, undefined);
  assert.equal(turn2.cancelRequested, true);
  dispose();
});
