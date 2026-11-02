/**
 * 探针 R3：DSH 原生长上下文与组合预算门禁真实原生压缩探针
 *
 * 验证重点：
 * 1. 实际加载锁定 DSH 插件：
 *    - @deepseek-ai/dsh-compaction-basic (BasicCompactionEngine)
 *    - @deepseek-ai/dsh-llm (LlmRuntime)
 *    - @deepseek-ai/dsh-llm-pi-ai (PiAiAdapter)
 *    - @deepseek-ai/cordis (Context)
 * 2. 真实原生归属与触发：
 *    - 严禁人工 emit 压缩事件，严禁手写摘要替代真实引擎；
 *    - 通过 BasicCompactionEngine 真实原生管道触发 summarization，原生自动注入 `sessionId: agent.session.id` 与 `purpose: "compaction"`；
 * 3. 闭环 R2 主审缺陷：
 *    - 普通 chat 必须验证一次性宿主准入凭证（Ticket），无凭证在网络前以 MISSING_ADMISSION_TICKET 阻断；
 *    - 取消 turn（cancelRequested: true）在网络前以 RUN_CANCELLED 阻断；
 * 4. 网络 I/O 与预算精确断言：
 *    - 1 次普通 Chat（带 Ticket）+ 1 次原生 Compaction = 恰好 2 次本地 HTTP/SSE 网络调用，2 次预算；
 *    - 预算耗尽后第 3 次调用在网络前阻断，无凭证 chat 与取消摘要均在网络前阻断；
 *    - 本地 HTTP/SSE 替身接收到的请求总数严格保持为 2（零泄漏）；
 * 5. 可移植加载能力：验证候选模块复制到生成 profile 临时布局下可无损加载。
 */

import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { LlmRuntime } from "../../shell/node_modules/@deepseek-ai/dsh-llm/lib/index.js";
import { BasicCompactionEngine } from "../../shell/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";

import {
  ChatAdmissionTicketManager,
  installNativeContextGateR3,
} from "../../shell/runtime/dsh-native-context-r3-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

console.log("=== Context R3 真实原生压缩与预算门禁探针开始 ===");

// 1. 验证生成 profile 临时目录的可移植加载能力
console.log("\n[1/5] 验证候选模块在生成 profile 临时目录的可移植加载能力...");
{
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-context-r3-profile-"));
  const targetPath = path.join(tempProfileDir, "candidate.mjs");
  const sourceCode = fs.readFileSync(
    new URL("../../shell/runtime/dsh-native-context-r3-candidate.mjs", import.meta.url),
    "utf8"
  );
  fs.writeFileSync(targetPath, sourceCode, "utf8");

  const imported = await import(`file://${targetPath}`);
  assert.equal(typeof imported.installNativeContextGateR3, "function");
  assert.equal(typeof imported.ChatAdmissionTicketManager, "function");
  console.log("  ✔ 临时生成 profile 目录加载与导出函数校验成功");

  fs.rmSync(tempProfileDir, { recursive: true, force: true });
}

// 2. 搭建本地 Loopback HTTP/SSE 替身
console.log("\n[2/5] 搭建本地 HTTP/SSE 替身服务，监听真实 wireRequests...");
const wireRequests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  wireRequests.push({
    model: parsed.model,
    messagesCount: parsed.messages?.length,
    lastRole: parsed.messages?.[parsed.messages.length - 1]?.role,
  });

  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({
    id: "offline-context-r3",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";

  // 根据请求类型返回模拟文本
  const isCompaction = parsed.messages?.some(m => {
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    return raw.toLowerCase().includes("checkpoint") || raw.toLowerCase().includes("compaction");
  });

  const replyText = isCompaction
    ? "This is an established checkpoint consolidating earlier project tasks and tenant rules."
    : "Chat response from assistant.";

  res.write(frame({ role: "assistant", content: replyText }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

try {
  // 3. 构建原生 PiAiAdapter 与 Provider
  console.log("\n[3/5] 构建原生 Provider 与 PiAiAdapter...");
  const rawModels = [{
    id: "model-a-chat",
    name: "Model A Chat",
    api: "openai-completions",
    provider: "powertokens",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }];

  const piProvider = createProvider({
    id: "powertokens",
    name: "PowerTokens",
    api: openAICompletionsApi(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    auth: {
      apiKey: {
        name: "PowerTokens",
        resolve: () => Promise.resolve({
          auth: { apiKey: "offline-r3-mock-key" },
          source: "PowerTokens"
        })
      }
    },
    models: rawModels
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
    resolveApiKey: async () => "offline-r3-mock-key",
    auth: undefined
  });

  // 4. 组装 Cordis Context、LlmRuntime 与真实 BasicCompactionEngine
  const ctx = new Context();
  const llmRuntime = new LlmRuntime(ctx);
  llmRuntime.registerAdapter(["powertokens"], adapter);

  const compactionEngine = new BasicCompactionEngine(ctx, {
    summarizationProvider: "powertokens",
    summarizationModel: "model-a-chat",
    maxTokens: 1024,
    auto: false
  });

  const budget = createRunBudget({
    limits: { maxModelCalls: 2 } // 严格限制最多 2 次模型调用
  });

  const recordedAudits = [];
  const turnState = {
    sessionId: "native-session-probe",
    runId: "run-probe-001",
    tenantId: "tenant-probe",
    budget,
    cancelRequested: false,
    recordEvent: (evt) => recordedAudits.push(evt),
  };

  const ticketManager = new ChatAdmissionTicketManager();

  const { dispose } = installNativeContextGateR3(ctx, {
    getActiveTurn: (sid) => (sid === "native-session-probe" ? turnState : null),
    ticketManager,
    recordModelIntent: async (intent) => {
      recordedAudits.push({ type: "model_intent_persisted", ...intent });
    }
  });

  // --- 测试流程 1：普通 Chat 请求（带合法 Ticket） ---
  console.log("\n[4/5] 执行普通对话与真实原生压缩触发序列...");
  const chatTicket = ticketManager.issueTicket({
    sessionId: "native-session-probe",
    runId: "run-probe-001",
    provider: "powertokens",
    model: "model-a-chat",
  });

  // 在 host 准入计数
  const chatAdmission = budget.admit({ type: "model" });
  assert.equal(chatAdmission.allowed, true);

  const chatStream = await ctx.llm.stream({
    provider: "powertokens",
    model: "model-a-chat",
    sessionId: "native-session-probe",
    purpose: "chat",
    admissionTicket: chatTicket,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Goal: Analyze project status and constraints." }]
    }]
  });

  for await (const chunk of chatStream) {}
  chatAdmission.settle();

  assert.equal(wireRequests.length, 1);
  assert.equal(budget.snapshot().modelCalls, 1);
  console.log("  ✔ Chat 请求成功：1 次本地 HTTP 调用，预算计数 1，消费 1 次凭证");

  // --- 测试流程 2：真实原生压缩引擎触发 ---
  // 由锁定 BasicCompactionEngine.prototype.summarize 触发真实调用
  const historyInput = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Tenant constraint: data cannot leave zone. Todo: audit logs." }]
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Acknowledged tenant constraints and registered todo." }],
        source: { kind: "model", provider: "powertokens" }
      }
    ]
  };

  const agentWrapper = {
    session: {
      id: "native-session-probe",
      requestHeader: () => undefined,
    },
    options: {
      provider: "powertokens",
      model: "model-a-chat"
    }
  };

  const compactionResult = await compactionEngine.summarize(historyInput, agentWrapper);

  assert.equal(wireRequests.length, 2);
  assert.equal(budget.snapshot().modelCalls, 2);
  assert.equal(compactionResult.summary.length > 0, true);
  console.log("  ✔ 原生 Compaction 成功：触发 BasicCompactionEngine -> ctx.llm.stream -> HTTP 替身，预算计数 2");
  console.log(`    生成的摘要文本: "${compactionResult.summary[0].text}"`);

  // --- 测试流程 3：第 3 次调用预算耗尽阻断 ---
  console.log("\n[5/5] 验证预算耗尽与 R2 主审缺陷闭环阻断（零网络外发）...");
  await assert.rejects(async () => {
    await compactionEngine.summarize(historyInput, agentWrapper);
  }, (err) => err.code === "RUN_MODEL_CALL_LIMIT");

  assert.equal(wireRequests.length, 2, "预算耗尽后本地替身请求计数严格不增加 (仍为 2)");
  console.log("  ✔ 预算耗尽阻断通过：零新增网络请求");

  // --- 测试流程 4：无凭证 chat 拒绝 (关闭 R2 主审缺陷 1) ---
  await assert.rejects(async () => {
    const unauthenticatedStream = await ctx.llm.stream({
      provider: "powertokens",
      model: "model-a-chat",
      sessionId: "native-session-probe",
      purpose: "chat",
      // 无 admissionTicket!
      messages: [{ role: "user", content: [{ type: "text", text: "unauthorized" }] }]
    });
    for await (const _ of unauthenticatedStream) {}
  }, (err) => err.code === "MISSING_ADMISSION_TICKET");

  assert.equal(wireRequests.length, 2, "无凭证 chat 请求网络前阻断，替身请求数仍为 2");
  console.log("  ✔ 无凭证 Chat 阻断通过：MISSING_ADMISSION_TICKET，零网络外发");

  // --- 测试流程 5：取消状态 turn 拒绝 (关闭 R2 主审缺陷 2) ---
  turnState.cancelRequested = true;
  await assert.rejects(async () => {
    await compactionEngine.summarize(historyInput, agentWrapper);
  }, (err) => err.code === "RUN_CANCELLED");

  assert.equal(wireRequests.length, 2, "已取消 turn 的 compaction 必须网络前阻断，替身请求数仍为 2");
  console.log("  ✔ 取消 Turn 阻断通过：RUN_CANCELLED，零网络外发");

  // 核对模型意图审计持久化记录
  const intentEvents = recordedAudits.filter(a => a.type === "model_intent_persisted");
  assert.equal(intentEvents.length >= 1, true, "必须记录持久模型意图");
  console.log("  ✔ 持久模型意图记录验证通过");

  console.log("\n=== Context R3 探针全部通过 (ALL PASS) ===");
  dispose();
} finally {
  server.close();
}
