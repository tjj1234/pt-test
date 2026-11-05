# 剩余25包：分类、领取与决策索引
2026-11-04｜用户已通过09文件编辑/10 Seedance示范，并说明Gemini已完成01–08；本轮仅扩写11–35共25包，未改这10包正文。用户交互/混合型17包完整包含决策树、分步表、待决策；后端/验收治理型8包使用契约/操作恢复矩阵。新增建议尚未拍板，规格扩写不代表已派发或实现。
本索引只聚合分类与链接，不复制维护各包需求；详细产品决定、接口/依赖、AC、资源、Plan B和交付门禁以包内正文为准。主审/集成/本地/staging/生产分别记录于[主台账](REFACTOR-MASTER-TRACKER-20261103.md)。[渲染与文档验证](evidence/PACKAGE-SPEC-VALIDATION-20261104.md)只证明文档检查，不是产品验收。

| ID/任务包 | 分类与理由 | 验收项 | 待决策 | 图/矩阵 |
|---|---|---|---|---|
| [11 上下文辅助插件](REFACTOR-CONTEXT-TOOLS-PACKAGE-20261103.md) | 混合型：原生插件＋已有压缩入口交互 | 11 | [4项，含用户/技术/外部责任](REFACTOR-CONTEXT-TOOLS-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/REFACTOR-CONTEXT-TOOLS-PACKAGE-20261103-1.svg) |
| [12 标题、待办与目标体验](REFACTOR-TASK-UX-PACKAGE-20261103.md) | 用户交互型：三种状态独立投影 | 10 | [4项，含用户/技术/外部责任](REFACTOR-TASK-UX-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/REFACTOR-TASK-UX-PACKAGE-20261103-1.svg) |
| [13 子Agent与工作流](REFACTOR-ORCHESTRATION-PACKAGE-20261103.md) | 混合型：原生委派＋用户控制与汇报 | 11 | [4项，含用户/技术/外部责任](REFACTOR-ORCHESTRATION-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/REFACTOR-ORCHESTRATION-PACKAGE-20261103-1.svg) |
| [14 r28与新增功能生产业务验收](REFACTOR-PRODUCTION-ACCEPTANCE-PACKAGE-20261103.md) | 验收型：无新增用户流程 | 11 | [3项，含用户/技术/外部责任](REFACTOR-PRODUCTION-ACCEPTANCE-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [15 跨功能并发与故障验收](REFACTOR-RESILIENCE-PACKAGE-20261103.md) | 验收型：累计产品故障矩阵 | 11 | [3项，含用户/技术/外部责任](REFACTOR-RESILIENCE-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [16 干净CI独立验收与性能](REFACTOR-CI-PERFORMANCE-PACKAGE-20261103.md) | 后端/工程型：无新增用户分支 | 10 | [3项，含用户/技术/外部责任](REFACTOR-CI-PERFORMANCE-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [17 依赖、能力与发布治理](REFACTOR-GOVERNANCE-PACKAGE-20261103.md) | 治理型：含定时目录自动维护，无新增用户流程 | 18 | [3项，含用户/技术/外部责任](REFACTOR-GOVERNANCE-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [18 累计版本安装、升级与联合恢复](REFACTOR-OPS-RECOVERY-PACKAGE-20261103.md) | 运维型：无新增终端用户分支 | 11 | [4项，含用户/技术/外部责任](REFACTOR-OPS-RECOVERY-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [19 项目与工作空间](PRODUCT-PROJECT-PACKAGE-20261103.md) | 用户交互型：项目容器与资料范围 | 11 | [4项，含用户/技术/外部责任](PRODUCT-PROJECT-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-PROJECT-PACKAGE-20261103-1.svg) |
| [20 执行计划与范围确认](PRODUCT-PLAN-PACKAGE-20261103.md) | 用户交互型：执行前控制面 | 10 | [4项，含用户/技术/外部责任](PRODUCT-PLAN-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-PLAN-PACKAGE-20261103-1.svg) |
| [21 进度与中途干预](PRODUCT-PROGRESS-PACKAGE-20261103.md) | 用户交互型：活动Run安全控制 | 11 | [4项，含用户/技术/外部责任](PRODUCT-PROGRESS-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-PROGRESS-PACKAGE-20261103-1.svg) |
| [22 成果预览与批注迭代](PRODUCT-PREVIEW-PACKAGE-20261103.md) | 用户交互型：多格式成果与版本 | 11 | [4项，含用户/技术/外部责任](PRODUCT-PREVIEW-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-PREVIEW-PACKAGE-20261103-1.svg) |
| [23 历史搜索、分叉与重做](PRODUCT-HISTORY-PACKAGE-20261103.md) | 用户交互型：可追溯检索与安全分叉 | 11 | [4项，含用户/技术/外部责任](PRODUCT-HISTORY-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-HISTORY-PACKAGE-20261103-1.svg) |
| [24 任务模板与个人偏好](PRODUCT-TEMPLATE-PACKAGE-20261103.md) | 用户交互型：固定模板、版本与有效设置 | 10 | [4项，含用户/技术/外部责任](PRODUCT-TEMPLATE-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-TEMPLATE-PACKAGE-20261103-1.svg) |
| [25 第三方资料与应用连接](PRODUCT-CONNECTORS-PACKAGE-20261103.md) | 用户交互型：授权跳转与资源选择 | 11 | [4项，含用户/技术/外部责任](PRODUCT-CONNECTORS-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-CONNECTORS-PACKAGE-20261103-1.svg) |
| [26 定时与事件自动化](PRODUCT-AUTOMATION-PACKAGE-20261103.md) | 用户交互型：持久规则与无人值守边界 | 11 | [4项，含用户/技术/外部责任](PRODUCT-AUTOMATION-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-AUTOMATION-PACKAGE-20261103-1.svg) |
| [27 批量任务](PRODUCT-BATCH-PACKAGE-20261103.md) | 用户交互型：逐项账本与部分结果 | 11 | [4项，含用户/技术/外部责任](PRODUCT-BATCH-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-BATCH-PACKAGE-20261103-1.svg) |
| [28 团队共享与协作](PRODUCT-COLLAB-PACKAGE-20261103.md) | 用户交互型：资源授权和撤销 | 10 | [4项，含用户/技术/外部责任](PRODUCT-COLLAB-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-COLLAB-PACKAGE-20261103-1.svg) |
| [29 通知与任务收件箱](PRODUCT-INBOX-PACKAGE-20261103.md) | 用户交互型：站内事件到任务定位 | 10 | [4项，含用户/技术/外部责任](PRODUCT-INBOX-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-INBOX-PACKAGE-20261103-1.svg) |
| [30 知识与记忆管理中心](PRODUCT-MEMORY-UI-PACKAGE-20261103.md) | 用户交互型：可见来源、范围与撤销 | 11 | [4项，含用户/技术/外部责任](PRODUCT-MEMORY-UI-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-MEMORY-UI-PACKAGE-20261103-1.svg) |
| [31 统一供应商能力接口](PRODUCT-PROVIDERS-PACKAGE-20261103.md) | 后端型：typed facade与渐进兼容适配 | 11 | [4项，含用户/技术/外部责任](PRODUCT-PROVIDERS-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [32 本地连接器与电脑操作](PRODUCT-LOCAL-PACKAGE-20261103.md) | 用户交互型：设备配对、目录授权与可见执行 | 14 | [5项，含用户/技术/外部责任](PRODUCT-LOCAL-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-LOCAL-PACKAGE-20261103-1.svg) |
| [33 并发、存储与资源申请](PRODUCT-CAPACITY-PACKAGE-20261103.md) | 后端/资源型：测量、服务限额与申请 | 10 | [4项，含用户/技术/外部责任](PRODUCT-CAPACITY-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [34 PT能力核实与需求清单](PRODUCT-PT-CAPABILITIES-PACKAGE-20261103.md) | 调查/契约型：无新增用户流程 | 10 | [4项，含用户/技术/外部责任](PRODUCT-PT-CAPABILITIES-PACKAGE-20261103.md#4-建议方案与待确认决策) | 操作/失败恢复矩阵，无新增用户图 |
| [35 生产基础补强：质量、监控、数据与成本](PRODUCT-PRODUCTION-PACKAGE-20261103.md) | 混合型：四条后端治理链＋受限管理控制台 | 15 | [6项，含用户/技术/外部责任](PRODUCT-PRODUCTION-PACKAGE-20261103.md#5-建议方案与待确认决策) | [已渲染SVG](evidence/package-spec-mermaid-20261104/PRODUCT-PRODUCTION-PACKAGE-20261103-1.svg) |

## 领取前的决定与边界
先确认各包M0涉及的产品范围/默认行为/资源费用，技术事实由负责人核实，不能把99项混成要求用户逐项技术回答。优先影响第一批闭环的决策：19个人/项目范围和归档，20强制计划与未知费用，21安全暂停范围，22首轮格式/锚点，24设置优先级，30临时聊天读写开关；33容量目标与18独立staging资源。25首个第三方系统、26无人值守、27批次规模、28团队账单、32平台/伴侣、35留存/SLO等按对应波次拍板，不提前扩大首版承诺。
建议按原路线图依赖推进，31/34/33先交契约/事实/测量，19–24/29–30形成用户工作流；14–18/35提供同版放行，连接器/自动化/批量/协作及本地阶段按V2/V3。此处是推进建议，不是已分配任务或新增发布时间承诺。Gemini原8包的作者完成不意味着本轮已做独立主审或共享接线；按契约接入，不回头重写。

## 32包修订记录（2026-11-04）
[32完整规格稿2](PRODUCT-LOCAL-PACKAGE-20261103.md)补齐“已有配对有效→设备密钥新挑战验证→直接重连”，有效老设备不创建配对码；离线/超时不当成未配对，失效信任仅由用户主动重配。已有有效root优先展示，重连不恢复撤销权限、不重放未决写入。32-02及32-03/05/11同步细化；AC和决策项数量不变。仅规格修订，未实现或验收产品。

## 17包/AUTO补充（2026-11-04）
[17完整规格稿2](REFACTOR-GOVERNANCE-PACKAGE-20261103.md)新增PT目录定时自动同步、镜像/当前Key候选增删、完整性与失效/审计保护；无需人工逐模型审核。08作者已交付且本轮指纹匹配，正文/候选不动，新增执行选择规则见[补充接线契约](AUTO-08-CATALOG-FALLBACK-CONTRACT-20261104.md)。17新增8项AC（25包总计281项），决策项仍99。PT官方零费用拒绝语义未确认时，执行失败后切换保持关闭；此项不冒充已实现/上线。
