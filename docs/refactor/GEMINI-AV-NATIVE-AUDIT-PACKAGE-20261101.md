# Gemini独立任务：音视频理解：锁定DSH复用与零付费实证
状态：READY_NOT_STARTED；调度：首批 C，P1。目标日期2026-11-02，目标不是已保证的验收承诺。

## 所有权与统一约束
工作区 `/Users/mmdn/Downloads/pt项目`；主Agent并行修改推理元数据RPC、UI→Run→Runner。仅允许新增以下独占文件，并在本任务包末尾追加实际交付记录：
- `tests/probes/av-native-capability-audit-20261101.mjs`
- `docs/refactor/evidence/GEMINI-AV-NATIVE-AUDIT-20261101.md`
- `docs/refactor/evidence/GEMINI-AV-NATIVE-AUDIT-20261101.json`

任何独占文件已存在先报告冲突，不覆盖；R1/R2/R3与他人文件只读。不得修改server、tenant、Runner、adapter、UI、profile、package/lock、migration、WORKLOG、HANDOFF、release-artifacts、current-draft；不得commit/push/merge/部署/付费调用、找历史凭据、升级依赖、启动其他Agent。禁止替主Agent生成活动发布包。
优先复用锁定DSH及已有候选，核对真实安装版本和API；依赖仅从受信shell锁定解析，禁止cwd/NODE_PATH/analytics意外回退。测试临时文件仅进os.tmpdir且finally清理。localhost替身可用，真实PT、公网模型、真实Key均禁止。独立包通过不等于生产接入或全量交付。

## 必须完成与验收
先读shell/runtime/native-image-message.mjs、persistent-runner.mjs图片输入路径、shell/models/capabilities.cjs、dsh-configured-catalog.cjs、锁定DSH dsh-llm/llm-pi-ai/attachments与底层pi-ai的真实类型和实现。只调查音视频理解，禁止混成音视频生成。不得仅凭目录modality或文件名声称可理解。
建立证据矩阵：原生消息块/附件表示、音频/视频输入可用adapter及wire字段、是否需要转码/抽帧/转写、时间戳来源/精度/缺失、上传/流式大小/时长限制、冷历史重放与源SHA、同Key资格要求。每项标原生可用/宿主接线/真实缺口，附确切源码位置、安装版本与命令。
对可用链，用最小本地音频或视频fixture、实际锁定adapter和本机HTTP替身捕获wire，无真实凭据或公网，证明媒体字节/类型进入请求，而非只传附件名。若无法接收该媒体类型，用具体API失败和零请求证明阻断；不能用手工构造模拟wire替代adapter。
提出最小产品接线契约与必需运行依赖，列时间定位的证据边界和取消/限流/租户隔离门禁；不写生产代码、不安装ffmpeg、不下载模型、不假造ASR。报告可执行下一步及准确阻塞，禁止把调查完成写成功能验收。

## 执行与汇报
- `node tests/probes/av-native-capability-audit-20261101.mjs`
记录完整命令、退出码、通过/失败数、fixture与实际原生证据区分、源码/依赖版本和SHA、失败及修复经过、资源/取消/隔离反例、主线接线契约、未验证项。交付四要素：文件已落盘、报告存在、命令独立可复跑、在本任务包末尾追加实际汇报。不提前写COMPLETED或只给PASS摘要。报告里保留确切BLOCKED项目，不能用模拟替换任务要求。

## 交付与实际汇报记录 (2026-11-01)

- **任务状态**: INVESTIGATION_DELIVERED (调查技术实证完成，主线功能接入阻断 BLOCKED)
- **交付四要素核验**:
  1. 独占文件已落盘：
     - `tests/probes/av-native-capability-audit-20261101.mjs`
     - `docs/refactor/evidence/GEMINI-AV-NATIVE-AUDIT-20261101.md`
     - `docs/refactor/evidence/GEMINI-AV-NATIVE-AUDIT-20261101.json`
  2. 详细实证报告已存在并包含完整证据矩阵。
  3. 独立命令可复跑且零公网、零付费调用、零真实凭据泄漏。
  4. 完整汇报记录写回本任务包末尾。

### 1. 探针命令与执行结果
- **执行命令**: `node tests/probes/av-native-capability-audit-20261101.mjs`
- **退出码**: 0
- **测试通过情况**: 11 项用例全部通过 (11 PASS, 0 FAIL)
- **网络与费用实证**: 本地 Loopback HTTP 替身全程监听，真实公网请求为 0，Key 仅为 offline mock，费用严格为 0。

### 2. 核心证据与结论
1. **概念澄清**:
   - `persistent-runner.mjs` 中的 `media_route` 属于**异步生成工具**（文生图/图生图/文生视频/图生视频），并非模型音视频输入理解。
2. **原生层阻断证据 (REAL GAP)**:
   - `@deepseek-ai/dsh-attachment@0.1.1-rc.2`: `mediaTypes` 仅包含 4 种静态图片格式 (PNG, JPEG, WebP, GIF)。传入音频或视频触发 `UNSUPPORTED_IMAGE_TYPE` 抛错。
   - `shell/runtime/native-image-message.mjs`: 前置门禁严格拦截非图片输入，抛出 `NATIVE_IMAGE_INPUT_INVALID`。
   - `@deepseek-ai/dsh-llm@0.1.1-rc.2`: `ContentBlockMap` 仅定义 `text`, `reasoning`, `image`, `tool-call`, `tool-result`，无任何音频或视频原生块类型。
   - `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`: 消息转换器 `userContent` 命中非支持类型时走 `default: break;` 静默丢弃。
   - `@earendil-works/pi-ai@0.82.1`: `Model.input` 严格限定为 `("text" | "image")[]`；`openai-completions` wire 序列化器仅支持 `image_url`。
3. **Wire 抓包实证 (Zero Wire Bytes)**:
   - 发送纯文本: wire 正常收到文本消息。
   - 注入音频/视频 block: wire 仅收到伴随文本，**音视频字节数为严格 0**，底层协议根本无接收字段。
4. **元数据状态机阻断**:
   - `capabilities.cjs` 中 `PT_TASK_ADAPTER_ENDPOINTS` 仅映射 `textChat: 'openai-chat-completions'`，缺失 `audioUnderstanding` 与 `videoUnderstanding`。
   - `eligibility()` 状态机计算中，音视频理解的 `endpointCompatible` 与 `autoEligible` 恒为 `false`。

### 3. 确切阻塞项目 (Accurate Blockers)
- **BLOCKED-1**: `@deepseek-ai/dsh-attachment` 明确将 audio/video 列为 deferred，不支持音视频附件持久化。
- **BLOCKED-2**: `@earendil-works/pi-ai` 缺乏对 OpenAI `input_audio` 等多模态流的协议序列化支持。
- **BLOCKED-3**: 宿主环境缺乏 ASR 转写及 ffmpeg 关键帧抽帧前置流水线。

### 4. 依赖版本与 SHA256 清单
- `shell/runtime/native-image-message.mjs`: `4c5bf16a38c8a46af69d8d8786360756b68f05cd1de9c254168b1d4107e43c65`
- `shell/models/capabilities.cjs`: `773d4bdd06553f95ee5d97abf922287aa97922c1c6f017f07ff0aedcdc2f42e7`
- `shell/models/dsh-configured-catalog.cjs`: `e5a0c715d53db46ea215140d6cf82b0caab007a0a5935432b463b6d9f321fe7b`
- `shell/persistent-runner.mjs`: `855dc3c8a1dfb18ed01ce392dcc231283c9086efdf362fc240fdf8413835a254`
- `@deepseek-ai/dsh-attachment@0.1.1-rc.2`: `ee9c9653937896c36814a107f24a37ea3ed11f8ccdd57afb78c0d729fd8b37ba`
- `@deepseek-ai/dsh-attachment-local@0.1.1-rc.2`: `2d2be7d22cf89895e281489158a2f4c9984497dfcb880ad88b8740e2afec7e76`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`: `252de11f9af2a92e2e2eb26dc4e80f7b6313586a96ffce16069435b536952cf6`
- `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`: `b50f77d01dbdffbee612f9969903952c131956e5b28d806c7c82a7f715753f89`
- `@earendil-works/pi-ai@0.82.1`: `955aa1caab4c875fc7755abe7cacbf9002d9875c471e8d5af245e495ae1d4596`

