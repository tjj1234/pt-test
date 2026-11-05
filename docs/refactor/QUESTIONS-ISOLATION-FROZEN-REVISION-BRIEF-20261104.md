# 05/06统一修订任务书：原生优先、冻结边界与完整验收矩阵
版本1｜2026-11-04｜接收：Gemini原05/06作者｜负责人：Codex｜当前阶段：M0设计/接缝审核，**先交方案，不立即继续改实现**。
本文件替代历次05/06审核报告中的零散施工指令；历史报告/JSON保留作证据，不要求按每份文件重复修一遍。08和r28 Bug修复不在本任务范围。安全不变量在本文件冻结，实际挂载点/后端选择待M0核实，不能把待核实接口当既有能力。
主程序承担此前规格和审核不充分的责任：先前“原生问答存储”“原生沙箱”称谓过宽，局部反例也不足以覆盖完整生命周期。以下按实际锁定依赖分清可复用接口、真实缺口与测试层。不能保证所有未知缺陷已穷尽；新增问题须区分违反冻结契约、未验证已列项及主程序新范围要求，禁止全记开发者返工。

## 1. 本轮顺序与停止点

| 阶段 | 交付/责任 | 放行门禁 |
|---|---|---|
| M0 原生接缝方案 | 原作者交REUSE-MATRIX、字段/状态/可信数据流、实际接口和缺口、后端威胁模型、下表AC映射；主程序核实并书面确认具体版本 | 不接受只提交“8/8通过”；没有M0认可不继续扩大自建审批/执行器 |
| M1 实现最小切片 | 05接原生问答/审批＋必要宿主记录；06先安全只读及默认禁执行；仅在真实后端满足契约时开启执行 | 每项说明原生实现、产品接线或宿主缺口，不能用测试值特判/布尔后端替代 |
| M2 作者完整自验 | 真实实现/SDK/仓储/OS反例＋UI自测；填完矩阵所有适用项，包括FAIL/BLOCKED | 必测安全不变量不可豁免；外部环境受阻须明确未完成，不算全包PASS |
| M3 主程序独立复审 | 在固定tip重跑原反例、扩展矩阵、审代码及证据；确认变更范围 | 候选局部通过不等于主线接入或端到端批准执行通过 |
| M4 接线及独立验收 | 主程序改共享入口，独立测试工程师同版staging点击E2E；正式发布另走门禁 | 缺真实后端则脚本入口继续关闭；不将只读/问答切片称完整06完成 |

## 2. 原生能力核实结果与具体限制
证据来自当前安装的`@deepseek-ai/*`，下列包package.json均为`0.1.1-rc.2`；对应README.zh.md、lib/types声明已读取。本轮没有升级依赖。这里的API是已查到的真实符号；现主壳是否已装配、支持全部部署环境，仍需M0逐点证明。

| 原生包/真实接口 | 已核实能力 | 明确限制与最小宿主接线 |
|---|---|---|
| dsh-user-questions：UserQuestionService.registerProvider(provider)、ask(request) | 单活provider；questions/agent/signal；答案为answers[id,selected,custom]；带agent时检查确切存活根agent | 这是Service Definition，不是持久化审批库。问答结构不包含完整diff/文件选择词汇；宿主provider负责UI/Run关联/持久待决记录；不能将通用custom文本当批准 |
| dsh-tool-ask-user：ask_user_question | 通过ctx.userQuestions提问、复用正常工具循环，取消沿exec.signal | 不自带UI或超时预算；由宿主落实Run deadline，不另造Agent暂停循环 |
| dsh-user-approval：ctx.approval.request、approval/request waterfall、approval/asked/decided事件 | allowed-once/rejected/cancelled/unavailable；必须活跃轮次；无应答者fail-closed；审计追加失败不返回未记录决定 | 不携带完整工具参数，不含allow-always/撤销存储，轮次外持久批准暂缓。宿主只补绑定完整操作/身份/Run/期限的可信记录，关联原生callId及结果，不能把一次原生allowed-once泛化成通用token |
| dsh-shell：ctx.shell.resolve(request)、run(spec)、start(spec) | 执行器seam，统一后台句柄/结果；jobs负责归属与取消；复用原执行过程 | tool-bash是bash方言，不能把任意Node字符串当同等隔离；错误/超时/取消各有真实结果，不靠stdout关键词推成功 |
| dsh-bash-sandbox＋dsh-sandbox-local＋dsh-sandbox-policy | 用真实平台runner包装精确argv；runner不可用SANDBOX_UNAVAILABLE，不裸执行；会话根/模式共享 | README明确只限制文件影响，网络不受限制、进程可见性按后端；workspace-write还含平台临时目录。不能直接满足本包“限定读取根、无网络/无凭据”等全部要求；M0给出额外隔离/挂载/网络约束证据，否则脚本保持关闭 |
| dsh-fs-sandbox＋dsh-tool-fs/ctx.fs | 复用原生读写编辑和策略围栏 | README明确读取始终通过、围栏不是内核边界、残留TOCTOU不覆盖对抗性宿主。不能用此名称证明tenant读隔离；宿主可信root/安全句柄provider仍需核实，不能重写原编辑引擎 |

本轮实际SDK小探针：new UserQuestionService(new Cordis.Context())无provider时返回NO_PROVIDER；注册合成provider后NO答案被原样返回。仅这两条通过，不代表真实agent/审批审计/持久恢复/OS沙箱已经实测。初次探针误用Context.start()失败，查清接口后使用服务构造方式完成，未将初次失败记PASS。
SDK/文档证据位置：`shell/node_modules/@deepseek-ai/<上述包>/README.zh.md`及`lib/types/index.d.ts`；approval结果类型在`dsh-user-approval/lib/types/types.d.ts`。M0交付须附文件SHA/真实装配探针，避免将安装目录与运行profile混淆。

## 3. 威胁模型与信任边界（已定，不能由实现者放宽）
不可信：模型问题/脚本/路径/JSON、浏览器传来的ID/token/答复、返回给调用方的对象、目录符号/硬链接及检查后替换、晚到/重复/乱序事件。可信：已鉴权服务端身份、已验证原生调用/Run关联、服务端不可变操作快照、真实后端能力与持久仓储。测试fixture不能给自己签发权限。

| 边界 | 必须保持 |
|---|---|
| 身份 | owner/tenant/Run/call/operation由服务端与原生活跃调用绑定；客户端传值只作查找线索，不授予权限。澄清也不能把同tenant任意人默认当有权 |
| 展示 | 先生成不可变候选及完整操作摘要，再展示；批准精确对应显示内容/权限范围；displayedToUser=true自报无授权效力 |
| 批准 | 显式typed approve/reject，标签顺序/语言/custom不改变语义。NO永远不能签发批准；不把第一个选项当批准 |
| 消费 | 原子一次领取；验证可信预期身份/Run/call/operation/type/目标版本/完整payload/digest/期限/撤销；hash仅完整性，不是授权证明 |
| 执行 | 批准不替代沙箱/资源/文件权限；后端不可用或验证服务未知一律不执行，不使用裸spawn兜底 |
| 失效 | Run取消、权限撤销、候选改动、deadline到达使未消费执行权失效；timer仅唤醒，消费时检查绝对时间。服务端失败/重启不恢复旧执行权 |
| 未知 | 已开始的外部/文件动作取消不等于回滚或停费；结果未知只核对原operation，不重新执行；恢复不能自动重放脚本 |
| 审计 | 审批/执行intent与结果有权威引用，持久失败不对用户报成功；不存凭据/全文secret/签名URL |

## 4. 唯一状态与数据契约
下列是目标宿主增量语义，不假定DSH已提供同名HTTP API；允许映射不同名称，禁止弱化语义。原生Session/审批决定仍用原接口，宿主仅维护产品缺失的记录，不另造执行循环或第二份相互矛盾的权威批准。

| 对象 | 最少字段/规则 |
|---|---|
| RequestBinding | schemaVersion、serverActor/tenant、Run/call/operation、nativeRequest/callId、type、question/options语义、targetRef/version、规范化完整payload、显示摘要、createdAt/deadline、revision |
| CanonicalDigest | 规范化有界JSON，覆盖上述授权相关字段；拒绝循环/函数/不支持值，明确数字/缺省/空值；不得用options.join('|')或只hash裸script取代完整操作摘要 |
| Decision | approve/reject/cancel/unavailable/expired，绑定请求revision/digest、真实答复者、时间、原生审计引用。通用自由文本回答与执行批准分开 |
| GrantRef | 服务端不可变私有记录的opaque引用；不暴露可共享引用的权威对象。外部对象变更不能修改服务器快照；token自带字段必须与可信记录/执行context核对 |
| ExecutionBinding | 当前预期scope、operation、目标版本、参数摘要、真实backendId/revision/capabilities、limits、批准消费引用、attempt/lease/fencing、执行结果/未知状态 |

问答/批准状态：pending→approved或rejected/cancelled/expired/unavailable；批准执行权：issued→claimed→completed/failed/unknown，issued还可revoked/expired。跨记录的签发、撤销与消费要有唯一键/事务或等价CAS；同ID同参返回原记录，异参CONFLICT，拒绝/取消不可复活。claim后无执行可能性可按明确恢复协议处理，但不得自动再次获得一次权限；unknown冻结核对。
原生审批仅活跃轮次有效。宿主持久待答重启后可展示历史/未决状态，但不能直接复活旧原生Promise或轮次外allowed-once：新轮次恢复须重新校验原Run/权限/候选，必要时新审批。记录持久化不代表执行被允许自动续跑。
05批准与06执行摘要必须同一schema/规范化函数，包含cwd、root、args、env/network模式、权限、目标版本等实际生效参数，不能05 hash JSON而06另hash脚本文本。身份/权限验证在最后执行点重做，数据库终态不能冒充进程已停止。

## 5. 用户与运行可观察行为
入口由真实问题/工具权限事件触发，显示操作范围、选项和等待期限；缺provider/存储失败/后端未配分别显示不可用原因。用户拒绝、关闭、取消、超时均不执行；重新打开只读当前权威状态，已处理/已撤销按钮不可重放。重复点击一次决定；修改候选必须重新预览批准。回答仅用原生answers词汇，不凭“第一项/肯定语气”识别权限。
06前台执行通过原生工具/结果协议展示；超限、超时、取消、runner不可用分开；stdout/stderr都受字节限制，后台job的归属/增量读取/取消复用jobs。没有真实沙箱时明确“暂不支持执行”，只读/问答可独立验收，不能在后台悄悄用宿主Node执行。
本任务书是统一接缝修订，不另维护第二份前端产品规格；原包UI/Run/SSE路径仍须给真实点击证据，所有待决状态及恢复都纳入下表。

## 6. 冻结验收矩阵：交卷前逐项填结果
每项填写实际实现/原生导出、fixture、命令/退出码、源码/用例SHA、PASS/FAIL/BLOCKED、证据及责任。原8与新增5是其中最小反例，不是全部验收范围。静态文本断言只能辅助，不计行为验证通过。所谓“完整”指本契约范围的已知边界，不保证穷尽未来未知缺陷。

| AC | 必须覆盖及预期 | 层/责任 |
|---|---|---|
| F01 | 锁定原生服务真实加载、无provider拒绝、重复provider、答案结构保真 | 作者SDK＋主程复核 |
| F02 | 原生approval无应答者/never策略/审计失败/非活跃轮次fail-closed，正常allowed-once与审计配对 | 作者真实SDK |
| F03 | 原生tool→问题→UI答复→同一活跃Run恢复，agent/call关联正确，子agent未授权提问拒绝 | SDK＋独立点击 |
| F04 | 宿主补充字段逐条证明原生缺口，profile/provider没有重复装配，不修改DSH内部 | 主程架构门禁 |
| F05 | approval合法schema、必选语义明确；空/未知type、非法options/超大输入拒绝 | 真实接口 |
| F06 | YES/NO换顺序、不同标签语言、拒绝/跳过/custom自由文本均不能误签发批准 | 真实服务＋UI |
| F07 | 同ID同参幂等；不同question/type/operationType/payload/options/deadline等异参冲突 | 仓储/接口 |
| F08 | 请求options/target嵌套对象创建后突变，不改变显示/摘要/允许答案 | 真实实现 |
| F09 | 绝对deadline：timer未运行仍拒迟答；边界时钟/超时参数明确且有界 | 冻结时钟/真实服务 |
| F10 | 其他user/tenant/Run/call/operation访问/答复/消费/查询拒绝，无枚举私密内容 | 双身份接口 |
| F11 | 候选内容/目标版本/cwd/root/args/env/network范围变更使旧批准失效 | 05→06联测 |
| F12 | NO不签发；取消前待答/取消后新问均拒；已签发未消费批准取消后失效 | 真实服务 |
| F13 | 已签发批准到期、权限撤销、Run终态后不可消费；执行中取消边界如实记录 | 仓储＋worker |
| F14 | 返回token/record的外部突变不修改权威记录；签名或opaque引用篡改拒绝 | 真实服务 |
| F15 | 任意随机未签发ID拒绝，不允许固定测试值特判；无verifier/异常/超时一律不执行 | 真实06接口 |
| F16 | verifier比对可信预期context，不只比较token内部hash/type；跨scope重放拒绝 | 联测 |
| F17 | 双击/并发/双worker消费恰有一个获权，重复返回稳定结果，不再执行 | 隔离PG/PGlite |
| F18 | 摘要规范化区分数组分隔符/空缺/null/类型/operationType；非法可执行值拒绝 | 契约实现 |
| F19 | 批准与审计持久化失败无执行；claim/执行前后崩溃保留可核对状态 | 故障注入 |
| F20 | 重启待答不复活旧Promise/原生轮次；已消费或unknown不重放执行 | 真实进程/仓储 |
| F21 | 新增/移除provider或重连不丢scope，旧问题/重复事件不重建批准 | SDK/事件 |
| F22 | 无真实后端/runner缺失/权限不足/partial enforcement不满足合同则拒绝，布尔true不能绕过 | OS/provider |
| F23 | 执行确由原生/经审provider受约束argv承载，无直接宿主spawn兜底或隐式升权 | 代码审＋OS |
| F24 | 实际root与挂载/可读可写范围、共享tmp及凭据可见性符合策略，A/B租户隔离 | OS真实fixture |
| F25 | 未允许的网络实际被阻止；静态黑名单/无网络词脚本不能绕过 | 隔离本地网络fixture，不访问公网 |
| F26 | 敏感环境/文件与DSH身份不跨Run泄露；禁止目录不可见或访问被拒 | 合成secret fixture |
| F27 | 父/叶/授权根symlink、hardlink、绝对/编码路径和检查后替换均无越界 | OS真实FS |
| F28 | 安全FD打开/读取，大小受控；不全文读入后才截断；UTF8边界/特殊文件不挂死 | FS/资源 |
| F29 | list-dir有界条目/输出，超大目录/权限错/不存在有稳定错误 | FS |
| F30 | stdout/stderr各自及总量有界，spill权限/保留受控；满盘/异常无泄漏 | 子进程/文件 |
| F31 | 执行超时、取消、signal预取消与竞态，停止并等待整个受控进程树 | OS进程 |
| F32 | background jobs归属/读取/kill/dispose与重启策略明确，无孤儿/跨Run取消 | 原生jobs |
| F33 | 执行参数超限/NaN/Infinity/非法类型拒绝或按冻结规则限制，不能改成无限制 | 接口/OS |
| F34 | backend已声明full/partial/unavailable与实效一致，runner失败不误报脚本失败或成功 | provider/OS |
| F35 | 来源/文件撤销与活动执行竞态：新访问拒绝，既有副作用/未知结果可核对 | 跨包联测 |
| F36 | UI加载/空/错误/过期/拒绝/等待与后端一致；键盘、焦点、离开/刷新/多标签 | 作者自测＋独立点击 |
| F37 | 取消/错误保留现有成果与历史，不伪称上游停止或零费；未知不自动重提 | 联测 |
| F38 | 问题、批准、执行、审计、产物的Run/call/operation可串联，记录无凭据/私密正文泄露 | 证据审查 |
| F39 | 原聊天/媒体授权/取消/资料/记忆/Skill链受影响回归，同应用版本验证 | 主程集成 |
| F40 | 同一冻结归档在staging独立验收；真实PT/正式冒烟单独授权，版本/配置/迁移一致 | 独立测试/发布 |

F22–34缺环境/实际后端时，执行相关功能整体BLOCKED且关闭；可以提交F01等只读/问答切片，不能把缺项改成不适用后称全部05/06通过。平台确实不支持的能力可提出明确缩范围方案，由主程/用户决定，不在代码中偷偷放宽。

## 7. M0实际需要作者先回复的内容
只交以下可审材料，先不继续堆实现：

| 材料 | 必答内容 |
|---|---|
| REUSE-MATRIX.md | 第2节每个原生接口的锁/导出/真实装配方式、已有宿主路径、真实缺口与最小补充，不引用不存在导出 |
| TRUST-AND-STATES.md | 第3–4节可信数据来源、不可变快照、规范化schema、状态/事务/撤销消费、原生call关联与崩溃恢复；拒绝语义显式定义 |
| BACKEND-PROPOSAL.md | 当前OS与目标OS的真实provider/runner、读/写/网络/凭据/进程威胁模型和差距；原生只管文件影响的缺口如何补或保持关闭，给资源/环境需求而非假布尔开关 |
| AC-MAP.md | F01–F40映射现有实现/需修/需补证据/外部BLOCKED，明确哪些由主程共享接线或独立测试完成，不能把全部丢给作者 |
| PATCH-PLAN.md | 基线fb250a9、独占文件/接口变更与兼容性、分步补丁顺序/回退、预计验证方式；不改其他包和共享脏文件 |

主程M0回复必须明确“采用的原生接口、批准的宿主缺口、后端能力、schema版本、执行开关及验收适用项”，随后才恢复代码施工。M0不是再次让用户回答技术问题；技术核实由主程负责。若设计仍不满足冻结不变量，先改方案，避免实现后逐点返工。

## 8. 统一交付、责任和变更规则
代码在原独立修复分支或另建明确分支，保留历史tip/原探针结果；禁止覆盖当前主工作区、原包正文、其他候选或tests/e2e所有权范围。候选内交可测试接缝/补丁建议，server/runner/profile/迁移/依赖由主程集成。没有批准服务/实际后端时不跑不可信代码；本任务不授权真实PT/生产/外发/采购。
交卷一份总报告：base/tip/源码与依赖SHA、原生/宿主接口版本、F01–40各结果、真实命令/退出码/fixture、作者UI证据、外部BLOCKED、遗留Bug、挂载/配置/恢复及清理。主审保留失败证据，验证合同而非只看测试数；测试数据随机化，不允许与样本字面值绑定判断。
本文件安全边界内的问题属于契约不符合；本矩阵已列但没跑的是验证未完成；超出范围新增产品/平台要求记录变更及影响，由主程负责规格补充。不能承诺永不发现新问题，但不再把“某几个反例PASS”说成“全部安全闭合”。不请求作者重做其他6包，旧05/06实现可复用的部分保留，错误的自建机制只在确证原生接缝后做必要替换。
