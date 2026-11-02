# 记忆来源、确认与范围候选实证报告

**交付日期**: 2026-11-01  
**状态**: DELIVERED (候选已落盘，测试与探针全部通过)  
**对应任务包**: `docs/refactor/GEMINI-MEMORY-PROVENANCE-PACKAGE-20261101.md`  
**候选实现**: `shell/memory/provenance-candidate.cjs`  
**回归测试**: `tests/regression/memory-provenance-candidate-test.mjs` (5/5 PASS)  
**能力探针**: `tests/probes/memory-provenance-candidate-probe.mjs` (5/5 PASS)

---

## 1. 架构原则与纯数据策略层设计

本模块作为记忆系统的**纯数据策略层**，不直接执行数据库 SQL、不操作 UI、不发起模型召回网络请求，专注于保证记忆在跨对话、跨租户流转时的**溯源保真、范围隔离与生命周期失效安全**：

```javascript
const {
  normalizeMemoryRecord,    // 记忆记录规范化与准入校验
  selectRecallableMemories, // 跨对话与租户的安全召回筛选
  invalidateMemorySources,  // 来源失效与撤销检测
  PROVENANCE_KINDS,
  MEMORY_SCOPES,
  LIMITS,
} = require('./provenance-candidate.cjs');
```

### 1.1 三类来源溯源 (Provenance Classification)
系统严格区分三类记忆来源，打破以往“模型推断自动等同事实”的隐患：
1. `user-explicit-confirmation`: 用户明确确认（通过系统 UI 弹窗或授权命令确认，高可信，`confirmed: true`）。
2. `user-verbatim-statement`: 用户对话原话（直接陈述，`confirmed: true`，明确记录 `confirmedBy: 'user-statement'`）。
3. `model-inference`: 模型自主推断。
   - **铁律**: 模型推断默认 `confirmed: false`，默认召回时被排除在可信记忆之外。
   - **防 Prompt 伪造确认**: 严禁模型在 Prompt 中自称“用户已确认”而自报 `confirmed: true`。若无宿主外部可信鉴权凭据 (`options.hostAssertion`)，任何自报确认均被前置抛出 `MEMORY_UNVERIFIED_INFERENCE_CONFIRMATION_FORBIDDEN` 强行阻断。

### 1.2 会话与租户多级范围隔离 (Conversation Scoping)
- `scope: 'user'`: 用户全局记忆，可在该用户的所有会话间流通。
- `scope: 'conversation'`: 单会话专属临时记忆，强制绑定 `conversationId`。
- **防越权泄漏**: 在 `selectRecallableMemories` 召回时，非当前活跃会话的对话专属记忆被严格阻断并记录 `REJECTED_CONVERSATION_MISMATCH`；跨租户与跨用户分别被判定为 `REJECTED_CROSS_TENANT` 与 `REJECTED_CROSS_USER`。

### 1.3 来源失效与快照过期 (Stale Snapshot Detection)
- 记忆记录与源文件/消息强绑定（记录 `source.id`, `source.hash`, `source.version`）。
- 当宿主发现源文件被删除、修改（SHA-256 改变）或版本升级，`invalidateMemorySources` 立即返回 `{ valid: false, reason, revisionTrigger: true }`。
- 召回引擎自动输出最新的 `snapshotRevision` 水位线；若客户端持有的旧快照小于最新水位线，或存在失效记忆，返回 `stale: true`，为宿主调用 `tasks/memory-run-invalidation.cjs` 的 `cancelActiveRunsForMemoryChange` 清理热会话与取消 Run 提供确定性依据。

### 1.4 错误信息安全与限额防御
- **绝不泄漏记忆正文**: 无论发生何种校验错误（如保留内部键 `$model`、Key 超长、格式非法），抛出的 `Error.message` 严禁出现记忆内容 `value`，防止敏感凭据泄漏到监控或日志系统。
- **预算硬限**: 最大召回条数硬限 100（默认 20），字符预算硬限 20,000（默认 4,000）；采用确定性稳定排序（`updatedAt` 降序，`key` 字典序升序）。

---

## 2. 验证命令与测试记录

### 2.1 单元回归测试
**命令**:
```bash
node --test tests/regression/memory-provenance-candidate-test.mjs
```
**输出**:
```text
✔ Memory Provenance - normalizeMemoryRecord 基础门禁与保留键拒绝 (0.669084ms)
✔ Memory Provenance - 三类来源分类与推断不可自授权确认 (0.923166ms)
✔ Memory Provenance - 对话级别与多租户/用户严格隔离 (5.28125ms)
✔ Memory Provenance - 来源失效与快照过期 (Stale Snapshot Detection) (0.184916ms)
✔ Memory Provenance - 确定性排序与字符预算截断 (0.10725ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 43.333708
```

### 2.2 探针全流程验证
**命令**:
```bash
node tests/probes/memory-provenance-candidate-probe.mjs
```
**输出**:
```text
=== 记忆来源、确认与范围策略候选探针开始 ===

[1/5] 验证候选模块在临时隔离目录中的可移植加载能力...
  ✔ 临时隔离目录加载与纯函数导出契约校验成功

[2/5] 验证三类来源区分：模型推断不能默认变事实，宿主授权方可生效...
  ✔ [PASS] 模型推断默认 confirmed: false，召回时默认排除
  ✔ [PASS] 宿主外部鉴权通道确认模型推断为已确认事实

[3/5] 验证会话级范围 (conversation scope) 隔离与防泄露...
  ✔ [PASS] 多会话混排记忆按当前 conversationId 严格隔离

[4/5] 验证来源变更失效、revision 自增与宿主 Run 取消接缝...
  ✔ [PASS] 来源文档变更或记忆撤回生成确定性 revision 接缝

[5/5] 验证原型污染防御与错误信息零正文泄漏...
  ✔ [PASS] 输入非法原型与极端参数时安全拦截，错误信息不带记忆正文

=== 探针完成：共执行 5 项用例，通过 5 项，失败 0 项 ===
```

---

## 3. 文件与 SHA256 清单

| 文件路径 | SHA256 校验和 | 职责说明 |
|---|---|---|
| `shell/memory/provenance-candidate.cjs` | `640bd59e6ff5182c6dde6e65adb08ed2d1f20aeb03a5f6fb2e9053fd5bbc7c8d` | 记忆来源、确认与范围策略核心候选库 |
| `tests/regression/memory-provenance-candidate-test.mjs` | `e98d4a73fd731cb374a99115153db59b9c126b0732dbbcb0b4184c3d183f2071` | 单元回归测试集（覆盖 5 项核心准则） |
| `tests/probes/memory-provenance-candidate-probe.mjs` | `c003ba4380e3769d7f09b09fe8ec1c0ff732d1b952003a5481b3efad729a4dae` | 探针测试集（包含隔离加载、来源失效、范围隔离测试） |
| `docs/refactor/evidence/GEMINI-MEMORY-PROVENANCE-20261101.md` | - | 本实证报告文件 |
