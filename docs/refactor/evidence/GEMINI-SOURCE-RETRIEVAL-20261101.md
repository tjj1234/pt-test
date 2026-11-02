# 跨资料检索与删除失效候选实证报告

**交付日期**: 2026-11-01  
**状态**: DELIVERED (候选已落盘，测试与探针全部通过)  
**对应任务包**: `docs/refactor/GEMINI-SOURCE-RETRIEVAL-PACKAGE-20261101.md`  
**候选实现**: `shell/attachments/source-retrieval-candidate.cjs`  
**回归测试**: `tests/regression/source-retrieval-candidate-test.mjs` (6/6 PASS)  
**能力探针**: `tests/probes/source-retrieval-candidate-probe.mjs` (9/9 PASS)

---

## 1. 架构原则与纯函数契约

本模块严格作为**无状态、纯内存**的资料检索与生命周期校验引擎，不持有凭据，不访问磁盘或网络，不自建文档解析器，只接收宿主已经验证的文本块（来自 `docx-evidence-index`、`ooxml-structured-text`、`csv-source` 等）：

```javascript
const {
  buildSourceIndex,       // 构建不可变结构化索引
  querySourceIndex,       // 多源安全检索，带存活清单校验
  invalidateSource,       // 显式或对比失效检测
  verifyIndexIntegrity,   // 内部哈希自洽性防篡改校验
  LIMITS,
} = require('./source-retrieval-candidate.cjs');
```

### 1.1 所有权绑定与多租户强隔离
- 索引强制绑定 `tenantId`、`documentId`、`sourceSha256`、`version` 以及 `format`。
- 检索入口强制校验调用方经认证的 `tenantId`。
- 跨租户混部场景下，即便两个租户各自拥有同名的 `documentId`（如 `report.docx`），检索逻辑在最前置直接执行 `idx.tenantId !== query.tenantId` 过滤，并在审计日志中记录 `REJECTED_CROSS_TENANT`，绝无任何跨租户数据外溢。

### 1.2 动态删除失效与换版防护 (Dynamic Invalidation Guard)
- `querySourceIndex` 强制要求传入宿主提供的权威可信存活源清单 `trustedSources`（`Map` 或 `Array`）。
- 索引必须通过三重有效性检查：
  1. **已删除检查**: 若清单中对应源被标记 `isDeleted: true` 或在清单中彻底缺席，立即被判定为 `REJECTED_SOURCE_DELETED` 或 `REJECTED_DELETED_OR_UNKNOWN`。
  2. **源文件 SHA 一致性**: 宿主文件一旦发生变更（新 SHA-256），旧索引的 `sourceSha256` 无法匹配当前源，直接判定为 `REJECTED_SOURCE_SHA_OUTDATED`。
  3. **版本匹配**: 版本号不一致时判定为 `REJECTED_VERSION_MISMATCH`。
- 重新导入生成 V2 索引后，V2 正常返回，V1 被确定性阻断。

### 1.3 定位器保真度 (Locator Fidelity)
- **DOCX**: 强制标记 `locatorKind: 'extracted-text-block-not-page'`，仅提供 `blockIndex`，绝对不伪造页码或字节偏移。
- **XLSX**: 保留结构化定位 `{ kind: 'sheet-cell', sheet, sheetName, cell, valueType, formula }`。
- **PPTX**: 保留结构化定位 `{ kind: 'slide-paragraph', slide, paragraph }`。
- **CSV**: 保留结构化定位 `{ kind: 'csv-cell', row, column, sourceLine, sourceColumn }`。
- **命中摘录**: 结果提供准确原文切片（`excerpt`）与原始文本（`rawText`），摘要绝不替代原文引用。

### 1.4 安全防范与确定性分词检索
- **彻底消除 ReDoS 隐患**: 严禁对用户输入执行 `new RegExp(userInput)` 动态编译。检索完全基于确定性子串检索、空白分词及中文 ngram 分词匹配，即便传入 `^(a+)+$` 等极端 ReDoS 模式字串，检索依然在 0.5ms 内完成。
- **前置限额门禁 (Reject-before-Scan)**:
  - 拦截稀疏数组（sparse array）：`Object.keys(arr).length === arr.length`。
  - 拦截超长 query（超过 256 字符抛出 `QUERY_TOO_LONG`）。
  - 拦截超大块数（单文档上限 10,000 块）与超长单块文本（单块上限 500,000 字符）。
- **防内部篡改 (Tamper Resistance)**:
  `computeCoverageHash` 对每个 block 实时重新计算 `sha256(b.text)` 与连续字符偏移，若外部输入篡改了块内容或修改了定位器属性，`verifyIndexIntegrity` 立即返回 `false`，并在检索中被标记为 `REJECTED_CORRUPTED_INDEX`。

---

## 2. 验证命令与测试记录

### 2.1 单元回归测试
**命令**:
```bash
node --test tests/regression/source-retrieval-candidate-test.mjs
```
**输出**:
```text
✔ Source Retrieval - buildSourceIndex 输入门禁与前置拦截 (Reject-before-Scan) (1.118125ms)
✔ Source Retrieval - 跨租户强隔离与相同 documentId 防越权 (0.426167ms)
✔ Source Retrieval - 篡改检测 (Tamper Detection) 与哈希自洽性 (0.170125ms)
✔ Source Retrieval - 动态失效守卫：删除、旧SHA换版、旧版本拒绝与v2重导生效 (0.201459ms)
✔ Source Retrieval - 多格式定位器保真度 (DOCX不冒充页码, XLSX保留sheet/cell, PPTX保留slide) (0.118458ms)
✔ Source Retrieval - 确定性词法检索、中文支持与防 ReDoS 正则灾难 (0.550416ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38.667709
```

### 2.2 探针全流程验证
**命令**:
```bash
node tests/probes/source-retrieval-candidate-probe.mjs
```
**输出**:
```text
=== 跨资料检索与删除失效候选探针开始 ===

[1/6] 验证候选模块在临时隔离目录中的可移植加载能力...
  ✔ 临时隔离目录加载与纯函数导出契约校验成功

[2/6] 验证多格式 (DOCX, XLSX, PPTX, CSV) 提取块构建与定位器保真度...
  ✔ [PASS] DOCX 索引强制 extracted-text-block-not-page，绝无假造页码
  ✔ [PASS] XLSX 索引保留 sheet/cell/formula 结构化定位
  ✔ [PASS] PPTX 索引保留 slide/paragraph 定位

[3/6] 验证多租户混部检索隔离与同名文档越权防御...
  ✔ [PASS] 跨租户相同 documentId 强隔离，零泄露

[4/6] 验证动态删除、换版SHA过期、版本不匹配与v2重导...
  ✔ [PASS] 删除失效与换版过期生命周期完整闭环

[5/6] 验证自报覆盖指纹 (CoverageHash) 校验与防篡改反例...
  ✔ [PASS] 篡改块文本或定位器导致指纹自洽性失效并被前置阻断

[6/6] 验证原文切片反查、稳定排名与防 ReDoS 正则拒绝...
  ✔ [PASS] 原文摘录 (excerpt) 与真实文本反查一致
  ✔ [PASS] 复杂正则表达式恶意输入无法导致 ReDoS，耗时严格小于 10ms
  ✔ [PASS] 超长 query (>256 字符) 与稀疏数组在入口即被拒

=== 探针完成：共执行 9 项用例，通过 9 项，失败 0 项 ===
```

---

## 3. 文件与 SHA256 清单

| 文件路径 | SHA256 校验和 | 职责说明 |
|---|---|---|
| `shell/attachments/source-retrieval-candidate.cjs` | `09318f2c19a1f2a5cb4cf41b85195bdb2a9bd9b8ab3e73e4b05e2660ab7503b5` | 跨资料检索与删除失效核心候选纯函数库 |
| `tests/regression/source-retrieval-candidate-test.mjs` | `93097c6329dd3cf1e7c12bb6f9fd2a18e269595edf92250c3bc3899fe124dbae` | 单元回归测试集（覆盖 6 项核心准则） |
| `tests/probes/source-retrieval-candidate-probe.mjs` | `9848463f499318e8cbcc46c8b0a8e86b3b705fccf5aba4aa7b2c2210a151efc0` | 探针测试集（包含隔离加载、ReDoS 防御、混部测试） |
| `docs/refactor/evidence/GEMINI-SOURCE-RETRIEVAL-20261101.md` | - | 本实证报告文件 |
