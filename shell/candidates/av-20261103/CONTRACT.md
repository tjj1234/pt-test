# CONTRACT: 音视频内容与时间定位 (av-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 已知原生缺口（来自 AUDIT-20261101）

- `@deepseek-ai/dsh-attachment@0.1.1-rc.2`: mediaTypes 仅含 PNG/JPEG/WebP/GIF，音视频抛 UNSUPPORTED_IMAGE_TYPE
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`: ContentBlockMap 无 audio/video 块类型
- `@earendil-works/pi-ai@0.82.1`: Model.input 限定为 ("text" | "image")[]
- Wire 抓包实证：音视频字节数严格为 0

**结论**：DSH 原生无法传递 audio/video 到模型，本候选提供最小宿主桥（本地处理+文本转写摘要）。

## 输入 Schema

```typescript
interface AvProcessInput {
  runId: string;
  tenantId: string;
  buffer: Buffer;                  // 媒体文件字节
  mimeType: string;                // 'audio/wav' | 'audio/mp3' | 'video/mp4' | ...
  durationHintMs?: number;         // 时长提示（秒级精度）
  maxDurationMs?: number;          // 最大允许时长（默认 300_000ms = 5分钟）
  signal?: AbortSignal;
}
```

## 输出 Schema

```typescript
interface AudioResult {
  type: 'audio';
  blocked: boolean;               // true = ASR 不可用
  blockedReason?: string;         // BLOCKED_ASR_NATIVE | BLOCKED_FFMPEG
  segments?: TranscriptSegment[];
  inputSha256: string;            // 输入文件 SHA256（可重现）
  tenantId: string;
}

interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

interface VideoResult {
  type: 'video';
  blocked: boolean;
  blockedReason?: string;
  frames?: KeyFrame[];
  inputSha256: string;
  tenantId: string;
}

interface KeyFrame {
  timestampMs: number;
  frameBase64: string;            // JPEG base64
  width: number;
  height: number;
}
```

## 格式支持矩阵

| 格式 | 验证输入 | 转写/提帧 | 说明 |
|------|----------|-----------|------|
| audio/wav | SUPPORTED | BLOCKED_ASR_NATIVE | WAV magic bytes 验证通过，无 ASR |
| audio/mp3 | SUPPORTED | BLOCKED_ASR_NATIVE | MP3 ID3/FF FB 验证通过，无 ASR |
| video/mp4 | SUPPORTED | 若有 ffmpeg 则 PARTIAL | ftyp box 验证；ffmpeg 可提帧 |
| video/webm | SUPPORTED | BLOCKED_FFMPEG（若无） | EBML 验证 |
| image/* | 转交 dsh-attachment | N/A | 非本候选处理范围 |

## 错误码

| 错误码 | 含义 |
|--------|------|
| `UNSUPPORTED_FORMAT` | mimeType 不在支持列表，或 magic bytes 不匹配 |
| `DURATION_EXCEEDED` | 超过 maxDurationMs |
| `BYTE_LIMIT_EXCEEDED` | 文件超字节上限（默认 100MB）|
| `TRANSCRIPTION_BLOCKED` | ASR 不可用（BLOCKED_ASR_NATIVE）|
| `FRAME_EXTRACTION_BLOCKED` | ffmpeg 不可用 |
| `CROSS_TENANT_REJECTED` | tenantId 不匹配 |

## BLOCKED 项目

- `BLOCKED_ASR_NATIVE`: 无本地 ASR/Whisper，需外部服务
- `BLOCKED_DSH_AV_INPUT`: DSH 原生不支持 audio/video block 传递给模型（已由 AUDIT-20261101 实证）

## 环境检测

```javascript
// ffmpeg 可用性（系统级）
const { execSync } = require('child_process');
let ffmpegAvailable = false;
try { execSync('ffmpeg -version', { stdio: 'pipe' }); ffmpegAvailable = true; } catch {}
```
