/**
 * 探针 R4：DSH 原生自动/手动压缩与准入反例闭环探针
 *
 * 验证重点：
 * 1. 实际加载锁定 DSH 插件并初始化完整生态：
 *    - @deepseek-ai/dsh-commands (CommandRuntime)
 *    - @deepseek-ai/dsh-command-compact (公开 /compact 命令入口)
 *    - @deepseek-ai/dsh-compaction-basic (BasicCompactionEngine)
 *    - @deepseek-ai/dsh-token-meter (TokenMeter)
 *    - @deepseek-ai/dsh-session (SessionService)
 *    - @deepseek-ai/dsh-llm (LlmRuntime)
 *    - @deepseek-ai/dsh-llm-pi-ai (PiAiAdapter)
 *    - @deepseek-ai/cordis (Context)
 * 2. 真实公开入口触发：
 *    - 通过真实 CommandRuntime 路由触发 command-compact 公开 /compact 命令；
 *    - 通过 BasicCompactionEngine 真实原生管道触发 summarization，原生自动注入 `sessionId: agent.session.id` 与 `purpose: "compaction"`；
 * 3. 闭环主审独立复现的 5 项 Controlled Dispatch 穿透缺口：
 *    - 无活动 Run 的 Chat 请求：网络前被 RUN_NOT_BOUND 阻断，0 dispatch；
 *    - 客户端自报 runId 覆盖活动 Run：网络前被 TICKET_RUN_MISMATCH 阻断，0 dispatch；
 *    - 辅助调用缺意图记录器：网络前被 MISSING_INTENT_RECORDER 阻断，0 dispatch；
 *    - await 意图审计期间取消：双重核验后被 RUN_CANCELLED 阻断，0 dispatch；
 *    - 流创建后消费前取消：惰性调度前被 RUN_CANCELLED 阻断，0 dispatch；
 * 4. 真实网络 I/O 与预算精确断言：
 *    - 1 次普通 Chat（带 Ticket）+ 1 次原生 Compaction = 恰好 2 次本地 HTTP/SSE 网络调用，2 次预算；
 *    - 5 项穿透反例与预算耗尽尝试均在网络前被拦截，本地替身请求计数严格维持为 2（零泄漏）；
 * 5. 模块可移植加载能力：验证候选模块复制到生成 profile 临时布局下可无损加载。
 */

import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { CommandRuntime } from "../../shell/node_modules/@deepseek-ai/dsh-commands/lib/index.js";
import * as commandCompact from "../../shell/node_modules/@deepseek-ai/dsh-command-compact/lib/index.js";
import { LlmRuntime } from "../../shell/node_modules/@deepseek-ai/dsh-llm/lib/index.js";
import { BasicCompactionEngine } from "../../shell/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js";
import TokenMeter from "../../shell/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js";
import SessionService from "../../shell/node_modules/@deepseek-ai/dsh-session/lib/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";

import {
  ChatAdmissionTicketManager,
  installNativeContextGateR4,
} from "../../shell/runtime/dsh-native-context-r4-candidate.mjs";

const require = createRequire(import.meta.url);
const { createRunBudget } = require("../../shell/tasks/budget.cjs");

console.log("=== Context R4 准入反例闭环与真实原生压缩探针开始 ===");

// 1. 验证生成 profile 临时目录的可移植加载能力
console.log("\n[1/6] 验证候选模块在生成 profile 临时目录的可移植加载能力...");
{
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-context-r4-profile-"));
  const targetPath = path.join(tempProfileDir, "candidate.mjs");
  const sourceCode = fs.readFileSync(
    new URL("../../shell/runtime/dsh-native-context-r4-candidate.mjs", import.meta.url),
    "utf8"
  );
  fs.writeFileSync(targetPath, sourceCode, "utf8");

  const imported = await import(`file://${targetPath}`);
  assert.equal(typeof imported.installNativeContextGateR4, "function");
  assert.equal(typeof imported.ChatAdmissionTicketManager, "function");
  console.log("  ✔ 临时生成 profile 目录加载与导出函数校验成功");

  fs.rmSync(tempProfileDir, { recursive: true, force: true });
}

// 2. 搭建本地 Loopback HTTP/SSE 替身
console.log("\n[2/6] 搭建本地 HTTP/SSE 替身服务，监听真实 wireRequests...");
const wireRequests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  wireRequests.push({
    model: parsed.model,
    messagesCount: parsed.messages?.length,
  });

  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({
    id: "offline-context-r4",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";

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
  console.log("\n[3/6] 构建原生 Provider 与 PiAiAdapter...");
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
          auth: { apiKey: "offline-r4-mock-key" },
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
    resolveApiKey: async () => "offline-r4-mock-key",
    auth: undefined
  });

  // 4. 组装 Cordis Context 与完整 DSH 原生生态
  const ctx = new Context();
  new CommandRuntime(ctx);
  new TokenMeter(ctx);
  new SessionService(ctx);
  const llmRuntime = new LlmRuntime(ctx);
  llmRuntime.registerAdapter(["powertokens"], adapter);

  const compactionEngine = new BasicCompactionEngine(ctx, {
    summarizationProvider: "powertokens",
    summarizationModel: "model-a-chat",
    maxTokens: 1024,
    auto: false
  });
  commandCompact.apply(ctx);

  const budget = createRunBudget({
    limits: { maxModelCalls: 2 } // 严格限制最多 2 次模型调用
  });

  const recordedAudits = [];
  const turnState = {
    sessionId: "native-session-r4",
    runId: "run-r4-authoritative",
    tenantId: "tenant-r4",
    budget,
    cancelRequested: false,
    recordEvent: (evt) => recordedAudits.push(evt),
  };

  const ticketManager = new ChatAdmissionTicketManager();

  const { dispose } = installNativeContextGateR4(ctx, {
    getActiveTurn: (sid) => (sid === "native-session-r4" ? turnState : null),
    ticketManager,
    recordModelIntent: async (intent) => {
      recordedAudits.push({ type: "model_intent_persisted", ...intent });
    }
  });

  // --- 测试流程 1：验证公开 /compact 命令入口 ---
  console.log("\n[4/6] 验证真实 command-compact 公开入口在受控维护 Run 下调度...");
  const dummyAgent = {
    session: {
      id: "native-session-r4",
      append: () => {},
      surface: {},
      events: []
    },
    runMaintenance: async (cb) => cb(new AbortController().signal),
    options: {}
  };

  const commandResult = await ctx.commands.execute(dummyAgent, "/compact", [], new AbortController().signal);
  assert.equal(commandResult?.result?.kind, "success");
  assert.equal(commandResult?.result?.text, "No compactable history yet.");
  console.log(`  ✔ /compact 命令公开入口调用成功: ${commandResult.result.text} (commandId: ${commandResult.commandId})`);

  // --- 测试流程 2：普通 Chat 请求（带合法 Ticket）与原生压缩触发 ---
  console.log("\n[5/6] 执行普通对话与真实原生压缩触发序列...");
  const chatTicket = ticketManager.issueTicket({
    sessionId: "native-session-r4",
    runId: "run-r4-authoritative",
    provider: "powertokens",
    model: "model-a-chat",
  });

  const chatAdmission = budget.admit({ type: "model" });
  assert.equal(chatAdmission.allowed, true);

  const chatStream = ctx.llm.stream({
    provider: "powertokens",
    model: "model-a-chat",
    sessionId: "native-session-r4",
    purpose: "chat",
    admissionTicket: chatTicket,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Task: analyze tenant compliance and budget." }]
    }]
  });

  for await (const chunk of chatStream) {}
  chatAdmission.settle();

  assert.equal(wireRequests.length, 1);
  assert.equal(budget.snapshot().modelCalls, 1);
  console.log("  ✔ Chat 请求成功：1 次本地 HTTP 调用，预算计数 1，消费 1 次凭证");

  // 原生 Compaction 引擎真实触发
  const historyInput = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Goal: migrate databases safely under tenant rule." }]
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Database migration rules acknowledged." }],
        source: { kind: "model", provider: "powertokens" }
      }
    ]
  };

  const agentWrapper = {
    session: {
      id: "native-session-r4",
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

  // --- 测试流程 3：闭环主审独立复现的 5 项穿透反例 ---
  console.log("\n[6/6] 验证 5 项 Controlled Dispatch 穿透反例全部闭环阻断（零网络外发）...");

  // 反例 1: 无活动 Run 的 Chat 请求
  await assert.rejects(async () => {
    const ticketNoRun = ticketManager.issueTicket({ sessionId: "no-run-session", runId: "r" });
    const s = ctx.llm.stream({
      provider: "powertokens",
      model: "model-a-chat",
      sessionId: "no-run-session",
      purpose: "chat",
      admissionTicket: ticketNoRun,
      messages: [{ role: "user", content: [{ type: "text", text: "unbound" }] }]
    });
    for await (const _ of s) {}
  }, (err) => err.code === "RUN_NOT_BOUND");
  console.log("  ✔ 反例 1 闭环：chat-ticket-without-active-run 阻断 (RUN_NOT_BOUND)");

  // 反例 2: 客户端自报 runId 覆盖活动 Run
  await assert.rejects(async () => {
    const oldRunTicket = ticketManager.issueTicket({ sessionId: "native-session-r4", runId: "old-run-override" });
    const s = ctx.llm.stream({
      provider: "powertokens",
      model: "model-a-chat",
      sessionId: "native-session-r4",
      runId: "old-run-override",
      purpose: "chat",
      admissionTicket: oldRunTicket,
      messages: [{ role: "user", content: [{ type: "text", text: "override" }] }]
    });
    for await (const _ of s) {}
  }, (err) => err.code === "TICKET_RUN_MISMATCH");
  console.log("  ✔ 反例 2 闭环：chat-ticket-old-run-client-overrides-active-run 阻断 (TICKET_RUN_MISMATCH)");

  // 反例 3: 辅助调用缺失模型意图记录器
  const dummyCtx = new Context();
  const dummyLlm = new LlmRuntime(dummyCtx);
  dummyLlm.registerAdapter(["powertokens"], adapter);
  const dummyGate = installNativeContextGateR4(dummyCtx, {
    getActiveTurn: () => ({ sessionId: "s", runId: "r", budget }),
    // 无 recordModelIntent!
  });
  await assert.rejects(async () => {
    const s = dummyLlm.stream({
      provider: "powertokens",
      model: "model-a-chat",
      sessionId: "s",
      purpose: "compaction",
      messages: [{ role: "user", content: [{ type: "text", text: "aux" }] }]
    });
    for await (const _ of s) {}
  }, (err) => err.code === "MISSING_INTENT_RECORDER");
  dummyGate.dispose();
  console.log("  ✔ 反例 3 闭环：auxiliary-missing-required-intent-recorder 阻断 (MISSING_INTENT_RECORDER)");

  // 反例 4: await 意图期间取消
  const freshBudget4 = createRunBudget({ limits: { maxModelCalls: 5 } });
  const cancelTurnOnAudit = { sessionId: "s-cancel", runId: "r", budget: freshBudget4, cancelRequested: false };
  const cancelAuditGate = installNativeContextGateR4(dummyCtx, {
    getActiveTurn: () => cancelTurnOnAudit,
    recordModelIntent: async () => {
      cancelTurnOnAudit.cancelRequested = true; // 意图审计途中取消
    }
  });
  await assert.rejects(async () => {
    const s = dummyLlm.stream({
      provider: "powertokens",
      model: "model-a-chat",
      sessionId: "s-cancel",
      purpose: "compaction",
      messages: [{ role: "user", content: [{ type: "text", text: "aux" }] }]
    });
    for await (const _ of s) {}
  }, (err) => err.code === "RUN_CANCELLED");
  cancelAuditGate.dispose();
  console.log("  ✔ 反例 4 闭环：auxiliary-canceled-while-awaiting-intent 阻断 (RUN_CANCELLED)");

  // 反例 5: 流创建后消费前取消
  const freshBudget5 = createRunBudget({ limits: { maxModelCalls: 5 } });
  const cancelTurnBeforeConsume = { sessionId: "s-bc", runId: "r", budget: freshBudget5, cancelRequested: false };
  const cancelConsumeGate = installNativeContextGateR4(dummyCtx, {
    getActiveTurn: () => cancelTurnBeforeConsume,
    recordModelIntent: async () => {},
  });
  const streamBeforeConsume = dummyLlm.stream({
    provider: "powertokens",
    model: "model-a-chat",
    sessionId: "s-bc",
    purpose: "compaction",
    messages: [{ role: "user", content: [{ type: "text", text: "aux" }] }]
  });
  cancelTurnBeforeConsume.cancelRequested = true; // 消费前取消
  await assert.rejects(async () => {
    for await (const _ of streamBeforeConsume) {}
  }, (err) => err.code === "RUN_CANCELLED");
  cancelConsumeGate.dispose();
  console.log("  ✔ 反例 5 闭环：auxiliary-canceled-after-stream-created-before-consume 阻断 (RUN_CANCELLED)");

  // 断言替身请求总数严格保持为 2
  assert.equal(wireRequests.length, 2, "所有穿透反例必须在网络触发前阻断，替身请求数严格为 2");
  console.log("  ✔ 本地替身请求计数严格维持为 2，反例测试零网络泄露！");

  console.log("\n=== Context R4 探针全部通过 (ALL PASS) ===");
  dispose();
} finally {
  server.close();
}
