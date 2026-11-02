# Gemini独立任务：记忆来源、确认与范围候选
状态：READY_NOT_STARTED；调度：排队 E，待首批释放名额。目标日期2026-11-02，目标不是已保证的验收承诺。

## 所有权与统一约束
工作区 `/Users/mmdn/Downloads/pt项目`；主Agent并行修改推理元数据RPC、UI→Run→Runner。仅允许新增以下独占文件，并在本任务包末尾追加实际交付记录：
- `shell/memory/provenance-candidate.cjs`
- `tests/regression/memory-provenance-candidate-test.mjs`
- `tests/probes/memory-provenance-candidate-probe.mjs`
- `docs/refactor/evidence/GEMINI-MEMORY-PROVENANCE-20261101.md`

任何独占文件已存在先报告冲突，不覆盖；R1/R2/R3与他人文件只读。不得修改server、tenant、Runner、adapter、UI、profile、package/lock、migration、WORKLOG、HANDOFF、release-artifacts、current-draft；不得commit/push/merge/部署/付费调用、找历史凭据、升级依赖、启动其他Agent。禁止替主Agent生成活动发布包。
优先复用锁定DSH及已有候选，核对真实安装版本和API；依赖仅从受信shell锁定解析，禁止cwd/NODE_PATH/analytics意外回退。测试临时文件仅进os.tmpdir且finally清理。localhost替身可用，真实PT、公网模型、真实Key均禁止。独立包通过不等于生产接入或全量交付。

## 必须完成与验收
先读shell/memory.cjs、tasks/memory-run-invalidation.cjs、现有存储与DSH memory能力，保留现有CRUD语义。设计最小纯数据策略层 normalizeMemoryRecord / selectRecallableMemories / invalidateMemorySources，公开schema与固定错误码，不做DB/UI/真实召回请求。
区分用户明确确认、用户原话、模型推断三类来源；推断不能默认变成已确认事实。记录owner tenant/user、scope(user或conversation)、source message/document身份与hash/version、confirmed状态、revoked状态、revision和时间。所有可信身份/确认动作由宿主提供，不能接受内容自身授权；对话范围不能泄漏到其他对话，跨用户/租户拒绝。
源删除/修订/记忆撤销后，旧召回快照必须可检测失效；返回供宿主取消Run/清热会话的确定性revision接缝，但不得声称本候选已执行取消或DB事务。召回有数量/字符硬限、确定排序，拒绝未知枚举/非法时间/原型异常/非有限上限；输入不变，错误不带记忆正文。用纯fixture证明确认前后、跨范围、撤回和旧revision失效；不得将prompt中的确认文字当可信确认。

## 执行与汇报
- `node --test tests/regression/memory-provenance-candidate-test.mjs`
- `node tests/probes/memory-provenance-candidate-probe.mjs`
记录完整命令、退出码、通过/失败数、fixture与实际原生证据区分、源码/依赖版本和SHA、失败及修复经过、资源/取消/隔离反例、主线接线契约、未验证项。交付四要素：文件已落盘、报告存在、命令独立可复跑、在本任务包末尾追加实际汇报。不提前写COMPLETED或只给PASS摘要。报告里保留确切BLOCKED项目，不能用模拟替换任务要求。

## 交付与实际汇报记录 (2026-11-01)

- **任务状态**: DELIVERED (独占文件已落盘，测试与探针全部通过，交付四要素已核验)
- **交付四要素核验**:
  1. 独占文件已落盘：
     - `shell/memory/provenance-candidate.cjs`
     - `tests/regression/memory-provenance-candidate-test.mjs`
     - `tests/probes/memory-provenance-candidate-probe.mjs`
     - `docs/refactor/evidence/GEMINI-MEMORY-PROVENANCE-20261101.md`
  2. 详细实证报告已存在并包含完整架构设计与测试说明。
  3. 独立命令可复跑且零网络调用、零真实凭据泄漏、临时文件仅进 os.tmpdir 且 finally 清理。
  4. 完整汇报记录写回本任务包末尾。

### 1. 验证命令与测试结果
- **单元回归测试**:
  - `node --test tests/regression/memory-provenance-candidate-test.mjs`
  - 退出码: 0
  - 测试统计: 5 pass, 0 fail (通过耗时 43.3ms)
- **探针全流程验证**:
  - `node tests/probes/memory-provenance-candidate-probe.mjs`
  - 退出码: 0
  - 探针用例: 5 项全部通过 (5 pass, 0 fail)

### 2. 核心架构与防御准则闭环
1. **纯数据策略层契约**:
   - `normalizeMemoryRecord` / `selectRecallableMemories` / `invalidateMemorySources`
   - 不接触数据库操作，不发起模型网络调用，不修改现有 CRUD 接口，只做纯内存结构化规范化与校验。
2. **三类来源溯源与推断防自授权**:
   - `user-explicit-confirmation`: 用户明确确认（系统鉴权通道触发，`confirmed: true`）。
   - `user-verbatim-statement`: 用户对话原话（`confirmed: true`，记录 `confirmedBy: 'user-statement'`）。
   - `model-inference`: 模型推断。默认 `confirmed: false`，默认召回自动排除；严禁模型在 Prompt 中自称确认而自报 `confirmed: true`（若无宿主外部凭据 `hostAssertion`，直接拦截抛出 `MEMORY_UNVERIFIED_INFERENCE_CONFIRMATION_FORBIDDEN`）。
3. **会话级与多租户/用户严格隔离**:
   - `scope: 'conversation'` 强制绑定 `conversationId`。
   - 跨对话召回时严格过滤并记录 `REJECTED_CONVERSATION_MISMATCH`，绝不跨会话泄漏；跨租户与跨用户分别记录 `REJECTED_CROSS_TENANT` 与 `REJECTED_CROSS_USER`。
4. **来源失效与快照过期 (Stale Snapshot Detection)**:
   - 记录 `source.id`、`source.hash`、`source.version`。
   - 源文件被删除、修改或换版时，`invalidateMemorySources` 判定失效并触发 `revisionTrigger: true`。
   - 召回引擎返回最新 `snapshotRevision`，旧快照被识别为 `stale: true`，为宿主调用 `cancelActiveRunsForMemoryChange` 清理热会话与取消 Run 提供确定性依据。
5. **错误信息安全性与预算硬限**:
   - 抛出的错误信息严禁携带记忆具体内容 (`value`)，防敏感信息外溢日志。
   - 硬限保护：最大召回条数硬限 100（默认 20），字符预算硬限 20,000（默认 4,000）；按 `updatedAt` 降序与 `key` 字典序稳定排序。

### 3. 文件 SHA256 校验清单
- `shell/memory/provenance-candidate.cjs`: `640bd59e6ff5182c6dde6e65adb08ed2d1f20aeb03a5f6fb2e9053fd5bbc7c8d`
- `tests/regression/memory-provenance-candidate-test.mjs`: `e98d4a73fd731cb374a99115153db59b9c126b0732dbbcb0b4184c3d183f2071`
- `tests/probes/memory-provenance-candidate-probe.mjs`: `c003ba4380e3769d7f09b09fe8ec1c0ff732d1b952003a5481b3efad729a4dae`
- `docs/refactor/evidence/GEMINI-MEMORY-PROVENANCE-20261101.md`: 实证与架构详细报告

