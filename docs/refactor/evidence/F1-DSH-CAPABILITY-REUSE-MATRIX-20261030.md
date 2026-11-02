# F1 r14 对《DSH-CAPABILITY-REUSE-AUDIT》的逐项落地核对

**结论：F1 接上了 DSH Agent/文本模型执行、模型选择钩子、热 Session、事件/工具调用框架与取消；没有接上 DSH 的 Web 产品面，也没有开放审计列出的 28 个禁用插件。** 媒体、PT 动态资格、租户 ACL、持久 Run/外部付费操作、托管产物和历史 UI 是北极星自有接线，不能计为 DSH 原生能力。F1 r14 归档 SHA-256 `f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993`；包内 `dsh-adapter.cjs`、`persistent-runner.mjs`、`contract.cjs`、`tenant.cjs`、`server.cjs`、`package.json` 与本轮所查源码逐字节一致。以下是包内静态接线加既有本地真实产品/锁定 SDK 证据，**不是目标机线上加载或发布验收**。

## 真正复用 DSH 的路径

| 能力 | F1 r14 实际接线 | 验证边界 |
|---|---|---|
| Agent 与文本模型 | 生成 profile 仅装 `@deepseek-ai/dsh-base`；Runner 从 `agents` 创建 Agent，以 `agent.followup(createUserMessage(...))` 发轮次，锁定 DSH/pi-ai 执行文本模型。 | 本地真实 PT 普通聊天及同会话 A→B 两轮 completed；不是自写 LLM Agent 内核。 |
| 模型选择 | Runner 调 DSH `installModelSelection`，每轮更新 provider/model；北极星在 `agent/request` 前做预算和调用意图。 | 本地真实产品 A→B 请求/POST 与选定模型一致；上游 `responseModel` 缺失时身份仍 `unknown`，不能从请求推断实际路由。`reasoningEffort` 没贯通。 |
| Session/流式/取消 | DSH `agents.create` 的 Session 在热轮次复用；Runner 读 `session/event` 的 delta、tool call/result、turn end，调用 `sessions.flush` 与 `agent.cancel`。 | DSH 热会话和事件链确已用；冷启动历史由北极星持久历史注入，浏览器历史/Run/媒体回读仍由北极星负责，不是 DSH 原生查询 UI。 |
| 工具机制 | Runner 以 DSH `defineTool`/`agentCtx.tools.register` 注册工具，模型经 DSH 发出 `tool/call`、`tool/result`；具体 `media_route`、CSV、GA、归因等通过北极星 host RPC 与 ACL/预算执行。 | 复用 DSH 工具调用框架；业务工具实现、付费提交、外部操作账本与托管媒体均非 DSH 原生。 |
| 用量/轨迹 | 从 DSH Session 事件读取响应 usage 与模型身份，再写北极星 Run 预算、事件和历史。 | 事件来源是 DSH；实际美元账单仍未知，DSH token/调用次数不是货币硬上限。 |

## 审计列出的 28 个 profile 禁用项

下面每行在 r14 的 `PROFILE_PATCH` 中仍为 `disabled: true`。`安全边界`只表示有多租户/凭据/权限或自主调用风险；标注“推断”的项没有独立批准记录。`产品/策略空缺`表示不应把未接线说成安全决策。

| ID | F1 状态 | 关闭性质与具体边界 |
|---|---|---|
| `hmr` | 关 | 发布稳定性；用 manifest 覆盖的无操作兼容服务满足启动接口，不是启用热重载。非多租户安全验收项。 |
| `session-title-llm` | 关 | 额外模型调用、标题账本/去重未接；非已证明的多租户隔离决定。 |
| `user-questions` | 关 | 自有 UI 缺暂停、提问、恢复及 Run 状态协议；产品空缺。 |
| `compaction-basic` | 关 | 长对话压缩未接，原生摘要请求尚未纳入北极星预算与租户来源约束；未见逐项关闭决定，下一期。 |
| `command-compact` | 关 | 依赖压缩且自有 UI 无命令入口；下一期。 |
| `tool-bash` | 关 | 安全边界：T05 未证明 child 的 OS 级命令、文件、网络、进程隔离。 |
| `tool-pwsh` | 关 | 同 Bash；目标平台适配还需核查。 |
| `tool-jobs` | 关 | 安全边界：后台进程生命周期、租户权限、取消和预算/Run 归属未验。 |
| `tool-fs` | 关 | 安全边界：cwd 不能当沙箱，路径越界与跨租户文件访问未封闭。 |
| `tool-fs-search` | 关 | 安全边界：索引/搜索范围可能跨租户目录。 |
| `tool-skill` | 关 | 安全/可信发布边界：Skill 来源、租户准入、版本固定与模型可读范围未闭合；不等于 DSH registry 不存在。 |
| `subagent` | 关 | 安全边界：子 Agent 身份、凭据继承、并发付费与 Run 归属未验；逐项批准记录缺失。 |
| `subagent-spawn-in-process` | 关 | 同上，另有进程内共享状态边界。 |
| `subagent-fork-in-process` | 关 | 同上，另有会话/工作区继承边界。 |
| `tool-subagent-control` | 关 | 子 Agent 的控制、取消及宿主 Run 归属未验。 |
| `tool-subagent-list-agents` | 关 | 即使只读，清单可见性也需租户过滤；未单独启用。 |
| `tool-subagent` | 关 | 子 Agent 调用的租户授权、资源和预算未验。 |
| `tool-subagent-fork` | 关 | 分叉的会话/凭据继承与费用归属未验。 |
| `tool-subagent-report` | 关 | 报告的租户可见性与 Run 归属未验。 |
| `workflow-worker-thread` | 关 | 线程并发、权限、资源/生命周期与 Run 未绑定；安全理由属审计推断。 |
| `tool-workflow` | 关 | 依赖工作流线程，预算、取消/恢复及权限未验；安全理由属审计推断。 |
| `tool-result-pruner` | 关 | 结果裁剪未接；需保护来源、用量和审计记录。没有逐项关闭决定，不能算已交付。 |
| `tool-todo` | 关 | 自有 UI/历史无原生待办状态，Run 工具预算需单列；产品空缺。 |
| `tool-goal` | 关 | 原生 Goal 与北极星任务/Run 状态、预算和 UI 未对齐；产品空缺。 |
| `tool-ralph` | 关 | 自主循环可能放大模型/工具费用，缺停止、权限、恢复和预算验收；安全/费用边界属推断。 |
| `tool-str-replace-editor` | 关 | 文件写入的租户隔离、路径与审计问题同 `tool-fs`。 |
| `repeat-tool-reminder` | 关 | 原生重复调用提醒未验证与现有 0/1 工具预算的交互；不是 T05 OS 隔离问题。 |
| `tool-web` | 关 | 出网/SSRF、搜索提供方凭据与费用、来源证据未验；DSH base 本身还设 `fetch:false`。 |

## 容易误报为“DSH 已接”的其他条目

| 审计条目 | F1 r14 的准确状态 |
|---|---|
| DSH Skill registry/filesystem | `dsh-base` 底层挂载；北极星只初始化租户 `.dsh/skills` 目录。`tool-skill` 关闭；`/api/skills` 列业务 `toolsRegistry` 卡片，不是 DSH Skill 安装、读取或发布。 |
| 推理强度 | DSH `session.selectModel` 可带 `reasoningEffort`，但 F1 Runner 每轮只传 provider/model；自有 UI 没有 effort 输入，“思考中”是等待动画。下一期候选，不属本次 F1 验收。 |
| 模型目录/菜单 | DSH 模型选择钩子被复用；同 Key PT 目录、权限与 model×task 资格由北极星实现。原生 DSH 模型菜单属于未装配的 `dsh-web-app`。 |
| Session 查询/投影 | DSH JSONL Session/投影挂载且热 Session/flush 已用；`session-query-sqlite` 的全文搜索默认 `openAt: never`。北极星历史、Run、ACL、产物与外部操作记录仍是自有链，不可说成 DSH 原生历史 UI。 |
| OTEL、Skill badge、Web fetch | base 默认 OTEL `DISABLED`、`skill-badge` disabled、`tool-web.fetch:false`，非北极星 28 项额外关闭；未作为 F1 产品能力交付。 |
| 沙箱/审批 | DSH base 插件存在，但 F1 没有开放 Bash/FS/Web/子 Agent 等原生危险工具，不能从插件挂载推出已取得 OS 多租户隔离或用户审批验收。 |
| `dsh-web-app` | r14 profile 依赖合成只选 `@deepseek-ai/dsh-base`；DSH 原生模型菜单、Skills、Plan、用户提问、Jobs、Goals、权限、附件、工作区、交付物、轨迹与会话 Web UI 均未装配。北极星自有 Web 壳的同名界面不算复用这些组件。 |

**证据入口：**[原审计](../DSH-CAPABILITY-REUSE-AUDIT-20261027.md)；`shell/runtime/dsh-adapter.cjs:182-245`（profile）、`shell/runtime/profile-dependencies.cjs:29`（仅 base）、`shell/persistent-runner.mjs:232-335,393-464,765-792`（原生 Agent/模型选择/Session/工具）、`shell/runtime/contract.cjs:17-53`（冷/热边界）、`shell/server.cjs:1845-1891`（业务 Skill 卡片）、[真实 A→B 与媒体记录](F1-live-test-and-model-intent-fix-20261029.md)、[r13/r14 归档门禁](F1-candidate34-r13-20261030-release-gate.md)。原审计末尾已记录用户范围决定：推理强度、Skill 发布、压缩、联网搜索放下一期，F1 不扩项。
