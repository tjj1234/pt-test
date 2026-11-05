# CONTRACT: PDF/OCR/旧Office/ZIP输入 (docinput-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface DocInputParams {
  runId: string;
  tenantId: string;
  buffer: Buffer;
  format: 'pdf' | 'doc' | 'xls' | 'ppt' | 'zip';
  options?: DocInputOptions;
  signal?: AbortSignal;
}

interface DocInputOptions {
  maxPages?: number;               // 最大页数（默认 100）
  maxExpandedBytes?: number;       // ZIP 最大解压展开字节（默认 32MB）
  maxEntries?: number;             // ZIP 最大条目数（默认 256）
  enableOcr?: boolean;             // 扫描件是否启用 OCR 提取
  timeoutMs?: number;              // 解析超时（默认 10,000ms）
}
```

## 输出 Schema

```typescript
interface DocSuccessResult {
  ok: true;
  format: string;
  inputSha256: string;
  pageCount?: number;
  pages?: DocumentPage[];
  entries?: ZipEntryResult[];
  truncated: boolean;
  durationMs: number;
}

interface DocumentPage {
  pageNumber: number;              // 从 1 开始
  text: string;
  isOcr: boolean;
}

interface ZipEntryResult {
  name: string;
  size: number;
  sha256: string;
}

interface DocErrorResult {
  ok: false;
  code: ErrorCode;
  detail?: string;
}

type DocResult = DocSuccessResult | DocErrorResult;
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `DOC_FORMAT_UNSUPPORTED` | 不支持的格式或格式与 Magic Bytes 不匹配 |
| `DOC_INPUT_INVALID` | 输入 Buffer 空或畸形 |
| `ZIP_TRAVERSAL_REJECTED` | ZIP 条目含 `..`、绝对路径或盘符 |
| `ZIP_EXPANSION_LIMIT` | ZIP 展开大小超过 maxExpandedBytes（防压缩炸弹）|
| `ZIP_ENTRY_LIMIT` | ZIP 条目数超过 maxEntries |
| `ZIP_ACTIVE_CONTENT_REJECTED` | ZIP 包含 `.exe`、`.vbs`、`vbaProject.bin` 等活跃宏/可执行载荷 |
| `ENCRYPTED_FILE_REJECTED` | 加密/口令保护文档拒绝处理 |
| `LEGACY_OFFICE_CONVERTER_UNAVAILABLE` | 旧版 Office (.doc/.xls/.ppt) 无转码后端时 fail-closed |
| `OCR_UNAVAILABLE` | 需 OCR 识别但环境未提供可用 OCR 引擎 |
| `DOC_TIMEOUT` | 解析过程超时 |
| `DOC_CANCELLED` | 外部信号取消 |

## 安全约束

1. **防解压炸弹与目录穿越**：ZIP 严格流式解压检查，禁止目录穿越，严格限定展开倍率与总字节。
2. **活跃内容阻断**：杜绝 VBA 宏、脚本嵌入、可执行载荷。
3. **确定性证据**：所有输入必须生成 `inputSha256`。
4. **外部转码 Fail-Closed**：旧版二进制 Office 及 OCR 需专用后端；在缺少后端时明确报错，不伪造解析成功。
