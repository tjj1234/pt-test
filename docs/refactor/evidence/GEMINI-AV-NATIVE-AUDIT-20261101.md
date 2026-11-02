# 音视频理解：锁定 DSH 复用与零付费实证审计报告

**审计日期**: 2026-11-01  
**状态**: BLOCKED_ON_NATIVE_DSH_AND_PI_AI (技术调查完成，原生能力存在真实缺口，功能接入阻塞)  
**对应任务包**: `docs/refactor/GEMINI-AV-NATIVE-AUDIT-PACKAGE-20261101.md`  
**测试探针**: `tests/probes/av-native-capability-audit-20261101.mjs` (11/11 PASS)  
**结构化矩阵数据**: `docs/refactor/evidence/GEMINI-AV-NATIVE-AUDIT-20261101.json`

---

## 1. 核心结论与调查摘要

1. **绝对禁止将音视频生成混为音视频理解**：
   - 现存 `shell/persistent-runner.mjs` 中的 `media_route` 工具及 `MEDIA_TASK_TYPES` (`text2image`, `image2image`, `text2video`, `image2video`) 仅属于**业务生成工具**（调用外部异步生成接口返回图片/视频 URL）。
   - 本调查严格聚焦**模型多模态输入理解（Input Understanding）**，即大模型直接接收音频字节流/视频帧并执行推理、转写或描述的能力。
2. **锁定 DSH 与底层 pi-ai 原生层存在绝对能力缺口（REAL GAP）**：
   - `@deepseek-ai/dsh-attachment (0.1.1-rc.2)` 及其实现 `@deepseek-ai/dsh-attachment-local`:
     明确锁定仅支持 4 种静态图片格式（PNG, JPEG, WebP, GIF），`mediaTypes` 数组硬编码；音频或视频输入被 `validateImageBatch` 严格拦截并抛出 `UNSUPPORTED_IMAGE_TYPE` 异常。
   - `@deepseek-ai/dsh-llm (0.1.1-rc.2)`:
     `ContentBlockMap` 联合类型仅定义 `text`, `reasoning`, `image`, `tool-call`, `tool-result`，根本不存在 `AudioBlock` 或 `VideoBlock` 原生类型定义。
   - `@deepseek-ai/dsh-llm-pi-ai (0.1.1-rc.2)`:
     在消息转换器 `userContent()` 中，`switch (block.type)` 仅处理 `text`, `image`, `tool-result`，其它任何类型命中 `default: break;` 被**静默丢弃**。
   - `@earendil-works/pi-ai (0.82.1)`:
     核心类型 `Model<Api>.input` 严格限定为 `("text" | "image")[]`；其 `openai-completions` 序列化器仅支持 `text` 与 `image_url`。
3. **本地 HTTP/SSE 抓包实证（Zero Live Call, Zero Wire Bytes）**：
   - 本地回环探针注入音频与视频 fixture，通过真实加载的 `PiAiAdapter` 执行流式派发。
   - 抓包结果证实：**实际到达底层 Wire 的音频与视频字节严格为 0 字节**，请求载荷中仅保留伴随的纯文本，绝无任何媒体泄漏或未授权传输。
4. **宿主元数据与准入状态机阻断**：
   - `shell/models/capabilities.cjs` 中 `PT_TASK_ADAPTER_ENDPOINTS` 仅定义了 `{ textChat: 'openai-chat-completions' }`，完全未对 `audioUnderstanding` 或 `videoUnderstanding` 配置适配器端点映射。
   - 在 `eligibility()` 计算中，即使上游 PT 元数据标记了 `supported_tasks: ['audio-understanding', 'video-understanding']` 与 `input_modalities: ['audio', 'video']`，其计算结果依然恒为 `endpointCompatible: false` 且 `autoEligible: false`。

---

## 2. 证据矩阵（Evidence Matrix）

| 维度 | 原生可用性 | 宿主接线现状 | 真实缺口与根因 | 确切源码位置 | 依赖包及锁定版本 |
|---|---|---|---|---|---|
| **原生消息块表示** | ❌ 无原生块 | 仅 `nativeImageMessage`，无音频/视频辅助函数 | `ContentBlockMap` 仅支持 `text`, `reasoning`, `image`, `tool-call`, `tool-result` | `dsh-llm/lib/types/types.d.ts:40-60` | `@deepseek-ai/dsh-llm@0.1.1-rc.2` |
| **原生附件准入存储** | ❌ 仅支持静态图片 | 仅配置图片存储，音视频被 `admitEncodedImages` 阻断 | `mediaTypes` 仅包含 PNG/JPEG/WebP/GIF，传入音频/视频抛 `UNSUPPORTED_IMAGE_TYPE` | `dsh-attachment-local/lib/index.js:15-25`, `dsh-attachment/lib/index.js:116` | `@deepseek-ai/dsh-attachment@0.1.1-rc.2` |
| **Adapter Wire 字段** | ❌ 无音视频 wire | 仅透传 `openai-chat-completions` | `pi-ai` 仅支持 `image_url`；`dsh-llm-pi-ai` 的 `userContent` 静默丢弃未知块 | `pi-ai/dist/api/openai-completions.js:819-825`, `dsh-llm-pi-ai/lib/index.js:1074-1100` | `@earendil-works/pi-ai@0.82.1`, `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` |
| **转码/抽帧/转写需求** | ❌ 无内置处理器 | 无 ASR 或 ffmpeg 接线 | 无法直接接收原声音视频流，必须依赖宿主前置转写（ASR）或抽帧（Keyframes）转为图片 | `shell/persistent-runner.mjs:878-883` | 宿主环境缺失 ASR/ffmpeg 依赖 |
| **时间戳与时序定位** | ❌ 无时序定义 | 无 | 消息协议中无任何时间偏移量（timestamp）、起始结束时间或字幕对应锚点 | N/A | 无对应类型设计 |
| **上传与流式限制** | ❌ 仅限图片配额 | 仅图片 4 张 / 10MB 解码限制 | 缺乏针对大体积音视频的流式上传、分块校验或时长超限熔断门禁 | `shell/runtime/native-image-message.mjs:6` | 仅 `MAX_IMAGES=4, MAX_BYTES=10MB` |
| **冷历史重放与源 SHA** | ❌ 无媒体引用持久化 | 无 | 附件层不支持持久化音视频对象，会话事件中无法保存 `AudioAttachmentRef` 或 `VideoAttachmentRef` | `dsh-attachment/README.md:35-37` | 明确标注 audio/video deferred |
| **同 Key 资格要求** | ❌ 无适配通道 | `capabilities.cjs` 判定未适配 | `PT_TASK_ADAPTER_ENDPOINTS` 无映射，`endpointCompatible` 恒为 `false` | `shell/models/capabilities.cjs:12, 105-108` | 本地宿主元数据策略 |

---

## 3. 探针实证详情与执行日志

**执行命令**:
```bash
node tests/probes/av-native-capability-audit-20261101.mjs
```

**执行结果**:
- **退出码**: 0
- **总测试数**: 11
- **通过测试数**: 11
- **失败测试数**: 0

**抓包与实证核心记录**:
1. **DSH 附件层拒绝音频/视频**:
   - 输入: `audio/mp3`, `video/mp4`
   - 结果: 严格抛出 `AttachmentError` (code: `UNSUPPORTED_IMAGE_TYPE`, message: `Image type audio/mp3 is not accepted by this deployment.`)
2. **宿主入口门禁拒绝**:
   - `nativeImageMessage` 针对非图片 MIME 立即抛出 `NATIVE_IMAGE_INPUT_INVALID`。
3. **Adapter Wire 请求捕获 (Loopback HTTP 替身)**:
   - 纯文本请求: Wire 捕获 `{"role":"user","content":"Standard text message"}`。
   - 注入音频块 (Mock MP3 Base64): Wire 捕获 `{"role":"user","content":"Please transcribe this audio"}`。**音频字节严格为 0，Wire Payload 检索不到任何 base64 或 MIME**。
   - 注入视频块 (Mock MP4 Base64): Wire 捕获 `{"role":"user","content":"Please describe this video clip"}`。**视频字节严格为 0，Wire Payload 检索不到任何 base64 或 MIME**。
4. **元数据状态机计算**:
   - 模型: `pt-omni-multimodal-v1` (声明 `audio-understanding` 与 `video-understanding`)。
   - 计算结果: `states.audioUnderstanding.endpointCompatible === false`，`states.audioUnderstanding.autoEligible === false`。

---

## 4. 文件与依赖版本 SHA256 审计清单

| 文件 / 依赖模块 | 声明版本 | SHA256 校验和 | 角色说明 |
|---|---|---|---|
| `shell/runtime/native-image-message.mjs` | - | `4c5bf16a38c8a46af69d8d8786360756b68f05cd1de9c254168b1d4107e43c65` | 宿主图片输入辅助门禁 |
| `shell/models/capabilities.cjs` | - | `773d4bdd06553f95ee5d97abf922287aa97922c1c6f017f07ff0aedcdc2f42e7` | PT 元数据标准化与资格状态机 |
| `shell/models/dsh-configured-catalog.cjs` | - | `e5a0c715d53db46ea215140d6cf82b0caab007a0a5935432b463b6d9f321fe7b` | 模型目录约束过滤器 |
| `shell/persistent-runner.mjs` | - | `855dc3c8a1dfb18ed01ce392dcc231283c9086efdf362fc240fdf8413835a254` | 宿主持久化 Runner |
| `@deepseek-ai/dsh-attachment` | `0.1.1-rc.2` | `ee9c9653937896c36814a107f24a37ea3ed11f8ccdd57afb78c0d729fd8b37ba` | 锁定附件抽象层 |
| `@deepseek-ai/dsh-attachment-local` | `0.1.1-rc.2` | `2d2be7d22cf89895e281489158a2f4c9984497dfcb880ad88b8740e2afec7e76` | 锁定附件本地存储层 |
| `@deepseek-ai/dsh-llm` | `0.1.1-rc.2` | `252de11f9af2a92e2e2eb26dc4e80f7b6313586a96ffce16069435b536952cf6` | 锁定核心 LLM 类型包 |
| `@deepseek-ai/dsh-llm-pi-ai` | `0.1.1-rc.2` | `b50f77d01dbdffbee612f9969903952c131956e5b28d806c7c82a7f715753f89` | 锁定 pi-ai 桥接层 |
| `@earendil-works/pi-ai` | `0.82.1` | `955aa1caab4c875fc7755abe7cacbf9002d9875c471e8d5af245e495ae1d4596` | 锁定基础多提供商底层传输 |

---

## 5. 最小产品接线契约与架构建议

若后续主线需要支持音视频理解，鉴于锁定 DSH 底层库短期内不会支持原生二进制音视频块，必须采用**宿主前置工程管线（Host Preprocessing Seam）**接入：

### 5.1 音频理解（Audio Understanding）推荐契约
1. **音频转写前置（ASR Pipe）**：
   - 用户上传音频（mp3/wav/m4a）不得直接进入 `nativeImageMessage` 或 DSH attachment。
   - 由宿主独立接入语音转写接口（如 Whisper / PT ASR 端点），获取带时间戳的转写文本（VTT / SRT / JSON）。
   - 将结构化文本作为 `text` 块组装至 `userMessage`，或作为系统辅助上下文供 Agent 消费。

### 5.2 视频理解（Video Understanding）推荐契约
1. **关键帧抽帧前置（Keyframe Extraction Pipe）**：
   - 视频文件由宿主服务通过 ffmpeg 提取关键帧（如 1 frame / 2s，最多 4~8 帧）。
   - 将提取出的图片通过已有成熟的 `nativeImageMessage` + `@deepseek-ai/dsh-attachment` 准入为合规的 `ImageAttachmentRef`。
   - 伴随文字注明每帧的时间轴信息（如 `[Frame 1: 00:02]`, `[Frame 2: 00:04]`），在现有能力下实现拟视频理解。

### 5.3 隔离与风控门禁（Non-Negotiable Gates）
- **租户隔离**: 预处理产生的临时音频/图片文件必须遵循会话隔离目录，会话结束时强制清理。
- **流控与配额**: 音频文件限制最大时长（如 120 秒）及最大体积（如 25MB）；视频抽帧严格受限不超过 DSH 静态图片配额（当前上限 4 张）。
- **取消信号关联**: 预处理任务必须传递并监听 `AbortSignal`，Parent Run 取消或超时必须立即中断转写与抽帧进程。

---

## 6. 准确阻塞项（Accurate Blockers）与下一步规划

> [!IMPORTANT]
> **本调查已彻底闭环技术实证，不可写成“功能已交付/已通过”。当前确切阻塞如下：**

1. **底层阻断**: `@deepseek-ai/dsh-attachment` 明确在 README 与源码中将 generic files, audio, video 列为 `deferred`，当前版本无法直接复用原生通道。
2. **适配器阻断**: `@earendil-works/pi-ai` 仅具备 `("text" | "image")[]` 输入能力，无音视频协议字段生成。
3. **下一步执行建议**:
   - 维持当前主线对音视频理解任务的 `endpointCompatible: false` 保护，防止非法请求穿透导致运行时崩溃。
   - 若业务强需求音视频理解，需立项专项“宿主前置音视频预处理流水线”，切勿试图直接修改锁定的 `@deepseek-ai` 依赖包。
