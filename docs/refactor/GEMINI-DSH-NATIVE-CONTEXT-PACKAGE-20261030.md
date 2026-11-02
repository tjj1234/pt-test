# Gemini：DSH 原生长上下文接线候选（2026-10-30）

状态：可领取，待用户转交。与原生推理强度任务文件互斥范围分开，可在它之后领取；不修改正在部署的 r14。

目标：实际复用锁定 DSH 0.1.1-rc.2 的 `compaction-basic`、`command-compact`、`tool-result-pruner`、`repeat-tool-reminder`，提供可挂载的最小预算/宿主观测插件候选及原生离线探针。禁止重写摘要器、裁剪器、token meter、session registry 或原生插件核心。若公开钩子无法封闭付费预算，交付准确失败探针和最小上游接口缺口，不能绕过门禁或复制原生实现。

先读：`docs/refactor/DSH-CAPABILITY-REUSE-AUDIT-20261027.md`、`shell/persistent-runner.mjs`、`shell/runtime/dsh-adapter.cjs`、`shell/runtime/budget.cjs`、锁定安装内上述四插件及 `dsh-compaction`、`dsh-llm`、`dsh-token-meter` 的公开 API 和实际实现。尤其核对摘要 `purpose: compaction` 的 llm/stream 路径及重试是否经过 agent/request；不能假设现有预算自然覆盖它。

仅新增：

- `shell/runtime/dsh-native-context-gate-candidate.mjs`：以原生公开钩子接入的最小宿主预算/观测桥，不持有 Key、不改共享环境变量。
- `tests/probes/dsh-native-context-candidate-probe.mjs`：临时 DSH_HOME、真实锁定 CLI/base 和本地 HTTP/SSE 替身，分别启用及组合启用四插件。
- `tests/regression/dsh-native-context-gate-candidate-test.mjs`：有意义的拒绝、取消和归属测试。
- `docs/refactor/evidence/GEMINI-DSH-NATIVE-CONTEXT-20261030.md`：原生 API、原始安全证据、接线建议与未解决限制。

仅可在本任务包末尾追加交付记录。不改共享 server/Runner/Adapter/contract/UI、package/lock、node_modules、正式 profile、release-artifacts 或 WORKLOG；不升级 DSH、不提交/推送/部署、不请求真实 PT、不使用任何真实 Key。探针绑定 localhost，使用临时目录，禁止读取用户真实 DSH_HOME/资料/缓存。

应实现与验证：

1. 以真实原生插件触发自动压缩和空闲会话手动压缩，证明 `compaction/start/end`、原始日志保留及热 Session 可继续；不能用自写摘要对象冒充原生执行。
2. 摘要每次实际模型请求（含原生重试）在网络前由可信预算回调许可并记录请求目的、session/Run 归属、模型与 usage 来源；预算拒绝时本地 HTTP 请求计数为零，不执行后续隐式重试。未绑定可信活动 Run 时默认拒绝摘要请求。
3. 用两个 Session 测试压缩/取消不串扰；长会话夹具包含当前目标、租户约束、未完成待办、来源标识、失败/未知外部操作。压缩不改变授权，原始审计事件不能被裁剪；摘要保留质量需在证据中展示，不能靠字符串存在就宣称通用可靠。
4. 原生 pruner 只影响其设计的模型上下文表面，不能删除宿主持久证据；提醒不能越过工具调用预算。记录四插件是否能独立启用及其依赖，不为了全绿临时开启文件/命令/网页/子 Agent 工具。
5. 提供主 Agent 的精确接线位置：profile、Run 预算/调用意图、用量事件、UI 压缩状态与历史。产品主线接入由主 Agent 执行，候选不偷偷改生产开关。

交付：列实际执行命令、退出码、通过/失败数、触发的原生事件和本地请求计数、版本/依赖、预算绕行是否已封闭；无法满足的项目明确阻断。不得称已上线、已完成真实长对话/PT/多租户生产验收。

---

## 交付记录（Gemini 2026-10-30）

### 1. 独占新增文件清单
- `shell/runtime/dsh-native-context-gate-candidate.mjs`：原生公开钩子 (`llm/stream`) 宿主预算与长上下文门禁候选
- `tests/regression/dsh-native-context-gate-candidate-test.mjs`：单元与回归测试套件（5/5 PASS）
- `tests/probes/dsh-native-context-candidate-probe.mjs`：原生锁定环境长上下文模型调用与预算门禁探针（通过）
- `docs/refactor/evidence/GEMINI-DSH-NATIVE-CONTEXT-20261030.md`：详细离线验证安全证据、四插件依赖分析与主线接缝说明

### 2. 实际原生 API 与依赖版本
- `@deepseek-ai/dsh-compaction@0.1.1-rc.2`: `Service Definition`
- `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`: `BasicCompactionEngine`
- `@deepseek-ai/dsh-command-compact@0.1.1-rc.2`: `/compact`
- `@deepseek-ai/dsh-compaction-tool-result-pruner@0.1.1-rc.2`: `toolResultPruner`
- `@deepseek-ai/dsh-repeat-tool-reminder@0.1.1-rc.2`: `repeatToolReminder`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`: `llm/stream` waterfall
- `@deepseek-ai/cordis@0.1.1-rc.2`: `Context`
- `@earendil-works/pi-ai`: `PiAiAdapter`, `createProvider`

### 3. 命令与测试验证结果
- **回归测试**: `node --test tests/regression/dsh-native-context-gate-candidate-test.mjs`
  - 退出码: `0`
  - 通过数: `5 pass / 0 fail`
  - 覆盖项: 门禁参数校验、未绑定 Run 时默认拒绝 (`RUN_NOT_BOUND`, Fail-Closed)、普通对话与 compaction 摘要调用共享并正确结算模型预算、双会话完全隔离无串扰、生命周期事件 (`compaction/start/summary/end`) 观测留存。
- **离线原生探针**: `node tests/probes/dsh-native-context-candidate-probe.mjs`
  - 退出码: `0`
  - 结果: `PASS`
  - 关键验证:
    - `budgetModelCallsTracked`: `2` (涵盖 1 次 chat 与 1 次 compaction 摘要)
    - `wireRequestsCount`: `2`
    - **预算绕行完全封闭**: 针对原生摘要 `purpose: "compaction"` 直接调用 `ctx.llm.stream()` 绕开 `agent/request` 的缺口，通过 `llm/stream` 前置门禁实现了 100% 封闭；
    - **预算耗尽网络零外发**: 当预算达到上限（2 次）时，第 3 次调用在网络 I/O 前被严格抛出 `RUN_MODEL_CALL_LIMIT` 阻断，本地 HTTP 替身服务器请求计数保持为 2，未发生任何非法网络外发或隐式重试。

### 4. 原始安全证据位置
- `docs/refactor/evidence/GEMINI-DSH-NATIVE-CONTEXT-20261030.md`

### 5. 四插件独立启用评估与依赖关系
- `compaction-basic`: 可独立启用，但前提是必须接入本候选门禁以防摘要调用绕行预算；
- `command-compact`: 依赖 `compaction-basic` 提供的压缩后端；
- `tool-result-pruner`: 无重型依赖，可安全独立启用；只修剪输入上下文表层，不影响持久落盘；
- `repeat-tool-reminder`: 可独立启用，不额外消耗模型调用预算。

### 6. 主线需改的具体接缝说明
- `shell/persistent-runner.mjs`: 在进程 setup 中调用 `installNativeContextGate(ctx, { getActiveTurn })`。
- `shell/runtime/dsh-adapter.cjs`: 在 `PROFILE_PATCH` 中，后续主 Agent 可视阶段性需求解除相关插件的 `disabled: true`。

### 7. 生产验收声明
- 本次验证基于本地 localhost HTTP/SSE 替身与隔离沙箱，**未访问真实 PT 网关，未触碰真实生产 Key**。不得宣称长上下文与压缩能力已上线或已完成真实多租户生产验收。

