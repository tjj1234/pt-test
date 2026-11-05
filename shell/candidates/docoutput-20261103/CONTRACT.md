# CONTRACT: 模型文档产物与中文PDF (docoutput-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface GenerateDocumentInput {
  runId: string;
  tenantId: string;
  artifactVersion: string;         // 语义化或递增版本，不可变
  format: 'pdf' | 'docx' | 'xlsx';
  content: StructuredDocContent;
  resourceLimits?: DocOutputLimits;
  signal?: AbortSignal;
}

interface StructuredDocContent {
  title: string;
  // 用于 pdf / docx
  sections?: Array<{
    heading?: string;
    paragraphs: string[];
  }>;
  // 用于 xlsx
  sheets?: Array<{
    name: string;
    rows: Array<Array<string | number | boolean | null>>;
  }>;
}

interface DocOutputLimits {
  maxOutputBytes?: number;         // 默认 10MB
  maxParagraphs?: number;          // 默认 2000
  timeoutMs?: number;              // 默认 10000ms
}
```

## 输出 Schema

```typescript
interface DocOutputSuccess {
  ok: true;
  format: 'pdf' | 'docx' | 'xlsx';
  mimeType: string;
  runId: string;
  tenantId: string;
  artifactVersion: string;
  buffer: Buffer;
  byteLength: number;
  sha256: string;
  durationMs: number;
}

interface DocOutputFailure {
  ok: false;
  code: ErrorCode;
  detail?: string;
}

type DocOutputResult = DocOutputSuccess | DocOutputFailure;
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `DOC_FORMAT_UNSUPPORTED` | 不支持的导出格式 |
| `DOC_INPUT_INVALID` | 缺少必填参数或字段类型非法 |
| `DOC_INPUT_LIMIT` | 标题超长、段落数或行数超标 |
| `FORMULA_INJECTION_DETECTED` | 检测到潜在公式注入（若未开启自动转义）|
| `ILLEGAL_CONTROL_CHARS` | 包含非法不可打印控制字符 |
| `DOC_OUTPUT_LIMIT` | 生成产物超过 maxOutputBytes |
| `DOC_TIMEOUT` | 生成过程超时 |
| `DOC_CANCELLED` | 外部信号取消 |

## 安全与防注入约束

1. **不可变与归属绑定**：产物必须包含明确的 `runId`、`tenantId` 与 `artifactVersion`。
2. **公式注入转义**：表格单元格以 `=+\-@\t\r` 开头的字符串自动做单引号安全转义。
3. **中文 PDF 原生与安全渲染**：生成符合 PDF/A 或标准 PDF 语法的紧凑流，采用预定义字体及十六进制 UTF-16BE / Unicode 字符串或 Type 0 CIDFont 映射，完整支持中文字符集与特殊标点。
4. **失败无半成品**：内存纯生成机制，失败即抛出标准错误码，不留下损坏的临时文件。
