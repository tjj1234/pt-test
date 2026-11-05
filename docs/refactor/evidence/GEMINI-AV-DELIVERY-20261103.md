# GEMINI-AV-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/av-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**29/29 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | Magic Bytes 探测 | WAV magic bytes 识别通过 | ✔ PASS |
| 2 | Magic Bytes 探测 | WAV 匹配 MP4 mime 拒绝 | ✔ PASS |
| 3 | Magic Bytes 探测 | MP3 ID3 magic bytes 识别通过 | ✔ PASS |
| 4 | Magic Bytes 探测 | MP4 ftyp magic bytes 识别通过 | ✔ PASS |
| 5 | Magic Bytes 探测 | WEBM EBML magic bytes 识别通过 | ✔ PASS |
| 6 | Magic Bytes 探测 | 伪造媒体数据校验拒绝 | ✔ PASS |
| 7 | 格式与输入安全 | 坏媒体返回 UNSUPPORTED_FORMAT | ✔ PASS |
| 8 | 格式与输入安全 | 跨租户拒绝 CROSS_TENANT_REJECTED | ✔ PASS |
| 9 | 资源限制与取消 | 超字节上限返回 BYTE_LIMIT_EXCEEDED | ✔ PASS |
| 10 | 资源限制与取消 | 超时长上限返回 DURATION_EXCEEDED | ✔ PASS |
| 11 | 资源限制与取消 | 信号取消返回 RUN_CANCELLED | ✔ PASS |
| 12 | 音频转写降级与证据 | 音频结构解析 ok=true | ✔ PASS |
| 13 | 音频转写降级与证据 | type=audio | ✔ PASS |
| 14 | 音频转写降级与证据 | 原生无 ASR 标记 blocked=true | ✔ PASS |
| 15 | 音频转写降级与证据 | blockedReason=BLOCKED_ASR_NATIVE | ✔ PASS |
| 16 | 音频转写降级与证据 | inputSha256 与媒体精确匹配 | ✔ PASS |
| 17 | 音频转写降级与证据 | ASR 挂载转写 ok=true | ✔ PASS |
| 18 | 音频转写降级与证据 | 转写成功 blocked=false | ✔ PASS |
| 19 | 音频转写降级与证据 | 生成 2 个时间戳分段 | ✔ PASS |
| 20 | 音频转写降级与证据 | 分段内容与时间线对齐 | ✔ PASS |
| 21 | 视频抽帧降级与证据 | 视频解析 ok=true | ✔ PASS |
| 22 | 视频抽帧降级与证据 | type=video | ✔ PASS |
| 23 | 视频抽帧降级与证据 | 无 ffmpeg 标记 blocked=true | ✔ PASS |
| 24 | 视频抽帧降级与证据 | blockedReason=BLOCKED_FFMPEG | ✔ PASS |
| 25 | 视频抽帧降级与证据 | inputSha256 精确匹配 | ✔ PASS |
| 26 | 视频抽帧降级与证据 | 抽帧处理 ok=true | ✔ PASS |
| 27 | 视频抽帧降级与证据 | 抽帧成功 blocked=false | ✔ PASS |
| 28 | 视频抽帧降级与证据 | 成功获取 2 个时间戳关键帧 | ✔ PASS |
| 29 | 视频抽帧降级与证据 | 关键帧分辨率元信息完整 | ✔ PASS |

## 实现说明

- **基于 AUDIT-20261101 的原生缺口桥接**：由于 DSH 原生 `@deepseek-ai/dsh-attachment` 与 `@deepseek-ai/dsh-llm` 不支持 audio/video block，本候选实现最小宿主桥
- **严格 Magic Bytes 探测**：不信任文件后缀名，深入二进制校验 WAV (RIFF/WAVE)、MP3 (ID3/Sync)、MP4 (ftyp)、WEBM (EBML)，防范伪造格式文件注入
- **租户安全与资源上限门禁**：绑定 `tenantId` 杜绝越权串租户；严格把关 `maxBytes` (默认100MB) 与 `maxDurationMs` (默认5分钟)
- **优雅降级与可审计证据**：在无外部 ASR 或 ffmpeg 环境下，输出规范降级结构，标记真实 `blockedReason` 并生成输入媒体文件的确定性 `inputSha256`
- **挂载后端全链路闭环**：在挂载 ASR 或 FrameExtractor 时，准确生成时间戳转写段（`startMs`/`endMs`/`confidence`）与关键帧元信息（`timestampMs`/`frameBase64`/`width`/`height`）

## 文件 SHA256

```
a789c404ee5594d69059dab411ac7f72ebbf3c609132cdafc6b2e4ecbc46aed5  shell/candidates/av-20261103/CONTRACT.md
f9f2820e77c1f5e05b68e3890f839d838e190b57266679022475682b47981180  shell/candidates/av-20261103/index.cjs
cdb7401f8f0844c4ccb5bb7a9a9f2afaf6270a28f7f05bb131d811f8ac9f7de3  tests/probes/av-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_ASR_NATIVE`: 原生无内置 Whisper 等 ASR 引擎，需生产环境提供外接语音识别服务。
- `BLOCKED_DSH_AV_INPUT`: DSH 原生 llm/attachment 协议不支持音视频块直接透传，必须通过宿主桥转写/抽帧后转交视觉或文本模型。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (29/29 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载到多模态媒体理解链路。
