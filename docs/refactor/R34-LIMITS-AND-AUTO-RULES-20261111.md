# R34 限制与 AUTO 规则清单

状态：线上只读核查进行中，未完成。用户要求暂停整体开发，本轮不改配置、不派发模型调用、不部署。基线源码1586f76；文档后续提交不等于运行包变化。

## 1. 证据标识

| 标识 | 含义 |
|---|---|
| 线上实际值 | 本轮从存活进程环境、运行profile、nginx有效配置或只读数据库直接取得 |
| 线上公网事实 | 本轮直接访问公网无副作用端点所得；不能替代私有配置核实 |
| 代码默认值 | 源码的回退值，尚未确认线上是否覆盖 |
| 代码固定值 | 源码硬编码，仍须绑定线上源码哈希才可称实际生效 |
| 本地资格推导 | 由代码或测试推出，不是第三人当次线上事实 |
| 未确认 | 缺连接、授权、账号/时间或日志；不能填“未设置/默认”冒充已查 |

本轮公网实查：`/healthz`返回ok，PID494892，2026-11-11T07:53:41.971Z，uptime7944秒；`/api/auth/google/status`返回configured=true。这只证明服务存活及Google登录配置存在。共享SSH通道超时，新的只读连接待恢复；私有环境/route文件/日志/用户Key同一性仍未核实。

## 2. 线上问题核实台账

| 问题 | 当前结论 | 依据/待取证 |
|---|---|---|
| 新用户首次文字AUTO是否可能失败 | **代码上会**：无本scope运行验证时，AUTO拒绝；尚未确认第三人的实际原因 | server.cjs:924、1533；task-router.cjs:40；model-catalog.cjs:629 |
| 同一Key的新用户是否继承验证 | 不继承：scope包含baseURL、userId和Key指纹 | models/catalog-cache.cjs:71–76 |
| 旧用户换Key | 新scope，没有旧scope验证时同样可能冷启动失败 | 同上 |
| PT_AUTO08_ROUTE_CONFIG_FILE | **未确认线上是否设置** | 需读取实际进程环境及只读配置内容；不能由systemd公开Environment为空推断未设 |
| TRUST_PROXY | **未确认线上实际值** | 需实际进程环境+nginx透传头及唯一入口配置 |
| PT_RUNS_PER_USER/GLOBAL、聊天频率是否改过 | **未确认** | 默认4/16/35；需进程环境。即使当前值非默认，也不能仅据当前值给出历史修改时间 |
| 第三人的实际错误码 | **未确认** | 需账号或报错时间；关联Run事件、app日志及nginx。不能从用户描述直接当作已找到日志 |
| 测试同事是否共用Key | **未确认** | 计划只在服务器内解密比较，输出用户匿名代号/Key组号，不输出Key或可复用指纹 |
| 登录10/分、失败5次是否真实生效 | 不能直接套用旧密码登录规则。R34代码先返回410关闭密码路径；实际Google OAuth有独立限流 | server.cjs:1737–1742；auth-google-routes.cjs:20、31、45；公网Google configured=true |

同一办公室共享出口IP时，即使TRUST_PROXY=1也可能共享OAuth的IP桶。若未信任反代且全部请求来自127.0.0.1，则可能退化成所有人共享同一桶。两种情况与“只有两人席位”不同，均须取线上证据区分。

## 3. 并发、频率、身份及连接限制

本节“设计性质”为代码注释或主程判断，均注明。建议不等于已修改值。

| 限制 | 值及证据类型 | 代码位置 | 作用范围、性质与建议 |
|---|---|---|---|
| 每用户活动Run | **代码默认4**；线上待核 | server.cjs:3147；runtime/session-scheduler.cjs:11、55 | 按userId；运行中超额通常排队，不是两用户上限。容量保护，调整须压测 |
| 全站活动Run | **代码默认16**；线上待核 | server.cjs:3148；runtime/session-scheduler.cjs:50 | 实为单服务进程计数；多实例不能当全站共享计数。内存/CPU约束，不能盲目加大 |
| 每对话活动执行 | **代码固定1** | runtime/session-scheduler.cjs:55；tasks/store.cjs:190 | 同user+session序列化，并有持久对话租约；一致性约束，建议保留 |
| 排队 | 代码没有独立的固定队列长度上限 | runtime/session-scheduler.cjs:16、50–84 | 不表示无限容量可承诺；建议补队列等待/长度保护，不等同席位限制 |
| 聊天频率 | **代码默认35次/分钟/已认证用户** | server.cjs:362–363、2793 | 内存固定窗口；不是按办公室IP。可配置，建议保持并以真实负载调整 |
| Google OAuth起点 | **代码默认10次/分钟/IP/路径** | auth-google-routes.cjs:20、31、45；server.cjs:3080 | /start与/callback桶分开；无独立env覆盖传入。NAT用户会共用，建议按设备/会话加细分保护后调整 |
| Google OAuth回调 | **代码默认10次/分钟/IP/路径** | 同上 | 429/RATE_LIMITED；不是旧密码失败锁定机制 |
| 旧密码登录 | **已在代码入口关闭：410 GOOGLE_LOGIN_REQUIRED** | server.cjs:1739–1742 | auth-routes虽保留10/分默认，正常此入口不可达；不要误报为当前Google登录有效值 |
| 旧用户名注册 | 同样先返回410 | server.cjs:1739–1742 | auth-routes.cjs:44为5/分/IP代码旧默认，不是当前Google注册速率 |
| 旧忘记密码 | 同样先返回410 | server.cjs:1739–1742；auth-routes.cjs:23 | 旧默认5/分/IP不作为当前Google登录生效门禁 |
| 旧改密码 | 同样先返回410 | server.cjs:1739–1742；auth-routes.cjs:24 | 旧默认10/分；不要据此推断当前账号被锁 |
| 旧密码防爆破 | 默认5次失败/10分钟窗口，锁10分钟；用户名或IP | auth-routes.cjs:45–47、122–133 | 旧路径保护保留在代码，当前入口关闭。Google并不执行这套密码失败计数 |
| 反代信任 | **代码默认关闭**；线上待核 | ratelimit.cjs:68–82 | TRUST_PROXY=1才取X-Real-IP/XFF；必须同时保证可信代理覆盖头和后端唯一入口 |
| Google state | **代码默认5分钟** | auth-google.cjs:21、30 | 一次性、浏览器绑定；安全有效期，建议保留 |
| Google产品会话 | **代码默认7天** | auth-google.cjs:21、37–41 | 独立于旧auth.cjs的PT_SESSION_TTL_MS，不可见同名env就认定覆盖OAuth |
| 旧密码会话 | 默认7天，可PT_SESSION_TTL_MS覆盖 | auth.cjs:24、84 | 旧登录入口关闭；单列以避免混淆 |
| PostgreSQL池 | **代码默认每Pool最多10连接** | db-pg.cjs:98 | PT_PG_POOL_MAX可覆盖；不是整个服务器10连接，也不是10用户 |
| PG连接等待 | **代码默认5000毫秒** | db-pg.cjs:99 | PT_PG_CONNECT_TIMEOUT_MS；与模型/Run超时不同 |
| PostgreSQL服务器max_connections | **线上待核** | 实际数据库SHOW max_connections | 不是应用源码默认，应结合analytics及其他服务连接合计 |
| 常驻DSH回收 | **代码默认闲置15分钟** | runtime/dsh-adapter.cjs:355、828–835；tenant.cjs:161 | 有waiter/metadata请求时不回收；运行资源策略，不是用户会话过期 |
| 回收检查周期 | 最长60秒 | runtime/dsh-adapter.cjs:835 | 到15分钟不保证毫秒级退出 |
| 常驻进程组织 | 每tenant持有runner，tenant内复用Session | runtime/dsh-adapter.cjs:359 | 不等于每个请求启动独立进程，也未发现“最多2个用户”硬码 |
| 元数据请求并发 | 全部runner合计8；同runner1 | runtime/dsh-adapter.cjs:846–849 | MODEL_INFO_BUSY，区别于正式聊天并发 |
| 用户/席位总上限 | 已查注册、Google建户和成员入口中**未发现固定人数上限** | auth-google.cjs:44–60；member-routes.cjs:31–39；auth.cjs | 不是证明所有外部服务无限制；Google项目测试用户/组织策略尚未读取 |
| 租户关系 | Google首次登录通常新建用户和租户 | auth-google.cjs:58–60 | 同办公室、同Key不等于同tenant或同权限 |

## 4. Run、模型输出和恢复预算

| 项目 | 代码/发行profile值 | 代码位置 | 性质和建议 |
|---|---|---|---|
| Run/adapter时长 | 180秒；线上profile待读 | runtime/run-budget*.json:1；runtime/dsh-adapter.cjs:356 | 试运行/资源上限，复合AUTO计划应单独配置，不直接无限延长 |
| 普通对话输出 | **128 token/请求** | runtime/run-budget.json:7 | 试运行值，主程建议改8192；目前尚未修改 |
| 普通澄清输出 | 128 token/请求 | runtime/run-budget-questions.json | 同上；不是用户输入字数 |
| 联网输出 | 512 token/请求 | runtime/run-budget-web.json | 可调整，需模型能力及预算支持 |
| 账单输出 | 512 token/请求 | runtime/run-budget-billing.json | 同上 |
| 文件生成输出 | 2048 token/请求 | runtime/run-budget-documents.json | 建议长结构化报告提高或分段，不削弱writer限额 |
| 只读分析输出 | 2048 token/请求 | runtime/run-budget-analysis.json | 不等于Python stdout上限 |
| provider自动重试 | 0 | dsh-settings.yaml:22 | 试运行保护；实际seeded settings待线上读取哈希绑定 |
| 普通/澄清框架恢复 | 最多1 | run-budget.json / run-budget-questions.json | 不是所有层次都0重试；与未来每模型3次不同 |
| 其他专用框架恢复 | 0 | 其余run-budget*.json | 用户新方案尚未实现，不能当作已变3次 |
| 每工具参数键 | 最多1次 | 各profile maxToolCallsPerKey | 去重保护；组合任务须明确区分新步骤与重复同调用 |
| 上下文辅助额度 | 1次，包含在模型总调用中 | 各profile contextModelCalls；persistent-runner.mjs:610 | 不是额外赠送一次，不当作仅主对话费用 |
| 压缩摘要输出 | 128 token；压缩重试0 | runtime/dsh-adapter.cjs:207–209 | 试运行小值，建议单独调整并回归摘要完整性 |
| 运行租约 | 默认30秒，校验范围1秒–5分钟 | tasks/execution.cjs:5；tasks/store.cjs:155–175 | 崩溃/并发安全边界，不能当总Run时长 |
| 取消宽限 | 默认3秒 | runtime/dsh-adapter.cjs:357 | 等退出与持久partial；建议保留并测试 |
| 普通提问等待 | 60秒/问题服务设置 | questions/service.cjs:12 | 交互有效期，应独立于Run活动时钟设计 |
| 模型意图绝对兜底 | 最多100条/Run | tasks/store.cjs:315–319 | 当前数据/去重兜底，不是实际允许100次；更小profile预算优先 |
| 心跳 | 默认关闭；开启后默认5分钟 | server.cjs:365–369 | 真模型路径，可能计费；线上开关待核，不应偷偷用来首用验证 |

| 发行模式 | 模型总调用 | 工具总调用 | 框架恢复 | 输出token |
|---|---:|---:|---:|---:|
| 普通 | 3 | 0；时间工具特殊豁免 | 1 | 128 |
| 澄清 | 3 | 1 | 1 | 128 |
| 联网 | 4 | 2 | 0 | 512 |
| 账单 | 3 | 1 | 0 | 512 |
| 文件 | 3 | 1 | 0 | 2048 |
| 只读分析 | 5 | 3 | 0 | 2048 |
| CSV | 3 | 1 | 0 | 512 |
| 媒体 | 3 | 1 | 0 | 512 |
| Skill | 4 | 2 | 0 | 512 |
| Skill+CSV/媒体 | 5 | 3 | 0 | 512 |

本表由发行源码profile读取；实际运行profile尚待本轮线上核对。硬编码、配置文件、环境回退三者分开记录。

## 5. 文件、解析器与Python限制

| 限制 | 代码默认/固定值 | 代码位置 | 性质与放开建议 |
|---|---|---|---|
| TXT/MD/CSV上传 | 默认5MiB | server.cjs:372、2695 | PT_DOC_UPLOAD_MB可覆盖；需与parser/代理保持一致 |
| DOCX/XLSX/PPTX/PDF/DOC/XLS/PPT/ZIP上传 | 固定20MiB | server.cjs:375、2695 | 格式解析保护；不能只提高nginx限制 |
| 图片上传 | decoded最多20MiB；JSON请求体20MiB | server.cjs:2579–2591 | base64/表单开销使可传字节不同；图片后续原生输入还有限额 |
| 原生图片输入 | 每次最多4张、合计10MiB | runtime/native-image-message.mjs:6、17–19 | 模型输入保护；上传成功不等于全部能一次理解 |
| 音视频上传 | 默认50MiB；JSON包80MiB | server.cjs:378、2737、2745 | PT_MEDIA_UPLOAD_MB可覆盖；实际处理器仍有50MiB上限 |
| 租户上传总额 | 默认100MiB | server.cjs:2608、2715、2754 | PT_UPLOAD_QUOTA_MB；目前按目录求和，非全站席位限制；提高前评估磁盘/并发配额原子性 |
| Multipart包开销 | 相应文件上限再加1MiB | server.cjs:2579、2673、2730 | 传输边界，非额外文件容量 |
| 普通文档上下文 | 默认100000字符，累计 | server.cjs:373、585 | PT_DOC_CONTEXT_CHARS；与文件字节和模型token不是同一单位 |
| 文档上下文总deadline | 15秒 | server.cjs:594、599 | 解析资源保护；可分批/异步，而不是取消deadline |
| Office/PDF解析 | 输入20MiB；默认10秒，最多15秒；两个解析槽 | attachments/office-document-parser.cjs:4、38–49 | 资源保护；繁忙返回OFFICE_PARSER_BUSY，第三个解析不是第三个用户不能登录 |
| 解析worker内存 | old128MiB、young16MiB、stack4MiB | attachments/office-document-parser.cjs:12 | worker资源设置不等于整个服务RSS上限 |
| 现代Office容器 | 展开64MiB、512成员 | attachments/office-zip-guard.cjs:6 | 压缩炸弹防护，保留 |
| PDF物理页 | 最多200页 | attachments/pdf-text-parser.cjs:12 | 可按明确任务分页扩展，不能用虚构页号 |
| PDF提取文本 | 最多5MiB | attachments/pdf-text-parser.cjs:22 | 资源保护，保留或通过分片机制扩大 |
| PDF OCR页 | 最多10空文字页 | attachments/pdf-text-parser.cjs:29 | 无文字的空白页也可能计入；建议异步分页，不直接无上限 |
| OCR单页图像 | 最多300万像素、PNG2MiB | attachments/pdf-text-parser.cjs:30、33 | 保留像素/解码限制 |
| ZIP | 原包20MiB、64目录项、16文档、单成员10MiB、展开合计20MiB | attachments/document-bundle-worker.cjs:5–40 | 资源/路径保护，拒绝嵌套通用ZIP、加密、执行内容、重复名、符号链接 |
| ZIP解析输出 | 5MiB文本、10000块 | attachments/document-bundle.cjs:20 | 与成员各自限额同时生效 |
| CSV parser | 默认20MiB、100000行、16384列、100000单元格 | attachments/csv-parser.cjs:3–9 | 上传入口通常先收紧到5MiB；不能把parser值误报为上传值 |
| 旧Office固定转换 | deadline5.5秒，stdout1MiB、stderr32KiB | runtime/native-readonly-process.mjs:8–17 | 固定可信程序，保留隔离与等待退出 |
| 媒体本地理解 | 一次1个输入、50MiB、300秒、最多3视频帧 | server.cjs:1002；media/local-content-runtime.cjs:41–68 | 不是原生连续视频；建议独立任务队列，不直接提高并发 |
| 媒体处理器并发 | 一个处理任务 | media/local-content-runtime.cjs:6、41–43 | CPU/内存保护，不等于一个网站用户 |
| Whisper子进程 | 最长150秒 | media/local-content-runtime.cjs:55 | 本地处理时长，不是模型Run时长 |
| 生成文档结构 | 64KiB、20章节、500段、1000行、5000单元格 | tasks/document-export-handler.cjs:10 | writer资源保护，长文档应分段 |
| 生成文件 | 5MiB、worker10秒/128MiB/两槽 | exports/conversation-docx.cjs:42–63 | worker资源保护；建议保留，通过分段扩容 |
| 分析输入 | 最多8个、每个1MiB、合计2MiB | tasks/analysis-workspace.cjs:9–21 | 已上传大文件不等于允许直接进Python |
| Python代码 | 最多8192字节 | runtime/offline-analysis.mjs:9 | 保留输入上限 |
| Python平台 | Linux x64且完整Landlock | runtime/offline-analysis.mjs:8、15 | 安全条件，不降级普通spawn |
| Python墙钟/CPU | 5秒/4秒 | isolation/offline-analysis.c:32、45 | 安全与资源上限；长任务另设计，不能只改UI |
| Python内存/FD/文件写 | 128MiB、32 FD、文件写上限0、禁core | isolation/offline-analysis.c:32 | 安全边界，保留 |
| Python输出 | 每个受控输出流16KiB | runtime/offline-analysis.mjs:19；native-analysis-provider.mjs:34–41 | 与模型回答token不同 |
| 分析读取文本 | 最多16000字符 | runtime/native-analysis-provider.mjs:21 | 二进制不能假装UTF-8 |
| 分析并发 | 输入预留最多2；provider内同时1个Python | tasks/analysis-workspace.cjs:10；runtime/native-analysis-provider.mjs:9、29 | 不直接等于全站两人上限 |
| 记忆 | 显示100条，召回20条/4000字符 | memory/provenance-store.cjs:9、47 | 产品/上下文上限，可改但需保留确认与来源失效 |
| 资料选择 | 一次8条；列表100 | public/index.html:303；server.cjs:2486 | 组合AUTO应按步骤引用而非全量塞上下文 |
| API分页 | Run/events/usage通常最多500 | tasks/store.cjs:28；server.cjs:2021、2073 | 分页保护，不是用户/任务总数限制 |
| Nginx请求体/超时/连接限流 | **线上待核** | nginx -T目标vhost及继承配置 | 未检查前不能把应用50MiB当公网实际可上传50MiB |

## 6. AUTO真正选择条件和顺序

以下顺序对应当前代码，不是未来规划模型方案。

1. 确定任务：通常textChat；非生成任务存在当前/历史图片或视频帧时走imageUnderstanding。见server.cjs:921–924。
2. 确定用户/对话选择。新用户未保存选择时默认AUTO，见server.cjs:275。
3. 读取当前用户Key对应目录，scope包含固定网关、userId、Key指纹。见server.cjs:153–180；models/catalog-cache.cjs:71–76。
4. 将实际DSH settings里的配置ID施加到目录，过滤Seedance。目录出现不等于DSH可调用。见server.cjs:193–198；models/dsh-configured-catalog.cjs:34–50。
5. 若AUTO路由配置存在，取当前任务routes中给定顺序；该任务未配则AUTO_TASK_NOT_CONFIGURED；手动模式不应用此顺序。见models/auto-route-policy.cjs:16–25。
6. 校验任务输入要求、候选列表及重复ID、选择模式。重复身份等结构错误直接失败，不靠过滤隐藏。
7. 对每个候选按下面顺序检查，首个通过者即被选择。

| 顺序 | 条件 | 拒绝码 | 代码 |
|---:|---|---|---|
| 1 | 目录availability.status=available且有modelIds | AVAILABILITY_UNKNOWN | models/task-router.cjs:18–20 |
| 2 | 候选present且出现在当前目录 | MODEL_REMOVED / MODEL_UNAVAILABLE | 同文件:21–22 |
| 3 | permission===true | PERMISSION_UNKNOWN_OR_DENIED | 同文件:29 |
| 4 | 实际DSH已配置 | DSH_MODEL_NOT_CONFIGURED | 同文件:30 |
| 5 | 本地策略enabled且包含当前task | LOCAL_POLICY_UNKNOWN_OR_DENIED | 同文件:31–32 |
| 6 | 当前任务能力事实为true | TASK_UNSUPPORTED / CAPABILITY_UNKNOWN | 同文件:33–34 |
| 7 | 适配器存在且已适配 | ADAPTER_UNVERIFIED | 同文件:36–37 |
| 8 | 可信任务端点兼容 | ADAPTER_ENDPOINT_MISMATCH / ENDPOINT_COMPATIBILITY_UNKNOWN | 同文件:38 |
| 9 | AUTO要求运行验证通过；手动可进入验证试用 | RUNTIME_UNVERIFIED | 同文件:40 |
| 10 | 输入/输出包含text；图片任务另含image | MODALITY_UNKNOWN / TEXT_MODALITY_UNSUPPORTED / IMAGE_MODALITY_UNSUPPORTED | 同文件:41–45 |
| 11 | AUTO要求state.autoEligible===true | NOT_AUTO_ELIGIBLE | 同文件:46 |

verified自身还要求同scope、同model、task、adapter ID/version/endpoint和capabilityRevision的可信passed证据。能力/接口版本变化不能继续复用旧验证。见models/capabilities.cjs:95–108的eligibility/verification检查。

### 6.1 多个合格模型时

有PT_AUTO08_ROUTE_CONFIG_FILE时按文件给定顺序选第一个合格模型。没有该配置时沿候选数组顺序；通常规范目录按ID排序，但最终以实际传入顺序为准。价格不参与routeChatTask打分，不调用廉价规划模型，也不按整段用户需求安排多个模型协作。

任务类型参与资格过滤；不是“哪个最聪明/最便宜”的动态比较。输入模态参与筛选；没有能力事实不会靠名称猜测。

图片AUTO还有特例：未配置route policy且正常AUTO找不到时，server.cjs:226–232会对第一个有图片事实、目录权限的候选尝试manual资格路径。文字AUTO没有对应冷启动fallback；不能用图片特例解释文字已解决。

### 6.2 换模型与手动选择

| 情况 | 当前行为 |
|---|---|
| 调用前一个候选不合格 | AUTO继续检查下一个候选 |
| 候选重复ID/配置结构不合法 | 直接失败，不任意选一个 |
| 所有候选被拒 | 文字返回NO_ELIGIBLE_MODEL及可用reasonCodes；持久SSE可能HTTP200但done失败 |
| 手动选择 | 只检查该模型；不要求AUTO的verified/autoEligible，但仍检查其他资格；不被AUTO顺序替换 |
| 真调用开始前资格/版本变了 | 模型意图再次检查，返回MODEL_ELIGIBILITY_CHANGED或MODEL_ROUTE_REVISION_CHANGED；不是自动跳新模型 |
| 已调用后错误 | 本Run模型固定；可能触发原预算允许的同模型恢复，不存在通用跨模型失败接力 |
| 已提交且结果未知 | 持久预留阻止盲目重放；不是“Key有余额就可以无条件重建同付费操作” |
| 当前是否每模型重试3次 | **否**。这是新方案，不是R34线上事实 |

## 7. 手动验证与冷启动问题

server.cjs:1533只有非AUTO文字请求才尝试recordManualTextChatVerification。成功聊天也不保证写入验证：helper要求实际modelCalls===1、configured预算、单个可信modelIdentity响应、当前scope/revision/权限/adapter仍有效等。含辅助压缩或多次工具往返的成功Run可能不满足这个单响应门槛。

因此“首次AUTO没有任何verified模型→全部拒绝→不产生成功Run→无法晋级”的文字冷启动循环是代码上成立的。它是可用性缺口，不是应该要求新用户自己解决的产品流程。是否就是第三人那次失败仍必须查实际Run/log。

未来方案必须加入受控auto-bootstrap：使用审核能力/适配事实和当前Key权限直接执行用户真实任务首轮，成功后按实际attempt晋级。不复制别人的运行验证、不伪造passed、不额外偷偷发付费Hello。详见[改进方案第21节](AUTO-CHAT-PRODUCT-IMPROVEMENT-PLAN-20261111.md#21-新用户与新key首次auto必须解决的冷启动闭环)。

## 8. 实际可选模型名单：待本轮线上取证

这里不能放DSH配置的27个ID冒充AUTO名单。AUTO资格按用户/Key范围区分。将分别登记每位测试用户的已存scope、最后同步时间、verified清单、按资格过滤后的可选项及配置顺序。

只读审计脚本不调用真实模型、不刷新目录或写缓存。其缓存重算结果必须标“线上已存事实”，不是新的实时Key权限验证；若需要当前热内存/实时目录的证明，须另用已认证只读视图并记录刷新副作用，不能悄悄把只读检查变成模型验证。

当前未恢复SSH，不在此填任何“当前真正可选”名单。缺证据本身保留为未确认。

## 9. 意图与放开建议汇总

| 类别 | 判断 | 建议 |
|---|---|---|
| 128/512 token与单模式互斥、0/1恢复 | 试运行限制或现阶段接线策略 | 新AUTO中按模型真实能力提高输出并组合工具；先改契约及回归，不直接全开 |
| 新scope必须先手动verified | 原来保守准入造成冷启动缺口 | 必须补自动bootstrap；不删除所有资格检查 |
| 每用户4/全站16 | 运维默认容量值，不是授权席位 | 先核实际值、排队与CPU/RSS，再容量压测调整 |
| 同对话1、租约/CAS、身份/Key隔离 | 一致性/安全边界 | 保留 |
| OAuth IP桶 | 抗滥用默认，但NAT易共享 | 核实TRUST_PROXY与nginx，再增加设备/会话维度和合理IP总桶；不直接关闭所有保护 |
| 文件、PDF、ZIP、Python限额 | 解码炸弹、资源及隔离边界 | 保留；通过分页、后台处理和不同任务等级扩容 |
| 上传总配额、常驻idle、PG池 | 可配置资源策略 | 根据实际磁盘/连接/内存调整，不按用户抱怨猜值 |
| 预算与媒体去重 | 费用/副作用保护 | 新方案允许正常付费恢复，同时保留未知受理的幂等/查单边界 |

新方案第11–20节已涵盖金额/媒体上限、设置授权撤销、多租户、计划冻结、Python安全、PT依赖、模型选择/数据格式/传递、5–7人日估计及回归影响；原生DSH8组与CLI1组小验证已有回执。第21节补首用冷启动。以上仍为方案，不表示整体开工或已上线。
