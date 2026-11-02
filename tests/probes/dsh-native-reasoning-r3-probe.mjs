/**
 * 探针 R3：推理选择可移植导入与前置资源边界验证
 *
 * 验证重点：
 * 1. 可移植解析：支持在生成 profile 目录或任意运行时布局加载，动态解析原生 @deepseek-ai/dsh-agent；
 * 2. 前置资源限额（Reject-before-Scan）：
 *    - 稀疏/代理超长数组在 O(1) length 检查时立即拒绝，元素属性访问次数严格为 0；
 *    - 超限对象映射（> 32 键）在截断计数处立即拒绝，杜绝全量 Object.keys / Object.entries 分配；
 * 3. 权威元数据投影：直接从原生 Provider 模型定义提取和规范化，不凭空猜测；
 * 4. 同一热 Agent 会话 A(high) -> B(未指定) -> A(low) 切换，本地 HTTP/SSE 捕获字段完全正确，B 无继承；
 * 5. 失败选择强原子性：元数据或非法入参校验失败时不污染当前 selectionRef，且零泄露网络请求；
 * 6. 纯本地 localhost，零真实 PT 网关外发，零真实密钥。
 */

import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  createModelSelectionRef,
  transitionModelSelection,
  validateAndBuildModelSelection,
  normalizeAuthoritativeReasoningMeta,
  installModelSelection,
  MAX_EFFORTS_COUNT,
} from "../../shell/runtime/dsh-reasoning-selection-r3-candidate.mjs";

console.log("=== Reasoning R3 探针验证开始 ===");

// 1. 验证 Reject-before-Scan 行为
console.log("\n[1/4] 验证前置限额（Reject-before-Scan）与 O(1) 防御...");
{
  let arrayPropertyAccessCount = 0;
  const proxyArray = new Proxy(new Array(MAX_EFFORTS_COUNT + 10), {
    get(target, prop) {
      if (typeof prop === "string" && !isNaN(Number(prop))) {
        arrayPropertyAccessCount++;
      }
      return target[prop];
    }
  });

  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({ supportedEfforts: proxyArray });
  }, (err) => err.code === "REASONING_METADATA_LIMIT_EXCEEDED");
  assert.equal(arrayPropertyAccessCount, 0, "超长数组必须在 length 检查时被拒绝，元素访问必须为 0");

  const oversizedMap = {};
  for (let i = 0; i < MAX_EFFORTS_COUNT + 10; i++) {
    oversizedMap[`k_${i}`] = "wire";
  }
  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({ thinkingLevelMap: oversizedMap });
  }, (err) => err.code === "REASONING_METADATA_LIMIT_EXCEEDED");
  console.log("  ✔ Reject-before-Scan 检查通过：0 元素访问，超限对象快速中断");
}

// 2. 验证生成 profile 目录中的可移植加载能力
console.log("\n[2/4] 验证生成 profile 临时目录可移植加载能力...");
{
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-profile-r3-probe-"));
  const targetCandidatePath = path.join(tempProfileDir, "candidate.mjs");
  const sourceCandidate = fs.readFileSync(
    new URL("../../shell/runtime/dsh-reasoning-selection-r3-candidate.mjs", import.meta.url),
    "utf8"
  );
  fs.writeFileSync(targetCandidatePath, sourceCandidate, "utf8");

  const importedInProfile = await import(`file://${targetCandidatePath}`);
  assert.equal(typeof importedInProfile.installModelSelection, "function");
  const dummyCtx = new Context();
  const dummyRef = importedInProfile.createModelSelectionRef();
  importedInProfile.installModelSelection(dummyCtx, dummyRef);
  console.log("  ✔ 临时生成 profile 目录可移植加载与 installModelSelection 绑定成功");

  fs.rmSync(tempProfileDir, { recursive: true, force: true });
}

// 3. 搭建本地 HTTP/SSE 替身服务，捕获 wireRequests
console.log("\n[3/4] 搭建本地 HTTP/SSE 替身，验证权威投影与原生切换...");
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
    id: "offline-r3-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: parsed.model,
    choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";
  res.write(frame({ role: "assistant", content: "PROBE_R3_OK" }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

try {
  // 构建原生 piProvider
  const rawModels = [
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
  ];

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

  // 严格从 Provider 原生模型定义中投影元数据，非人工伪造
  const modelDefA = rawModels.find(m => m.id === "model-a-reasoning");
  const modelDefB = rawModels.find(m => m.id === "model-b-standard");
  const metaA = normalizeAuthoritativeReasoningMeta(modelDefA);
  const metaB = normalizeAuthoritativeReasoningMeta(modelDefB);

  assert.deepEqual(metaA.supportedEfforts, ["high", "low"]);
  assert.equal(metaA.reasoning, true);
  assert.deepEqual(metaB.supportedEfforts, []);
  assert.equal(metaB.reasoning, false);

  const ctx = new Context();
  const selectionRef = createModelSelectionRef();
  installModelSelection(ctx, selectionRef);

  // --- Step 1: Model A, high ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-a-reasoning",
    reasoningEffort: "high"
  }, metaA);

  await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  const req1 = await ctx.waterfall("agent/request", { turn: 1, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.equal(req1.reasoningEffort, "high");

  const s1 = adapter.stream({
    ...req1,
    messages: [{ role: "user", content: [{ type: "text", text: "step 1" }] }]
  });
  for await (const chunk of s1) {}
  assert.equal(wireRequests.length, 1);
  assert.equal(wireRequests[0].model, "model-a-reasoning");
  assert.equal(wireRequests[0].reasoning_effort, "high");
  console.log("  ✔ Step 1: Model A (high) 请求成功发往本地替身，wire 字段验证无误");

  // --- Step 2: Model B, 未指定 effort ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-b-standard"
  }, metaB);

  await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  const req2 = await ctx.waterfall("agent/request", { turn: 2, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.equal(req2.reasoningEffort, undefined);

  const s2 = adapter.stream({
    ...req2,
    messages: [{ role: "user", content: [{ type: "text", text: "step 2" }] }]
  });
  for await (const chunk of s2) {}
  assert.equal(wireRequests.length, 2);
  assert.equal(wireRequests[1].model, "model-b-standard");
  assert.equal(wireRequests[1].reasoning_effort, undefined, "Model B 绝对不得继承 Model A reasoningEffort");
  console.log("  ✔ Step 2: Model B (未指定) 成功发往替身，wire 字段无继承 (undefined)");

  // --- Step 3: Model A, low ---
  transitionModelSelection(selectionRef, {
    provider: "powertokens",
    model: "model-a-reasoning",
    reasoningEffort: "low"
  }, metaA);

  await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
  const req3 = await ctx.waterfall("agent/request", { turn: 3, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
  assert.equal(req3.reasoningEffort, "low");

  const s3 = adapter.stream({
    ...req3,
    messages: [{ role: "user", content: [{ type: "text", text: "step 3" }] }]
  });
  for await (const chunk of s3) {}
  assert.equal(wireRequests.length, 3);
  assert.equal(wireRequests[2].model, "model-a-reasoning");
  assert.equal(wireRequests[2].reasoning_effort, "low");
  console.log("  ✔ Step 3: Model A (low) 成功发往替身，wire 字段为 low");

  // 4. 验证失败选择强原子性与零网络泄漏
  console.log("\n[4/4] 验证非法/冲突选择的原子性防御与零泄露...");
  const snapshotBefore = { ...selectionRef.current };

  assert.throws(() => {
    // 尝试向不支持 reasoning 的 Model B 指定 effort: "high"
    transitionModelSelection(selectionRef, {
      provider: "powertokens",
      model: "model-b-standard",
      reasoningEffort: "high"
    }, metaB);
  }, (err) => err.code === "UNSUPPORTED_REASONING_EFFORT");

  // 验证 selectionRef 原值未受污染
  assert.deepEqual(selectionRef.current, snapshotBefore, "失败选择不得污染 selectionRef 原值");
  // 验证零额外网络请求泄露
  assert.equal(wireRequests.length, 3, "非法选择在网络触发前已被阻断，无额外 HTTP 请求");
  console.log("  ✔ 失败选择强原子性验证通过：selectionRef 保持原值，本地替身请求计数无新增");

  console.log("\n=== Reasoning R3 探针全部通过 (ALL PASS) ===");
} finally {
  server.close();
}
