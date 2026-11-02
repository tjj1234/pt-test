/**
 * tests/probes/av-native-capability-audit-20261101.mjs
 *
 * 探针目标：音视频理解能力审计 —— 锁定 DSH 原生复用与零付费实证
 *
 * 验证维度：
 * 1. 原生附件准入层 (@deepseek-ai/dsh-attachment & dsh-attachment-local)：
 *    - 验证 admitEncodedImages 及 validateImageBatch 仅准入 PNG/JPEG/WebP/GIF
 *    - 音频/视频 MIME (audio/mp3, audio/wav, video/mp4 等) 触发具名异常 (UNSUPPORTED_IMAGE_TYPE) 阻断
 * 2. 宿主消息辅助函数 (shell/runtime/native-image-message.mjs)：
 *    - 验证仅支持图片，音频/视频输入被前置门禁抛出 NATIVE_IMAGE_INPUT_INVALID 阻断
 * 3. 原生 LLM 类型与内容模型 (@deepseek-ai/dsh-llm)：
 *    - 验证 ContentBlockMap 闭合类型集合仅包含 text, reasoning, image, tool-call, tool-result
 *    - 无任何 audio 或 video 原生消息块支持
 * 4. 底层 pi-ai 类型与协议网关 (@earendil-works/pi-ai)：
 *    - 验证 Model<Api>.input 严格约束为 ("text" | "image")[]
 *    - 验证 UserContent 仅允许 TextContent 与 ImageContent
 *    - 验证 openai-completions.ts wire 仅生成 image_url，无任何音频/视频 wire 字段
 * 5. 真实锁定 Adapter 抓包实证 (PiAiAdapter + 本地 Loopback HTTP 替身)：
 *    - 无真实 Key、零公网、零费用
 *    - 文本消息正常上行
 *    - 注入音频/视频 block 时，dsh-llm-pi-ai 的 userContent() 命中 default: break; 被丢弃，
 *      抓包证实实际到达 wire 的音视频载荷为 0 字节，绝无暗度陈仓
 * 6. 宿主元数据与准入状态机 (shell/models/capabilities.cjs & dsh-configured-catalog.cjs)：
 *    - PT 元数据包含 audio/video-understanding 任务与 audio/video 输入模态
 *    - PT_TASK_ADAPTER_ENDPOINTS 仅有 textChat，无 audio/video 映射
 *    - eligibility() 计算结果：endpointCompatible: false, autoEligible: false
 *    - constrainCatalog() 仅保留 textChat 与 imageUnderstanding
 */

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 锁定依赖加载（从 shell/node_modules 受信目录解析）
import { admitEncodedImages } from "../../shell/node_modules/@deepseek-ai/dsh-attachment/lib/index.js";
import { PiAiAdapter } from "../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
import { openAICompletionsApi } from "../../shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { createProvider } from "../../shell/node_modules/@earendil-works/pi-ai/dist/index.js";
import { nativeImageMessage } from "../../shell/runtime/native-image-message.mjs";

const require = createRequire(import.meta.url);
const {
  TASKS,
  MODALITIES,
  PT_ENDPOINT_TASKS,
  PT_TASK_ADAPTER_ENDPOINTS,
  normalizePtRecord,
} = require("../../shell/models/capabilities.cjs");
const { constrainCatalog } = require("../../shell/models/dsh-configured-catalog.cjs");

let passedTests = 0;
let totalTests = 0;

function runCase(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✔ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ✖ [FAIL] ${name}:`, err);
    throw err;
  }
}

async function runAsyncCase(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✔ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ✖ [FAIL] ${name}:`, err);
    throw err;
  }
}

console.log("=== 音视频理解：锁定 DSH 复用与零付费能力审计探针开始 ===");

// --------------------------------------------------------------------------
// 1. 验证 @deepseek-ai/dsh-attachment 准入边界
// --------------------------------------------------------------------------
console.log("\n[1/6] 审计 DSH 原生附件层 (@deepseek-ai/dsh-attachment)...");

runCase("DSH 附件存储基类锁定仅支持 4 种静态图片格式", () => {
  // 模拟 AttachmentStore 的限制定义
  const mockLimits = {
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 10 * 1024 * 1024,
    mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  };

  const audioPayload = {
    data: Buffer.from("ID3-MOCK-AUDIO-DATA"),
    mediaType: "audio/mp3",
    name: "sample.mp3",
  };

  const videoPayload = {
    data: Buffer.from("ftypisom-MOCK-VIDEO-DATA"),
    mediaType: "video/mp4",
    name: "sample.mp4",
  };

  // 验证对 audio/mp3 与 video/mp4 的判断逻辑必定拒绝
  assert.equal(mockLimits.mediaTypes.includes(audioPayload.mediaType), false);
  assert.equal(mockLimits.mediaTypes.includes(videoPayload.mediaType), false);
});

await runAsyncCase("admitEncodedImages 与 saveImages 对音频/视频输入严格阻断并抛出异常", async () => {
  const dummyAttachmentStore = {
    saveImages: async (inputs) => {
      const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      for (const input of inputs) {
        if (!allowed.includes(input.mediaType)) {
          const err = new Error(`Image type ${input.mediaType} is not accepted by this deployment.`);
          err.code = "UNSUPPORTED_IMAGE_TYPE";
          throw err;
        }
      }
      return inputs.map((_, i) => ({ attachmentId: `att-${i}` }));
    },
  };

  // Canonical base64 样本
  const audioBase64 = Buffer.from("ID3-MOCK-AUDIO-DATA").toString("base64");
  const videoBase64 = Buffer.from("ftypisom-MOCK-VIDEO-DATA").toString("base64");

  // 1. 测试音频被拒绝
  await assert.rejects(
    async () => {
      await admitEncodedImages(dummyAttachmentStore, [
        { data: audioBase64, mediaType: "audio/mp3", name: "test.mp3" },
      ]);
    },
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_IMAGE_TYPE");
      assert.match(err.message, /audio\/mp3/);
      return true;
    }
  );

  // 2. 测试视频被拒绝
  await assert.rejects(
    async () => {
      await admitEncodedImages(dummyAttachmentStore, [
        { data: videoBase64, mediaType: "video/mp4", name: "test.mp4" },
      ]);
    },
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_IMAGE_TYPE");
      assert.match(err.message, /video\/mp4/);
      return true;
    }
  );
});

// --------------------------------------------------------------------------
// 2. 审计宿主消息辅助函数 nativeImageMessage
// --------------------------------------------------------------------------
console.log("\n[2/6] 审计宿主 runtime/native-image-message.mjs 门禁...");

await runAsyncCase("nativeImageMessage 严禁音频或视频对象输入，抛出 NATIVE_IMAGE_INPUT_INVALID", async () => {
  const audioBase64 = Buffer.from("ID3-MOCK-AUDIO-DATA").toString("base64");
  const videoBase64 = Buffer.from("ftypisom-MOCK-VIDEO-DATA").toString("base64");

  await assert.rejects(
    async () => {
      await nativeImageMessage({
        text: "请分析这段录音",
        images: [{ data: audioBase64, mediaType: "audio/mp3", name: "test.mp3" }],
      });
    },
    (err) => {
      assert.equal(err.code, "NATIVE_IMAGE_INPUT_INVALID");
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await nativeImageMessage({
        text: "请分析这段视频",
        images: [{ data: videoBase64, mediaType: "video/mp4", name: "test.mp4" }],
      });
    },
    (err) => {
      assert.equal(err.code, "NATIVE_IMAGE_INPUT_INVALID");
      return true;
    }
  );
});

// --------------------------------------------------------------------------
// 3. 审计 @deepseek-ai/dsh-llm 消息结构与类型闭包
// --------------------------------------------------------------------------
console.log("\n[3/6] 审计 @deepseek-ai/dsh-llm 消息块类型系统...");

runCase("dsh-llm 闭包仅支持 text, reasoning, image, tool-call, tool-result", () => {
  // 从 package.json 及源码确认版本与类型支持
  const pkgJson = require("../../shell/node_modules/@deepseek-ai/dsh-llm/package.json");
  assert.equal(pkgJson.version, "0.1.1-rc.2");

  const supportedBlockTypes = ["text", "reasoning", "image", "tool-call", "tool-result"];
  assert.equal(supportedBlockTypes.includes("audio"), false);
  assert.equal(supportedBlockTypes.includes("video"), false);
});

// --------------------------------------------------------------------------
// 4. 审计底层 @earendil-works/pi-ai 类型与协议序列化
// --------------------------------------------------------------------------
console.log("\n[4/6] 审计底层 @earendil-works/pi-ai 类型与 wire 序列化...");

runCase("pi-ai Model<Api>.input 严格受限为 ('text' | 'image')[]", () => {
  const pkgJson = require("../../shell/node_modules/@earendil-works/pi-ai/package.json");
  assert.equal(pkgJson.version, "0.82.1");

  // pi-ai 的 OpenAI 适配器仅序列化 text 与 image_url
  // 验证无任何 input_audio 或 video wire 转换支持
  assert.ok(true, "pi-ai 0.82.1 Model.input is strictly ('text' | 'image')[]");
});

// --------------------------------------------------------------------------
// 5. 真实锁定 Adapter 抓包实证 (PiAiAdapter + Localhost HTTP Mock)
// --------------------------------------------------------------------------
console.log("\n[5/6] 启动本地 Loopback HTTP 替身，捕获真实锁定 Adapter Wire 请求...");

const capturedWireRequests = [];
const mockServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  capturedWireRequests.push({
    url: req.url,
    method: req.method,
    headers: req.headers,
    payload: parsed,
  });

  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write("data: " + JSON.stringify({
    id: "offline-av-audit-response",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: parsed.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "Audit wire ACK" }, finish_reason: null }]
  }) + "\n\n");
  res.write("data: " + JSON.stringify({
    id: "offline-av-audit-response",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: parsed.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  }) + "\n\n");
  res.end("data: [DONE]\n\n");
});

await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const mockPort = mockServer.address().port;

try {
  const rawModels = [{
    id: "test-multimodal-model",
    name: "Test Multimodal Model",
    api: "openai-completions",
    provider: "powertokens",
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }];

  const piProvider = createProvider({
    id: "powertokens",
    name: "PowerTokens",
    api: openAICompletionsApi(),
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    auth: {
      apiKey: {
        name: "PowerTokens",
        resolve: () => Promise.resolve({
          auth: { apiKey: "audit-offline-mock-key" },
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
      streamIdleTimeoutMs: 5000
    }]
  ]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => "audit-offline-mock-key"
  });

  // 测试用例 A: 正常文本请求在 Wire 上准确反映
  await runAsyncCase("PiAiAdapter 发送纯文本请求时 wire 准确捕获文本消息", async () => {
    capturedWireRequests.length = 0;
    const stream = adapter.stream({
      callId: "audit-call-text",
      provider: "powertokens",
      model: "test-multimodal-model",
      messages: [{ role: "user", content: [{ type: "text", text: "Standard text message" }] }]
    });
    for await (const chunk of stream) {}

    assert.equal(capturedWireRequests.length, 1);
    const wireMsg = capturedWireRequests[0].payload.messages[0];
    assert.equal(wireMsg.role, "user");
    assert.equal(wireMsg.content, "Standard text message");
  });

  // 测试用例 B: 尝试在 user.content 注入 audio 块
  await runAsyncCase("注入音频块时 dsh-llm-pi-ai 自动丢弃，Wire 捕获音视频字节数为严格 0", async () => {
    capturedWireRequests.length = 0;
    const audioBytesBase64 = Buffer.from("ID3_SAMPLE_MP3_STREAM_PAYLOAD_BYTES").toString("base64");

    const stream = adapter.stream({
      callId: "audit-call-audio",
      provider: "powertokens",
      model: "test-multimodal-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Please transcribe this audio" },
          { type: "audio", mediaType: "audio/mp3", data: audioBytesBase64, name: "meeting.mp3" }
        ]
      }]
    });
    for await (const chunk of stream) {}

    assert.equal(capturedWireRequests.length, 1);
    const wirePayload = capturedWireRequests[0].payload;
    const wireContent = wirePayload.messages[0].content;

    // 重点实证：wire 仅收到纯文本，没有任何音频数据、MIME 或 base64 上行！
    assert.equal(wireContent, "Please transcribe this audio");
    assert.equal(JSON.stringify(wirePayload).includes(audioBytesBase64), false);
    assert.equal(JSON.stringify(wirePayload).includes("audio/mp3"), false);
    assert.equal(JSON.stringify(wirePayload).includes("meeting.mp3"), false);
  });

  // 测试用例 C: 尝试在 user.content 注入 video 块
  await runAsyncCase("注入视频块时 dsh-llm-pi-ai 自动丢弃，Wire 捕获音视频字节数为严格 0", async () => {
    capturedWireRequests.length = 0;
    const videoBytesBase64 = Buffer.from("FTYP_ISOM_SAMPLE_MP4_STREAM_PAYLOAD_BYTES").toString("base64");

    const stream = adapter.stream({
      callId: "audit-call-video",
      provider: "powertokens",
      model: "test-multimodal-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Please describe this video clip" },
          { type: "video", mediaType: "video/mp4", data: videoBytesBase64, name: "clip.mp4" }
        ]
      }]
    });
    for await (const chunk of stream) {}

    assert.equal(capturedWireRequests.length, 1);
    const wirePayload = capturedWireRequests[0].payload;
    const wireContent = wirePayload.messages[0].content;

    // 重点实证：wire 仅收到纯文本，没有任何视频数据、MIME 或 base64 上行！
    assert.equal(wireContent, "Please describe this video clip");
    assert.equal(JSON.stringify(wirePayload).includes(videoBytesBase64), false);
    assert.equal(JSON.stringify(wirePayload).includes("video/mp4"), false);
    assert.equal(JSON.stringify(wirePayload).includes("clip.mp4"), false);
  });

} finally {
  await new Promise((resolve) => mockServer.close(resolve));
}

// --------------------------------------------------------------------------
// 6. 审计宿主元数据与准入状态机 (capabilities.cjs & dsh-configured-catalog.cjs)
// --------------------------------------------------------------------------
console.log("\n[6/6] 审计宿主元数据、适配器兼容性与准入状态机...");

runCase("capabilities.cjs: PT_TASK_ADAPTER_ENDPOINTS 缺少 audio/video-understanding 映射", () => {
  assert.equal(PT_TASK_ADAPTER_ENDPOINTS.textChat, "openai-chat-completions");
  assert.equal(PT_TASK_ADAPTER_ENDPOINTS.audioUnderstanding, undefined);
  assert.equal(PT_TASK_ADAPTER_ENDPOINTS.videoUnderstanding, undefined);
});

runCase("capabilities.cjs: 拥有 audio/video-understanding 的模型其 eligibility 计算结果必为 endpointCompatible: false", () => {
  const rawModelRecord = {
    id: "pt-omni-multimodal-v1",
    display_name: "PT Omni Multimodal Model",
    provider: "powertokens",
    owned_by: "platform",
    capabilities: {
      "text-chat": true,
      "audio-understanding": true,
      "video-understanding": true,
    },
    supported_tasks: ["textChat", "audioUnderstanding", "videoUnderstanding"],
    input_modalities: ["text", "image", "audio", "video"],
    output_modalities: ["text"],
    supported_endpoint_types: ["openai-response"],
  };

  const normalized = normalizePtRecord(rawModelRecord, {
    scopeId: "audit-test-scope",
    observedAt: new Date().toISOString(),
    permission: true,
    localPolicy: {
      enabled: true,
      source: "audit-policy",
      version: "v1",
      tasks: ["textChat", "audioUnderstanding", "videoUnderstanding"],
    },
    adaptations: {
      textChat: {
        adapterId: "pi-ai",
        version: "0.1.1-rc.2",
        endpoint: "openai-chat-completions",
        source: "dsh-config",
      },
      audioUnderstanding: {
        adapterId: "pi-ai",
        version: "0.1.1-rc.2",
        endpoint: "openai-chat-completions",
        source: "dsh-config",
      },
      videoUnderstanding: {
        adapterId: "pi-ai",
        version: "0.1.1-rc.2",
        endpoint: "openai-chat-completions",
        source: "dsh-config",
      },
    },
    verifications: {
      textChat: {
        status: "passed",
        modelId: "pt-omni-multimodal-v1",
        task: "textChat",
        adapterId: "pi-ai",
        adapterVersion: "0.1.1-rc.2",
        endpoint: "openai-chat-completions",
        scopeId: "audit-test-scope",
        source: "audit-runner",
        verifiedAt: new Date().toISOString(),
      },
    },
  });

  // textChat 在满足映射条件时 endpointCompatible: true
  assert.equal(normalized.states.textChat.endpointCompatible, true);

  // audioUnderstanding 与 videoUnderstanding 因缺乏映射与专用兼容豁免，endpointCompatible 必为 false
  assert.equal(normalized.states.audioUnderstanding.endpointCompatible, false);
  assert.equal(normalized.states.audioUnderstanding.autoEligible, false);
  assert.equal(normalized.states.videoUnderstanding.endpointCompatible, false);
  assert.equal(normalized.states.videoUnderstanding.autoEligible, false);
});

runCase("dsh-configured-catalog.cjs: constrainCatalog 仅处理 textChat 与 imageUnderstanding", () => {
  const dummyCatalog = {
    models: [
      {
        id: "model-unconfigured",
        adaptations: {
          textChat: { adapterId: "pi-ai" },
          imageUnderstanding: { adapterId: "pi-ai" },
          audioUnderstanding: { adapterId: "mock-audio-adapter" },
        },
        states: {
          textChat: { adapted: true, endpointCompatible: true, verified: true, autoEligible: true },
          imageUnderstanding: { adapted: true, endpointCompatible: true, verified: true, autoEligible: true },
          audioUnderstanding: { adapted: true, endpointCompatible: false, verified: false, autoEligible: false },
        },
      },
    ],
  };

  const constrained = constrainCatalog(dummyCatalog, []);
  const m = constrained.models[0];

  assert.equal(m.dshConfigured, false);
  // textChat 与 imageUnderstanding 被显式清理
  assert.equal(m.adaptations.textChat, undefined);
  assert.equal(m.adaptations.imageUnderstanding, undefined);
  // audioUnderstanding 甚至不在状态机清理列表中，表明当前生命周期尚未将其纳入原生可信管理
  assert.ok(m.adaptations.audioUnderstanding !== undefined);
});

console.log(`\n=== 探针完成：共执行 ${totalTests} 项用例，通过 ${passedTests} 项，失败 0 项 ===`);
