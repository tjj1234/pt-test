/**
 * 探针 R2：基于真实锁定 DSH SDK 与本地 HTTP/SSE 替身验证
 * 
 * 验证重点：
 * 1. 同一热会话执行完整的 A(high) -> B(未指定) -> A(low) 切换序列；
 * 2. 真实网络 I/O 监听验证：
 *    - Model A 第一次请求：携带 `reasoning_effort: "high"`；
 *    - Model B 请求：无 `reasoning_effort` 字段（证明 B 绝无继承）；
 *    - Model A 第二次请求：携带 `reasoning_effort: "low"`；
 * 3. 严格元数据防线验证：
 *    - 仅声明 `reasoning: true` 的模型（无具体支持列表）：选择文本通过，但尝试传递显式 effort 立即在网络前被拒绝；
 *    - 发生非法尝试时，本地服务器接收请求计数严格不增加；
 *    - 失败的选择不改变当前 selectionRef（原子性验证）；
 * 4. 纯本地 localhost 运行，零真实 Key，零真实 PT 网关外发。
 */

import http from "node:http";
import assert from "node:assert/strict";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  createModelSelectionRef,
  transitionModelSelection,
  validateAndBuildModelSelection,
  installModelSelection,
} from "../../shell/runtime/dsh-reasoning-selection-r2-candidate.mjs";

const wireRequests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  wireRequests.push({
    model: parsed.model,
    reasoning_effort: parsed.reasoning_effort,
    thinking: parsed.thinking,
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({
    id: "offline-r2-test",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";
  res.write(frame({ role: "assistant", content: "PROBE_R2_OK" }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

try {
  // 构建原生 pi-ai provider 包含两个模型
  const piProvider = createProvider({
    id: "powertokens",
    name: "PowerTokens",
    api: openAICompletionsApi(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    auth: {
      apiKey: {
        name: "PowerTokens",
        resolve: () => Promise.resolve({
          auth: { apiKey: "offline-r2-mock-key" },
          source: "PowerTokens"
        })
      }
    },
    models: [
      {
        id: "model-a-reasoning",
        name: "Model A Reasoning",
        api: "openai-completions",
        provider: "powertokens",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        reasoning: true,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { low: "low", high: "high" }
      },
      {
        id: "model-b-standard",
        name: "Model B Standard",
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
    resolveApiKey: async () => "offline-r2-mock-key",
    auth: undefined
  });

  // 权威元数据声明
  const metaA = {
    reasoning: true,
    supportedEfforts: ["low", "high"],
  };
  const metaB = {
    reasoning: false,
    supportedEfforts: [],
  };

  const ctx = new Context();
  const selectionRef = createModelSelectionRef();
  // 必须直接使用原生 installModelSelection
  installModelSelection(ctx, selectionRef);

  // --- 步骤 1：第一轮 Model A，指定 high ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-a-reasoning",
    reasoningEffort: "high"
  }, metaA);

  await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  const reqConfig1 = await ctx.waterfall("agent/request", { turn: 1, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.equal(reqConfig1.reasoningEffort, "high");

  const s1 = adapter.stream({
    ...reqConfig1,
    messages: [{ role: "user", content: [{ type: "text", text: "step 1" }] }]
  });
  for await (const chunk of s1) {}

  assert.equal(wireRequests.length, 1);
  assert.equal(wireRequests[0].model, "model-a-reasoning");
  assert.equal(wireRequests[0].reasoning_effort, "high");

  // --- 步骤 2：同一热会话切换为 Model B (未指定 effort) ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-b-standard"
  }, metaB);

  await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  const reqConfig2 = await ctx.waterfall("agent/request", { turn: 2, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.equal(reqConfig2.reasoningEffort, undefined);

  const s2 = adapter.stream({
    ...reqConfig2,
    messages: [{ role: "user", content: [{ type: "text", text: "step 2" }] }]
  });
  for await (const chunk of s2) {}

  assert.equal(wireRequests.length, 2);
  assert.equal(wireRequests[1].model, "model-b-standard");
  assert.equal(wireRequests[1].reasoning_effort, undefined, "Model B must NOT inherit Model A reasoning effort");

  // --- 步骤 3：同一热会话切换回 Model A，指定 low ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-a-reasoning",
    reasoningEffort: "low"
  }, metaA);

  await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  const reqConfig3 = await ctx.waterfall("agent/request", { turn: 3, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.equal(reqConfig3.reasoningEffort, "low");

  const s3 = adapter.stream({
    ...reqConfig3,
    messages: [{ role: "user", content: [{ type: "text", text: "step 3" }] }]
  });
  for await (const chunk of s3) {}

  assert.equal(wireRequests.length, 3);
  assert.equal(wireRequests[2].model, "model-a-reasoning");
  assert.equal(wireRequests[2].reasoning_effort, "low");

  // --- 步骤 4：验证 R2 严格元数据防线：仅有 reasoning: true 但未提供具体列表的模型 ---
  // 4.1 允许作为普通文本模型选择
  const validTextSelection = validateAndBuildModelSelection({
    provider: "powertokens",
    model: "model-boolean-only",
  }, { reasoning: true });
  assert.equal(validTextSelection.model, "model-boolean-only");
  assert.equal("reasoningEffort" in validTextSelection, false);

  // 4.2 显式要求 effort 必须立即在网络前被拒绝
  let errorCaught = null;
  try {
    transitionModelSelection(selectionRef, {
      provider: "powertokens",
      model: "model-boolean-only",
      reasoningEffort: "high",
    }, { reasoning: true }); // 仅有布尔值，无具体支持列表
  } catch (err) {
    errorCaught = err;
  }
  assert.ok(errorCaught);
  assert.equal(errorCaught.code, "UNSUPPORTED_REASONING_EFFORT");

  // 4.3 验证失败选择不改变当前 ref (原子性)
  assert.equal(selectionRef.current.model, "model-a-reasoning");
  assert.equal(selectionRef.current.reasoningEffort, "low");

  // 4.4 验证网络请求严格保持为 3（零外发）
  assert.equal(wireRequests.length, 3);

  console.log(JSON.stringify({
    probeResult: "PASS",
    description: "Reasoning R2 Probe: Verified A(high)->B(none)->A(low) and strict non-speculative metadata defense",
    wireRequestsCount: wireRequests.length,
    requestsSummary: wireRequests.map(r => ({
      model: r.model,
      reasoning_effort: r.reasoning_effort,
    })),
    bDidNotInheritEffort: true,
    atomicTransitionOnFailure: true,
    noSpeculativeEffortsAllowed: true,
  }, null, 2));

} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
