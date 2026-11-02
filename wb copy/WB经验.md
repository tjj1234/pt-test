# WB经验

# 问题四（第 1 块）· tencent-docx 三段流水线的「溯源协议」与「下游技能」

## ① 分析本身

一次"写份文档"的请求被拆成 S1 内容创作 → S2 版式生成（恒 html）→ S3 格式转换（html→docx） ，由编排者`tdoc-orchestrator` 串起。

*   S1 =`agents/doc-writer.md` ，意图 →`stage1/final_draft.md`
    
*   S2 =`agents/doc-formatter.md` ，md → html（ 恒为 html ，不存在别的输出格式）
    
*   S3 =`agents/doc-converter.md` ，html →`.docx` （强制`present_files` 开预览）
    
*   只有两条预设链：`full_pipeline = S1→S2→S3` 、`beautify_only = S2→S3` ； 编辑类（edit\_only/inject\_fill）不进本 skill ，直接转给`tencent-docs-routing` 另起 request\_id。 溯源协议 = 两个文件分工 （ log-schema.md 里逐字声明）：
    

文件 记什么 面向 形态 `pipeline-state.yaml` 流转与产物（各 Stage 状态、产物路径） 进度/产物溯源 单文件原地更新 `trace/pipeline.log` 每次路由决策（怎么判、走哪条路、耗时） 决策回溯 JSON Lines 追加

关键定位（ pipeline-state-protocol.md 逐字）：  "`pipeline-state.yaml` 是本次 Pipeline 的溯源记录（audit trail），不是执行锁。" 所以它 无需锁、无需原子 tmp+rename、无需启动时校验拒绝执行 ——因为它是 单写者、追加式 的。日志里还刻意 不记原文 （只有`intent_length` ），为保护隐私。

schema v1 关键字段 ：`request_id` (uuid-v4) /`entry_type` (full\_pipeline|beautify\_only) /`stage_chain:[1,2,3]` /`output_docx_path` (绝对) /`output_docx_user_specified` /`current_stage:0..3|completed` ；三段各自`status/output_path/...` （stage\_1 有`critic_decision: PASS|DEGRADED` ；stage\_2 有`html_sub: template|imitate` ；stage\_3 有`present_files_opened` 硬约束）；末尾`consistency_check` 。

写入时机三节点 ：Stage 0 判定入口后（建目录、跑`resolve_output_docx_path.py` 、写基础字段）→ 每个 Stage 完成后（ 先写 YAML 再声明`[Stage N 完成]` 检查点 ）→ Pipeline 结束写`consistency_check` 。

"怎么防 S1/S2 半成品被误当最终结果"——三保险 ：

1.  硬约束 ：中间产物 禁止`present_files` /开预览/贴正文； 只有 S3 的 .docx 强制开预览 ，是"本轮唯一最终交付"。`doc-converter.md` 原话"🔒 硬约束 · 强制打开预览…无例外、无豁免"，未开预览即声明完成 = S3 未完成。
    
2.  命名区分 ：stage1 固定名、stage2 带主题后缀且 必须写实际文件名 、stage3 由`output_docx_path` 决定。
    
3.  一致性检查 ：结束 真实 stat 文件 + 比对`stage_chain` 全 completed。文件里逐字警告"历史上出现过 output\_path 写固定名而实际文件带主题后缀、却报 pass 的情况"——这是 历史 bug 的反向沉淀 。 下游技能 ：
    

*   S1：8 个 L2 专家（legal-contract / stock-research-report / business-copy / tech-blog / academic-paper / science-writing / work-report / poetry-prose）+ L1`general-writer` 兜底；支持`expert_id` 直指；另接`critic-generator` （出 critic\_decision）、`deep-research` ；短篇走`brief-compose` 。
    
*   S2：`design-token → doc-typeset → html-review` （+ format-extract）；4 情况收敛成 2 workflow（有`ref_doc` → html-imitate，否则 html-template）；`ref_doc` 只读、绝不落笔 。
    
*   S3：`html-to-docx` （Python，24 个模块）。
    
*   专家怎么加载：manifest 不支持`experts` 顶层字段 → 靠 agent 运行时 Read 加载 。  
    

## ③ 归属分层

*   A ：无——S1/S2/S3、专家、编排、溯源协议全是产品自定义。
    
*   B ：长链路拆段 + 段间契约；溯源双轨；目录/命名规范；"中间产物≠最终交付"的硬约束；`consistency_check` 的"留痕但不阻塞交付"取舍。
    
*   C ：编排层定位"composer 不是 lookup table，只拥有路由 + 数据衔接"；`SKILL.md` 六条铁律（弹性入口 / 链路不可中断 / 真委派—— 角色切换优先，spawn subagent 仅用户强制时 / 只关心路由与衔接 / 中间产物不主动展示 / 溯源必写）。
    

## ④ 借鉴点

1.  长链路必须配 状态文件 + 决策日志 双轨（只有状态文件 = 只看到结果、看不到原因）。
    
2.  把"什么算交付"写成 硬约束 ，别靠自觉：命名 + 展示权限 + 真实 stat，三保险。
    
3.  溯源文件当 审计流水 做（单写者追加式），别过度设计成分布式账本。
    
4.  编排层要 薄 ，业务下沉，才能各自演进。
    

## ⑤ 提问环节

*   S2 崩了，这份 yaml 留下什么？"链路不可中断"是不能跳过 S2，还是不能停？
    
*   为什么溯源刻意 不阻塞交付 ？报`fail` 时用户拿到的 .docx 还能用吗？
    
*   `request_id` 谁生成、何时生成？"再改一版"是复用还是新起？
    

# 问题四（第 2 块）· 模型 fallback 链 computeRelatedModel

## ① 分析本身

先更正一处 ：`computeRelatedModel` 不是"主模型失败/超时才切换"的容错链 ，它是 变体选择器 ——上游已选定主模型，它只回答"这个主模型的 lite / reasoning / vision / longContext / subagent 变体该用谁"。

入参只有两个：`(主模型 id, 变体类型)` ；变体白名单`MODEL_VARIANT_TYPES = {"lite","builtin-lite","reasoning","vision","longContext","subagent"}` 。

目标选择优先级链（命中即返回） ：

序 来源 说明 1 `builtin-lite` 专用分支 `if (el === rB) computeBuiltinLiteModel` 2 环境变量 `lite` →`CODEBUDDY_SMALL_FAST_MODEL` ；`reasoning` →`CODEBUDDY_BIG_SLOW_MODEL` 3 用户设置`settings.variantModels` 4 主模型自带`relatedModels[variant]` 需满足`requireEnabled` （禁用则跳过） — custom/external 短路 直接返回主模型 5 产品内置默认表`defaultRelatedModels[variant]` 需`productManager.waitConfiguration()` 就绪 6/7 主模型自身 / 主模型不在 modelMap 时返回`{id,name}` 裸对象 最后兜底

另有一条兜底：找不到某变体 →`falling back to lite variant` 。

custom/external 为什么跳过 ：

js

1 2 3 4 5 6

`isCustomOrExternalModel(eA) { return "enterprise" === eA.modelType || eA.tags?.includes("custom") === true || eA.id.startsWith("custom:") || eA.id.startsWith("custom-local:"); }`

*   触发四选一：`modelType==="enterprise"` 、tags 含`custom` 、id 以`custom:` /`custom-local:` 开头。
    
*   它只跳过第 5 步（产品内置默认表） ，1~4 步照走。
    
*   意图： 用户自带/企业定制模型不能被产品内置对照表替换掉 ——内置表描述的是"我们自己认证过的模型之间怎么配对"，对第三方模型不成立，硬配会指向用户根本没配的模型。所以是"保守停在主模型"，不是"贴心地换一个"。 "这不是容错链"的证据 ：函数拿不到"上次调用结果"，没有任何失败/超时入参；错误分类与重试在另一条独立链（`ErrorUtils` /网络分类），与它无交叉引用；提取产物里搜`retryable|isRetryable|shouldRetry|maxRetries|backoff` → 0 命中 （负向证据）。
    

## ② REA 应用

`codebuddy.js` 是 22MB 单行混淆 bundle， 整体喂 REA 会 OOM → 用 切片取证 ：把关心偏移区间落成独立`.js` 再分析。本次先做 符号级检索 拿到`computeRelatedModel` 全文（@6989474，`1 occurrence` ），再逐字比对常量表与四个判定函数。 判定"机制不存在"时负向证据同样有效 （0 命中）。注意：正式结论要引用 REA 产出 Evidence（本会话 sidecar 那次有`evidence_id` +`subject.digest.sha256` ），切片片段只用于结构确认。

## ③ 归属分层

*   A ：无——变体/企业/custom 都是产品概念。
    
*   B ：变体体系、多层配置覆盖（env > settings > 模型级 > 产品默认）、custom 隔离、`modelMap` 注册表、`readyDeferred` /`waitConfiguration` 就绪门。
    
*   C ：优先级链"命中即返回 + 每层打日志说明为什么命中"。
    

## ④ 借鉴点

1.  把"主模型"与"变体"分开 ：给主模型声明一组变体（快/慢/长文/视觉/子智能体），"换模型"只改一处。
    
2.  覆盖顺序固定 env → 用户设置 → 模型自带 → 产品默认 → 主模型自身 ，且 每层命中都打日志 ，排障一眼看出"是谁给的模型"。
    
3.  对用户自带/第三方模型要 保守 （宁可停在主模型），别让用户觉得"我配的模型被系统换了"。
    
4.  别把"变体选择"（静态配置解析）和"故障重试"（运行时容错）混在一起 ——WB 里是两条独立链。
    

## ⑤ 提问环节

*   用户把`variantModels.lite` 配成一个 不存在 的 id 会怎样？（看`findModelByIdOrName` 返回假的分支）
    
*   为什么环境变量优先级 高于 用户设置？
    
*   `resolveDefaultRelatedModel` 为什么要`waitConfiguration()` 等产品配置就绪？
    

# 问题四（第 3 块）· 审批记忆：规范化规则 / 过期与清除时机

## ① 分析本身

结论：有两套并行的"审批记忆" ，而`02-permissions-sandbox.md` 第 6 章 只写了其中一套 。

A · 命令级 B · 工具级 载体 `SandboxApprovalStoreImpl` （挂 Session） `ToolAlwaysApprovalService` 键 `canonicalCommand` +`cwd` 工具签名（Bash 就是`"Bash"` ） 粒度 具体命令 + 目录 整个工具 文档 有 （§6 逐字一致） 无描述

A 的规范化规则（`canonicalizeCommand` 逐字） ：

js

1 2 3 4 5 6 7 8

`function canonicalizeCommand(eA) { let el = (eA ?? "").trim(); if (0 === el.length) return ""; let ec = extractPosixShellScript(el); if (ec) return` posix-script:${ec.script.trim()}`; let eu = extractPowerShellScript(el); return eu ?` powershell-script:${eu.script.trim()}\` : \`raw:${el}`; }`

*   只做三件事：`trim()` ；剥离 POSIX shell 外壳（`sh -c '...'` ）→`posix-script:` ；剥离 PowerShell 外壳 →`powershell-script:` ；都不是 →`raw:` 。
    
*   不做 ：参数顺序重排、相对/绝对路径归一、别名展开。所以`ls -la /tmp` 与`ls /tmp -la` 命中 不同键 ，各自重问。
    
*   键序列化：`${canonicalCommand}\u0000${cwd}` （`\0` 分隔，避免拼接碰撞）。
    
*   命中路径：`ask` →`_getSessionApproval(key) === "approved_for_session"` → 本地执行（日志`command-safety ask session-cache hit` 、来源`"session-approved"` ）。 `mcpui` 复用同一个 store，`cwd` 传空串 。其它写入点：`_handlePostExecEscalation` 、`_handleSafeDeleteFailClosedEscalation` 、`_handlePreExecBypass` 、`_handleSystemToolPolicy` （`"always_confirm"` 时）。 过期与清除时机（结论） ：
    

1.  没有 TTL、没有定时清理、没有容量上限 ；`clear()` 只在整体清空时调用。
    
2.  "会话级"靠对象生命周期 ：store 挂在`sessionSubject.value.sandboxApprovalStore` ， Session 销毁 → store 消失 ，天然不跨会话泄漏。
    
3.  无 store 时`allow_session` 退化为"仅本次生效"，并 打日志说明 （不静默失效）。
    
4.  `allow_once` 不落 缓存，`allow_session` 才落 缓存。 B 的关键点 ：`getToolSignature` 里， HIGH/CRITICAL 风险返回`undefined` → 不产生签名 → 每次都问 ；SKILL 用稳定 skill 名；只有 SAFE/LOW/MEDIUM 才落缓存；session 级还要`syncApprovalToMainSession` 。
    

与文档对照 ：§6 与 A 逐字一致 （§6.1 原话"审批缓存的键不能是原始命令（`ls -la` 和`ls -la` 应命中同一条记忆），所以要规范化"）； B 在文档中完全没写 → 这是文档缺口。

## ③ 归属分层

*   A ：无。
    
*   B ：键设计（规范化到什么程度）、会话级作用域落地、多粒度共存、危险操作不可记忆、与"权限规则系统"（allow/deny/ask，另一套）划清界限。
    
*   C ： 键规范化 + 会话级挂载 + 分层审批 + 危险必问 ——低复杂度高安全性的一套组合。
    

## ④ 借鉴点

1.  键要规范化，但别过度归一 ：去壳 + trim 就够； 别重排参数、别做路径归一 ，否则会把"两条其实不同的命令"合记忆成一条，产生安全风险。
    
2.  "会话级"用对象生命周期实现最省事 ：挂 Session 对象，结束即回收—— 不需要 TTL ，也别一上来就持久化。
    
3.  分层审批 ：细粒度（命令+cwd）管"同类命令只问一次"；粗粒度（工具名）管"这个工具我信任"。别合并。
    
4.  危险命令永不记忆 （HIGH/CRITICAL 必问），`allow_once` 不落缓存——把"这次"和"以后都行"分清。
    
5.  降级要显式 ：无 Session 时`allow_session` 变"仅本次"并打日志。
    
6.  文档要跟着代码走 ：本次就发现文档只写了 A、漏了 B。
    

# 问题 A（第 1 块）：上传入口层 —— 三层架构 + 分流路由 + 各通道上限

## ① 分析本身

WB 处理"用户上传的文件" 不是单一函数 ，而是三层分工，这是理解后面所有细节的骨架：

层 位置 回答什么问题 第 1 层 内核 `codebuddy.js` 这个文件 能不能被模型看见 ？（文本读入 / 图片转 base64 / 二进制跳过） 第 2 层 资料库 skill `skills/library/*` 这个文件 落到哪个平台对象 ？（在线表 / 在线页面 / 在线文档 / 网盘文件 / 附件） 第 3 层 服务端 API COS +`space/api/agent/v1/*` 真正存储、真正类型判定

### 第 2 层的分流路由表

这张表是`library` 的"上传总闸"，原文在 SKILL.md ：

上传类型 落点对象 脚本 图片`.png/.jpg/.jpeg/.gif/.webp/.bmp/.svg/.heic/.heif/.tiff` 托管 COS 直链 （不建节点） `manage/upload_image.py` `.csv` 在线数据表 （database） `database/import_csv.py` `.html` /`.htm` /`.zip` 在线 Page `page/import_html.py` `.md` 在线文档 （doc） doc 模块 `docx / pdf / pptx / xlsx` 等普通文件 网盘文件 （drive） `drive/upload_drive_file.py` 挂到已有节点 附件 `attachment/attachment.py`

关键设计点（`drive/entry.md` 原文）：  本入口只收普通文件。`.md` 走 doc、`.csv` 走 database、`.html` /`.zip` 走 page—— 这些类型导入后是可编辑的在线内容，不是网盘文件。 也就是说： 分发依据是"导入后要不要可编辑"，不是"文件大小"或"用户想放哪" 。`.docx` 被刻意排除在"在线可编辑"之外（走网盘），因为 WB 的在线编辑品类是 doc/sheet/slide，不是"上传一个 .docx 就能在线改"。

### 各通道硬上限（这是"支持哪些格式"的真正答案）

通道 允许扩展名 大小上限 超限行为 图片托管 10 种（见上表） 10 MiB 本地读`MAX+1` 字节即判超限 CSV 仅`.csv` 50 MiB 同上 HTML/ZIP 仅`.html/.htm/.zip` 50 MiB 同上 网盘 drive 任意普通文件 100 MiB 超限 直接失败，不分片重试 附件 attachment 任意 本地不预判 ，服务端校验 被拒后 不分片重试 在线文档 doc（生成侧） markdown 内容 50 MiB（`CONTENT_MAX_BYTES` ） error\_exit

三处细节值得记住：

1.  "读`MAX+1` 字节"的判定技巧 （`_file_meta` ）：`f.read(MAX_UPLOAD_BYTES + 1)` 一次读完，`size == 0 or size > MAX` 就返回空 → 不用先`stat` 再读，避免 TOCTOU。
    
2.  `import_csv.py` 硬校验后缀 ：`ext not in _ALLOWED_EXTS` →`error_exit("不支持的文件扩展名: {ext}（仅支持 .csv）")` 。即 CSV 通道 只认 .csv ，`.tsv` /`.xlsx` 会被拒。
    
3.  HTML 导入额外收口 ：`import-flow.md` 明确"服务端按 字节流魔数 识别 zip / html，与后缀无关；但文件名后缀仍应与内容一致"；且 目录不接受 （`os.path.isfile` 校验，给文件夹要先打成 zip）。
    

### 两条同源协议：cosKey vs confirmKey

CSV 与 HTML 的协议 完全同构 （同一对 API）：

text

1 2 3

`POST /space/api/agent/v1/get-upload-credential → uploadUrl + cosKey PUT <uploadUrl> (二进制体) → COS POST /space/api/agent/v1/import-local-file → cosKey 建节点，返回 nodeBlockId/url/publishUrl`

drive 通道是 变体 ：credential 返回`uploadUrl + headers + confirmKey` ，PUT 时 携带服务端下发的 headers （注释原文："不注入 WorkBuddy 鉴权头"），最后`import-local-file` 传的是 `confirmKey` 而不是`cosKey` 。

→ 同一对 API，靠`uploadType` 字段分流 （drive 脚本里有`if upload_type != "drive": error_exit("该文件类型不走网盘上传，请使用对应资料库模块")` ）。

## ③ 归属分层

归属 内容 A · Agent 本身（WB 的 Agent 能力） 分流路由表本身（按"要不要在线可编辑"分派）、`MAX+1` 判定、同源 API 靠`uploadType` 分流 B · 工程化要解决 大小上限与"不分片重试"的取舍、COS 直传 vs 带 headers 直传、`os.path.isfile` 静默 exit 0 这类边界、字节流魔数 vs 后缀 C · 可借鉴（通用做法） 三层解耦（内核可见性 / 对象落点 / 服务端存储）；credential → PUT → confirm 三段式直传

## ④ 借鉴点

1.  "有没有可编辑的在线形态"应当作为上传分流的首要判据 ，而不是按扩展名硬编码。WB 的做法是：`metadata` 决定它进哪个对象模型，进了之后对用户是"可编辑文档"还是"网盘文件"。
    
2.  上传协议做成同源三段式 （要凭证 → 直传 → 回执建节点），把"鉴权"和"存储"分离，服务端可替换存储而不动客户端。
    
3.  上限用"读 MAX+1 字节"实现 ，避免先 stat 后读的竞态。
    
4.  "超限不重试"要明确写进契约 ——否则模型会自作主张分片，反而制造脏数据。
    

先回答你的两个问题，再进第二块。

## 追问 1：为什么图片是"托管直链不建节点"，而 CSV 一定建节点？

边界判据是「导入后的终态对象，是不是一个需要独立身份 / 权限 / 版本 / 可被引用的一等公民」。

原文依据 —— manage/entry.md 对`upload_image.py` 的定义：  把本地图片或第三方图片 URL 转为 可内嵌的公网直链，不创建资料库节点 。 关键在" 可内嵌 "三个字。图片在 WB 里的角色是 别人的属性值 ：

图片出现在哪 它的形态 page 的`<img src>` 一个 URL 字符串 database 的`image` 字段值 一个 URL 字符串 doc 里的插图 一个 URL 字符串

而 CSV 的终态是 一张在线数据表 ，它自己就是节点（有`nodeBlockId` 、有权限、有版本、能被`page_database_relation` 引用）。 csv-import-flow.md §5 把这条写得很硬：  交付给用户的必须是在线数据表的 url 或 id，不得给本地 CSV 路径或临时目录。 两个反例验证这条判据成立：

1.  图片也需要节点身份时 → 走 attachment 。`attachment/attachment.py upload --node-id <nb_xxx> <path>` 会把图片/任意文件 挂成节点的附件 （返回`attachment_id` /`file_type` /`media_type` ）。此时图片不是"某个对象的属性"，而是"独立文件实体" → 建节点。
    
2.  CSV 只是表的"导入格式" ：导入完成后，本地 CSV 就"死"了，活的是派生的表。所以 CSV 通道不返回"文件节点"，而是返回表的`nodeBlockId` 。 再加一层"可编辑形态"的判据：
    

图片 CSV → 表 可编辑的形态是什么 换 URL （值更新） 改结构 / 改记录 （对象更新） 需要版本吗 不需要 需要 需要权限吗 不需要（谁都能看这张图） 需要（谁能改这张表）

一句话： "值"用直链，"对象"建节点 。

## 追问 2：cosKey 和 confirmKey 的实际差异，不只是命名

我取证的两条链路原文对比：

CSV / HTML 通道 drive（网盘）通道 credential 返回 `uploadUrl` + `cosKey` `uploadUrl` + `headers` + `confirmKey` + `taskId` PUT 怎么发 直接`Request(url, data=body, method="PUT")` ， 无自定义 headers 必须携带服务端下发的`headers` ，注释：" 不注入 WorkBuddy 鉴权头 " PUT 超时 60s 120s （文件可到 100 MiB） 确认阶段传什么 `cosKey` `confirmKey` （+ 非空时带`taskId` ） 脚本注释原文 — " 不使用 cosKey 中转，不回退 SMH 节点 " 类型校验 无`uploadType` 校验 `if upload_type != "drive": error_exit("该文件类型不走网盘上传，请使用对应资料库模块")`

差异归纳成两种 模式 ：

① cosKey = "自助写入模式" 客户端把二进制直接写进 平台自己的对象桶 （COS），预签名 URL 里自带鉴权 → PUT 不用带额外头。服务端拿到`cosKey` （一个对象键）就知道文件在哪，直接建节点。路径短、依赖少。

② confirmKey = "托管确认模式"`uploadUrl` 指向 第三方存储 （所以鉴权靠服务端下发的`headers` ，不能用 WB 自己的鉴权头）。上传完成后客户端只拿到一个`confirmKey` （确认令牌），必须回平台" 确认 "（confirm）——由服务端二次校验并落库，还有一个`taskId` 说明这是 异步任务 模型（可能要转码 / 入网盘索引 / 配额校验）。

实际影响（4 点）：

1.  鉴权归属不同 ：cosKey 靠 URL 内嵌签名；confirmKey 靠 headers → 客户端不能复用同一套 PUT 代码。
    
2.  服务端介入时机不同 ：cosKey 是"写完即建节点"；confirmKey 是"写完还要服务端确认"→ drive 可以在此处做 100 MiB 校验、类型校验、入网盘库。
    
3.  异步性 ：`taskId` 只在 drive 出现。
    
4.  这是同一个 credential API 的两个分支 ：`uploadType` 是分流字段，脚本必须校验，否则会"用错模块"。 一句话： cosKey 是"你写我的桶，报个键名给我"；confirmKey 是"你写中转，再回来让我确认" 。前者轻（小文件、平台自有内容），后者重（大文件、要服务端做转换/入库）。
    

# 问题 A（第 2 块）：CSV 子链 —— 从本地 .csv 到在线数据表（含日期判定细节）

## ① 分析本身

### import\_csv.py 的 5 步（这是"搬运工"，不是"判断者"）

text

1 2 3 4 5 6 7

`1. 校验 os.path.isfile(path) + 后缀 ∈ {".csv"} → 否则 error_exit("不支持的文件扩展名: {ext}（仅支持 .csv）") 2. 读取 _file_meta: f.read(50MiB + 1) → size==0 或 size>50MiB → error_exit("文件为空或超出大小上限") 3. 凭据 POST /space/api/agent/v1/get-upload-credential body {fileName, fileSize, parentId?} timeout 8.0 4. 直传 _put_to_cos: PUT 二进制，200<=status<300 为成功，任何异常静默 False timeout 60 5. 建节点 POST /space/api/agent/v1/import-local-file body {cosKey, fileName, spaceId?, parentId?, nodeBlockId?, title?} title = 去扩展名；timeout 30.0 → 返回 nodeBlockId / url / publishUrl；成功输出 KS_IMPORT_OK <json>`

收尾纪律： 任何业务异常一律`error_exit` → exit 0，不暴露 token / 中间响应 。

### 最关键的一条认知（也是你困惑的根源） `import_csv.py` 里没有任何类型推断、没有任何日期解析代码。

它只做"搬到 COS + 建节点"。真正的"内容判断"发生在 另外两个地方 ：

判断者 内容 文档层（agent 按规则执行） 读表头 + 样本 → 逐列判定类型 → 选路径 A/B 服务端 路径 A：后端按自己的规则推断；路径 B：agent 显式给 schema，服务端照建

所以"上传 CSV 判断日期"细节多， 不是因为有复杂的解析代码，而是因为这是一套文档化的决策流程，由模型按规则执行 。这是 WB 典型的"把判断外置成 SOP"的做法。

### csv-import-flow.md 的决策细节

§1.1 基础检查 （不满足则 停止该 CSV 处理并返回错误 ）：

*   必须有 单行表头 ；字段名非空且不重复
    
*   解析失败 / 列数不一致 / 无有效数据行 → 停止 §1.2 字段类型推断 （读"表头 + 前 N 行样本"， 建议 N=20~50 ）：
    

信号 判定 低基数列（取值少而重复） `select` 单元格含多个值 `multi_select` 字段名语义 + 样本格式像日期 `date` 推断不确定 / 同列类型冲突 / 格式混合 统一降级为`text`

硬门 ：原文" 必须先输出逐列判定表，再进入 §2 决策，不可跳过 "，判定表列头 =`列名 | 样本值 | 判定类型` 。

§2 路径决策表 （首个命中即生效）：

条件 路径 CSV > 50 MiB 路径 B 或先拆分 任一列判定为`text` /`number` /`date` 之外的类型 （如 select / person / image…） 路径 B （agent 精确指定 schema） 全部列均为`text` /`number` /`date` 三种之一 路径 A （交后端推断） 备注 "行数多 不构成 回退路径 A 的理由"

### 日期处理的完整链条（5 层，这是你要的"细节"）

text

1 2 3 4 5 6 7 8 9 10

`① 判定层 样本值形如日期 + 字段名语义（如"报名日期"）→ 判定为 date（或含时分秒 → datetime） ② 决策层 date 属于 {text, number, date} 三类型之一 → 走【路径 A】，把推断交给后端 ③ 落库层 值必须是 ISO 8601 字符串： "2026-06-24" 或 "2026-06-24T10:00:00Z" ④ 展示层 DateConfig.format，9 种格式： yyyy"年"m"月"d"日" yyyy-mm-dd yyyy/m/d m"月"d"日" [$-804]yyyy"年"m"月"d"日" dddd m/d/yyyy d/m/yyyy yyyy"年"m"月"d"日" hh:mm yyyy-mm-dd hh:mm ⑤ 查询层 Filter 对 date 的操作符：equals / before / after，值也是 ISO 8601`

两个容易踩的坑，都在这张表里：

*   `m/d/yyyy` 和`d/m/yyyy` 并存 → 说明系统 绝不猜 月/日顺序，一律要显式指定。这正是 §1.2"格式混合 → 降级为 text"的落点：`2026/03/04` 这种值， 不猜，降级 text 。
    
*   存储格式（ISO 8601）与展示格式（`format` ）严格分离 ：库里永远是`2026-06-24` ，界面上才可能是"2026年6月24日 星期三"。
    

### 一个高价值对比：同样是"日期"，CSV 侧和 XLSX 侧落地形态完全相反

database（CSV 导入） sheetagent（XLSX 生成） 落地形态 ISO 8601 字符串`"2026-06-24"` date / datetime 对象 + 设`number_format` 原因原文 表是 存储型 ，跨端/跨语言传输要无歧义 " 避免把日期、数值写成字符串导致计算类公式无法求值 "

→ 同一个"日期"，两个子系统选了相反的做法 ，因为一个是"给人看/给前端读的表"，一个是"要跑 SUM/AVERAGE 的计算表"。这个对比后面讲问题 B 时还会再用到。

## ③ 归属分层

归属 内容 A · Agent 本身 类型推断 SOP（样本 N=20~50、判定表先出、冲突降级 text）、路径 A/B 决策、date 的 ISO 8601 约定、展示与存储分离 B · 工程化要解决 推断交给谁（前端 vs 后端）、推断错了怎么办（幂等重试复用`database_id` ）、50 MiB 上限、`select` options 必须基于 完整去重值 而非样本 C · 可借鉴 把"内容理解"从代码搬进 SOP，让模型按规则执行 + 硬门（判定表必须先出）

## ④ 借鉴点

1.  "判断外置" ：不写`parse_date()` ，而写"什么时候该判定为 date、什么时候该降级"的规则。这让规则可演进、可被审计，也让模型能解释自己的决策（先出判定表）。
    
2.  歧义一律降级，绝不猜 ：`m/d/yyyy` 与`d/m/yyyy` 并存 + "格式混合降级 text" → 猜错的代价（脏数据）远大于降级的代价（少一个类型）。
    
3.  存储格式与展示格式分离 ：ISO 8601 入库、`format` 管展示。这是任何"日期要跨端"的系统的铁律。
    
4.  幂等设计 ：§6 规定路径 A 重试复用`database_id` /`node_block_id` 覆盖；路径 B 建表成功后中断，复用它只补写未成功行，" 禁止整表盲目重放造成重复记录 "。
    
5.  "行数多不构成回退路径 A 的理由" ——防止模型把"数据多"误当作"必须精确控制 schema"，这条是踩过坑才写得出来的。
    

先回答三个问题。

## 追问 1：text/number/date 可交后端，select/person 必须 agent 指定 —— 分界线的本质

本质是：推断是「读」还是「造」——是可逆的，还是不可逆/有副作用的。

把待推断类型分成两类看：

类型 后端能不能自己推？ 推错了能无损回退吗？ `text` 能（默认兜底） 能（改类型重解析即可） `number` 能（值域连续，可逆） 能 `date` 能（ISO 8601 自描述） 能 `select` /`multi_select` 不能 ——需要 options 不能 `person` 不能 ——需要 uid 不能，且有副作用 `image` /`attachment` 不能 ——需要 先上传拿 URL 不能

关键在于 后三类需要"造出数据里没有的东西" ：

①`select` 的障碍不是"认不出值"，而是"造不出选项集合"。 后端从数据里只能读到"出现了哪几个值"，但造不出：

*   选项 id —— 而 database/entry.md §13 明写："`option.id` 一旦写入 永久有效禁止替换 " → 造错不可逆 。
    
*   哪些近义值该合并 （`北京` /`北京市` /`北京` 是不是同一选项）
    
*   选项顺序、颜色
    
*   用户希望的完整枚举集 （数据里只出现 3 个值，但用户想要 5 个选项，未来还能选） 这四条 全部是业务语义，不是数据事实 。后端没有对话能力，推不出来。
    

②`person` 的障碍是"外部实体引用 + 副作用"。 §Person 规则原文：先解析 uid，" 唯一精确命中才写、模糊候选不得自动写入、多个精确命中整批不提交 "。把"张三"错误关联到通讯录里的另一个人 → 数据污染 + 触发通知/权限 ，且不可逆。

③`image` /`attachment` 更直接 ：值必须是已上传的 URL，后端不可能"猜"出一个 URL。

所以分界线一句话：  推断 = 从数据"读"出类型（可逆、无副作用）→ 交后端自动化。 推断 = 需要"造"出 id / 枚举集 / 外部引用（不可逆、有副作用）→ 必须 agent 造，而且要能和用户确认。 补一个 责任归属 角度：select 的选项集是"用户的业务决策"（这列该用哪几个枚举值）， 需要对话才能确定 。后端 import 接口没有对话能力 → 这类决策必须留在 agent 层。这也是为什么 §1.2 硬性要求" 必须先输出逐列判定表 "——把 agent 的推断摊开给人看，正是为了让人在不可逆操作前能拦截。

## 追问 2：表头重复/缺失时，WB「停止处理」，你该照搬还是「改名后继续」？

结论：不要二选一，改成「能无损的继续（+ 告知），不可逆的停下来问」。

先看 WB 为什么选"停止"——它的理由是成立的：

*   表头是 用户数据的语义标签 。擅自改名会造出"看起来对、实际语义被 agent 猜过"的表 → 用户后续按表头查数据对不上。
    
*   两个都叫"金额"的列，可能本意是"应收金额"/"应付金额"。agent 猜不出来 ，改名就是 不可逆的语义决策 。 但"一律停止"的代价是：一个 95% 质量、只有一列空表头的 CSV 会 整份用不了 ，体验很差。
    

建议的分层策略（对我们的项目）：

情况 处理 理由 表头为空 （缺失） 生成占位名`列1/列2…` ， 继续，并显式告知 用户"第 3 列表头为空，已临时命名" 空表头通常是导出瑕疵， 数据本身有效 ；占位名是可逆的（用户可随时改名），告知即无隐瞒 表头重复 （同名但内容可能不同） 停下来问用户 ，或 给出候选方案让用户选 （"第 2/5 列都叫'金额'，是否改为'金额A'/'金额B'？"） 改名是 不可逆的语义决策 ，必须由人确认 解析失败 / 列数不一致 停止 这是 结构性问题 ，不是命名问题，继续做会产出错行

这个策略其实 和我们取证到的 WB 自身另一条规则完全一致 —— page/entry.md §12 原文：  schema 推断有歧义时 不猜测 ，展示候选方案让用户选择。 也就是说 WB 在 page 侧就是"歧义 → 给候选让人选"，只是 database 侧选了更保守的"直接停止"。

实践建议 ：默认走 宽松模式 （空表头 → 占位 + 告知；重复表头 → 问用户），另留一个`strict` 开关给"数据必须原样入库"的场景。 判据始终是那句：能无损恢复的就继续，不可逆的就交回人。

## 追问 3：date 只有日期 vs 带时间 —— 同一个类型还是两个？

database 侧：一个类型（`date` ），靠「值里带不带时间分量」+「format」区分。

三条证据：

① 类型枚举里只有一个`date` —— \_db\_types.py ：

Python

1 2 3 4 5

`VALID_TYPE_KEYS = frozenset({ "text", "number", "currency", "select", "multi_select", "date", "checkbox", "url", "email", "phone_number", "image", "attachment", "person", }) # 13 种，只有 date，没有 datetime`

② 两种值共用同一个字段名`date` —— params-reference.md ：

JSON

1 2

`{ "date": "2026-06-24" } // 只有日期 { "date": "2026-06-24T10:00:00Z" } // 带时间`

③ 差异由`DateConfig.format` 表达 ：9 种格式里 7 种纯日期、2 种带时间（`yyyy"年"m"月"d"日" hh:mm` 、`yyyy-mm-dd hh:mm` ）。Filter 的`equals` /`before` /`after` 对两者通用。

对比 sheetagent（xlsx）侧：有两个类型。

schema\_principle.md 的类型表里明确列了「 日期`YYYY-MM-DD` 」和「 日期时间`YYYY-MM-DD HH:mm` 」 两项 。

为什么差？

database sheetagent 类型数 1 个 （date） 2 个 （日期 / 日期时间） 差异靠什么表达 值（ISO 8601 自带`T` ）+ format 单元格`number_format` 原因 服务端结构化存储 + API 读写， ISO 8601 自描述 Excel 单元格格式必须 提前定死 才能正确参与计算

→ 又回到同一个模式：database 是"存储型/传输型"，倾向让值自己描述；sheetagent 是"计算型"，必须把格式提前钉死在单元格上。 这和上一块 date 落地形态相反（ISO 字符串 vs date 对象）是同一个原因。

# 问题 A（第 3 块）：内核侧 —— codebuddy.js 怎么"读"文件

## ① 分析本身

上面两块讲的是"文件进资料库"，这一块讲 更底层的一层：文件怎么进模型的上下文 。这一层在 22MB 单行 bundle codebuddy.js 里，是 四组判定 + 两条通路 。

### 第一组：文本文件怎么读

js

1

`isTextFile(eA) // 返回 bool`

机制： 扩展名白名单`includes` + 二进制兜底 。

白名单（原文，节选）：`.txt .md .json .js .ts .jsx .tsx .html .htm .css .scss .sass .less .xml .yaml .yml .toml .ini .cfg .conf .log .csv .tsv .sql .py .java .c .cpp .h .hpp .cs .php .rb .go .rs .swift .kt .scala .clj .hs .elm .vue .svelte .astro .sh .bash .zsh .fish .ps1 .bat .cmd .dockerfile .gitignore …`

不在白名单时 ：

js

1

`return !await FileUtils.isBinaryFile(eA); // 不是二进制 → 就当文本`

→ 这是\*\*"白名单优先、内容兜底" 的双保险：白名单是 快路径\*\*（省一次读盘探测），`isBinaryFile` 是 正确性兜底 （防止一个没有扩展名的文本被误判）。

读进来后：`MAX_TEXT_FILE_SIZE` 超限则`continue` —— 注意是 跳过而不是报错 ，不中断整个流程。

Read 工具成功后注入一行提示：

HTML

1

`<system-reminder data-role="tool-hint"> Called the Read tool with the following input: {"file_path":"..."} </system-reminder>`

### 第二组：图片文件怎么读（这里有个很特别的设计）

js

1 2 3 4

`isImageFile(eA, el) { return ImageUtils.isImageSupportedByModel(eA, <当前模型 id>) // ① 模型能力 && await FileUtils.isBinaryFile(eA); // ② 确实是二进制 }`

特殊点在 ① ：图片能不能被"读"，取决于 当前模型是否支持看这种图 ，而不是文件本身是什么。  同一个`.heic` ，换个模型可能就从"可读"变成"不可读"。 这是 多模型路由 的必然结果：文件可见性 = 文件属性 × 当前模型模态能力。

读图片走的是 base64 通路：

js

1 2 3 4 5 6

`createImageContent: const b64 = ...; // 读二进制转 base64 url =` data:${mime};base64,${b64}`// data URL → compressUserImage(...) // 压缩 → 失败 / 压缩后仍过大 → IMAGE_TOO_LARGE_AFTER_COMPRESSION_PLACEHOLDER → imageBlobService.storeFromFile(...) // 存 blob`

注意这里的处理哲学：降级而非失败。 图片压缩后还太大， 不是报错中断 ，而是 用占位符字符串替换 ，让对话继续。这和文本侧的"超限 continue"是同一个思路。

### 第三组：写文件的判定（.csv/.tsv 加 BOM）

js

1 2 3 4 5 6 7 8 9

`shouldWriteUtf8Bom(filePath, content, existing, isNew) { if (content.startsWith("\uFEFF")) return false; // 已有 BOM → 不加 if (!isNew && existing?.hasBom && (utf8 编码)) return true; // 覆盖已有带 BOM 文件 → 保持 BOM if (isNew) { // 新建 const ext = extname(filePath).toLowerCase(); return ".csv" === ext || ".tsv" === ext; // 只有 csv/tsv 加 } return false; }`

三个判定都值得注意：

1.  只对`.csv` /`.tsv` 加 BOM —— 因为 Excel 打开无 BOM 的 UTF-8 CSV 会中文乱码 。这是 用户体验细节 ，不是技术必需。
    
2.  只对"新建"（`isNew` ）加 —— 用户已有的文件 保留原样 ，不擅自改动用户文件。
    
3.  已有的 BOM 设置会被继承 —— 覆盖写时保持与原文一致。 写侧的错误码（分了三种，比读侧细）：
    

错误码 触发条件 `WriteFilePathError` 路径指向目录 `WriteFilePermissionError` `EACCES` `WriteFileDiskFullError` `ENOSPC`

→ 写操作比读操作"危险"，所以错误分类更细、要能精确回给用户 。读失败大不了跳过，写失败必须说清是权限、路径还是磁盘问题。

### 第四组：MIME 映射表

js

1 2 3 4 5 6 7 8 9

`Cc = { ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".svg":"image/svg+xml", ".bmp":"image/bmp", ".ico":"image/x-icon", ".tiff":"image/tiff", ".tif":"image/tiff", ".pdf":"application/pdf", ".json":"application/json", ".js":"text/javascript", ".ts":"text/typescript", ".html":"text/html", ".css":"text/css", ".xml":"application/xml", ".txt":"text/plain", ".md":"text/markdown", ".csv":"text/csv", ".zip":"application/zip", ".gz":"application/gzip", ".tar":"application/x-tar" }; // 兜底 application/octet-stream`

另有一张 反表 （MCP resource 的 MIME → 扩展名）：

js

1 2 3 4 5 6

`gp = { "text/plain":".txt", "text/markdown":".md", "text/html":".html", "text/css":".css", "text/javascript":".js", "text/csv":".csv", "text/xml":".xml", "application/json":".json", "application/xml":".xml", "application/pdf":".pdf", "application/zip":".zip", "application/octet-stream":".bin", "image/png":".png", "image/jpeg":".jpg", "image/gif":".gif", "image/svg+xml":".svg", "image/webp":".webp" }`

→ MCP resource 从远端拿到的只有 MIME，落盘要变回文件名 ，所以需要反表。这是"MCP 资源 → 本地文件"这一步的必要拼图。

### 一个反向发现（负向证据）

我们在内核 bundle 里定向搜过：

text

1 2

`Grep '\.docx' in codebuddy.js → 0 命中 Grep 'supportedFileTypes' → 0 命中`

结论：内核根本不管`.docx/.xlsx/.pptx` 。 这些格式的处理 全部在 skill 层 （`tencent-docx` /`sheetagent` /`tencent-pptx` ）。内核的文件世界观只有两类： 能读成文本的 / 要转 base64 的 ，加一个二进制兜底。 这个边界非常干净 ——内核不关心业务格式，只关心"能不能进模型上下文"。

归属 内容 A · Agent 本身 文件可见性判定（文本/图片/二进制）、按模型判定图片能力、超限降级（跳过 / 占位符）、Read 的 tool-hint 注入 B · 工程化要解决 白名单 + 内容兜底的双保险、`.csv` BOM 这种"针对 Excel 的体验补丁"、写侧三种错误码分类、MIME 双向映射 C · 可借鉴 "内核不关心业务格式"的边界划分；"降级而非失败"的统一哲学；"可见性 = 文件属性 × 模型能力"

## ④ 借鉴点

1.  文件可见性 = 文件属性 × 当前模型能力 ，不是文件的单方面属性。凡是有多模型路由的系统，这条必须显式建模，否则换模型就出"读不了图"的诡异 bug。
    
2.  "降级而非失败"要统一贯彻 ：文本超限 →`continue` ；图片压缩后还大 → 占位符；两者都保证 对话不中断 。反例是"报错中断"，用户体验断崖式下跌。
    
3.  写侧错误分类要比读侧细 ：读失败可跳过，写失败必须让用户知道是 权限 / 路径 / 磁盘 哪一种。
    
4.  白名单 + 内容兜底 ：白名单是性能快路径，内容探测是正确性底线，缺一不可。
    
5.  内核只答"能不能进上下文"，业务格式全下沉到 skill 。这条边界让内核保持极简（整个文件世界观只有两个分支 + 一个兜底）。
    

## 追问 1：不能接受降级的场景 + 适用边界

判据（三条件全满足才可降级）：

条件 含义 (a) 产出仍是 正确的部分结果 不是错的、也不是残缺到无意义 (b) 降级事实 对下游可见 有告知 / 有记录，模型或用户知道"这里降级了" (c) 不涉及 不可逆写入与安全边界 写操作、删除、鉴权一律不降级

绝对不能降级的四类场景：

1.  安全 / 鉴权边界 —— auth 失败绝不能降级为"匿名访问"。
    
2.  不可逆写操作 —— 覆盖写、删数据不能"部分成功但不吭声"。
    
3.  降级导致错误不可见（静默丢数据） —— 这是最危险的一类。
    
4.  计算 / 金额 —— 绝不能给假数字。 用这个标尺回头量 WB 自己的四处"降级"：
    

WB 的做法 (a) (b) (c) 评判 文本超限`continue` ✅ ❌ 静默 ✅ ⚠️ 有瑕疵 图片占位符`IMAGE_TOO_LARGE_AFTER_COMPRESSION_PLACEHOLDER` ✅ ✅ 模型看得到 ✅ ✅ 合格 recalc 三层降级（libreoffice→formulas→ error ） ✅ 最后失败返回 error 而非假数 ✅ ✅ ✅ 合格 CSV 逐条失败保留`results` 并汇总 ✅ ✅ ✅ ✅ 合格  批判点 ：WB 的"文本文件超限 →`continue` "违背了它自己的哲学—— 静默跳过，模型根本不知道这个文件存在过 ，于是可能得出"文件里没有这个信息"的错误结论。这是一处真实缺陷。正确做法是：跳过后 追加一条提示 告知模型"某文件因超限被跳过"，让降级可见。 这也说明"降级而非失败"不是教条，前提是"错误可见"。 一句话边界：降级可接受的充要条件是——降级后的错误仍然可见。

## 追问 2：isImageSupportedByModel 值不值得做一层？

答案分两半：值得做，但要先做粗粒度，而且 WB 在这里其实做错了。

先看"要不要做"的三个前提：

前提 不满足就不必做 有 多个模型 单模型 → 纯 over-engineering 模型的 模态能力确实不同 都一样 → 不必建模 你愿意 持续维护能力表 这是真正的成本：模型升级了能力，表要跟着更新

建议做法（渐进式）：

1.  先做粗粒度 ：一个`supportsVision(modelId): boolean` 布尔就够， 不要一上来做"模型 × 文件格式"的精细矩阵 （WB 是细粒度的，代价是要维护一张二维表）。
    
2.  能力表和模型注册定义放一起 （单一数据源），绝不两处维护。
    
3.  细化的触发条件 ：等你真的遇到"同一模型，支持 png 但不支持 heic"这种坑，再细化。 批判点（这也是对追问 1 的呼应）：
    

WB 的`isImageSupportedByModel` 在这里其实是 硬失败 ，不是降级 —— 模型不支持视觉时，图片 对模型直接不可见 ，没有任何 fallback（没有 OCR 抽文字、没有转给另一个有视觉能力的模型、连"这里有一张图但你看不到"都没告诉模型）。  所以 WB 的"降级而非失败"是有选择的，不是普适教条。 我们做的话，正确姿势是三层降级：① 换一个支持视觉的模型看图 → ② OCR 抽文本（至少知道内容）→ ③ 至少告知模型"存在一张图，当前模型无法查看"。 至少第 ③ 层必须有 ，否则就是追问 1 里的"静默丢数据"。