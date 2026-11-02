/**
 * 探针：验证在原生锁定 DSH (dsh-llm-pi-ai + pi-ai + cordis) 环境下的推理强度选择与分派。
 * 
 * 约束：
 * 1. 仅监听 localhost，不访问外网，不使用任何真实 Key。
 * 2. 验证原生 PiAiAdapter 的真实 stream 调用链路与最终发送到模拟 HTTP 服务器的真实请求体。
 * 3. 验证同会话模型切换（A -> B）时：
 *    - 切换为无 reasoning 强度的模型时，请求中绝不携带 reasoning_effort。
 *    - 切换为支持 reasoning 的模型并指定 effort 时，请求准确携带 reasoning_effort。
 * 4. 验证当对不支持 reasoning 的模型显式要求 effort 时，原生 PiAiAdapter 触发 UNSUPPORTED_REASONING_EFFORT。
 * 5. 验证 Cordis waterfall 下 prompt 变量与 request 选项的严格一致性。
 */

import http from "node:http";
import assert from "node:assert/strict";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import { installModelSelection } from "../../shell/node_modules/@deepseek-ai/dsh-agent/lib/index.js";
import {
  createModelSelectionRef,
  transitionModelSelection,
  validateAndBuildModelSelection,
} from "../../shell/runtime/dsh-reasoning-selection-candidate.mjs";

const wireRequests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  wireRequests.push({
    url: req.url,
    method: req.method,
    model: parsed.model,
    reasoning_effort: parsed.reasoning_effort,
    thinking: parsed.thinking,
    body: parsed,
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({
    id: "offline-test",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";
  res.write(frame({ role: "assistant", content: "PROBE_OK" }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

try {
  // 1. 构建原生 piProvider
  const piProvider = createProvider({
    id: "powertokens",
    name: "PowerTokens",
    api: openAICompletionsApi(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    auth: {
      apiKey: {
        name: "PowerTokens",
        resolve: () => Promise.resolve({
          auth: { apiKey: "offline-mock-key-not-a-secret" },
          source: "PowerTokens"
        })
      }
    },
    models: [
      {
        id: "model-reasoning",
        name: "Model Reasoning",
        api: "openai-completions",
        provider: "powertokens",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        reasoning: true,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { low: "low", medium: "medium", high: "high" }
      },
      {
        id: "model-standard",
        name: "Model Standard",
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
    resolveApiKey: async () => "offline-mock-key-not-a-secret",
    auth: undefined
  });

  // 2. 建立原生 Cordis 上下文与 ModelSelectionRef
  const ctx = new Context();
  const selectionRef = createModelSelectionRef();
  installModelSelection(ctx, selectionRef);

  const metaReasoning = {
    reasoning: true,
    supportedEfforts: ["low", "medium", "high"],
  };
  const metaStandard = {
    reasoning: false,
    supportedEfforts: [],
  };

  // --- 步骤 1：第一轮选择 model-reasoning，指定 reasoningEffort 为 high ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-reasoning",
    reasoningEffort: "high"
  }, metaReasoning);

  // 模拟 Cordis agent prompt 组装
  const assembledPrompt1 = await ctx.waterfall(
    "system-prompt/assemble",
    { variables: {} },
    {},
    () => Promise.resolve({ variables: {} })
  );
  assert.equal(assembledPrompt1.variables.model, "model-reasoning");

  // 模拟 Cordis agent/request 路由
  const requestConfig1 = await ctx.waterfall(
    "agent/request",
    { turn: 1, step: 1 },
    () => Promise.resolve({ provider: "fallback", model: "fallback" })
  );
  assert.equal(requestConfig1.model, "model-reasoning");
  assert.equal(requestConfig1.reasoningEffort, "high");

  // 通过原生 PiAiAdapter 发起真实请求并校验
  const stream1 = adapter.stream({
    ...requestConfig1,
    messages: [{ role: "user", content: [{ type: "text", text: "round 1: think high" }] }]
  });
  for await (const chunk of stream1) {}

  assert.equal(wireRequests.length, 1);
  assert.equal(wireRequests[0].model, "model-reasoning");
  assert.equal(wireRequests[0].reasoning_effort, "high");

  // --- 步骤 2：同一会话热切换到 model-standard，不指定 reasoningEffort ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-standard"
  }, metaStandard);

  const assembledPrompt2 = await ctx.waterfall(
    "system-prompt/assemble",
    { variables: {} },
    {},
    () => Promise.resolve({ variables: {} })
  );
  assert.equal(assembledPrompt2.variables.model, "model-standard");

  const requestConfig2 = await ctx.waterfall(
    "agent/request",
    { turn: 2, step: 1 },
    () => Promise.resolve({ provider: "fallback", model: "fallback" })
  );
  assert.equal(requestConfig2.model, "model-standard");
  assert.equal(requestConfig2.reasoningEffort, undefined);

  const stream2 = adapter.stream({
    ...requestConfig2,
    messages: [{ role: "user", content: [{ type: "text", text: "round 2: standard" }] }]
  });
  for await (const chunk of stream2) {}

  assert.equal(wireRequests.length, 2);
  assert.equal(wireRequests[1].model, "model-standard");
  assert.equal(wireRequests[1].reasoning_effort, undefined);

  // --- 步骤 3：同一会话热切换回 model-reasoning，改为 low 档 ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-reasoning",
    reasoningEffort: "low"
  }, metaReasoning);

  await ctx.waterfall(
    "system-prompt/assemble",
    { variables: {} },
    {},
    () => Promise.resolve({ variables: {} })
  );

  const requestConfig3 = await ctx.waterfall(
    "agent/request",
    { turn: 3, step: 1 },
    () => Promise.resolve({ provider: "fallback", model: "fallback" })
  );
  assert.equal(requestConfig3.model, "model-reasoning");
  assert.equal(requestConfig3.reasoningEffort, "low");

  const stream3 = adapter.stream({
    ...requestConfig3,
    messages: [{ role: "user", content: [{ type: "text", text: "round 3: think low" }] }]
  });
  for await (const chunk of stream3) {}

  assert.equal(wireRequests.length, 3);
  assert.equal(wireRequests[2].model, "model-reasoning");
  assert.equal(wireRequests[2].reasoning_effort, "low");

  // --- 步骤 4：验证原生适配层防线（反例测试） ---
  // 当用户强行指定不支持的 effort 时，原生 PiAiAdapter 必须拒绝
  let errorCaught = null;
  try {
    const streamIllegal = adapter.stream({
      provider: "powertokens",
      model: "model-standard",
      reasoningEffort: "high", // 试图在不支持的模型上传递 effort
      messages: [{ role: "user", content: [{ type: "text", text: "illegal effort" }] }]
    });
    for await (const chunk of streamIllegal) {}
  } catch (err) {
    errorCaught = err;
  }
  assert.ok(errorCaught, "Expected PiAiAdapter to reject reasoningEffort on standard model");
  assert.equal(errorCaught.code, "UNSUPPORTED_REASONING_EFFORT");
  // 确认非法请求绝未发出到服务器
  assert.equal(wireRequests.length, 3);

  console.log(JSON.stringify({
    probeResult: "PASS",
    description: "Native locked DSH & pi-ai reasoning effort selection probe verified",
    wireRequestsCount: wireRequests.length,
    requestsSummary: wireRequests.map(r => ({
      model: r.model,
      reasoning_effort: r.reasoning_effort,
    })),
    hotSwitchEffortCleared: true,
    unsupportedEffortBlockedByNativeAdapter: true,
  }, null, 2));

} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
