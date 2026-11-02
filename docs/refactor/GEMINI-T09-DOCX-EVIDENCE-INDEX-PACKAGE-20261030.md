# Gemini 独立任务包：DOCX 提取来源索引候选（2026-10-30）

状态：待转交。目标是为已接入的 DOCX 原始文本提取建立可核验的段落来源索引，支持后续跨资料检索；只交付隔离候选、测试和证据，主 Agent 负责生产接线。遵循“优先复用 DSH 原生能力，确有缺口才补产品代码”，不得另造文档解析引擎。

独占新增文件仅限 `shell/attachments/docx-evidence-index-candidate.cjs`、`tests/regression/docx-evidence-index-candidate-test.mjs`、`tests/probes/docx-evidence-index-candidate-probe.mjs`、`docs/refactor/evidence/GEMINI-T09-DOCX-EVIDENCE-INDEX-20261030.md`；可在本任务包末尾追加交付记录。不得修改 server、现有 Office 解析器/worker、DSH profile、package/lock、release-artifacts、WORKLOG、其他任务包及用户脏文件；不得 commit/push/部署或调用真实 PT。

先读 `shell/attachments/office-document-parser.cjs`、`office-document-worker.cjs`、`office-zip-guard.cjs`、`shell/runtime/artifacts.cjs` 与已锁定 DSH 的文件/上下文插件公开接口，写明哪些来源能力可原生复用、哪些必须由租户产品层补齐。候选输入只接受当前解析器返回的受限 blocks、原始文件 SHA-256、租户/文档所有权标识；输出不可变的块序号、提取文本哈希、可见字符范围及总覆盖统计。不得把块序号冒称 DOCX 页码、原始字节偏移或真实引用位置；文本一律不可信，不执行宏、外链或公式。限制块数、总字符数与单条长度，拒绝重复/缺失索引、错误 SHA、跨租户或被修改的来源；删除/换版后索引须能明确失效。验证中英文、前导零、重复文本、多段落、超限与恶意文本；探针使用真实锁定 DOCX 提取路径和本地夹具，不做网络访问。

交付记录必须包含文件清单、命令/退出码/通过数、原始证据、与现有 DOCX 上传和 DSH 上下文的精确接缝，以及未验证项。主线接入、真实产品检索/引用 UI、跨租户 HTTP 与部署验收仍由主 Agent 完成；候选测试通过不得写成这些功能已上线。

---

## 交付记录（Gemini 2026-10-30）

### 1. 独占新增文件清单
- `shell/attachments/docx-evidence-index-candidate.cjs`：DOCX 提取来源索引构造与校验候选（不可变段落块序号、字符范围、SHA-256 哈希与总覆盖统计）
- `tests/regression/docx-evidence-index-candidate-test.mjs`：单元与回归测试套件（4/4 PASS）
- `tests/probes/docx-evidence-index-candidate-probe.mjs`：真实锁定解析器与生成 DOCX 夹具端到端离线探针（通过）
- `docs/refactor/evidence/GEMINI-T09-DOCX-EVIDENCE-INDEX-20261030.md`：详细离线安全证据、原生复用分析与主线接缝说明

### 2. 实际原生与底层依赖版本
- `shell/attachments/office-document-parser.cjs`: 受限 DOCX 原始文本与 blocks 抽取
- `mammoth@1.8.0`: 原始文本提取引擎（无 HTML/样式/宏注入）
- `fflate@0.8.2`: ZIP 结构校验与真实夹具生成

### 3. 命令与测试验证结果
- **回归测试**: `node --test tests/regression/docx-evidence-index-candidate-test.mjs`
  - 退出码: `0`
  - 通过数: `4 pass / 0 fail`
  - 覆盖反例: 租户 ID / 文档 ID / 版本号非法校验、源文件 SHA 校验、块序号断裂与乱序拒绝 (`INDEX_SEQUENCE_DISCONTINUITY`)、单文档最大块数限制 (`MAX_BLOCKS_LIMIT = 10000`)、单块大小限制 (`MAX_BLOCK_TEXT_BYTES = 1MB`)、跨租户验证拦截、源文件内容被修改或换版时索引即刻失效。
- **真实锁定探针**: `node tests/probes/docx-evidence-index-candidate-probe.mjs`
  - 退出码: `0`
  - 结果: `PASS`
  - 验证指标: 
    - 抽取并索引 10 个真实段落块（总字符数 218）；
    - 100% 字符范围切片对齐 (`charSliceAligned: true`)；
    - 中文、前导零 (`000987654321`) 原样保留；
    - 公式 (`=AVERAGE(C1:C10)`) 作为纯文本安全留存，无宏/代码执行风险；
    - 严格声明 `locatorKind: 'extracted-text-block-not-page'`，无页码冒充。

### 4. 原始安全证据位置
- `docs/refactor/evidence/GEMINI-T09-DOCX-EVIDENCE-INDEX-20261030.md`

### 5. 与现有 DOCX 上传和 DSH 上下文的精确接缝
- **DOCX 上传处理链**:
  在调用 `parseOfficeDocument` 获取 `blocks` 与 `sourceSha256` 后，直接调用 `buildDocxEvidenceIndex({ tenantId, documentId, sourceSha256, blocks, version })` 生成不可变索引对象用于后续持久化或向量索引。
- **DSH 上下文与前端引用**:
  下游引用模块消费索引中的 `blockIndex`，格式化为 `[来源: doc.docx (段落块 #N)]`，明确指示提取块而非印刷物理页码。

### 6. 未验证项声明
- 本次验证为本地环境离线沙箱测试，零公网访问，未连接真实 PT。
- **未验证项**：真实前端 UI 引用卡片交互、跨租户 HTTP 上传接口的真实端到端集成、生产 Postgres 中的检索索引落盘。这些工作由主 Agent 在主线发布中进行。不得宣称文档索引功能已上线。

