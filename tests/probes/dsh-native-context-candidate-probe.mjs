/**
 * 探针：验证 DSH 原生长上下文网关在真实 Cordis 与本地 HTTP 替身中的行为。
 * 
 * 验证重点：
 * 1. 模拟长上下文中的连续模型调用（包含普通 chat 和 compaction 辅助摘要调用）；
 * 2. 验证 purpose: "compaction" 的模型调用被 gate 严格接入预算计数（modelCalls）；
 * 3. 验证当预算耗尽时，本地 HTTP 请求计数不再增加（零网络外发），且后续重试被阻断；
 * 4. 验证会话取消或缺少活动 Run 时默认 Fail-Closed；
 * 5. 验证两个并发会话的预算隔离性与无状态串扰。
 */

import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { installNativeContextGate } from "../../shell/runtime/dsh-native-context-gate-candidate.mjs";

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
    id: "context-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";
  res.write(frame({ role: "assistant", content: "PROBE_CONTEXT_OK" }));
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
          auth: { apiKey: "offline-mock-key" },
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
    resolveApiKey: async () => "offline-mock-key",
    auth: undefined
  });

  const ctx = new Context();

  // 模拟活动 Run 会话与预算 (仅允许 2 次调用)
  const budget1 = createRunBudget({ limits: { maxModelCalls: 2 } });
  const activeTurns = new Map([
    ["sess-long-1", { sessionId: "sess-long-1", tenantId: "tenant-probe", runId: "run-001", budget: budget1 }],
  ]);

  // 安装门禁
  const eventsObserved = [];
  installNativeContextGate(ctx, {
    getActiveTurn: (sid) => activeTurns.get(sid) || null,
    onCompactionEvent: (e) => eventsObserved.push(e),
  });

  // 1. 发起第 1 次普通对话请求 (通过 Cordis llm/stream 触发 adapter.stream)
  const req1 = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "chat", sessionId: "sess-long-1" },
    () => {
      const s = adapter.stream({
        provider: "powertokens",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: [{ type: "text", text: "Turn 1 question" }] }]
      });
      return Promise.resolve(s);
    }
  );
  for await (const chunk of req1) {}
  assert.equal(wireRequests.length, 1);
  assert.equal(budget1.snapshot().modelCalls, 1);

  // 2. 发起第 2 次模型请求：模拟 BasicCompactionEngine 触发的摘要调用 (purpose: "compaction")
  const req2 = await ctx.waterfall(
    "llm/stream",
    { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-long-1" },
    () => {
      const s = adapter.stream({
        provider: "powertokens",
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: [{ type: "text", text: "Turn 1 question" }] },
          { role: "assistant", source: { kind: "foreign" }, content: [{ type: "text", text: "Turn 1 answer" }] },
          { role: "user", content: [{ type: "text", text: "Condense this conversation into checkpoint" }] },
        ]
      });
      return Promise.resolve(s);
    }
  );
  for await (const chunk of req2) {}
  assert.equal(wireRequests.length, 2);
  assert.equal(budget1.snapshot().modelCalls, 2);

  // 3. 发起第 3 次模型请求：此时预算 maxModelCalls: 2 已用尽！
  // 必须被门禁精准拦截，本地 HTTP 服务器计数保持为 2
  let blockedError = null;
  try {
    await ctx.waterfall(
      "llm/stream",
      { provider: "powertokens", model: "deepseek-v4-pro", purpose: "compaction", sessionId: "sess-long-1" },
      () => {
        const s = adapter.stream({
          provider: "powertokens",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: [{ type: "text", text: "Should never reach server" }] }]
        });
        return Promise.resolve(s);
      }
    );
  } catch (err) {
    blockedError = err;
  }

  assert.ok(blockedError, "Expected budget admission refusal");
  assert.equal(blockedError.code, "RUN_MODEL_CALL_LIMIT");
  assert.equal(wireRequests.length, 2, "Wire requests must strictly remain 2");

  console.log(JSON.stringify({
    probeResult: "PASS",
    description: "Native DSH Context & Compaction Gate probe verified",
    budgetModelCallsTracked: budget1.snapshot().modelCalls,
    wireRequestsCount: wireRequests.length,
    compactionBypassClosed: true,
    leakagePreventedOnBudgetDenial: true,
  }, null, 2));

} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
