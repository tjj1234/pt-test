# 北极星与 DSH 功能复用审计（2026-10-27）

**结论**：当前北极星使用固定的 DSH `0.1.1-rc.2` 的 `dsh-base` 作为 Agent 内核和持久 Runner，但使用自有 Web 壳，没有装配 `dsh-web-app`。运行 profile 明确禁用 **28 个插件 ID（含 HMR）**。关闭文件、命令、网络及子 Agent 入口有多租户安全依据；关闭上下文压缩、结果裁剪、待办、用户提问等功能尚未找到逐项决策依据，值得优先复核。Skill 的发现/加载已有 DSH 原生机制，北极星仅做租户目录初始化和另一套业务工具卡片，尚无完整安装/发布链。DSH 也已有按模型选择推理强度的能力；北极星目前没有接通该参数，界面“思考中”只是等待动画。

## 核查边界与状态词

依据当前工作区 `shell/runtime/dsh-adapter.cjs` 的 `PROFILE_PATCH`、固定依赖内 `@deepseek-ai/dsh-base/cordis.patch.yml` 与 `@deepseek-ai/dsh-web-app/cordis.patch.yml`、北极星 Runner/UI、T05/T13/T14 证据。当前工作区有大量未提交变更；本表是**此刻源码静态核查**，不是线上加载清单或用户端验收。以下“明确关闭”指北极星 profile 写入 `disabled: true`；“未装配”指 Web 包没有进入北极星 composition；“无产品入口”指底层插件可能挂载但当前 UI/调用链未用到。不能把这些状态混为一谈。

## 北极星明确关闭的全部 28 项

| ID | DSH 原功能 | 当前关闭原因/证据 | 复用判断 |
|---|---|---|---|
| `hmr` | 配置/插件热重载 | 固定生产 profile 的稳定性推断；未见逐项决策记录 | 生产可维持关闭 |
| `session-title-llm` | 模型生成会话标题 | 可能避免额外付费调用；未见逐项记录 | 与北极星会话标题链核对后再开 |
| `user-questions` | Agent 向用户提问 | 未见逐项记录 | 应核查是否能复用原生交互 |
| `compaction-basic` | 长对话上下文压缩 | 未见逐项记录；关闭会影响长会话 | 优先验证和恢复候选 |
| `command-compact` | 手动压缩命令 | 依赖压缩能力；未见逐项记录 | 随压缩一起评估 |
| `tool-bash` | Bash 命令执行 | T05 指出 child 无已验证 OS 文件/网络/进程隔离 | 保持关闭直至隔离验收 |
| `tool-pwsh` | PowerShell 执行 | 同上；当前 Mac 平台本身也有限制 | 保持关闭 |
| `tool-jobs` | 后台作业工具 | 可持续执行命令；T05 安全边界未成立 | 保持关闭直至隔离验收 |
| `tool-fs` | 文件操作 | T05 的 cwd 越界证据否定 cwd 是沙箱 | 保持关闭直至隔离验收 |
| `tool-fs-search` | 文件搜索 | 同上，可能跨租户/目录读取 | 保持关闭直至隔离验收 |
| `tool-skill` | 给模型列出/读取 Skill | T13/T14 测试要求禁用；Skill 内容/发布可信链未完成 | 复用 DSH 工具，但先建可信发布与 Run 固定 |
| `subagent` | 子 Agent 核心 | T05 的隔离与付费/权限边界可解释；无逐项记录 | 暂缓多租户启用 |
| `subagent-spawn-in-process` | 进程内子 Agent 创建 | 同上 | 暂缓 |
| `subagent-fork-in-process` | 进程内会话分叉 | 同上 | 暂缓 |
| `tool-subagent-control` | 子 Agent 控制 | 同上 | 暂缓 |
| `tool-subagent-list-agents` | 子 Agent 清单 | 与整体子 Agent 能力一起关闭；无逐项记录 | 可单独复核只读价值 |
| `tool-subagent` | 子 Agent 调用 | 同上 | 暂缓 |
| `tool-subagent-fork` | 子 Agent 分叉 | 同上 | 暂缓 |
| `tool-subagent-report` | 子 Agent 汇报 | 同上 | 暂缓 |
| `workflow-worker-thread` | 工作流线程运行 | 可能增加并发和执行面；无逐项记录 | 先核对业务需求/边界 |
| `tool-workflow` | 工作流工具 | 同上 | 同上 |
| `tool-result-pruner` | 工具结果裁剪 | 未见逐项记录；可能有助上下文/成本 | 优先验证和恢复候选 |
| `tool-todo` | 待办工具 | 未见逐项记录 | 可复用评估 |
| `tool-goal` | 目标工具 | 未见逐项记录 | 可复用评估 |
| `tool-ralph` | 持续执行循环 | 付费/执行次数和自主工具风险推断；无逐项记录 | 保持关闭至预算和权限验收 |
| `tool-str-replace-editor` | 文件编辑工具 | 与文件写入隔离问题相同 | 保持关闭直至隔离验收 |
| `repeat-tool-reminder` | 重复工具调用提醒 | 未见逐项记录 | 优先验证恢复候选 |
| `tool-web` | 网页搜索工具 | T14 明确禁用；T05 缺出网/SSRF 安全证明；DSH base 本身已禁任意 fetch | 先验证搜索提供方、费用与出网策略 |

上述“原因”是**已记录的安全约束或审计推断**，不代表当初每个关闭项都有独立评审。源头只有一个列表式开关。`tool-web` 底层 DSH base 只配置了 search，`fetch: false`；关闭整个工具的范围大于关闭网页抓取。`tool-pwsh` 在本机可能本来就不可用。

### 逐项复用决定：能否直接启用、所需改动、本期归属

“可直接”分两层：**可仅改 profile 开关**是工程动作，**可直接交付用户**还要求真实加载、入口、权限、费用和历史验收。当前静态证据不能证明任何一项只改开关即可作为产品功能交付。下表的“本期”以 `FUNCTION-DELIVERY-REPLAN-20261024.md` 的一期队列为准；“条件项”指一期安全/基础设施边界内按需求启用，不是承诺一期开放所有 DSH 开发者工具。

| ID | 能否直接用 | 不能直接用的原因；最小改动 | 本期归属／是否重写 |
|---|---|---|---|
| `hmr` | 否，生产无需 | 热重载与固定发布/回滚方式冲突风险；本地开发 profile 可单独试 | 否；不重写 |
| `session-title-llm` | 否 | 额外模型调用需预算/计费、与现有标题持久化去重；接 DSH 事件并验收 | 条件项；复用 DSH |
| `user-questions` | 否 | 自有 UI 无提问/暂停/恢复协议，Run 状态与超时需接线 | 条件项；复用 DSH 对话能力 |
| `compaction-basic` | 配置可试，产品不可直接用 | 压缩可能丢失租户约束、来源与关键记忆；需真实长会话/热 session 回归和用量记录 | **下一期长对话包**；复用 DSH 压缩 |
| `command-compact` | 否 | 依赖压缩，且自有 UI 无命令入口；接 UI/API 并验收 | 下一期长对话包可选入口；复用 DSH |
| `tool-bash` | 否 | 缺已验证 OS 级目录、身份、命令/出网隔离；先完成 T05 负向验收 | 条件项，T05；不重写执行器 |
| `tool-pwsh` | 否 | 同 Bash，且部署平台需确认；先完成隔离/平台验收 | 条件项，T05；不重写 |
| `tool-jobs` | 否 | 后台任务需权限、预算、取消/恢复及进程隔离；接 Run 账本 | 条件项，T05/F3；复用 DSH |
| `tool-fs` | 否 | cwd 不是沙箱；先隔离租户目录、符号链接与越界读取/写入 | 条件项，T05；复用 DSH |
| `tool-fs-search` | 否 | 文件搜索仍可能跨目录泄露；同上并限制索引范围 | 条件项，T05；复用 DSH |
| `tool-skill` | 否 | 缺可信发布/禁用、租户准入、Run 版本固定；把发布结果接原生 Skill registry | **下一期 PM 技能发布包**；复用 DSH reader/parser |
| `subagent` | 否 | 多 Agent 的租户/凭据、并发预算、Run 归属未验收 | 条件项，T05/F3；复用 DSH |
| `subagent-spawn-in-process` | 否 | 同上；进程内共享边界另需核查 | 条件项，T05/F3；复用 DSH |
| `subagent-fork-in-process` | 否 | 同上；继承会话/工作区范围须核查 | 条件项，T05/F3；复用 DSH |
| `tool-subagent-control` | 否 | 依赖子 Agent 与身份绑定/取消归属 | 条件项，T05/F3；复用 DSH |
| `tool-subagent-list-agents` | 否 | 依赖子 Agent；只读清单也需租户过滤 | 条件项，T05；复用 DSH |
| `tool-subagent` | 否 | 依赖子 Agent 的隔离、预算、Run 记录 | 条件项，T05/F3；复用 DSH |
| `tool-subagent-fork` | 否 | 分叉继承范围与资源计费需验收 | 条件项，T05/F3；复用 DSH |
| `tool-subagent-report` | 否 | 报告可见性和 Run 归属需验收 | 条件项，T05/F3；复用 DSH |
| `workflow-worker-thread` | 否 | 线程执行的权限/资源/生命周期与宿主 Run 未绑定 | 条件项，T05/F3；复用 DSH |
| `tool-workflow` | 否 | 依赖线程工作流，并需预算/取消/恢复 | 条件项，T05/F3；复用 DSH |
| `tool-result-pruner` | 配置可试，产品不可直接用 | 裁剪可能删掉来源、用量或审计证据；限定可裁剪消息，做历史回归 | **下一期长对话包**；复用 DSH |
| `tool-todo` | 配置可试，产品不可直接用 | 默认 Run 零工具、UI 无状态展示；需调整专用预算/权限并保留历史 | 条件项，Agent 任务体验；复用 DSH |
| `tool-goal` | 否 | 与现有目标/Run 状态、预算和 UI 语义未对齐 | 条件项，Agent 任务体验；复用 DSH |
| `tool-ralph` | 否 | 连续自主调用会突破当前有界 Run 策略；先完成预算/停止/恢复控制 | 条件项，T05/F3；复用 DSH |
| `tool-str-replace-editor` | 否 | 写文件有租户隔离和审计问题；先完成 T05 | 条件项，T05；复用 DSH |
| `repeat-tool-reminder` | 配置可试，产品不可直接用 | 需确认其提示不会诱发额外付费调用、破坏当前工具预算；锁定 SDK 回归 | 条件项，可在当前重构验证；复用 DSH |
| `tool-web` | 否 | 搜索提供方凭据/费用、真实来源、出网和 SSRF 边界未验收；保留 DSH 的 `fetch:false`，先接受控 search | **下一期联网研究包**；复用 DSH 搜索，补产品证据链 |

**近期可按“只开开关+回归”验证的候选仅有** `compaction-basic`、`tool-result-pruner`、`repeat-tool-reminder`；其中压缩/裁剪仍需保护来源和审计记录。`tool-todo` 还需专用工具预算，不能算只改开关。以上候选均不是“直接上线”。`session-title-llm` 与 `user-questions` 缺额外调用控制或 UI/Run 协议；其余项有明确依赖，不应直接开放。

## DSH 原生能力的其他三种状态

| 状态 | 功能 | 北极星现状 |
|---|---|---|
| DSH base 默认关闭/限用 | `skill-badge` 已 `disabled: true`；`session-query-sqlite` 的全文搜索 `openAt: never`；OTEL telemetry 默认 `DISABLED`；`tool-web.fetch: false` | 非北极星额外关闭，不能计入上述 28 项 |
| 底层挂载，产品链未用到或未验证 | `skill`、`skill-filesystem`、`plan-mode`、模型选择/推理强度、会话投影/持久化、token meter、沙箱与审批组件 | 挂载不等于有 UI、授权、OS 隔离或真实运行证据 |
| `dsh-web-app` 未装配 | 原生模型/推理强度菜单、Skills 页面、Plan、子 Agent、Jobs、Goals、用户提问、权限、附件、工作区、交付物、轨迹、设置、插件清单、会话 UI 等 | 北极星自建 Web 壳，因此这些不是 `PROFILE_PATCH` 关闭项；需逐项决定复用 UI/API 或继续自建，并核对多租户边界 |

## 重复建设与复用边界

| 能力 | DSH 已有 | 北极星当前 | 结论 |
|---|---|---|---|
| Skill 发现/读取 | `dsh-skill` registry、`dsh-skill-filesystem` 扫描 `.dsh/skills`/`.agents/skills`，`dsh-tool-skill` 给模型展示/读取 | `tenant.cjs` 首次复制共享 `.dsh/skills`；`/api/skills` 实际列的是业务 `toolsRegistry`；`tool-skill` 关闭；release-snapshot 模块尚未接入 Run loader | **部分复用、目录与展示语义分叉**。不要另写 Skill parser/registry；租户发布审批、版本固定和权限仍需北极星实现。不能称当前已有完整 Skill 安装机制 |
| 推理强度切换 | DSH 模型目录与 `session.selectModel` 支持 `{provider, model, reasoningEffort}`；pi-ai 提供每模型 `reasoningEfforts` 与校验 | Runner 调 `installModelSelection`，但每次只重置 provider/model；自有 UI 未提供 effort；“思考中”是动画；按名字猜 reasoning model 是换模型，不是切换强度 | **底层复用了一半，参数被北极星链路丢掉**。应接通 DSH 的 capability/selection，避免另造推理模式逻辑；PT 网关对具体 effort 的支持仍需实测 |
| 模型目录 | DSH 有目录与模型选择组件；pi-ai 静态配置不自行刷新 PT 权限目录 | 北极星实现同 Key 的 PT 目录、权限与 model×task 判定 | **PT 动态资格是必要适配**，但可向 DSH 的模型选择数据结构供给，而非平行维护两套选择语义 |
| 会话/历史与 Run | DSH 有 JSONL session、投影、查询、telemetry | 北极星持久 Run、租户 ACL、SSE、产物/付费操作对账 | **产品侧 Run 账本有合理新增需求**；需要映射到 DSH session/step，减少重复存储与恢复歧义，不能直接删除业务账本 |
| 工具、文件、网页、审批 | DSH 已有执行工具与插件式沙箱/审批 | 北极星 host RPC 业务工具、自有 ACL/Artifact 门禁；危险原生工具禁用 | **host 的租户/Run/外部付费门禁需要保留**；原生 OS 工具不能仅因 DSH 提供就开放，T05 尚无生产隔离证据 |
| 上下文/目标/工作流 | DSH 已有压缩、结果裁剪、Todo/Goal/Workflow | 多数被关闭；北极星另有预算/编排 | **优先审查可安全复用部分**，尤其压缩、裁剪和提醒；工作流需先解决预算/权限边界 |

### 已装配或未装配的关键功能：复用动作与一期关系

| 功能 | 能否直接用／障碍 | 最小改动 | 一期归属 |
|---|---|---|---|
| Skill 文件发现与加载 | **底层已可复用**；模型入口关闭，租户发布版本不可信 | 以 DSH registry 为唯一读取源；接可信发布、禁用、Run pin，再启 `tool-skill` | 下一期 PM 技能发布；无需重写解析/加载 |
| 推理强度切换 | **不能直接用**；Runner 丢弃 `reasoningEffort`，自有 UI 无入口，PT 模型能力未证实 | 从目录暴露精确模型支持的 effort，贯通 UI→Run→DSH selection→请求并验收 PT 实际行为 | **下一期候选**，不属于 F1 模型切换验收；不造新引擎 |
| DSH 原生模型选择 UI | **不能直接嵌入**当前自有 Web 壳，协议/登录/租户会话不同 | 复用 `ModelSelection` 数据与调用协议；保留北极星的登录和同 Key 权限过滤 | 是，F1 模型切换；无需重写选择语义 |
| DSH Plan/UI 提问/Jobs/Goals/轨迹/交付物等 Web 组件 | **不能直接打开**：整个 `dsh-web-app` 未装配，自有壳无对应 host/RPC 生命周期 | 逐项评估协议复用或嵌入成本；只接本期用户流程所需项，保留 tenant/Run 授权 | 不全部在一期承诺范围；相关长对话、任务体验、安全验收为条件项 |
| DSH session 持久化/查询 | 已作为底层存在；不能直接代替租户 Run/费用/产物账本 | 建同一 session/step 与 Run 的稳定映射，减少重复记录 | 是，F3/历史恢复；复用 DSH 底层 |

## 建议顺序

1. 固定当前真实运行插件清单与 UI/API 能力矩阵；逐项确认“可见、可调用、可恢复”，避免只看依赖包或源码开关。
2. 对压缩、结果裁剪、重复调用提醒、用户提问等低 OS 权限项做隔离回归；若有效，以 DSH 原生插件代替自建实现。保留当前默认关闭，直至回归通过。
3. 让 Skill 发布/Run 固定对接 DSH 原生 `ctx.skills`/`tool-skill`，使产品卡片明确区分“业务工具”与“DSH Skill”；在可信发布与租户 ACL 未成立前不要直接打开 `tool-skill`。
4. 将同 Key 的 PT 模型资格、每模型 effort 元数据接到 DSH 选择协议，Runner 全程传递 `reasoningEffort`，再做真实网关验证；前端不要用模型名推断来伪装思考强度。
5. Bash/FS/Web/子 Agent/自主循环维持关闭，直至 T05 的 OS 隔离、出网、权限、预算和 Run 对账有可重复证据。

**证据路径**：`shell/runtime/dsh-adapter.cjs:181-190`；`shell/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`；`shell/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`；`shell/persistent-runner.mjs:381-417`；`shell/tenant.cjs:74-87`；`shell/server.cjs:1671-1718`；`shell/node_modules/@deepseek-ai/dsh-client-ui-model-selection/README.md`；`shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/README.md`；`docs/refactor/T05-SECURITY-STATUS.md`；`docs/refactor/evidence/T13-T14-profile-fail-closed-regression-20261022.md`。

## 2026-10-27 补充：总文档 §4.8b 的升级门禁

`北极星总文档-v1.10_1.md:830-858` 已明确规定：升级 `@deepseek-ai/dsh` 时新开分支、改精确版本、重跑 26 项契约测试和真实对话冒烟，全过后才允许合并 main；涉及插件/bundle 配置还要同步 `docs/dsh-profile-snapshot/`。B1 的真实测试曾暴露 abort 与 closeSession 两个缺陷，B7 修复后达到 26/26 和 11/11；B8 添加兼容插件但 DSH 核心仍为 `0.1.1-rc.2`。因此先前把该流程当作新建议是不准确的，它是已有制度。

该段关于“DSH 升级只需改 `dsh-adapter.cjs`”描述的是**已有四方法/五事件行为在 SDK 变化时的隔离目标**，不能推出新增 Skill、推理强度、压缩和搜索只改 Adapter 就可交付。当前 `contract.cjs` 的 `run(spec)` 没有这些能力的字段；产品 UI、Run 账本、`persistent-runner.mjs` 和生成 profile 也分别是实际边界。特别是 `compaction-basic` 的摘要请求直接走 `llm/stream`、不经过现有 `agent/request` 预算钩子；现有 26 项旧契约测试并未覆盖这四项。若保持锁定 DSH 版本而仅接能力，不触发“版本升级”门禁的分支规则，但仍应在隔离分支或工作树运行旧契约测试、四项专项测试、真实对话冒烟和发布快照核对。若确需升级，严格按 §4.8b 执行，不以本审计替代。

**后续范围决定**：用户决定 F1 仅按原模型切换范围验收；`reasoningEffort` 调节与 Skill 发布、长对话压缩、联网搜索统一移至下一期候选，待有余量再排。上文“近期可验证”只表示技术上可做受控试验，不再表示当前 F1 或 F2/F3 的实施优先级。F1 不因这些新发现的 DSH 能力增加验收项或等待版本升级。
