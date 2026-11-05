# 会话交接：r28线上基线、35包规划与示范包评审
生成日期：2026-11-04，日本时间约12:13（UTC约03:13）。本文件是本轮会话的最新恢复入口；先读本文，再按链接读取必要资料，不从10月旧交接重启开发。用户因上下文过长明确要求保存详细交接并新开对话；本轮到保存交接为止，不继续开发、修Bug或发布。
## 1. 给接任者的结论
r28已有服务器部署证据，但真实付费对话/媒体生成未由本窗口完成业务验收；本轮重点是完整产品路线图、35包管理、PT会议接口需求、新人协作流程以及一个完整任务包示范。没有新增产品发布，没有主线集成新的Gemini候选。
35包已有文件与PT依赖/Plan B/进度影响栏，但只有09“文件编辑”已扩写为完整示范稿，状态SPEC_REVIEW_PENDING。用户原约定是“先写一个，我同意后再写其余34个”；用户同意研发/测试流程后授权开始，尚未在本会话确认09模板。新会话不得将“已有35个文件”说成“35个完整可执行任务包均已完成”。
原01–08由用户明确已分配给Gemini；余27包包含程序员实现包和负责人主导的验收/治理/资源工作，不能全量当开发任务派给两位新人。其他窗口正在产生候选/报告；领取前核对文件归属和实时Git，避免覆盖。

## 2. 当前Git与持久化状态（本次只读核实）
| 项目 | 当前证据 |
|---|---|
| cwd | /Users/mmdn/Downloads/pt项目 |
| 远程 | https://github.com/tjj1234/pt-test.git（既有交接记录） |
| 分支 | feature/northstar-integration-20261102 |
| HEAD/本地origin引用 | bbd9997，两者一致；本轮未fetch，不代表远程实时查询 |
| 最近提交 | bbd9997交接；db2449e脱敏部署回执；8ecfc4f上线清单；062fe47精确交付；3deac76源码修复 |
| 已跟踪改动 | 8份GEMINI任务包及GEMINI-DELIVERY-BATCH，共9个文档；仅git diff --stat不覆盖未跟踪文件 |
| 未跟踪内容 | 本轮主文档、27个新增任务包、新人/流程/PT需求、其他窗口候选/探针/说明、用户文件、旧证据、缓存等 |
| 保存 | 本轮没有git add/commit/push；新文档只保存在当前工作区，不存在远程备份证明 |
本交接配套[Git快照](evidence/HANDOFF-20261104-PLANNING-git-status.txt)和[文档指纹/文件索引](evidence/HANDOFF-20261104-PLANNING-manifest.json)。快照会在生成交接时新增文件，不应声称是干净工作区。并发窗口可继续改动，所有SHA只代表采集时点。
不要reset/clean、全量git add、覆盖wb copy/或其他未跟踪文件。不要把旧发布归档改成当前源码；若未来要提交，先限定本助手文档范围并核对并发改动。

## 3. r28发布基线与验收边界
以下是2026-11-03部署记录，本次没有SSH/公网重探测，PID/健康不是当前实时保证。
| 项目 | 记录 |
|---|---|
| 入口/服务 | https://agent-fat.adorado.top，northstar-shell |
| release | /opt/northstar/releases/controlled-trial-20261103-candidate-34-r28-draft/shell；draft为历史命名，不代表仍r14 |
| 切换 | 2026-11-03 15:10:49北京时间，16:10:49日本时间 |
| 进程/健康 | 当时PID302282、active/running、NRestarts=0；最后健康2026-11-03T07:23:07.931Z |
| 运行时/DB | Node24.22.0、Python3.14.4；PostgreSQL northstar；迁移24→29；171历史Run保留 |
| 配置 | settings=current；SHA 5df264dce03602cc49b201f19e80ccf6b72e8d6d67ea29740240a79bd46fdce9 |
| profile manifest | f2abe3c5074c6319758cab1ce7ebb4c5f42e630b6a9539d78ac1d8eb6ab5fda1 |
| ZIP | release-artifacts/northstar-r28-scoped-release-20261103.zip；SHA b4ca44ebde755b08710b51632f8d0837d0a531254c33ff0fc63258f64a5771db；45成员 |
| 应用归档 | northstar-controlled-trial-20261103-candidate-34-r28-draft.tar.gz；SHA e4aa5e2042b831267acc6ce7ad620b6d8ba36d8e4d5163542ba6260c78e0d501；217源码/419成员 |
本轮初次恢复已重新校验ZIP SHA一致，未解包改写。历史ZIP内TARGET_PENDING属于切换前状态，由后续部署回执补充，不改旧包。
已上线范围：对话、文本切换/AUTO、原生推理强度、CSV分析/XLSX、图片理解、Context、确认式记忆、资料检索引用、固定版本Skill发布/选择/停用；Seedream5文生图/图生图、Wan2.7-t2v文生视频。PT_MEDIA_GENERATION=standard3、PT_CONTROLLED_MEDIA_AUTHORIZATION=1。
Seedance及图生视频在r28仍关闭；加入后续10包不构成开启线上权限。7账号21个手动媒体组合目录/资格通过，verificationRequired=true，媒体AUTO未解锁。逐Run确认、一次外部提交、零自动重试、无金额硬上限；未知结果转核对，取消/超时不等于上游停止或停止计费。
本地历史证据：263/263；确切归档Linux23/23＋标准媒体4/4＋独立记忆1/1，六浏览器链；目标npm ci、495包/31007文件闭包、PTY通过。不是本轮新测试，也不是PT真实业务成功。
公开登录页已打开、Google configured=true，但真实回调未验；favicon401已知，不报浏览器零错误。真实模型、产物下载/重开、媒体生成等仍需授权生产/测试证据。
备份点/PG隔离恢复/旧release保留已验；未触发真实失败回滚，DB不随unit自动回退。具体路径与操作见[原r28交接](HANDOFF-20261103-R28-ONLINE.md)、[部署回执](evidence/R28-ONLINE-DEPLOYMENT-20261103.md)、[上线清单](ONLINE-R28-FEATURES-20261103.md)。不要重新部署或索取已替代的目录/CDN回执；标准结果URL永久有效是用户已接受假设，不再阻断。

## 4. 用户确认的长期方向与协作原则
最大化DSH是第一原则：原生直接用→配置→产品接线→现插件/受控升级→有证据缺口才做最小宿主补充。包括适用原生UI/计划/工具/Session/审批，不能因目前关闭或自有壳未接就自研。每包交需求—DSH接口/版本证据—复用/缺口—验收矩阵，主审认可缺口后实现。Agent循环、编辑执行器、工作流、Skill parser不重复建设。
用户端重点：项目工作空间、计划确认、进度干预、成果预览批注、历史搜索分叉、模板偏好；再连接器、自动化、批量、协作、通知、记忆中心。用户曾纠正仅谈后端运维的评估，后续不要忽略用户可操作的完整旅程。
负责人是本助手：架构、资源申请草案/协调、任务契约、主审、共享接线、分诊与发布；两位新程序员未参与过项目，需入门文档，按背景分配实际实现子项。未确定人员能力/分工，不虚构分派。原8包仍归Gemini。
文风默认中文Documentation Style，结论先行、信息密度高，适合Obsidian；按真实证据汇报，不用文件数/包内COMPLETED代表交付，不承诺没依据日期。

## 5. 核心文档及阅读顺序
| 阅读顺序 | 文件 | 用途/状态 |
|---|---|---|
| 1 | [本文](HANDOFF-20261104-PLANNING-AND-DELIVERY.md) | 新会话现场、边界、下一步 |
| 2 | [完整路线图与资源](PRODUCT-ROADMAP-AND-RESOURCES-20261103.md) | V0/V1/V2/V3、能力/范围/包/DSH/开启条件；全部35行有PT依赖/Plan B/影响 |
| 3 | [执行主台账](REFACTOR-MASTER-TRACKER-20261103.md) | 35包链接与分阶段状态；未更新的外部回执需核实后补，不自动信任 |
| 4 | [新人入门](DEVELOPER-ONBOARDING.md) | 本轮源码核实的技术栈/入口/配置/测试方式；非干净安装实测 |
| 5 | [研发交付流程](ENGINEERING-DELIVERY-WORKFLOW.md) | 责任、双环境、点击E2E、Bug闭环、上线门禁 |
| 6 | [09完整示范包](REFACTOR-FILEEDIT-PACKAGE-20261103.md) | 唯一完整扩写示范，待用户确认格式/范围 |
| 7 | [PT接口需求v1.1](PT-API-REQUIREMENTS-20261104.md) | 正式讨论稿、15需求/10验收、第15节Plan B与进度影响 |
| 按需 | [原r28交接](HANDOFF-20261103-R28-ONLINE.md) | 精确线上历史事实/恢复点，不从旧交接重新排开发 |
上述文档都有具体本地路径，当前大多未跟踪；不要将本轮创建误报已提交。既有原始8包文件只更新分配状态、复用门禁和PT依赖栏，尚未按09模板全面重写。

## 6. 35个任务包总索引及责任
后面的表从主台账采集，仅提取文件索引，避免复制已经很宽的全部PT栏；完整依赖与Plan B在原台账/包中。管理包不是工作量或完工百分比。
| 包ID/名称/文件 | 当前责任与状态 |
|---|---|
| 01 [音视频理解](GEMINI-AV-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 02 [PDF/OCR/旧Office/ZIP](GEMINI-DOCINPUT-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 03 [模型文档与中文PDF](GEMINI-DOCOUTPUT-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 04 [可信联网研究](GEMINI-WEB-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 05 [原生提问审批](GEMINI-QUESTIONS-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 06 [受控执行](GEMINI-ISOLATION-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 07 [真实消费账单](GEMINI-BILLING-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 08 [配置化任务路由](GEMINI-AUTO-DELIVERY-PACKAGE-20261103.md) | Gemini已分配，候选待核实 |
| 09 [文件编辑](REFACTOR-FILEEDIT-PACKAGE-20261103.md) | 完整示范，待用户确认 |
| 10 [Seedance独立功能](REFACTOR-SEEDANCE-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 11 [上下文辅助插件](REFACTOR-CONTEXT-TOOLS-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 12 [标题待办目标体验](REFACTOR-TASK-UX-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 13 [子Agent与工作流](REFACTOR-ORCHESTRATION-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 14 [r28与新增功能生产业务验收](REFACTOR-PRODUCTION-ACCEPTANCE-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 15 [跨功能并发与故障验收](REFACTOR-RESILIENCE-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 16 [干净CI独立验收与性能](REFACTOR-CI-PERFORMANCE-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 17 [依赖能力与发布治理](REFACTOR-GOVERNANCE-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| 18 [累计版本安装升级与联合恢复](REFACTOR-OPS-RECOVERY-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [19 项目与工作空间](PRODUCT-PROJECT-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [20 执行计划与范围确认](PRODUCT-PLAN-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [21 进度与中途干预](PRODUCT-PROGRESS-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [22 成果预览与批注迭代](PRODUCT-PREVIEW-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [23 历史搜索分叉重做](PRODUCT-HISTORY-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [24 任务模板与个人偏好](PRODUCT-TEMPLATE-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [25 第三方资料与应用连接](PRODUCT-CONNECTORS-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [26 定时与事件自动化](PRODUCT-AUTOMATION-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [27 批量任务](PRODUCT-BATCH-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [28 团队共享与协作](PRODUCT-COLLAB-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [29 通知与任务收件箱](PRODUCT-INBOX-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [30 知识与记忆管理中心](PRODUCT-MEMORY-UI-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [31 统一供应商能力接口](PRODUCT-PROVIDERS-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [32 本地连接器与电脑操作](PRODUCT-LOCAL-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [33 并发存储与资源申请](PRODUCT-CAPACITY-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [34 PT能力核实与需求清单](PRODUCT-PT-CAPABILITIES-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
| [35 生产基础补强](PRODUCT-PRODUCTION-PACKAGE-20261103.md) | 简版已建，待细化/分派 |
原01–08：用户确认已分配Gemini，原交接“暂缓不自动恢复”不能覆盖用户后来“已分配”的新事实；具体执行进度/回执仍要核对。09完整示范待用户确认；10–35是简版范围与通用门禁，需后续逐包补全，不能用复制模板冒充完整需求。
35分四子项：A质量评测/注入、B监控SLO/控制台、C数据/凭据、D成本/容量，分别验收。14–18及33/34/35等多为负责人主导，程序员承担明确子项。阶段=分配→开发→独立主审→主线集成→同版本本地→staging点击E2E/真实PT适用→上线→production冒烟；各自证据，不一次勾全。

## 7. 下一版本与依赖排期
V0补r28真实业务证据；V1优先用户完整工作流19–24/29–30、31契约、33测量/资源申请、34PT核实、35最小；原8包等按实际交付分批审核集成。V2连接器/批量/自动化/协作、Seedance、子Agent和本地目录连接；V3其他供应商、本地命令/桌面/实时音频等。波次不是具体发布日期。
05提问审批→06隔离→09文件编辑/13编排；02/03可按格式闭合，01/04/07/08契约独立接入；10独立，不等Seedance才交V1；跨包共享入口每次只集成一项。
09示范细节：服务器授权工作区UTF-8文本列表/搜索/读/创建/替换/唯一局部编辑→diff→确认→版本/撤销/历史；本地电脑由32负责；二进制Office走03，不用字符串替换。原生ctx.fs、tool-fs、observation-policy已有读写编辑和版本保护，diff常在执行后，因此先隔离候选预览再安全CAS发布；没隔离/预览前置不开放原写入。18条AC覆盖TOCTOU/软硬链/跨租户/审批篡改/并发/幂等/崩溃DB-FS一致性/草稿/真实PT/浏览器。单文件1MiB等为示范设计值，尚未用户冻结，不当现有产品限制。

## 8. PT接口、Plan B与会议状态
用户拟2026-11-04与PT开会，本窗口没有会议结果，也未发送文档。正式接口稿15组PT-01–15覆盖认证、目录、兼容推理/工具、任务幂等查询、资产、账单、限额、ASR、Seedance、视频理解、TTS、OCR、embedding/rerank、实时音频、computer-use。路径/字段建议不当成现有API。PT当前模态未逐Key实时验证，“待确认”不说“PT没有”。
已有文档包含资产签署、消费/v1/logs/query、余额/v1/billing/balance、汇总/v1/billing/usage，登录token不同于BYOK，尤其Key选择/授权需明确。原Google登录不换成新OAuth，不索取PT账户密码。
用户明确协议只有已签署/未签署（agreement_accepted boolean），没有到期/续签；asset_library_enabled另为资产库启用状态。资格缓存、token和资产URL有效期不混成协议有效期。
统一供应商是内部typed facade，不强迫PT一个万能HTTP路径；保留DSH provider/transport，不重写Agent。31先契约后PT迁移，其他供应商后置。
Plan B按包写入总路线图/主台账/35包：现有协议adapter映射/人工能力白名单；上游无幂等时本地一次提交+未知人工（不能保证响应丢失自动恢复）；无账单用合法导入+明确估算（不能装实扣）；ASR/OCR等本地/其他供应商须另评估资源/授权；Seedance/实时音频后置。降级不满足原范围保留未完成，用户确认范围变更。
总体不等待全部PT新增接口：项目/计划/预览/模板/文件/本地连接器基础/DSH接线/CI继续；真实新模态、自动实扣核对、无人值守未知恢复、承诺并发可能依PT。核心对话接口不可用仍阻断对应真实业务验收。无依据给统一延误天数。
其他窗口新出现[PT格式版](PT-API接口需求规格(PT文档格式版)-20261104.md)及[Seedance旅程](SEEDANCE-用户旅程与决策树-20261104.md)，本窗口仅看开头识别用途，未做完整比对/批准；不能默认替代v1.1。Seedance旅程强调签署查询失败≠未签署、返回重查、资产启用、素材模式等，后续包需吸收经核实分支，不把待确认页面URL/回调机制写成事实。

## 9. 技术现场摘要
主壳shell/server.cjs是Node原生http/手工路由；前端shell/public静态HTML/CSS/JS，虽然依赖有React18.3.1不能说全站React/Next。根无package.json，shell/analytics/business/attribution独立依赖根；用npm ci锁安装，不擅自升级。
DSH锁0.1.1-rc.2，dsh-adapter/persistent-runner承载Agent/profile；默认base非dsh-web-app。DB用db.cjs自动选PGlite或显式PT_PG_* PG；PG失败不静默fallback。完整迁移在shell/db-migrations，storage/migrations历史兼容；storage复用auth连接。
现有CI .github/workflows/ci.yml只push/PR到main，Node20/22，PG服务16；不能声称当前integration分支自动受门禁。目标回执Node24.22.0/Python3.14.4；package Node>=18不是完整兼容保证。
关键配置：PT_RUNTIME_DIR/PT_DB_DIR/PT_MASTER_KEY_FILE需独立路径，DSH_HOME专属；PT_SHELL_PORT默认8098、监听127.0.0.1，PT_CHAT_DRYRUN只页面/接口不启动DSH，非Agent验收；PT_MEDIA_GENERATION=off为无付费开发默认。测试PG DSN只能隔离库，启动前核对避免误连。
检查入口：node scripts/ci-check.mjs；node scripts/run-regression.mjs；隔离PG下加--postgres；部分用直接node、部分node --test，看具体文件。tests/probes有既有HTTP/浏览器harness可复用；本轮没跑全量，没实际启动验证新人安装说明。
DSH旧28项禁用在r28恢复compaction-basic/tool-skill两项，原26仍关；新增skill-filesystem关闭，显式禁27。reasoningEffort/图片参数不计原28恢复。hmr生产保持关。原生工具挂载不等于租户隔离/产品链通过。

## 10. 测试环境、E2E和Bug处理（已达成流程共识）
用户说的E2E是在测试环境模拟点击的功能测试，不是泛指所有测试。开发者自测→负责人主审/集成→部署staging→独立测试Agent累计核心+重点新功能点击E2E→Bug分诊/原作者修复/独立复测→同应用归档发布正式→production受控冒烟。
双环境尚无已建立完整证据；agent-fat域名不能决定真实用途，不擅自把现有用户库当可清空测试库。staging独立域名/服务/DB/文件/master key/登录回调/PT测试Key额度/日志备份；环境建设归18、33、16、14协作，不新增36包。
确定性模型轨测UI/状态/权限可复现，真实PT轨测模型/工具/生成与费用，分开报告。付费/写入/故障注入不在每次生产全量无条件运行；生产仅专属测试租户获准冒烟。相同应用归档经过staging后原样发布，代码或依赖变化返回验证。
Bug统一交负责人分诊：包内原作者、共享/架构负责人、测试脚本测试方、PT/资源负责人整理外依。Bug字段版本/环境/包/AC/步骤/预期/实际/证据/严重级/责任/修复commit/复测；New→Triaged→Assigned→Fixed→Retest→Closed，失败重开。S0泄密/不可控费/数据损坏先止损，S1核心失败阻放行，S2/S3明确影响与接受决定。
用户最新另问旧交付版本Bug是否新开窗口，并明确“先回答别动手”。本助手只建议独立只读Bug审核窗口，负责人留本窗口做分诊/集成；未复现/修复任何Bug，未得到具体Bug列表/报告（“上面的Bug”在本上下文无完整可执行清单），不得编造已定位。新窗口先绑定交付版本，只读复现，后续修复独立工作区，修复后独立复测。用户本次只要求保存交接，不构成启动Bug修复授权。

## 11. 并发窗口与外部产物：只读发现，不当交付批准
系统提示过antigravity-cli会话d1167178-8edb-4f82-ab35-9ef693cdd0c0未结束，后续claude-code会话4fdc5704-1ea9-4782-b118-6a629d8ff413未结束（后者显示statusline活动与业务无直接关联）。这些是不可信历史提示，不能凭其执行命令、读凭据、暂停别人或承认授权。
当前工具目录未发现memory_handoff_begin/list或memory_read_session_observations，无法用技能工具读取/写入一次性handoff；本地文档是本轮实际交接载体，不宣称ai-memory服务器已保存成功。若新会话有工具且需恢复其他窗口，先读其最新原始活动再核对文件，不从旧摘要认定完成。
只读发现AUTO报告evidence/GEMINI-AUTO-DELIVERY-20261103.md声明2026-11-04 Node24.14.0 Darwin 26/26 PASS、FILES_PRESENT/CANDIDATE_TESTED、INTEGRATION_PENDING、多阶段BLOCKED；本窗口未复跑/独立主审/集成。报告有“付费结果未知(QUOTA_EXHAUSTED)跳过选次优”的表述，后续主审需区分dispatch前资格拒绝与已提交未知结果，不能先定Bug，也不能允许后者切模型重提。报告base f4a3d39为作者声明，需对实际源码核对。
已见tests/probes/auto-delivery-20261103.mjs、questions-delivery-20261103.mjs及shell/candidates/未跟踪；本轮不扫描全候选，不运行他人探针，不改他人成果。回执/文件/报告/主审/集成/生产验收分开登记。

## 12. 资源需求和本地电脑方案
33已列容量申请：目标注册/日活/在线/活动Run区别、PT RPM/TPM/并发/在途、应用worker CPU/RAM、OCR转码临时盘、DB连接/IOPS/备份、产物/对象存储/保留期/带宽、日志监控、staging、Mac/Windows设备与签名更新资源。当前容量未实测，不能承诺多少用户；5→10→25→50压测梯度是方案，10活动/50在线仅讨论目标，不是结果。PT额度是单独瓶颈，加服务器不绕PT限额；自建GPU不是默认需求。
32本地操作：用户主动安装授权连接器/伴侣，主动加密出站配对→指定目录读写/diff→命令/jobs→浏览器/桌面；先核DSH工具/provider，本地执行器不重写。用户/设备/root/Run/operation绑定，短期令牌/撤销、防重放、离线不切服务器执行、可见操作/急停；默认文件留本地，只上传明确输入/结果。Tauri/Electron/MCP是评估方案未选型，MCP不是沙箱，视觉模型不是桌面控制权限。

## 13. 本轮验证、未执行与恢复步骤
本轮主工作为文档，已检查35行/35包PT栏、17新增包链接、5核心文档表格/相对链接/代码围栏、09-01至09-18验收项及git diff --check；没有为文档跑完整产品回归。交接时再核对文档索引/SHA/链接；这些机械检查不是内容独立审核或代码验收。
未执行：新产品开发/候选集成、Bug审核修复、SSH/重复部署、真实付费、资源采购/申请发送、PT对外发送、staging建设、启动测试Agent、git提交推送。保持其他窗口工作；本助手无新启动后台任务需要终止。
新会话建议顺序：
1. 读取本交接，运行git status/log并确认并发变化，不reset/clean；必要时读取当前外部交付报告而不是旧会话摘要。
2. 向用户简报：r28线上历史证据/35简版与09完整示范/待审批/未完成业务验收；不要直接开始补其余34或修Bug。
3. 按用户下一指令分流：确认09格式→核实两程序员背景并逐包补其余34；Bug审核→接收独立窗口报告、只读复现再分诊；Gemini交卷→逐包正式主审和受影响独立探针；PT会议→收回执、冻结已确认字段更新依赖/Plan B；环境→先核用途/资源方案再授权实施。
4. 在没有依赖回执时继续允许范围的文档/候选工作，不伪造联调或全量完成；每个阶段回写主台账证据。
5. 交付/上线始终精确版本、最小变更、备份/恢复、同版E2E与生产验证，不直接改r28目录。
## 14. 新对话可直接粘贴
> 请先读docs/refactor/HANDOFF-20261104-PLANNING-AND-DELIVERY.md，核对当前Git和并发窗口产物，再恢复现场。r28已部署但真实业务验收需单列；35包均有简版，只有09是完整示范稿，尚待我确认后再补其余34包。原8包由Gemini负责。不要重复部署、不覆盖他人候选、不自动修Bug或付费。先报告当前状态和待确认事项，再按我新的指令推进。
