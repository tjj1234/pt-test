# 新会话交接：R30已部署待QA，第二批Bug待分诊，05/06最新提交待复审
2026-11-05｜这是本轮恢复入口，优先于11月3/4旧交接。用户要求先总结再/new；本轮至此停止新开发/复审/部署。记录是历史现场，恢复时只读核对Git与线上事实，不重复部署。

## 1．结论与下一步顺序
R30 Bug修复候选已部署agent-fat，主程已独立核对服务/源码/公网健康；不是20项全部验收，不是Gemini8包接入完成。Bug-12普通回复HTML自动物化关闭，保留DEGRADED_PREVIEW/功能未完成。下一会话：①核对本交接与最新消息/Git，确认测试工程师按精确R30做QA，可并行进行；②主程先分诊第二批8项并明确派修/审核已有batch5，不能自动接受“QA误提/下一期”；③独立复审Gemini88dd344；④分别集成，通过后再单独冻结发布，禁止混线。

## 2．当前Git与所有权（本次实际核对）
| 对象 | 指纹/现场 | 含义 |
|---|---|---|
| 当前主工作区 | feature/northstar-integration-20261102，bbd9997d1e19920dc1c850c31ec6c71dbc5994d1 | 大量他人已跟踪文档改动及未跟踪候选/证据；不reset/clean/stash/全量add，不从脏工作区直接发布 |
| R30候选远端分支 | integration/r28-bugfix-r3-20261105，交接前da5c0b50f3ab0fb5164999bb604c43320ded40bd | 后续保存本交接将仅推进文档；正式主工作区仍bbd，不把Git当前HEAD当线上版本 |
| R30运行源码合并提交 | 0391eaf49c10ad1e074de4df4e54d11e745bfcef | 集成独立复审通过R4，不含Gemini8包/第二批8项 |
| R30归档提交 | 2cd7b5cad88fa7065f9eb7d2e2582c649cb2b0c0 | 冻结归档与构建/审计脚本，随后仅加部署证据文档 |
| 原Bug作者候选 | candidate/r28-bugfix-full，c58ffc6788c4b0df8dac8862249d05ac5edf0e77；/private/tmp/pt-fix-batch4 | 冻结保留，主程已追加修正，不让作者重复修 |
| R4修订 | fix/r28-r4-regressions-20261105，388712c47db4090dd189a3659e24aacd51c7c72e；/private/tmp/pt-fix-r4 | 局部复审通过，已集成，无需继续返工。作者报告full SHA曾误写，以Git为准 |
| 第二批Bug | fix/bug-batch5-followup，d3325a42522886ccc18f214f39dcf6c4fe840c4c；/private/tmp/pt-fix-batch5 | 尚未主审，不在已部署包中。只核对已有成果再派修，避免重复开发 |
| Gemini05/06最新 | fix/questions-m1-slice-20261105，88dd344a9d8bbbd579cdb61c4f146f77d3ba18d8；/private/tmp/pt-fix-05-06-slice-m1 | 作者Revision4生命周期23/23自测，主程尚未读取/复跑此版本，不能标验收通过 |
| 08修订 | fix/auto-08-r1-r6，0c8841cfb1a658d7d4a7d118584fca7dc3e6e1f2 | 需主程假值补丁后仅selector局部通过，未接线 |
| 两新人交接分支 | handoff/two-developers-20261105，e3ee9d254cf525eb39130af2b5b8eece557dfe98 | 原35包扣01–08=27包(09–35)，用户所称28的额外1包未确认；原09/10仅规格样本通过，不是实现完成 |
新分支、原工作树、/private/tmp验证树可能并发使用，不删除。原01–08与Bug修复由Codex审核、合并推送，两位新人只接其分派的新任务。两位GitHub协作者已由用户发邀请；账号/技术侧重与最终分工尚未正式登记，不将A/B建议当既定指派。共享入口/鉴权/锁/迁移/profile由主程协调，tests/e2e既有所有权保持。

## 3．线上R30事实、恢复点与限制
| 项目 | 已验证事实 |
|---|---|
| 入口/服务 | https://agent-fat.adorado.top；northstar-shell |
| 新目录 | /opt/northstar/releases/controlled-trial-20261105-candidate-34-r30-bugfix-draft/shell |
| 旧目录 | /opt/northstar/releases/controlled-trial-20261103-candidate-34-r28-draft/shell，完整保留 |
| 服务 | PID339125，active，独立核对时NRestarts0；analytics active |
| 最后只读健康 | 2026-11-05T09:28:55.235Z，PID339125，uptime797秒，ok；health.version仍1.0.0，身份靠release/源码/归档指纹 |
| 归档 | northstar-controlled-trial-20261105-candidate-34-r30-bugfix-draft.tar.gz；SHA493ad02a9d6a2b32aea2913604a4f74032c35143c479360dcda4875fd2ba2199 |
| 源码/依赖 | 217绑定源码/419归档成员；已部署217逐项回读无漂移；Linux x64/Node24.22.0/Python3.14.4；严格生产闭包495包31007文件匹配 |
| JS公网与本地 | /assets/app.js SHAe9f1c17f5053cbf584376e5790e564b5de9cb53ba010a8975624981438a7c5c8；/login200，匿名/api/models401 |
| 备份 | /var/backups/northstar/r30-20261105T091531Z，root0700；PG dump、实际隔离恢复、state tar、原unit与profile均保留在服务器，不下载/上传内容 |
| 恢复验证库 | northstar_r30_verify_20261105091531；273Run/29迁移匹配，PUBLIC CONNECT撤销、CONNECTION LIMIT0。前次备份091212Z及对应隔离库也保留，不擅自删 |
| 迁移/配置 | 本包迁移集合和DSH settings与旧r28逐字相同；离线通过原生rebuildProfile/makeProfile重建runner profile；env内部Key配置名存在，值未输出；媒体白名单未显式出现在主env，是否需要须按实际standard3策略核实，不盲改 |
用户已明确允许在agent-fat保留全部历史、仅专属测试租户验收；这不授权清库/真实用户故障注入。用户也授权本轮最多2美元、每类最多一次(文本/图片理解/T2I/I2I/T2V)、未知不重试；截至交接没有本助手PT付费调用，额度未消耗。PT凭据不写本文件/记忆/仓库；如新会话需要，使用安全通道，不从聊天日志搜索或复述旧密钥。独立测试工程师旧30美元预算不自动沿用。

## 4．SSH与sudo
服务器47.237.22.191:22，tongjiawan。用户自行输入密码建立本地ControlMaster，路径/private/tmp/pt-ops-20261105.sock；曾过期又重建，恢复时先ssh -S该路径 -O check。普通SSH可复用连接，但sudo依然需要交互，不能假设用户原TTY的sudo缓存可复用；不改sudoers、不要求NOPASSWD、不存密码。
若连接失效，让用户在本地新终端执行：ssh -M -S /private/tmp/pt-ops-20261105.sock -o ControlPersist=30m -fN tongjiawan@47.237.22.191。不要默认重复创建仍在用的socket。用户在服务器终端已亲自执行精确校验绑定脚本完成本次切换；无需再次运行脚本。普通root只读预检脚本与deploy脚本在/tmp/pt-r30-validation-20261105等目录；这些不是通用恢复命令，基线变了不能盲重跑。

## 5．部署教训：第一次误报回滚是主程脚本错误
第一次切换末尾误查/app.js，返回401触发cmp失败，自动恢复旧unit/profile并启动旧r28；不是R4产品缺陷。主程实际核实旧版同地址也401，而正确/assets/app.js为200并匹配源码。修正脚本先验证已有root-owned候选全部源码/闭包，再重新备份、实际PG隔离恢复及切换；第二次成功。其他xfs_scrub/cloudmonitor unit警告与本包无关，不擅自改系统服务。
长期要求：切换前从真实index.html/路由核实资源路径/鉴权/预期状态；旧版本先跑同样后检；curl失败不得与cmp空输出混作产品故障。源绑定、health PID、服务目录、静态资源指纹组合判断。备份必须真实隔离恢复；检查脚本出错不放宽门禁，修脚本并再次验证。已有release不可覆盖删除，只能全量复验后复用，不能无脑重复执行初次安装脚本。
部署脚本语法通过不等于路径语义正确；主程承担误报造成停机/用户额外sudo操作责任。经验还包括：测试先整文件语法；DSH依赖须独立npm ci，跨目录node_modules链接会被DSH_ENTRY_UNTRUSTED拒绝；本地socket监听需正确运行权限；Linux依赖文件mode受umask影响，发布安装使用umask022。不要为通过校验修改闭包期望。

## 6．测试与待办的证据边界
主程起初在错误沙箱/链接依赖环境跑267suite，222过45失败；纠正环境后仅重跑45，42通过，余下旧归档绑定与两个真实回归。旧归档门禁用新归档解决不改旧包；R4两个回归有bbd旧版通过/候选失败的对照，后续已实际修复复测通过。不是最终R30同版267逐个全量重跑。
R4原生推理拒绝恢复、UI脚本57/57、媒体确认安全、作者SDK探针、主程追加“通过实际persistent-runner合成流失败后同会话恢复”均通过；最终R30相关9测试通过。主程实际Linux干净安装/严格闭包/JS与Python静态验证通过，已部署后217源码/公网/匿名边界通过。仍未完成真实Google回调/登录态全业务点击/真实PT媒体/实扣和独立QA；不能把DEPLOYED_FOR_QA当20个Bug全结项。
独立QA入口：R28-BUGFIX-QA-REQUEST-20261105.md，顶部已更新实际R30归档/源码，不用正文历史db94/d2作为新测试目标。部署证据evidence/R30-DEPLOYED-FOR-QA-20261105.md。
原测试报告PTR-20261104-R28-FINAL实际位于/Users/mmdn/.gemini/antigravity-cli/brain/5fdb82ec-9c23-4b71-a6b5-53d2f32fa3fb/NORTHSTAR_R28_FULL_TEST_REPORT.md，含登录凭据，禁止原样提交/转发。仓库仅用脱敏副本evidence/NORTHSTAR_R28_FULL_TEST_REPORT-REDACTED-20261105.md；它是旧版线索，费用口径有冲突，旧CONDITIONAL GO不证明R30已验收。

## 7．下一会话具体工作队列
1. QA可由用户立即转交上述精确清单给独立测试工程师；收新报告后逐项映射原20Bug、PASS/FAIL/BLOCKED/DEGRADED。本助手不未经指示代发消息，不冒充独立QA。
2. 第二批8项先主程分诊，读取R28-BUGFIX-R4-HANDOVER-REPORT-20261105.md第3节和fix/bug-batch5-followup实际diff。已有三处实现是Usage标签高亮、无会话记忆范围、失效Skill处理，均未主审，尤其自动解绑Skill的用户行为需核对；其他账单/模型/跨系统失败/技能操作不可凭作者解释判QA误提或下一期。由主程明确本期修复/产品决策/外部依赖/后续范围和AC后再派作者。
3. Gemini最新88dd344先审实际diff/仓储和生命周期23项，不相信“无架构阻断”自评。上一主审469beb1仍失败：旧now慢CAS跨deadline→Promise timeout而DB answered；错Run管理器可答别Run；清timer/signal问题。统一施工入口evidence/QUESTIONS-ISOLATION-M1-R3-REVIEW-20261105.md；最新报告deliveries/questions-isolation-m1-20261105/DELIVERY-REPORT.md与累计patch、作者探针tests/probes/questions-isolation-author-m1-20261105.mjs。原M1仅普通问答+关闭审批/FS/任意脚本，不能自行扩大范围。即使M1通过也不是05/06或8包整体验收。
4. 原01–08作者交付不等于主审完成：01–04/07尚缺完整独立审核接线；05/06如上；08需主程假值补丁evidence/AUTO-08-LEAD-R3-FALSY-GUARD-20261104.patch，selector局部通过不代表PT attempt/费用/版本pin已接。17每日同步已入规格。PT未确认acceptance_state和确定零费前任何执行失败不自动切候选；timeout/5xx/429/无响应未知不重试。
5. 新人27包文档在docs/refactor/，按TWO-DEVELOPER-GITHUB-HANDOFF-20261105.md、DEVELOPER-ONBOARDING.md、ENGINEERING-DELIVERY-WORKFLOW.md入组；待用户补A/B能力分工/额外第28包，不抢共享入口。用户分支包三件套和Mermaid实际渲染，纯后端不硬套；先检查已有资源复用路径(素材库/已配对设备)。

## 8．防止再次循环返工
先读PROJECT-REVIEW-LESSONS.md。用户已提醒两次：不能只把原则写入记忆，必须把完整状态/事务线性化点/可信scope与适用矩阵落实到施工前。统一一份反馈，区分原契约违反、已列未测、主程新增范围；不要不断转发单例补丁。重复违反同一契约时先审结构和分工，必要时主程接管仓储接缝。严禁为避免返工而降低门禁，也不能承诺未知Bug零返工。

## 9．停止点与恢复提示
本助手无后台测试、部署或付费请求；线上服务正常运行，用户建立的SSH master可能仍在且会自动过期，不擅自关闭用户连接。主工作区未切换/合并，所有脏工作与作者分支保留。此次只总结，不开始88dd344复审/第二批Bug实现。新会话读本文件→只读核对Git/最新消息→按第7节推进，不重跑已完成部署。
