# 08 AUTO增强：主程共享接缝与首阶段冻结契约

状态：CONTRACT_FROZEN_FOR_PRE_DISPATCH_M1 / IMPLEMENTATION_PENDING。本轮仅代码接缝核对与契约整理，无生产源码修改、合并、部署、付费调用或自动切换。基线为本地Git integration/questions-m1-r5-20261106 / 88d6535（生产代码54c758c）；R33正式上线事实来自11月6日证据，本轮未重连服务器，不冒称当前线上再验。

## 首阶段边界

M1只实现“调用前配置化选择”：把可信配置的候选顺序与现有实时资格门禁组合；尚未提交上游时，首选资格不满足可选其它合格候选。该阶段不叫“零费用安全降级”。任何请求已进入发送/提交不确定区间、已提交、已接受或费用未知，禁止自动换模型或再次提交。当前无已核准的PT零收费拒绝协议，发送后的自动降级保持BLOCKED，不能用HTTP状态、空taskId、token=0、余额不变、usage缺失、错误字符串或maxRetries=0推断零费用。

零费用证明和未发送证明是不同证据。M1只依赖宿主可证明尚未跨过提交栅栏；后续若允许费用失败降级，须另立契约、确切请求/attempt身份、可信provider结算证明、预算及用户授权，独立主审，不从本M1默许扩展。

## 原生与已有代码复用映射

| 接缝 | 当前实现/事实 | M1责任 |
|---|---|---|
| Agent循环与provider | DSH原生；persistent-runner.mjs保留模型选定、工具/预算、意图RPC | 不新造Agent或重试循环；不能绕过原生调用与现有预算 |
| 对话入口 | server.cjs selectChatModel（217）与handleChat调用（879） | 主程接入配置候选顺序，保留manual行为与图片理解模式；行号以88d6535为准 |
| 资格判定 | models/task-router.cjs routeChatTask，目录/权限/任务/autoEligible检查 | 唯一资格入口；候选配置不能授予权限，不复制一套资格逻辑 |
| 旧选模 | model-catalog.cjs routeModelFor仅定义/导出，当前shell未发现调用点 | 不把关键词路由当生产新入口，不为了接08恢复旧路径 |
| 作者候选 | fix/auto-08-r1-r6 / 0c8841c及主程R3假值补丁；仅选择器局部通过 | 只取经审输入校验/不可变配置/顺序选择逻辑；不原样替换宿主引擎，不依赖未跟踪旧候选 |
| Run与事件 | tasks/store.cjs可信owner/租约/事件；server已有model_selection事件 | 在宿主事务冻结选择与attempt；事件仍通过原Run存储，不另造序号分配 |
| 模型意图与价格 | runner northstar.model_request_intent，server现有证据记录链 | pin实际配置、目录revision、模型与价格证据；pin透传不算验证完成 |
| 外部媒体任务 | tasks/external-operations-store.cjs、provider-reconciliation.cjs | 复用已适用的操作身份/未知状态/查询而非重提交语义；不能假定所有文字请求已被此仓库记录，文字attempt差距须补主程最小方案 |
| 预算与重试 | tasks/budget.cjs、dsh-settings.yaml provider maxRetries=0 | 保持现有门禁；不得把预算允许retry等同“费用安全”，不能引入新的恢复钩子重发 |

## 可信数据与提交栅栏

宿主提供tenantId/userId/runId、当前leaseOwner、normalizedTask、manual/auto、目录scope/revision、调用许可及配置版本；浏览器/模型不能提交eligibility=true、支付状态、任意provider/baseURL或可信pin。配置只映射任务→有序候选及预调用后备；缺失/非法mode、dispatchState、版本、task、重复候选、未知模型均明确拒绝，不能默认为安全。

建议统一选择记录（待实现，不代表已有迁移）：selectionId、runId、task、mode、configVersion/configSha、catalogScope/catalogRevision、requestedModelId、resolvedModelId、capabilityRevision、attemptId、leaseEpoch、state、createdAt。只存非秘密scope标识，不存用户key。若现有表/事件可表达则优先复用；需迁移时由主程确认，不由Gemini改共享迁移。

状态必须由持久宿主权威给出，不信任调用者传入的pre-dispatch：

| 状态 | 可做 | 禁止 |
|---|---|---|
| PLANNED | 校验配置、目录和候选 | 不输出已验证执行/费用结果 |
| SELECTED_NOT_SUBMITTED | 同一Run锁下重验租约/目录/配置，合法变更需新选择记录 | 不用旧scope资格，不静默改manual模型 |
| SUBMITTING | 发起前先持久写attempt栅栏，重验取消/租约/预算 | 任何另一worker、新模型fallback或恢复重发 |
| ACCEPTED/RUNNING | 跟随该attempt，能查询则查询 | 不重提交、不切模型 |
| UNKNOWN | 保留未知并查询/人工核对 | 不以错误类型猜测零费用 |
| TERMINAL | 记录真实成功/失败/取消和证据 | 不改写旧attempt或让旧worker恢复提交 |

同Run并发选择/提交需锁或CAS+唯一约束；丢失租约或过期worker不能越过提交栅栏。网络发送与本地事务不可能原子，因此若在“写SUBMITTING后、发送结果持久化前”崩溃，即使实际上可能没发送，也按不确定处理，不能重发求成功。供应商幂等键可用性需真实协议证实，不能自行造键后假定对方去重。

模型/config/catalog pin漂移：提交前拒绝或显式重新规划，保留拒绝原因；提交后不改变attempt身份。目录刷新失败/撤权、未知模态、AUTO资格缺失继续fail closed。多阶段任务、工具编排、媒体AUTO、执行失败后换模型不纳入M1。

## 主审一次性验收矩阵

| 范围 | 必须覆盖 |
|---|---|
| 选择与配置 | 正常顺序、无候选、无资格、配置不可变、重复项、空/假值/非法mode与task、manual绝不换选 |
| scope与pin | 跨租户/用户/Run、Key作用域变化、目录过期/撤权、config/catalog/capability revision变更，价格绑定不串attempt |
| 并发与恢复 | 两worker同Run提交、重复客户端请求、租约接管、崩溃/重启、SUBMITTING前后各断点；每个逻辑attempt上游发送次数可观测 |
| 生命周期 | 选择前/锁等待/持久化后/发送前/已发送后取消，慢写与迟到结果，超时与done竞争；无越权复活/无假成功 |
| 费用未知 | 网络断开、5xx/4xx、taskId缺失、usage缺失/0、HTTP成功但失败body；均不得自动切换或标零费用 |
| 兼容与产品 | 默认文本/图片理解/manual、Skill/提问模式、现有媒体显式授权与Run回放；缺候选明确提示，不把失败重试隐藏成成功 |
| 证据层 | 选择器单测、实际生产仓库并发/恢复、真实SDK+HTTP合成provider计数；再集成浏览器与同版QA。单层PASS不跨层签收 |

实现前先将现有文字请求意图记录与Run仓库的实际事务能力做最小探针，明确如何落attempt栅栏；不能先接候选后补幂等。验收使用合成provider、不花费真实PT额度。对真实零收费协议的查询另列文档核实，不在主程准备阶段隐含授权付费实验。

## Gemini与主程责任、统一状态纠偏

Gemini04：按既有主审修订为DSH ctx.web/tool-web provider候选，交源码/依赖/真实输出/取消/出口/引用证据，不改共享入口。Gemini08：保持局部选择器审查状态，未经主程明确子任务不改共享入口、不重复从零开发。宿主scope、attempt存储/栅栏、Run/事件、server/runner接线、集成和部署由Codex负责；本契约不是要求Gemini代写这些共享文件。

05/06补充：R5作者成果d78d5c9后，主程已以b714e69/54c758c完成普通澄清M1生产仓储/原生SDK/API/UI接线，R33已部署待独立QA；不能再说“05/06都只在R5独立工作树”。审批、FS、脚本仍关闭，05/06整包未完成。第三批Bug abb3851目前NEEDS_REVISION，不能混入08基线。

下一步：主程验证文字请求持久意图/租约与提交栅栏的最小可行接线，再决定08预调用M1实现；本轮只冻结契约，不宣称08已实现或零费用降级上线。当前不需要用户转发新的08修复样本或安排上线。

## 已完成的接缝探针（2026-11-09）

实际R33意图处理器+生产Run仓库/PGlite：同handler去重通过，重建handler相同attemptId产生两条意图；旧租约被拒、跨tenant读取被拒。确认intent_only不是跨重启提交栅栏，尚未修改实现。详见 evidence/AUTO08-HOST-INTENT-REVIEW-20261109.md。下一步冻结逻辑attempt标识/唯一约束/租约代次和CAS提交态，不能依靠RPC内存Map。

## 2026-11-09后续接入完成状态

上文为冻结前阶段契约。现已完成调用前M1独立接入：生产代码f5fa39a；R34归档70361b6ed893ae440650e3d7dce37058efa0633ea7f1b8f936b91026d359ee5d；272/272与Linux42项通过，PG锁后过期拒绝通过。详见AUTO08-M1-INTEGRATION-REVIEW-20261109.md。未部署、未获独立QA、未实现发送后降级/零费用保证。
