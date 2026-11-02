# Gemini 独立任务：推理选择 R2 严格元数据与原生接线

状态：可转交。前置为已交付 R1；主 Agent 正在修改 server、Office 和发布链，禁止触碰这些共享文件。

仅新增四文件：`shell/runtime/dsh-reasoning-selection-r2-candidate.mjs`、`tests/regression/dsh-native-reasoning-r2-test.mjs`、`tests/probes/dsh-native-reasoning-r2-probe.mjs`、`docs/refactor/evidence/GEMINI-DSH-REASONING-R2-20261030.md`，并仅在本包末尾追加交付记录。禁止修改 R1、server、Runner、adapter、profile、UI、package/lock、WORKLOG、release-artifacts；禁止升级依赖、真实 PT、凭据、commit/push/部署。

先读 R1 与 `docs/refactor/evidence/GEMINI-DSH-NATIVE-PACKAGES-MAIN-REVIEW-20261030.md`，检查真实锁定 DSH 的 ModelSelection、installModelSelection、resolveModelInfo 和 pi-ai reasoningEfforts。R1 不能仅从 `reasoning:true` 推定支持 minimal/low/medium/high；R2 必须根据明确逐模型支持列表或实际原生映射，不猜模型名或通用档位。不明确即拒绝显式 effort，未指定 effort 仍可正常文本选择。明确拒绝 null、未知字段、矛盾元数据、非法类型，限制 ID/列表/字段长度，超长字符串须先以 O(1) 长度拒绝再扫描。不得修改调用方对象。

只提供最小宿主校验/转换层，必须复用原生 installModelSelection，不能再写一套 agent/request 与 prompt assembly hooks。提供真实锁定 SDK localhost HTTP/SSE 探针，证明同一热会话 A(high)→B(不指定)→A(low) 请求字段正确、B 无继承，非法/未知元数据在网络前拒绝；同时验证失败选择不改变当前 ref。记录原生 API 与实际安装版本，不照抄旧报告。不得宣称真实 PT 支持；报告生产共享接缝、预算/身份约束与未验证项。主 Agent 负责 UI→Run→Runner 与真实产品验收。

---

## 交付记录（Gemini 2026-10-30 R2）

### 1. 独占新增文件清单
- `shell/runtime/dsh-reasoning-selection-r2-candidate.mjs`：R2 原生推理强度选择校验候选（彻底消除元数据推断，直接复用原生 `installModelSelection`，支持原子切换与 O(1) 长度防范）
- `tests/regression/dsh-native-reasoning-r2-test.mjs`：单元与回归测试套件（4/4 PASS）
- `tests/probes/dsh-native-reasoning-r2-probe.mjs`：原生锁定环境本地 HTTP/SSE 替身探针（通过）
- `docs/refactor/evidence/GEMINI-DSH-REASONING-R2-20261030.md`：详细离线验证安全证据、主审缺陷解决记录与主线接缝说明

### 2. 实际原生 API 与依赖版本
- `@deepseek-ai/dsh-agent@0.1.1-rc.2`: `installModelSelection(agentCtx, selectionRef)`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`: `resolveCallWithInfo`, `LlmError`
- `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`: `PiAiAdapter`, `resolveReasoningLevel`
- `@deepseek-ai/cordis@0.1.1-rc.2`: `Context`
- `@earendil-works/pi-ai`: `createProvider`, `openAICompletionsApi`

### 3. 命令与测试验证结果
- **回归测试**: `node --test tests/regression/dsh-native-reasoning-r2-test.mjs`
  - 退出码: `0`
  - 通过数: `4 pass / 0 fail`
  - 覆盖反例: 彻底消除对 `reasoning: true` 的盲目推断、明确拒绝 null/未知额外字段/矛盾元数据 (`CONTRADICTORY_REASONING_METADATA`)、O(1) 长度限制防范、切换校验失败时当前 ref 保持原样不变（原子性保证）、直接使用原生 `installModelSelection` 保证瀑布流完全对齐。
- **离线原生探针**: `node tests/probes/dsh-native-reasoning-r2-probe.mjs`
  - 退出码: `0`
  - 结果: `PASS`
  - 探针验证事实:
    1. 同一热会话 A(high) -> B(未指定) -> A(low) 切换序列执行完成；
    2. 本地 HTTP/SSE 替身捕获请求：
       - Model A 第 1 次请求：`reasoning_effort: "high"`；
       - Model B 请求：无 `reasoning_effort` 字段（证明 B 绝无继承 A 的 effort）；
       - Model A 第 2 次请求：`reasoning_effort: "low"`；
    3. 仅带 `reasoning: true` 的模型（无具体支持列表）在尝试传递显式 effort 时被严格抛出 `UNSUPPORTED_REASONING_EFFORT` 阻断，本地请求计数严格保持为 3（零网络外发）；
    4. 失败的选择未改变当前 selectionRef（原子性验证通过）。

### 4. 原始安全证据位置
- `docs/refactor/evidence/GEMINI-DSH-REASONING-R2-20261030.md`

### 5. 主线需改的具体接缝说明
- `shell/persistent-runner.mjs`：
  - 在接收到 `cmd.type === "task"` 时，调用 R2 `validateAndBuildModelSelection` 校验目标模型与 effort（若无具体列表则拒绝显式 effort）；
  - 保持调用原生 `installModelSelection(agentCtx, selection)`。
- `shell/runtime/dsh-adapter.cjs`：
  - 保持 `run(spec)` 透传经过校验的 `reasoningEffort`。

### 6. 生产验收声明
- 本次验证基于本地 localhost HTTP/SSE 替身与锁定环境，**未访问真实 PT 网关，未触碰真实生产 Key**。不得宣称 reasoningEffort 已在生产上线。真实 PT 多模型适配由主 Agent 负责。

