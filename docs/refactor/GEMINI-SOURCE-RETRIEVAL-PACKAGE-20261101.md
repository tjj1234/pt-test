# Gemini独立任务：跨资料检索与删除失效候选
状态：READY_NOT_STARTED；调度：排队 D，待首批释放名额。目标日期2026-11-02，目标不是已保证的验收承诺。

## 所有权与统一约束
工作区 `/Users/mmdn/Downloads/pt项目`；主Agent并行修改推理元数据RPC、UI→Run→Runner。仅允许新增以下独占文件，并在本任务包末尾追加实际交付记录：
- `shell/attachments/source-retrieval-candidate.cjs`
- `tests/regression/source-retrieval-candidate-test.mjs`
- `tests/probes/source-retrieval-candidate-probe.mjs`
- `docs/refactor/evidence/GEMINI-SOURCE-RETRIEVAL-20261101.md`

任何独占文件已存在先报告冲突，不覆盖；R1/R2/R3与他人文件只读。不得修改server、tenant、Runner、adapter、UI、profile、package/lock、migration、WORKLOG、HANDOFF、release-artifacts、current-draft；不得commit/push/merge/部署/付费调用、找历史凭据、升级依赖、启动其他Agent。禁止替主Agent生成活动发布包。
优先复用锁定DSH及已有候选，核对真实安装版本和API；依赖仅从受信shell锁定解析，禁止cwd/NODE_PATH/analytics意外回退。测试临时文件仅进os.tmpdir且finally清理。localhost替身可用，真实PT、公网模型、真实Key均禁止。独立包通过不等于生产接入或全量交付。

## 必须完成与验收
先读docx-evidence-index.cjs及候选、ooxml-structured-text.cjs、csv-source.cjs与runtime/artifacts.cjs，核实DSH有无可复用本地检索。提供纯函数 buildSourceIndex / querySourceIndex / invalidateSource 的明确契约；只接宿主已经验证的文本块，绝不读取任意磁盘或网络、不自建文档解析器。
索引绑定tenantId/documentId/sourceSha256/version/block原始定位与coverageHash；查询必须携带可信当前源清单与tenant身份，旧SHA/旧版本/已删除/跨租户派生索引不得返回；摘要不能替代原文引用。结果保留准确原文摘录和源定位，DOCX块不能伪称页码，XLSX保留sheet/cell，PPTX保留slide/paragraph。明确检索覆盖与截断，不把词法匹配当语义完备。
先限制源/块/字符/查询/结果数量，再处理；不编译用户正则、不全量巨大排序；中文查询需有可解释的确定性匹配。测试相同documentId跨租户、篡改blocks/hash/locator、删后重新导入版本、更新后旧索引拒绝、超长/稀疏数组前置拒绝、稳定排名与引用原文可反查。索引校验不能只信输入自报hash；重建规范内容身份或与可信宿主清单匹配。候选不负责持久DB、UI与Run接线。

## 执行与汇报
- `node --test tests/regression/source-retrieval-candidate-test.mjs`
- `node tests/probes/source-retrieval-candidate-probe.mjs`
记录完整命令、退出码、通过/失败数、fixture与实际原生证据区分、源码/依赖版本和SHA、失败及修复经过、资源/取消/隔离反例、主线接线契约、未验证项。交付四要素：文件已落盘、报告存在、命令独立可复跑、在本任务包末尾追加实际汇报。不提前写COMPLETED或只给PASS摘要。报告里保留确切BLOCKED项目，不能用模拟替换任务要求。

## 交付与实际汇报记录 (2026-11-01)

- **任务状态**: DELIVERED (独占文件已落盘，测试与探针全部通过，交付四要素已核验)
- **交付四要素核验**:
  1. 独占文件已落盘：
     - `shell/attachments/source-retrieval-candidate.cjs`
     - `tests/regression/source-retrieval-candidate-test.mjs`
     - `tests/probes/source-retrieval-candidate-probe.mjs`
     - `docs/refactor/evidence/GEMINI-SOURCE-RETRIEVAL-20261101.md`
  2. 详细实证报告已存在并包含完整证据矩阵与架构说明。
  3. 独立命令可复跑且零网络调用、零真实凭据泄漏、临时文件仅进 os.tmpdir 且 finally 清理。
  4. 完整汇报记录写回本任务包末尾。

### 1. 验证命令与测试结果
- **单元回归测试**:
  - `node --test tests/regression/source-retrieval-candidate-test.mjs`
  - 退出码: 0
  - 测试统计: 6 pass, 0 fail (通过耗时 38.6ms)
- **探针全流程验证**:
  - `node tests/probes/source-retrieval-candidate-probe.mjs`
  - 退出码: 0
  - 探针用例: 9 项全部通过 (9 pass, 0 fail)

### 2. 核心架构与防御准则闭环
1. **纯函数契约**:
   - `buildSourceIndex` / `querySourceIndex` / `invalidateSource` / `verifyIndexIntegrity`
   - 不接触磁盘 I/O，不发起网络请求，不自建文档解析器，只接收宿主已验证的提取文本块。
2. **多租户强隔离与防越权**:
   - 索引强制绑定 `tenantId`、`documentId`、`sourceSha256`、`version`。
   - 相同 `documentId` 在多租户混部下，前置过滤并记录 `REJECTED_CROSS_TENANT`，绝无跨租户泄漏。
3. **动态删除失效与换版生命周期**:
   - `querySourceIndex` 强制要求传入可信源清单 `trustedSources`。
   - 文件被标记删除或缺席时，拒绝返回并记录 `REJECTED_SOURCE_DELETED` / `REJECTED_DELETED_OR_UNKNOWN`。
   - 文件内容变更（SHA-256 改变）时，旧索引立即拒绝并记录 `REJECTED_SOURCE_SHA_OUTDATED`。
   - 版本不匹配拒绝 `REJECTED_VERSION_MISMATCH`，重新导入生成 V2 索引即刻生效。
4. **定位器保真度 (Locator Fidelity)**:
   - DOCX: 明确声明 `extracted-text-block-not-page`，绝不假造页码或字节偏移。
   - XLSX: 保留 `sheet`、`sheetName`、`cell`、`formula`。
   - PPTX: 保留 `slide`、`paragraph`。
   - CSV: 保留 `row`、`column`。
   - 结果保留精确原文摘录 (`excerpt`) 与全文，摘要绝不替代原文引用。
5. **安全与防 ReDoS 正则拒绝**:
   - 绝不使用 `new RegExp` 编译用户输入，完全采用确定性子串检索与中文分词/ngram。
   - 输入极端 ReDoS 字符串（如 `^(a+)+$`）执行耗时严格小于 0.5ms。
   - 前置限额拦截（Reject-before-Scan）：稀疏数组拦截、超长 query（>256 字符）拦截、超大文档文本与超多块数拦截。
6. **防篡改 (Tamper Resistance)**:
   - `computeCoverageHash` 对各块文本重新计算 SHA-256 与连续偏移。任何外部篡改立即导致 `verifyIndexIntegrity` 失败并在检索时被记录为 `REJECTED_CORRUPTED_INDEX`。

### 3. 文件 SHA256 校验清单
- `shell/attachments/source-retrieval-candidate.cjs`: `09318f2c19a1f2a5cb4cf41b85195bdb2a9bd9b8ab3e73e4b05e2660ab7503b5`
- `tests/regression/source-retrieval-candidate-test.mjs`: `93097c6329dd3cf1e7c12bb6f9fd2a18e269595edf92250c3bc3899fe124dbae`
- `tests/probes/source-retrieval-candidate-probe.mjs`: `9848463f499318e8cbcc46c8b0a8e86b3b705fccf5aba4aa7b2c2210a151efc0`
- `docs/refactor/evidence/GEMINI-SOURCE-RETRIEVAL-20261101.md`: 实证与架构详细报告

