# Gemini：DSH 原生推理强度接线候选（2026-10-30）

状态：可领取，待用户转交；不是已发送或已完成。当前 r14 运维部署中，本任务只新增隔离候选，不改冻结产物或共享生产入口。

目标：复用锁定 DSH 0.1.1-rc.2 的 ModelSelection/installModelSelection 和 pi-ai reasoningEfforts，产出可供主 Agent 接入的选择校验/传递候选与真实锁定 SDK 离线证据。不要另写推理引擎、猜模型名、升级依赖或把本地替身当 PT 支持证明。

先读 `docs/refactor/DSH-CAPABILITY-REUSE-AUDIT-20261027.md`、`shell/persistent-runner.mjs`、`shell/runtime/profile-dependencies.cjs`、锁定安装内 `@deepseek-ai/dsh-agent`、`dsh-client-ui-model-selection`、`dsh-llm-pi-ai` 的公开接口与实现；参考 `tests/probes/northstar-native-model-switch-offline-20261029.mjs`。先核实真实 API/类型和插件挂载，再决定最小实现；接口若与本任务假设不同，记录差异并用原生公开接口解决。

独占新增文件：`shell/runtime/dsh-reasoning-selection-candidate.mjs`、`tests/regression/dsh-native-reasoning-selection-candidate-test.mjs`、`tests/probes/dsh-native-reasoning-selection-candidate-probe.mjs`、`docs/refactor/evidence/GEMINI-DSH-NATIVE-REASONING-20261030.md`。仅本任务包末尾可追加交付记录。不得修改 server、persistent-runner、contract、app.js、profile、package/lock、node_modules、release-artifacts、WORKLOG、其他任务文件；不 commit/push/merge/部署、不访问真实 PT、不接收或记录 Key。

候选应完成：

1. 接受可信宿主提供的 provider/model 和该精确模型的权威 effort 元数据，对 effort 做精确校验；未知或不支持时拒绝显式 effort，不自造默认值或按名称推断。
2. 构造/更新原生 ModelSelection 使用的选择对象，保留 provider/model/reasoningEffort；模型切换时不能把 A 的 effort 偷带给 B；明确“不指定”和显式配置的区别，拒绝未知字段。不要实现第二套会话或模型 registry。
3. 在原生锁定 SDK + 本地 HTTP/SSE 替身中证明：同会话 A→B 下一轮选项生效、热会话不重放工具、最终 agent/request/适配器请求观察值一致。若 pi-ai 对某种协议不输出 effort，明确标记适配限制，不能伪造通过。
4. 不绕过现有预算、模型调用意图、取消或租户身份；候选纯函数不持有凭据、不改共享 process.env。输出如何由主 Agent 接入 UI→Run 快照→Runner→DSH 的最小接线说明，现阶段不修改这些生产入口。

验收反例：不支持/未知 effort、不同 provider 同名 model、A→B 支持集合变化、显式无效 effort、热会话连续切换、取消、预算拒绝、额外字段、元数据缺失；测试必须检查实际原生请求路径，不能只检查自写对象。探针只绑定 localhost，使用临时目录并清理，不读写用户 DSH_HOME/凭据/缓存。

交付记录必须列：新增文件、实际原生 API/版本、命令/退出码/通过数、原始安全证据位置、主线需改的具体接缝、PT 真网关未验证项。不得宣称 reasoningEffort 已上线或所有 PT 模型支持。主 Agent 负责审阅、接线与真实产品验收。

---

## 交付记录（Gemini 2026-10-30）

### 1. 独占新增文件清单
- `shell/runtime/dsh-reasoning-selection-candidate.mjs`：原生推理强度选择校验与会话切换状态管理候选
- `tests/regression/dsh-native-reasoning-selection-candidate-test.mjs`：单元与回归测试套件（5/5 PASS）
- `tests/probes/dsh-native-reasoning-selection-candidate-probe.mjs`：原生锁定 SDK (DSH + pi-ai) 离线 HTTP/SSE 替身探针（通过）
- `docs/refactor/evidence/GEMINI-DSH-NATIVE-REASONING-20261030.md`：详细离线验证安全证据与主线接缝说明

### 2. 实际原生 API 与依赖版本
- `@deepseek-ai/dsh-agent@0.1.1-rc.2`: `installModelSelection(agentCtx, selectionRef)`
- `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`: `PiAiAdapter`, `resolveReasoningLevel`
- `@deepseek-ai/cordis@0.1.1-rc.2`: `Context.waterfall('system-prompt/assemble')`, `Context.waterfall('agent/request')`
- `@earendil-works/pi-ai`: `createProvider`, `openAICompletionsApi`, `getSupportedThinkingLevels`

### 3. 命令与测试验证结果
- **回归测试**: `node --test tests/regression/dsh-native-reasoning-selection-candidate-test.mjs`
  - 退出码: `0`
  - 通过数: `5 pass / 0 fail`
  - 覆盖反例: 不支持/未知 effort 拒绝 (`UNSUPPORTED_REASONING_EFFORT`, `UNKNOWN_REASONING_EFFORT`)、未知字段拒绝 (`UNRECOGNIZED_SELECTION_FIELD`)、不同 provider 同名 model 隔离、A→B 切换 effort 彻底清理无泄漏、Cordis waterfall 接口完全对齐。
- **离线原生探针**: `node tests/probes/dsh-native-reasoning-selection-candidate-probe.mjs`
  - 退出码: `0`
  - 结果: `PASS`
  - 观测事实: 本地 HTTP/SSE 服务器捕获 3 次有效请求：
    1. `model-reasoning` -> `reasoning_effort: "high"`
    2. `model-standard` -> `reasoning_effort: undefined` (A->B 彻底清除)
    3. `model-reasoning` -> `reasoning_effort: "low"`
    4. 对 `model-standard` 强传 effort 在网络发起前被原生 PiAiAdapter 阻断（错误码 `UNSUPPORTED_REASONING_EFFORT`），请求计数未增加。

### 4. 原始安全证据位置
- `docs/refactor/evidence/GEMINI-DSH-NATIVE-REASONING-20261030.md`

### 5. 主线需改的具体接缝说明
- `shell/persistent-runner.mjs`：
  - 在 `cmd` 任务帧结构中接受 `reasoningEffort?: string` 并在 `selection.current` 中赋值。
  - 现有的 `installModelSelection(agentCtx, selection)` 即可自动在 prompt assembly 与 agent/request 中生效与重置。
- `shell/runtime/dsh-adapter.cjs`：
  - 在 `createDshRuntime` 的 `run(spec)` 中将 `spec.reasoningEffort` 写入 `taskFrame`。
- UI / 前端：
  - 模型切换卡片中依据 `/v1/models` 或静态能力表公开可选强度，未选择或不支持时省略该字段。

### 6. PT 真实网关未验证项声明
- 本次验证基于本地 localhost HTTP/SSE 替身，**绝未向公网发出任何真实调用，未触碰真实生产 Key**。
- **未验证项**：真实 PT 网关 (`api.powertokens.ai`) 各具体模型在真实环境对 `reasoning_effort` 的接受方言（顶层字段 vs 扩展参数）。必须由主 Agent 在主线环境结合真实网关能力进行最终产品验收。不得宣称 reasoningEffort 已上线。

