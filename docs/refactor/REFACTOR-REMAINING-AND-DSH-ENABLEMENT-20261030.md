# 完整重构剩余范围与 DSH 恢复目标（2026-10-30）

**交付目标：2026-11-02（周一）交付完整重构版本包（用户2026-10-31明确按周一推进，替代原11-03目标）。核心原则：放大 DSH 的能力，尽量利用 DSH 自身的功能，只有确有必要才关闭或自行开发。** 该日期为用户交付目标；范围和验收不因日期缩减。原生能力优先配置和接线，关闭/自研逐项附必要性、证据与恢复条件。

**现状：r14已由运维回执确认运行，但普通对话和媒体未通过目标验收；r16修复草案已冻结，本轮源码在其上继续推进。完整重构尚有 12 个开发/接线工作流，另有 5 类跨功能验收门禁。** 12 是下面固定分组的待办数，不是 12 个全新模块，也不是 T00–T18 的完成百分比。旧 10/24 计划里 CSV、媒体、AUTO 的部分缺口已被后续真实本地产品证据覆盖；正式整体验收仍未关闭。

当前推进台账见 [周一完整交付](MONDAY-FINAL-DELIVERY-20261102.md)，下方原始分组保留为范围，不以候选存在代表完成。

原则：先核对锁定 DSH 原生能力，能通过配置、公开协议、现有插件接入的就复用；北极星负责租户授权、可信 Run、业务输入输出和证据。每个继续关闭项需记录具体边界和重新开启的条件，不能用“多租户”笼统解释所有禁用项。不得在正在部署的 r14 中混入新源码。

| 剩余开发/接线工作流 | 现状与缺口 | DSH 复用方向 |
|---|---|---|
| 1 图片/音频/视频理解（T08） | 上传和生成已有；Runner 主输入仍 text，缺真实图像内容、ASR/音轨、视频采样及时间位置证据 | 原生消息/附件与模型能力协议优先，补 PT 端点适配和受控附件访问 |
| 2 办公文档输入（T09） | TXT/MD/CSV 已有；XLS/XLSX、PDF/OCR、DOC/DOCX、PPT/PPTX、ZIP 未成产品链 | 先查原生文件/插件能力，缺格式解析才补受限解析器，不自写模型读文档引擎 |
| 3 跨资料检索、引用与删除（T09） | 缺页码/段落/sheet 可定位 UI、跨文件范围查询和删除派生上下文失效闭环 | 复用原生上下文/引用接口；租户资料索引与删除属产品职责 |
| 4 长会话压缩（T12） | compaction/pruner/手动压缩未接；摘要调用目前可能绕过现有预算钩子 | 启用原生 compaction-basic/result-pruner，先封预算与来源保留边界 |
| 5 记忆来源与范围（T12） | CRUD、改删失效已有；来源、确认/推断区别、按需召回和摘要失效需补 | 接原生上下文；保留租户存储与确认权限 |
| 6 PM Skill 发布（T13） | 仅目录首拷贝和版本快照纯模块；缺发布入口、禁用、Run admission/版本 pin 与原生 loader 接线 | DSH registry/filesystem/tool-skill 为唯一发现读取机制，不另造 parser |
| 7 联网研究（T14） | 原生 tool-web 关闭，缺搜索/读取真实来源与出口约束 | 原生 search 优先；fetch/read 先验证原生能力和安全出口，再补确实缺失的适配 |
| 8 推理强度选择 | 原生支持，但 UI→Run→Runner 丢参数；当前没有产品入口 | 原生 ModelSelection/reasoningEfforts；Gemini 隔离候选已备 |
| 9 多格式产物与统一索引（T10） | 媒体/CSV 已成真实本地链；文档导出候选未完整接入，XLSX、多产物版本与统一列表待收口 | 原生工具/文件/交付物协议优先，租户托管/不可变版本与格式渲染必要补充 |
| 10 F3 费用核对（T11） | 请求意图、usage、价格版本/估算、导出已有；消费归一候选尚未形成真实账单关联完整流程 | 复用 Session 响应事件；供应商账单、币种/单位/未知覆盖由产品适配 |
| 11 多模态 AUTO（T06/T07） | 文本 AUTO 与手动媒体已有；理解→检索→生成的步骤能力路由和新模型适配仍缺 | 向原生选择协议提供 PT 资格，避免平行模型选择语义 |
| 12 交互与安全执行收口（T03/T05） | 原生提问/审批未接；host 工具已有但完整两入口统一、多报告与原生工具 OS 隔离仍有缺口 | 原生 user-questions/approval/tools；产品补 tenant/Run/预算绑定，不重写 Bash/FS/子 Agent 执行器 |

五类交付门禁：① Google/BYOK 换绑撤销、旧资产/迁移与真实 PostgreSQL 升级；② 同版浏览器普通聊天/切换/媒体/CSV及目标上游身份可观测边界；③ 两用户/多会话重叠、取消/断线/崩溃/晚到状态与隔离负向验收；④ 干净 CI、依赖/插件快照、真实样本/性能分布、独立验收；⑤ PG+密钥+文件联合备份恢复、版本回滚及全新实例复现。这些大多有代码或本地测试，不能统称未开发，也不能因为未验收就重新开发。

## 28 个禁用 ID 的恢复规划

**提出默认产品恢复候选 10 个：其中完整重构优先接线 7 个，体验扩展 3 个；另17个在隔离 profile 中按角色/平台/任务需求开放；生产 HMR 1 个保留关闭。** 7 个是 user-questions、compaction-basic、command-compact、tool-skill、tool-result-pruner、repeat-tool-reminder、tool-web；体验扩展3个是 session-title-llm、tool-todo、tool-goal。这是规划目标，不是已启用数量、已批准的新增范围或“全部完成自动开放27个”的承诺。原正式一期不要求全部开发者工具，体验扩展不能阻塞正在部署的 F1。

| 目标 | ID | 开启前条件 |
|---|---|---|
| 默认产品恢复候选：10 | session-title-llm、user-questions、compaction-basic、command-compact、tool-skill、tool-result-pruner、tool-todo、tool-goal、repeat-tool-reminder、tool-web | 复用原生；逐项接 UI/Run/预算/租户范围，记录真实加载和历史；tool-web 先开放受控 search，不能顺带开放任意 fetch |
| 隔离执行场景按需：17 | tool-bash、tool-pwsh、tool-jobs、tool-fs、tool-fs-search、subagent、subagent-spawn-in-process、subagent-fork-in-process、tool-subagent-control、tool-subagent-list-agents、tool-subagent、tool-subagent-fork、tool-subagent-report、workflow-worker-thread、tool-workflow、tool-ralph、tool-str-replace-editor | 复用原生执行能力；先证明 OS/出口/凭据/进程隔离、授权/预算/取消及 Run 归属。PowerShell 受平台限制，不能承诺 Linux 默认开放；持续循环受显式任务预算限制 |
| 生产保持关闭：1 | hmr | 固定版本、可审计重启发布；开发 profile 可单独启用 |

reasoningEffort 不在28项计数中，它是参数接线；原生 session-query 全文搜索、OTEL、skill-badge 是 DSH base 默认限用项，也不混入28项。`dsh-web-app` 是否嵌入需单独做租户协议评估，不以“安装了包”计复用。

Gemini 两任务已由用户确认转交：[原生推理强度候选任务包](GEMINI-DSH-NATIVE-REASONING-PACKAGE-20261030.md)、[原生长上下文候选任务包](GEMINI-DSH-NATIVE-CONTEXT-PACKAGE-20261030.md)。两个任务只新增互不重叠的隔离候选与原生 SDK 探针，主 Agent 负责生产共享接缝和其余工作流；用户转交不等于交付完成。

依据：正式 v2.0 T00–T18/AC01–24、FUNCTION-DELIVERY-REPLAN、r14 冻结归档与 F1/F2 真实本地证据、DSH-CAPABILITY-REUSE-AUDIT 和本轮 r14 复用矩阵。此盘点是功能级差距核对，不是全仓逐行代码审计；后续关闭项逐个附证据，不凭日期或文件数更新百分比。
