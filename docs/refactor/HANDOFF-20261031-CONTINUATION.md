# 北极星完整重构续接摘要｜2026-10-31主动换对话停点

**结论：用户明确要求先暂停、完整总结，再手动 `/new` 开始。当前主线未完成，不是在等Gemini；接入其两包也不能自动交付最终完整版。** 本摘要已按源码、Git、发布物哈希、任务文档及测试日志核对；不是只凭聊天记忆。暂停后不再开发、测试、启动Agent、付费调用或部署；没有本助手的后台开发任务。外部Gemini若仍在工作，不由本助手控制，不擅自停止或改其独占文件。

## 1. 目标、授权与恢复规则

工作区 `/Users/mmdn/Downloads/pt项目`，分支 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`。Git快照见 `HANDOFF-git-status-20261031-CONTINUATION.txt`；停点最终统计为 **67个已跟踪变更条目、736个未跟踪折叠条目**，未跟踪数量是Git默认折叠目录后的条目，不是实际文件数。全部既有脏工作及 `wb copy/` 保留；本段未commit、push、merge或操作线上服务。

用户最新交付目标为**2026-11-02周一**，替代原11-03周二。优先复用锁定DSH，必要缺口才开发；目标是同版能运行的完整Agent，不是候选模块集合。不降低安全、测试或原范围。用户明确“不等运维，持续开发”，此前阶段验证后直接结束回复是执行偏差，恢复后不要再因阶段门禁通过而停工；只有当前这次明确暂停生效。

正式范围：`MONDAY-FINAL-DELIVERY-20261102.md`、`REFACTOR-REMAINING-AND-DSH-ENABLEMENT-20261030.md`、正式v2.0任务包；不是完成百分比。周一是目标而非已经能保证的全量验收承诺。仍有大量主线接缝，不能把缺口归给Gemini或运维。

下一对话先读本文件、WORKLOG末尾与下列主审证据；核对Git/current-draft/198源码绑定后直接继续。不要重跑已经通过且源码未变的整套检查，不要重扫整个大仓。

## 2. 当前源码、草案与证据

当前活动指针：`docs/refactor/candidates/current-draft.json` → **candidate34-r19-draft**。应用归档：`release-artifacts/northstar-controlled-trial-20261031-candidate-34-r19-draft.tar.gz`，SHA256 **`7eb6d84fe8f2aa810f7f966071f0c11bed2b5a3a6f46b3ce10bc3b03dc6798eb`**，198源码/399成员，状态 **DRAFT_NOT_FOR_DEPLOYMENT**。停点直接逐项重算198个计划源码哈希，全部匹配，无新生产源码漂移。构建器 `scripts/package-northstar-candidate34-r19-draft.py`，独立审计 `scripts/audit-northstar-candidate34-r19-draft.py`。r16/r17/r18均保留，不覆盖旧包；最新开发包不是周一最终完整版，也未部署。

| 已完成增量 | 具体行为及边界 |
|---|---|
| r16目录/对话故障修复 | `shell/models/dsh-configured-catalog.cjs`读取实际DSH home settings；未注册模型展示但不能进入文字/图片理解路由，旧缓存不能绕过。模板精确新增两个已确认DeepSeek ID。Runner安全分类UNKNOWN_MODEL/NO_ADAPTER/INVALID_REQUEST，不加预算掩盖故障 |
| r17办公文档输入 | 原有DOCX/Mammoth/严格索引上，新增 `ooxml-structured-text.cjs`；XLSX保留原sheet/cell及原始值、公式文本/缓存；PPTX保留原slide/paragraph。接上传按钮/拖拽→worker→快照/SHA→Run上下文，不执行公式、不猜日期、不解释图表/媒体/备注 |
| r17会话Word导出 | 对话菜单“导出Word”→owned GET `/api/conversations/:id/export?fmt=docx`→有界worker→下载；中文/原文/空格保留，源/产物SHA响应头，历史不改；附件不嵌入并明确提示。不是模型主动结构化文档工具或统一产物索引 |
| r19原生工具门禁 | `guardNativeToolExecution`在原生`tools/execute`校验确切Agent、当前Run原生tool/call/rootCallId及直接调用名称、取消/过期/预算；热Agent旧Run不能借同一Agent身份放行。原生候选仅ask_user_question/skill/web_search，仍须显式allowedTools。宿主工具包装器保留单次预算责任，避免重复计数 |

Office单文件20MiB、ZIP展开64MiB/512项、2个128MiB worker；上下文总截止15s；XML单部件8MiB。拒绝外部主关系/路径逃逸/DOCTYPE/ENTITY/宏/嵌入对象/假格式。Word限制2MiB正文、2000消息/8000段落上界、2个128MiB worker、10s超时，worker退出后释放名额。复用fflate/Mammoth/现有候选生成器与已安装xmldom；直接锁定yaml2.9.1、xmldom0.8.15，DSH release manifest已用原工具重新生成并验证。

| 验证层 | 当前证据，不相加混成一次验收 |
|---|---|
| r19冻结后默认回归 | `evidence/r19-default-regression-20261031.log`：**239/239，0失败**；含自动发现的R3候选测试，不表示其正式交付/主审/生产接入 |
| 确切r19 Linux归档 | `evidence/r19-exact-archive-linux-20261031.log`：closure PASS，原生门禁/宿主SDK/Office/媒体/CSV **5/5**。真正原生DSH/HTTP/Run链，provider为受控替身，无真实PT |
| 干净Linux依赖 | `evidence/r17-office-linux-install-20261031-r2.log`：Node22.23.4 linux/x64，495生产包/31007文件，lockSHA `eb54f12313941e09c569058836b5662b2db82069a1fa721ae1a8b6c0113610d4`；r19依赖/SQL未变，复用同锁同安装再验closure |
| 真实PG16多连接 | `evidence/r17-postgres-regression-20261031.log`：**4/4**，仅localhost一次性DB，已自动清理；r19存储源码未改，不声称又跑了PG |
| Office同版链 | `office-http-sdk-chain-20261031.log`与`r17-exact-archive-office-sdk-linux-20261031.log`：上传→原生请求正文→Run completed/各1意图与1model/0tool→Word反读→历史重开；本机/Linux各1/1 |
| 前端与格式 | DOM桩运行真实app.js、HTTP上传/下载/权限回归通过；尚非目标真实浏览器人工/截图验收。PDF中文/可移植XLSX导出未完成 |

详情：`evidence/OFFICE-PRODUCT-R17-20261031.md`、`evidence/NATIVE-TOOL-RUN-GATE-R19-20261031.md`。r18完整回归虽238/238，但执行中补过rootCall归属，保留为过程日志，不能代替r19冻结后239/239。首次Docker未运行、HTTP测试顺序/格式白名单预期失败均保留，修后独立复跑，不抹掉失败。

6类遗留归档门禁已改为**哈希固定的冻结源码重建/结构/部署脚本检查**，不要求旧包等于今天源码；当前活动候选依旧严格绑定当前源码，未跳过套件，未改历史发布物。原测试 `evidence/legacy-release-gates-original-20261031.tar.gz` SHA `d74dac03c30370434321fe444b5e62fea688f24666f40da02fcd5ec9a0157f01`；辅助 `tests/helpers/check-frozen-release.py`、`check-frozen-candidate34.py`。

## 3. Gemini：待回报任务、文件证据与主审边界

**2026-11-01用户校正：两个R3任务包均尚未向用户上报完成。** 下列本地文件状态不能替代Gemini正式回报；推理包末尾虽有COMPLETED，也只能证明文件内存在该声明。两包均保留待回报、待验收状态，均未接入r19。此前“正式交付”标题混淆了文件声明与沟通状态，现更正。

| 优先级／任务包 | 核心目标 | 文件证据与验收状态 |
|---|---|---|
| **P0 Context R3**：[任务包](GEMINI-DSH-CONTEXT-R3-PACKAGE-20261030.md) | 真正触发原生自动/手动压缩；补齐可信准入、取消、预算和并发隔离 | 用户确认未上报完成。停点候选/测试/probe三文件存在，但证据报告 `evidence/GEMINI-DSH-CONTEXT-R3-20261030.md` 不存在，包末仅交付要求、没有实际交付记录。不得据此推断仍在运行或已经完成；等待正式回报后逐项主审。默认回归自动运行其测试不是验收，不覆盖独占文件 |
| **P1 推理选择 R3**：[任务包](GEMINI-DSH-REASONING-R3-PACKAGE-20261030.md) | 修复生成profile中的导入路径，以及元数据先扫描后限额问题 | 用户确认未上报完成；本地包末存在COMPLETED声明、四文件存在，属于与回报状态不一致的文件证据。本地主审已做，原4/4与HTTP/SSE探针通过，但4个反例阻止直接接入。原候选未改、未装入r19；正式回报后仍须处理主审阻断 |
| R1/R2历史 | 保留历史证据 | 原件保留；Context R2探针人工waterfall/emit，不是真实原生压缩，另有无Run chat、取消Run辅助调用放行反例；未接生产 |

推理R3候选SHA `ef4c41c3fcac0bdd23e126aafeb7be3843b1bd37ff9ba998e1ebb3b0487dcf77`。主审 `evidence/GEMINI-DSH-REASONING-R3-MAIN-REVIEW-20261031.md`，反例 `reasoning-r3-main-review-counterexamples-20261031.json`：①标准导入失败后从cwd/NODE_PATH等加载未验证同名包（999.0.0无害stub已复现）；②reasoning=false分支仍Object.keys全量处理（100属性均被访问）；③任意非空wire被广告为支持；④错误回显元数据值。原单元/探针通过不覆盖这些缺口。

**主线决定不再继续叠加自建thinkingLevelMap验证器。** 已核实并独立证明锁定DSH原生 `ctx.llm.resolveModelInfo`（efforts项字段是id/name，不是label）与 `resolveCallWithInfo`/`resolveCallConfig`可精确拒绝未支持档位，实际stream计数0。证明见 `tests/probes/native-reasoning-api-main-review-20261031.mjs`及对应JSON；受控适配器low/high不代表真实PT支持。模块依赖应只用已锁定包解析，无受信依赖即拒绝，不回退到租户cwd。原生`installModelSelection`已能在A→B切换时移除B未指定的旧effort，必须复用。

## 4. 本次刚开始的新任务：只调查，尚未写生产代码

用户质问是否只等Gemini后，已明确承认主线未完，选定下一实现为**推理选择UI→持久Run→Runner**。用户随即要求暂停换对话；到此只读了接口，没有新增metadata RPC、UI、reasoning持久字段或接线代码，198源码仍绑定r19。不要把下面设计当已实现。

已查清接缝：
- `shell/runtime/dsh-adapter.cjs`：`dispatchFrame`约514行、`getOrSpawnProcess`约674、`run`约772；目前返回仅run/pulse/activeTenants/abort/closeSession/close，无describeModel方法。taskFrame约881行没有reasoningEffort。
- `shell/tenant.cjs`：`runDshForUser`约218行传runtime.run，无reasoningEffort；可新增可信metadata入口复用租户身份/凭据和既有失效流程，不要另建运行时。
- `shell/persistent-runner.mjs`：已有原生installModelSelection，selection.current目前仅provider/model；可在明确校验后传effort。ready能力协商/即时控制命令处尚无model-info能力。原生查询不得变成真实模型task。
- `shell/server.cjs`：`/api/models`及`/api/models/select`负责owned会话偏好/当前同Key目录资格；chat用户消息、重新生成/分岔与持久请求必须绑定选中的effort，不能仅改UI或冷热会话丢字段。客户端、metadata、scope/revision与实际派发要一致；未支持档位在模型POST前拒绝。
- 原生 `resolveCallConfig`查询不绑定后续adapter注册；实际日志/派发须遵守prepareCall或真实原生dispatch绑定语义。UI元数据不是权限/真实运行验证；不从reasoning=true/名称猜档位，也不盲目给所有PT模型加reasoning配置。

**新发现的必要风险：只读metadata若冷启动常驻子进程，不能意外加入付费心跳。** `runtime.pulse`约933行会真实发模型请求；`tenant.activeHeartbeatTargets`约259→`runtime.activeTenants`，`server.startHeartbeat`约2650会遍历；开关 `PT_HEARTBEAT_ENABLED`源码默认关闭，目标实际是否启用未核验。metadata-only进程需与真实聊天活跃状态区分，并有空闲回收；不能将“只读GET元数据”间接变成收费。模型metadata应走独立、有限并发/超时/取消、有能力协商的RPC，禁止用run(question='describe')替代；不得暴露原始错误/Key。

建议恢复顺序：①核对r19绑定和Context正式交付状态；②完成原生metadata查询/生命周期零模型调用证据；③UI仅展示原生实际支持档位，切模型清除不适用值；④effort固化到Run/历史/重生成与Runner，原生请求字段及失败原子性实测；⑤再收口原生提问/审批、Skill发布与联网。执行过程中不因单轮门禁通过再自动停工。

## 5. 线上r14与运维：独立保留，不阻塞本地开发

线上状态仅以此前运维回执为据：r14旧入口已运行/health曾通过，本轮未刷新目标机、未切服务。`docs/refactor/logs20261030`扫描27文件，25错误：UNKNOWN_MODEL12、RUN_MODEL_CALL_LIMIT8、INVALID_REQUEST1、旧UNKNOWN4。两个DeepSeek目录ID未注册已本地复现；匿名汇总不能逐条绑定模型或Run，INVALID_REQUEST单条仍未定位。

用户最新实际settings回执：activeSettingsReadable=true、configuredModelCount=24；deepseek-flash、deepseek-v4-1-flash-260910、qwen3.8-flash均false，seed-2-0-lite-260228=true。确认实际配置落后，但不知道是否有运维编辑/受管基线，不能整份覆盖；只换新包/重启也不会自动升级home settings。发布需备份、精确settings迁移、profile重建、启动/回滚及同版业务验收，r19草案不能直接部署。

只读运维小包 `release-artifacts/northstar-r16-config-preflight-20261030.zip` SHA `a567d54e69a4caf14ac39cc43df519890b969b6c5cb3bbb843c555c19efaa61c`，说明 `OPS-R16-NEXT-ACTION-20261030.md`，不含应用/部署命令。待回执：settings基线/三个哈希及同故障账号三个模型scopeId/capabilityRevision/permission。媒体目标此前reviewConfigured=false、controlledAuthorization=false、assetHostsConfigured=false，是交付缺口，不归为Key问题；不得复制本地review或全模型放行。审核最长24h、受限CDN/单次授权与未知外部操作不重提规则保留。

本段未进行任何真实付费provider调用。历史用户授权测试余额供最小受控试验，余额未知；摘要不保存Key，当前没有安全内存中可复用的Key。不得从日志/聊天历史找凭据、把fixture Key当真Key，或对未知外部操作自动重试。继续独立本地开发，不为这些回执停下全部任务。

## 6. 最终完整版仍未关闭的范围

主Agent自己的任务远未全部完成；Gemini两包只是其中两条。完整台账见 `MONDAY-FINAL-DELIVERY-20261102.md`，至少保留：音视频理解/时间定位、PDF/OCR/旧Office/ZIP资料包、跨资料检索/定位引用/删除失效、真实原生长会话压缩、记忆来源/确认/范围、PM Skill发布/禁用/版本pin与原生loader、可信联网provider与受控出口、推理选择产品闭环、模型主动多格式产物/中文PDF/可移植XLSX/统一产物索引、实际账单关联/费用未知核对、多模态跨步骤AUTO、原生提问/审批及隔离执行。

另五类跨功能验收：身份/BYOK撤销及旧资产迁移；同版真实浏览器/上游身份；双用户多会话取消/断线/崩溃/晚到隔离；干净CI/依赖快照/性能与独立验收；PG+密钥+文件联合备份恢复/版本回滚/全新实例复现。现有模块或本地替身通过不等于这些全部关闭；不得虚报完成百分比或“只差Gemini”。

**暂停状态：仅完成交接文档，等待用户手动 `/new`。没有继续开发/测试或后台Agent。** 新对话收到“继续”后，以上授权恢复；本次暂停不是永久取消任务。
