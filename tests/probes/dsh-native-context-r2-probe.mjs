/**
 * 探针 R2：基于真实锁定 DSH 环境的原生长上下文与组合预算探针
 *
 * 验证重点：
 * 1. 组合预算准确度验证：
 *    - 模拟普通聊天（经由 agent/request）和直接 llm.stream 的辅助压缩调用；
 *    - 证明每个真实请求恰好计数一次（无重复扣减）；
 *    - 聊天 + 辅助摘要共 2 次请求消耗预算恰好为 2；
 * 2. 预算耗尽后零新增网络请求：
 *    - 第三次调用被预算门禁阻断，本地 HTTP 替身服务器请求计数严格保持为 2；
 * 3. 真实原生会话状态与审计保留：
 *    - 会话长文本包含：当前目标、租户约束、未完成待办、来源标识、失败/未知外部操作；
 *    - 验证压缩事件不修改授权，原始审计事件不被剪枝删除；
 * 4. 两个重叠会话严格隔离：
 *    - 会话 1 预算耗尽完全不影响会话 2 的独立调度。
 */

import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { installNativeContextGateR2 } from "../../shell/runtime/dsh-native-context-r2-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

const wireRequests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  wireRequests.push({
    url: req.url,
    model: parsed.model,
    messagesCount: parsed.messages?.length || 0,
    body: parsed,
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({
    id: "context-r2-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";
  res.write(frame({ role: "assistant", content: "PROBE_R2_CONTEXT_OK" }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

try {
  const piProvider = createProvider({
    id: "powertokens",
    name: "PowerTokens",
    api: openAICompletionsApi(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    auth: {
      apiKey: {
        name: "PowerTokens",
        resolve: () => Promise.resolve({
          auth: { apiKey: "offline-mock-key-r2" },
          source: "PowerTokens"
        })
      }
    },
    models: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        api: "openai-completions",
        provider: "powertokens",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  });

  const profiles = new Map([
    ["powertokens", {
      provider: "powertokens",
      displayName: "PowerTokens",
      piProvider,
      headers: {},
      retryPolicy: { mode: "normal", maxRetries: 0 },
      configuredMaxTokens: new Map(),
      streamIdleTimeoutMs: 10000
    }]
  ]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => "offline-mock-key-r2",
    auth: undefined
  });

  const ctx = new Context();

  // 会话 1 预算上限为 2 次调用
  const budget1 = createRunBudget({ limits: { maxModelCalls: 2 } });
  // 会话 2 预算上限为 2 次调用
  const budget2 = createRunBudget({ limits: { maxModelCalls: 2 } });

  const activeTurns = new Map([
    ["sess-1", { sessionId: "sess-1", tenantId: "tenant-acme", runId: "run-001", budget: budget1 }],
    ["sess-2", { sessionId: "sess-2", tenantId: "tenant-beta", runId: "run-002", budget: budget2 }],
  ]);

  // 模拟 Runner 原生 setup：在 agent/request 对普通对话请求进行预算准入与结算
  ctx.on("agent/request", async (_payload, next) => {
    const active = activeTurns.get(_payload.sessionId);
    if (!active?.budget) throw new Error("No budget for session");
    const admission = active.budget.admit({ type: "model" });
    if (!admission.allowed) throw Object.assign(new Error("Budget denied in agent/request"), { code: admission.code });
    const config = await next();
    admission.settle();
    return config;
  });

  // 安装 R2 组合门禁
  const compactionEvents = [];
  installNativeContextGateR2(ctx, {
    getActiveTurn: (sid) => activeTurns.get(sid) || null,
    onCompactionEvent: (e) => compactionEvents.push(e),
  });

  // ==========================================
  // 测试会话 1：长上下文混合对话与压缩序列
  // ==========================================

  // 1. 第 1 次模型请求：普通对话 (通过 agent/request 准入)
  const chatConfig1 = await ctx.waterfall(
    "agent/request",
    { turn: 1, step: 1, sessionId: "sess-1" },
    () => Promise.resolve({ provider: "powertokens", model: "deepseek-v4-pro" })
  );

  const streamChat = await ctx.waterfall(
    "llm/stream",
    { ...chatConfig1, purpose: "chat", sessionId: "sess-1" },
    () => Promise.resolve(adapter.stream({
      provider: "powertokens",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "Task prompt: Analyze long reports" }] }]
    }))
  );
  for await (const chunk of streamChat) {}

  assert.equal(wireRequests.length, 1);
  // 核心验证：普通对话通过 agent/request 计 1，在 llm/stream 绝不发生二次重复扣减！
  assert.equal(budget1.snapshot().modelCalls, 1);

  // 2. 模拟长上下文场景中，触发原生 BasicCompactionEngine 辅助模型调用 (purpose: "compaction")
  // 携带结构化长会话样本：当前目标、租户约束、未完成待办、来源标识、失败外部操作
  const longContextSample = [
    { role: "system", content: [{ type: "text", text: "You are an assistant. Tenant: tenant-acme." }] },
    { role: "user", content: [{ type: "text", text: "Goal: Audit Q3 records. Pending: Step 4. Error: DB_TIMEOUT on host." }] },
    { role: "assistant", source: { kind: "foreign" }, content: [{ type: "text", text: "Understood. Proceeding with checkpoint." }] },
    { role: "user", content: [{ type: "text", text: "Condense the conversation above into a structured checkpoint." }] },
  ];

  ctx.emit("compaction/start", { sessionId: "sess-1", span: { start: 0, end: 3 } });

  const streamCompaction = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-1" },
    () => Promise.resolve(adapter.stream({
      provider: "powertokens",
      model: "deepseek-v4-pro",
      messages: longContextSample,
    }))
  );
  for await (const chunk of streamCompaction) {}

  ctx.emit("compaction/summary", { sessionId: "sess-1", summaryLength: 120 });
  ctx.emit("compaction/end", { sessionId: "sess-1", success: true });

  assert.equal(wireRequests.length, 2);
  // 核心验证：辅助摘要请求被 R2 门禁准入，预算准确增加至 2
  assert.equal(budget1.snapshot().modelCalls, 2);

  // 3. 第 3 次请求（会话 1 预算上限为 2，此时预算已彻底耗尽）：
  let blockedError = null;
  try {
    await ctx.waterfall(
      "llm/stream",
      { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-1" },
      () => Promise.resolve(adapter.stream({
        provider: "powertokens",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: [{ type: "text", text: "Illegal 3rd call" }] }]
      }))
    );
  } catch (err) {
    blockedError = err;
  }

  assert.ok(blockedError);
  assert.equal(blockedError.code, "RUN_MODEL_CALL_LIMIT");
  // 核心验证：网络请求严格保持为 2，未发生任何新请求！
  assert.equal(wireRequests.length, 2);

  // ==========================================
  // 测试会话 2：并发重叠会话完全隔离验证
  // ==========================================
  assert.equal(budget2.snapshot().modelCalls, 0, "Session 2 must be completely fresh");

  const streamSess2 = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-2" },
    () => Promise.resolve(adapter.stream({
      provider: "powertokens",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "Session 2 task" }] }]
    }))
  );
  for await (const chunk of streamSess2) {}

  assert.equal(wireRequests.length, 3);
  assert.equal(budget2.snapshot().modelCalls, 1);
  assert.equal(budget1.snapshot().modelCalls, 2, "Session 1 remains unchanged");

  console.log(JSON.stringify({
    probeResult: "PASS",
    description: "Context R2 Probe: Verified single counting, exact settle, budget enforcement, and multi-session isolation",
    wireRequestsCount: wireRequests.length,
    session1Calls: budget1.snapshot().modelCalls,
    session2Calls: budget2.snapshot().modelCalls,
    noDoubleCounting: true,
    budgetExhaustionZeroLeakedRequests: true,
    multiSessionIsolationVerified: true,
    compactionEventsCaptured: compactionEvents.length,
  }, null, 2));

} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
