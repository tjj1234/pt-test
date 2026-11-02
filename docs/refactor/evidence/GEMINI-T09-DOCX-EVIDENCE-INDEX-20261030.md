# 离线证据：DOCX 提取来源索引候选验证（2026-10-30）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **底层解析组件**: `shell/attachments/office-document-parser.cjs`, `office-document-worker.cjs`, `office-zip-guard.cjs`, `mammoth@1.8.0`, `fflate@0.8.2`
- **生成工具**: `shell/exports/document-export-candidate.cjs`
- **运行环境**: 纯本地 Node.js 进程沙箱，零网络访问、零真实凭据、零数据库写操作。

---

## 2. 架构设计与复用核查

### 2.1 可原生复用的能力
1. **真实 DOCX 文本抽取与 ZIP 守卫**：
   - 复用 `office-zip-guard.cjs` 对 ZIP 膨胀率、相对路径跳跃（`..` 目录遍历）以及宏/嵌入对象 (`vbaProject.bin`, `embeddings/object.bin`) 的严格拦截。
   - 复用 `office-document-parser.cjs` 与工作线程沙箱，在独立 Worker 内通过 Mammoth 抽取原始文本及段落 blocks。
2. **块定位约定**：
   - 复用解析器输出的 `locatorKind: 'extracted-text-block-not-page'`。
   - 块序号代表从 1 起始的离散提取段落单元，不冒充真实 DOCX 页面序号或物理字节偏移。

### 2.2 由租户产品层补齐的索引能力 (`docx-evidence-index-candidate.cjs`)
1. **多租户与版本绑定**：
   - 强制绑定 `tenantId`, `documentId`, `documentVersion` 与 `sourceSha256`；
   - 跨租户检索直接拒绝，源文件内容变更（SHA 改变）或版本更新时索引明确失效。
2. **字符范围切片与连续性哈希**：
   - 计算每个 block 的精确 `charStart`, `charEnd`, `charLength` 以及 `textSha256`；
   - 维护整个文档的 `coverageHash`，防范任何局部段落增删篡改。
3. **容量与防御限制**：
   - 限制单文档块数 <= 10,000，单块大小 <= 1MB，总字符数 <= 5MB；
   - 严格拒绝断号、乱序、前导零错乱或非字符串文本。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/docx-evidence-index-candidate-test.mjs`)
- **执行命令**: `node --test tests/regression/docx-evidence-index-candidate-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `DOCX Evidence Index - Basic construction and immutability`: PASS
  2. `DOCX Evidence Index - Input validation and boundary enforcement`: PASS (非法租户/文档ID、版本号、SHA、序号断裂等强力拦截)
  3. `DOCX Evidence Index - Capacity & DOS protections`: PASS (超限块数与超大文本拦截)
  4. `DOCX Evidence Index - Verification, tenant isolation and revocation on version change`: PASS (跨租户拦截与版本变更失效)

### 3.2 原生锁定环境探针 (`tests/probes/docx-evidence-index-candidate-probe.mjs`)
- **执行命令**: `node tests/probes/docx-evidence-index-candidate-probe.mjs`
- **退出码**: `0`
- **测试真实夹具**:
  - 动态生成真实合规 DOCX，包含中英文、段落、前导零、特殊符号、伪公式；
  - 经由真实 `parseOfficeDocument` (Mammoth Worker) 抽取 10 个 blocks；
  - 构建索引并核验：
    - `totalBlocks`: 10
    - `totalChars`: 218
    - `coverageHash`: `b228df42fee97a33379fd76a68641ea26a5a0f0f56761e33a4d92a4d723f1f02`
    - `charSliceAligned`: true (100% 对齐)
    - `leadingZerosPreserved`: true
    - `formulaNotEvaluated`: true
    - `tenantIsolationEnforced`: true
    - `noPageNumberImpersonation`: true

---

## 4. 主 Agent 精确接缝说明

1. **DOCX 上传处理流程 (`shell/attachments/` 或相关路由)**:
   - 在调用 `parseOfficeDocument({ bytes, format: 'docx' })` 获得原始结果后：
     ```javascript
     const { buildDocxEvidenceIndex } = require('./attachments/docx-evidence-index-candidate.cjs');
     const evidenceIndex = buildDocxEvidenceIndex({
       tenantId: req.tenantId,
       documentId: uploadedFile.path,
       sourceSha256: parsed.sourceSha256,
       blocks: parsed.blocks,
       version: uploadedFile.version || 1,
     });
     // 持久化存储或存入检索索引库
     ```
2. **DSH 上下文与检索引用展示**:
   - 在 Agent 引用文档段落时，前端或上下文格式化模块消费 `evidenceIndex.blocks[i]`：
     - 展示形如：`[来源: survey.docx (段落块 #2)]`；
     - 明确提示用户该序号为提取段落块，而非打印页码。

---

## 5. 未验证项声明
- 本次验证为离线隔离验证，使用本地生成的合规 DOCX 二进制与沙箱解析器。
- **未验证项**：真实产品 UI 端长文档高亮与引用交互、跨租户 HTTP 上传接口的真实端到端集成、生产 Postgres 中的检索索引落盘。这些工作由主 Agent 在后续主线集成与发布中负责。不得宣称文档索引功能已上线。
