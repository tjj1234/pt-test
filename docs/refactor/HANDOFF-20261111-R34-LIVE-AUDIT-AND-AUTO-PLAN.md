# R34 只读线上核查与单聊天框 AUTO 交接

交接日期：2026-11-11，东京时间UTC+9。用户准备/new。**下一会话只继续只读线上核查、事故分诊与方案补充；用户已明确“暂时不开工”。禁止据“继续”自行启动整体开发、修改线上参数、重提媒体、重部署或派发程序员任务。**

## 1. 首先恢复什么

1. 阅读本文件和最新用户消息。检查两个隔离worktree的Git/HEAD/脏文件，保护共享主工作区。
2. 使用用户指定的本机SSH共享socket：`~/.ssh/pt-r34-audit.sock`。不要使用旧/private/tmp通道。
3. 本轮该socket在工具环境内未找到，私有线上核查未执行。先核查连接是否实际可用，不能把“用户说已连接”写成自己已取证。
4. 确认媒体报错时间的时区，定位指定用户Run及外部operation，不要直接归因为AUTO冷启动。
5. 执行经过SHA核验的只读审计，补完《R34限制与AUTO规则清单》的线上值，再回答用户三个部分。根因未明前不改代码或重试生成。

## 2. 已部署与仅方案，必须分开

### 2.1 正式环境发布事实

| 项目 | 已知记录 |
|---|---|
| 唯一正式环境 | https://agent-fat.adorado.top；没有独立staging |
| 服务器/服务 | tongjiawan@47.237.22.191 / northstar-shell；analytics为独立服务 |
| 已部署版本 | R34，DEPLOYED_FOR_QA；独立完整业务验收不因此通过 |
| 运行源码冻结提交 | 1586f765b53fde0a767ef13def3a47e56ca0c726 |
| 运行源码分支 | integration/r34-final-all8-20261109 |
| release | /opt/northstar/releases/controlled-trial-20261111-r34-all8-1586f76-target |
| 归档 | northstar-controlled-trial-20261111-r34-all8-1586f76-target.tar.gz |
| 归档SHA256 | cb36cdc5002bdc70a855fd30558893632c9442d847dd609534ea027efe94e4bf |
| 来源清单SHA256 | 8ee72b3d955eb79918409536380fe83c9b2eaf3e8a83cb9303e127aed9bb46c9 |
| 发布成功 | 2026-11-11备份时间05:40:24Z，即东京14:40:24；发布成功回执在其后 |
| 成功备份 | /var/backups/northstar/r34-20261111T054024Z |
| 隔离验证库 | northstar_r34_verify_20261111054024 |
| 发布门禁 | 361:30恢复→361:35迁移；最小运行ACL、两个审核价格导入、源码1095成员/模式与依赖通过 |
| 最后一次完整独立源码核对 | 2026-11-11T05:42:16.323Z；1095成员、PID及公网JS/CSS通过 |
| 本轮公网重核 | 2026-11-11T08:28:35.942Z；PID494892、ok、uptime10038秒；Google configured=true |
| 公网app.js SHA | 58ab60dd7c687fb40d351ffaa4ba9357d47a522a9cba712edee38763bc5e3b4a；本轮重核仍一致 |
| 证据边界 | 本轮未重新读取/opt服务目录、实际进程环境或全部源码；不能把旧完整核对冒充本轮新私有检查 |
| Bug-12 | DEGRADED_PREVIEW，普通回答HTML自动物化未开放，不标完整通过 |

R34上线范围：01本地音视频转写/采样帧；02现代/旧Office、PDF/OCR、ZIP及来源；03Word/中文PDF/Excel产物；04原生可信联网；05澄清/精确审批；06受限只读分析；07官方账单接线及双轨估算；08调用前资格/配置/持久预留；Bug3/R33整改。它们是受限组件接入，不等于用户要的“单聊天框自动规划组合交付”已经实现。

首次发布失败也保留：备份r34-20261111T051705Z，profile重建前ERR_INVALID_PACKAGE_CONFIG，已回滚R33（PID494147）。实际northstar身份验证：用户私有暂存cwd失败，cwd=/通过。修订脚本固定cwd并前置两身份模块检查后第二次发布成功。**不要再次运行发布脚本。**

### 2.2 当前Git工作区与文档分支

以下为交接文件保存前现场；保存后会新增纯文档/诊断提交，下一会话重新git rev-parse。

| 路径 | 分支/HEAD | 边界 |
|---|---|---|
| /Users/mmdn/Downloads/pt项目 | feature/northstar-integration-20261102 / bbd9997d1e19920dc1c850c31ec6c71dbc5994d1 | 共享主工作区：本轮检查29个tracked dirty、332个untracked。多数他人产物，不能reset/clean/切分支/全量add。此交接会额外新增一个同名新文件副本 |
| /Users/mmdn/Downloads/pt项目/.worktrees/r34-final-20261110 | integration/r34-final-all8-20261109 / a9cf350c8e9ee0c26db0b9750c192472895ba8d7 | 当前工程/审计文档工作树；tracked原干净，未跟踪多为自己发布资源。后续HEAD是文档/探针，不改变运行源码1586f76 |
| /Users/mmdn/Downloads/pt项目/.worktrees/r34-docs-20261111 | docs/r34-online-status-20261111 / b1fde1e59fd3984d4c4114ae5f7928044f784e59 | 只同步路线图/主台账，push目标handoff/two-developers-20261105；该分支运行代码旧，不能用其shell文件判断R34 |

特别注意：阅读代码必须在r34-final工作树。docs工作树server同类行号和实现可能旧。文档提交号不是线上运行提交号。

### 2.3 未开发/未部署的方案

`docs/refactor/AUTO-CHAT-PRODUCT-IMPROVEMENT-PLAN-20261111.md`是规划态。默认自动规划、多模式组合、每模型3次重试、8192/16384输出、持久金额账本、系统自动Python授权、设置授权改造及首次AUTO bootstrap均未实现/未上线。

本轮新增代码只有隔离小验证、只读诊断辅助脚本；没有产品运行代码、迁移或部署。不得把写方案/8组探针通过写成整体开工或功能交付。

## 3. 用户已经确认的产品决定与底线

| 决定 | 内容 |
|---|---|
| 产品入口 | 默认一个聊天框。用户说目标，系统选模型/工具、顺序执行并交付，不让用户选联网/分析/生成文件模式 |
| 简单与复杂任务 | 简单直接答，不强制多模型；复杂自动计划、组合；只问必要业务信息或授权 |
| 输出 | 128 token明显不合理，必须改进；方案建议普通8192、长文16384，按模型上限和预算适配。建议值不是线上值 |
| 每模型重试 | 用户要求每模型最多重试3次；方案目前解释首次1次+失败重试最多3次。不是整任务最多3次；媒体创建另有更严次数和幂等约束 |
| 金额 | 用户要求复用budget.cjs的maxCost任务金额保护；不能把“Key有钱”解释为无限重复。建议普通USD1、媒体USD5，均是方案建议；官方实扣硬帽尚不能保证 |
| 未知费用 | 缺本地价格不等于免费。新增硬额与任意未知价继续不兼容；默认审核估算预算，未知价计次模式需另行一次授权，不能静默绕过金额保护 |
| 媒体 | 建议图片最多2个操作、n=1；视频1个操作；计入整个任务。PT未知受理不能盲目重建或假称幂等 |
| 授权 | 保留设置页一次明确授权、可撤销；不是全隐式。个人授权tenant+user；租户策略只收紧，不能替成员授权个人Key |
| 多租户 | 身份取认证上下文；计划/步骤/attempt/retry/ref/budget都绑定tenant/user/run；不可跨Key借验证或账单 |
| 原生优先 | 锁定DSH已有能力先实测复用；只有确认缺口才最小宿主补充，不另造Agent循环 |
| 冻结/注入 | 计划校验后不可变版本+SHA；外部网页/文件只能提供数据，不改计划/权限/额度。局部工具还要宿主执行门禁 |
| Python | 设置单独授权仍不够；必须通过独立真实Linux安全矩阵，策略系统授权不能伪造成用户点击 |
| 发布 | 只有正式环境；冻结、备份恢复、迁移/ACL验证、发布后检和同版本独立QA分别记账 |
| 保护并发 | 不覆盖主工作区/作者工作；Codex负责共享入口/主审/合并/上线，两位程序员无生产权限 |
| 当前指令 | 暂不整体开发。先回答线上核查、限制清单和补充方案；没有新部署授权需求，不能重复部署 |

## 4. 事实、推导与未知：不得混记

### 4.1 已核实事实

- 公网本轮服务健康：时间/PID/SHA见第2节及`evidence/R34-LIVE-PUBLIC-STATUS-20261111.json`。
- 无凭据GET线上`/api/auth/login`确实返回410/GOOGLE_LOGIN_REQUIRED；`/api/auth/google/status`为configured=true。
- R34冻结代码中，文字AUTO要求verified/autoEligible。server:1533仅在非AUTO文字链路调用recordManualTextChatVerification；helper还要求单次模型响应、真实身份、scope/revision/adapter一致。scope包含userId+Key+网关。
- 锁定DSH0.1.1-rc.2原生8组小验证通过：同Agent/Session/turn内三模型两工具链、数据传递、动态全局工具限制、局部工具边界及宿主门禁、两Session范围、取消、maxCost已知/未知行为。另CLI+真实pi-ai本机回环换模1/1通过。全部无真实Key/付费/生产操作。
- 原生tools.restrict不覆盖Agent局部注册工具；宿主tools/execute/RPC门禁必须保留。
- budget.cjs现有maxCost需要估算及可信结算；未知结算会阻断。当前Runner构造请求后settle()无金额，因此不能只增加配置就称已接入金额硬帽。
- 现有审核价格只有deepseek-v4-pro/glm-4.7，cacheWrite为null。USD估算与官方credits实扣不换算、不互相冒充。
- 工具环境home=/Users/mmdn；本轮未找到用户指定socket。ssh -O check返回No such file or directory，批处理直连认证失败。未删除/关闭用户连接。

### 4.2 仅代码推导，尚不能定当次事故

- 新用户/新Key文字AUTO可陷入“未验证→AUTO拒绝→无成功→无法验证”的冷启动循环；即使共用Key，不同user仍不继承验证。
- Google OAuth默认10次/分钟/IP/路径；同办公室出口可共享额度。TRUST_PROXY未启且nginx回源同IP时可能所有人共用桶。线上值及是否发生过429尚未查。
- 多数并发默认是每用户4/全进程16、同会话1；超过调度并发通常排队，不是两人席位上限。但不能拿默认值回答线上是否改过。
- 媒体结果通用展示未通过可能来自没有合格媒体结果、操作尚未确认、发布/读取失败等；不能直接推断PT生成失败或成功。
- RUN_TOOL_CALL_LIMIT可能是实际选了零工具预算，也可能是一次媒体工具额度用完后又调用工具；必须看真实Run预算/步骤，不能先定为应该放宽。

### 4.3 未确认事项

- PT_AUTO08_ROUTE_CONFIG_FILE是否设置、实际文件内容/顺序/版本/SHA。
- TRUST_PROXY实际进程值；nginx真实X-Real-IP/XFF覆盖、body/timeout/限流继承配置及后端入口。
- PT_RUNS_PER_USER/GLOBAL、PT_RATE_CHAT_PER_MIN及上传/PG等实际覆盖值；是否历史修改过另需配置历史，当前值不能证明修改时间。
- 每位同事当前Key是否相同；需要服务器内解密内存比较，仅导出临时Key组号。
- 各user/Key scope真正通过资格的模型及顺序；不是配置27个ID。审计脚本目前仅重算线上存储事实，不刷新目录/读热内存，需标边界。
- 指定媒体事故的Run、错误事件、预算、外部task、媒体发布结果、官方费用/退款；尚未取得私有日志。
- Google Cloud项目测试用户名单/组织策略等外部限制尚未查，不能认定不存在外部账号限制。
- 官方实扣硬帽、PT幂等和丢task_id后按客户端操作号查受理的合同均未取得验收证据。

## 5. 第三位同事：原始上报和时间边界

| 字段 | 用户上报 |
|---|---|
| 账号 | google_46318be1631a400585946549d0605528 |
| user_id | 842a987b-1ec1-4931-9224-ba6886392dea |
| 场景 | 文生图或图生图 |
| 首个时间 | 2026/11/11 14:02:27；时区仍需确认 |
| 第一条提示 | 媒体生成未完成展示；远端任务状态请在运行记录中核对，勿重复提交。 |
| 之后提示 | （DSH 执行失败：Run stopped because the tool-call budget was exhausted） |

**这不是用户上报文字NO_ELIGIBLE_MODEL。** 不把媒体事故直接归因为文字AUTO冷启动。

冻结R34源码映射：server.cjs:1470–1478的`acceptsMediaRunResult`分支返回MEDIA_RESULT_NOT_AVAILABLE；persistent-runner.mjs:36将RUN_TOOL_CALL_LIMIT映射为第二条英文。属于代码映射，尚不是已找到当次线上error code。

acceptsMediaRunResult（shell/tasks/media-result-acceptance.cjs:9–17）要求result.ok、正好一次成功media_route、正好一个媒体结果、type匹配且URL为绑定当前Run的/api/run-media路径。失败提示本身不证明远端受理或费用状态。

时间换算：
- 若14:02:27是东京UTC+9，则05:02:27Z，早于R34成功发布05:40:24Z；应先查R33及当时服务，不能叫R34事故。
- 若14:02:27是北京UTC+8，则06:02:27Z=东京15:02:27，在R34后。
- 查两候选时间窗口和用户Run时间，确认浏览器/报告时区后再绑定版本；后续第二条错误可能在另一个Run/另一个版本，分别处理。

## 6. 只读核查脚本、连接与执行边界

### 6.1 连接

用户指定：本机`~/.ssh/pt-r34-audit.sock`，即当前工具环境`/Users/mmdn/.ssh/pt-r34-audit.sock`。不是服务器~/.ssh，也不是旧/private/tmp路径。

```bash
ssh -S /Users/mmdn/.ssh/pt-r34-audit.sock -O check tongjiawan@47.237.22.191
```

当前没有成功取到连接。下一会话先检查该路径是否存在且是socket，并请用户确认连接在同一本机工具环境中。禁止删除旧socket、关闭用户连接、改用密码批处理或读取SSH私钥。

`scripts/r34-ops-20261111.py`仍硬编码旧`/private/tmp/pt-ops-20261105.sock`，不要拿它误当新通道。应明确使用新ControlPath；必要时只改本地审计transport，不改产品。

### 6.2 脚本位置和审核状态

本机完整位置：
`/Users/mmdn/Downloads/pt项目/.worktrees/r34-final-20261110/scripts/r34-live-audit-readonly-20261111.py`

Git路径：`scripts/r34-live-audit-readonly-20261111.py`，integration/r34-final-all8-20261109分支。

本次更新后的SHA256：`e467f28de7bc5a30cf0b8d3edb6516d51063162ee99a9ed8cdb44fe449ca8751`。新会话若修改必须重算，并确保服务器拷贝一致。Python及内嵌Node语法校验已通过；**脚本尚未上传、尚未在服务器执行；数据库查询未实测。**

支持一个可选目标user UUID参数。已针对本次媒体事故增加Run tool/budget元数据、外部operation及R33旧日志读取。默认不提供UUID则取最近所有账号Run，建议本次给定目标以减少无关输出。

脚本只读：systemctl、/proc实际环境、运行profile及源码hash、nginx -T、有限日志尾部、只读SQL事务、缓存读取。用真实运行角色开1个诊断连接；不会init/migrate、改ACL、写缓存、建立登录会话、查询付费模型或媒体、取消任务或重启。Key只在服务器进程内解密比较，输出临时K01/K02组号；不输出原文、密文、末四位或可复用Key指纹。日志不导出Cookie、查询串、正文和凭据。

进程环境、root日志和私有Key存储需要sudo。SSH ControlMaster不共享用户TTY的sudo认证；不可要求用户把密码贴到聊天。连接恢复后先sudo -n true判断；不可用则给用户可审阅、SHA绑定的只读命令在其服务器终端执行。

### 6.3 恢复连接后的传输和用户终端命令示例

先用指定ControlPath将脚本上传到自己的旧stage（不覆盖应用文件），并独立核对远端SHA：

```bash
scp -o ControlPath=/Users/mmdn/.ssh/pt-r34-audit.sock /Users/mmdn/Downloads/pt项目/.worktrees/r34-final-20261110/scripts/r34-live-audit-readonly-20261111.py tongjiawan@47.237.22.191:/home/tongjiawan/pt-r34-stage-37930c7/assembled-1586f76/
```

仅在上传与SHA确认后，才给用户服务器终端执行：

```bash
cd /home/tongjiawan/pt-r34-stage-37930c7/assembled-1586f76 && printf '%s  %s\n' 'e467f28de7bc5a30cf0b8d3edb6516d51063162ee99a9ed8cdb44fe449ca8751' 'r34-live-audit-readonly-20261111.py' | sha256sum -c - && sudo python3 ./r34-live-audit-readonly-20261111.py 842a987b-1ec1-4931-9224-ba6886392dea
```

这是只读诊断，不是部署。脚本自己的Node子进程固定cwd=/，避免前次私有stage导致ERR_INVALID_PACKAGE_CONFIG。原始root日志/密钥不能让用户整段cat到聊天；使用脱敏JSON输出。

### 6.4 执行后必须核对

- 审计输出samePidAtEnd、服务真实目录、源码hash与冻结基线；环境默认与实际覆盖逐一比对。
- routePolicy版本、SHA和textChat/imageUnderstanding列表；即便有配置，未verified仍不能AUTO。
- nginx真实透传头、监听、上传/timeout及全局继承限制；进程TRUST_PROXY值。
- Uxx→目标用户、Kxx分组、Key更新时间；只能说明当前存Key相同，不能直接说明历史出错时同Key。
- target Run的requestedModel、done/error code、reasonCodes、step isError、run_budget snapshot/limits、外部operation/task_id/status/query。
- status 200的SSE可能done失败；nginx HTTP200不能作为生成成功。
- 如果日志未保留具体错误码，明确写证据缺口；不靠代码推导冒充日志发现。
- 存储cache重算不是新的实时PT权限或热内存读数。需要实时目录时另说明GET的副作用边界；不做真实推理验证。

## 7. 文档与证据入口

下列文件都在r34-final工作树；共享主工作区同名旧文件可能不是最新。

| 目的 | 路径 |
|---|---|
| 当前限制清单草稿 | docs/refactor/R34-LIMITS-AND-AUTO-RULES-20261111.md；待补线上值和事故结论 |
| 完整功能/DSH对应表 | docs/refactor/R34-FEATURE-AND-DSH-CAPABILITY-MATRIX-20261111.md |
| 自动聊天方案 | docs/refactor/AUTO-CHAT-PRODUCT-IMPROVEMENT-PLAN-20261111.md |
| 发布回执/QA指令 | docs/refactor/evidence/R34-ONLINE-AND-QA-HANDOVER-20261111.md |
| 独立上线1095成员核验 | docs/refactor/evidence/R34-INDEPENDENT-ONLINE-POSTCHECK-20261111.json |
| 本轮公网/连接事实 | docs/refactor/evidence/R34-LIVE-PUBLIC-STATUS-20261111.json |
| 原生小验证 | tests/probes/auto-chat-native-feasibility-20261111.mjs |
| 八组回执 | docs/refactor/evidence/AUTO-CHAT-DSH-FEASIBILITY-20261111.json |
| CLI/pi-ai回环回执 | docs/refactor/evidence/AUTO-CHAT-DSH-CLI-MODEL-SWITCH-20261111.txt |

GitHub基址：`https://github.com/tjj1234/pt-test/blob/integration/r34-final-all8-20261109/`。路线图与主台账维护在handoff/two-developers-20261105；本文件会在共享主目录新增一个副本，便于/new恢复，不覆盖已有交接。

## 8. 方案章节和分批实施建议（未开工）

| 章节 | 内容 |
|---|---|
| 第1–10节 | 产品目标、原生接线、输出、重试、单框UI、场景与顺序 |
| 第11节 | 本轮原生小验证与证据边界 |
| 第12节 | maxCost、USD1/5建议、图片2/视频1、持久预算与未知成本冲突 |
| 第13节 | 设置页一次授权、个人/租户作用域、撤销与在途处理 |
| 第14节 | 计划/步骤/attempt/retry/ref/budget字段、复合FK、拟议RLS及真实PG矩阵 |
| 第15–16节 | 规划首选glm-4.7/备用deepseek-v4-pro、计划JSON、冻结/hash、注入防护和引用传递 |
| 第17节 | 自动Python独立Linux安全矩阵及放行门禁 |
| 第18节 | PT幂等、丢task_id受理查询、报价/币种/账单/取消依赖和临时行为 |
| 第19–20节 | 原约5–7工程人日、独立QA1–2工作日；原生可复用，但尚未整体开工 |
| 第21节 | 新用户/新Key受控bootstrap；加入后约5.5–8工程人日，QA另列；不是交付承诺 |

若用户在后续明确批准实施，建议按下列可审查批次推进，而不是直接全量改共享入口：
1. 先冻结首用bootstrap、计划/权限/金额/重试契约；同一矩阵包含首用及撤销，不再靠用户转发零散反例。
2. 做用户真实任务首轮bootstrap与逐attempt验证，及正常输出预算；不得伪造当前Key已验证，不能偷偷发Hello。
3. 接通DSH每步模型选择和组合工具，持久计划/步骤/引用与结果检查。
4. 接通个人一次授权/撤销、真实PG隔离、预算/重试/媒体名额；所有恢复计数持久化。
5. 独立安全测试通过才开启系统自动Python。PT已确认契约的媒体恢复分支才开放；未知受理支路保留，不宣称零费用。
6. 默认聊天框真实点击/上传/下载/刷新/重开、真实模型与费用验收后，统一冻结候选并另行发布。

当前只能继续审计和文档，以上不是派工指令。不能单独隐藏按钮、放大token就称完整AUTO交付。

## 9. 各开发线文件边界

| 线 | 边界 |
|---|---|
| Codex主程 | 共享server.cjs、app.js、persistent-runner、模型/任务/权限/数据库/发布接线；只在隔离集成树审核后合并；当前暂停产品实现 |
| Bug作者 | fix/bug-batch3-complete-20261106历史交付059a119；不得覆盖主程后续首次连接不可变发布实现；新问题先分诊后派修 |
| Gemini | fix/web-04-revision-20261109历史04交付5e559ec；01–08候选/修订证据保留；不让其重复开发选择器或擅动共享入口 |
| 程序员A | C01 Excel原地编辑，09/03接口；形成复审结论后再C03 PPTX固定版式。不得把任务书状态写成已开发 |
| 程序员B | C02 Docling解析后端，02接缝；先原生/已有解析差分与M0，不覆盖当前文档链 |
| C01/C02/C03 | 文件在claude10个包/可下发任务包；A/B独立分支成果需重新核对，不预先宣称纳入R34，无生产权限 |
| QA | 黑盒同版本验收；不改代码、不部署；官方实扣和本地估算分开验收 |
| 共享主目录 | 原有29 tracked dirty/332 untracked不得清理、打包或全量提交；新交接副本属于本轮明确授权新增 |

## 10. 下一会话验收清单与停止点

- [ ] 指定socket实际存在且连接成功；必要时请用户在相同本机环境重新连接，不擅自清理。
- [ ] 确认14:02:27时区，按目标user查两个候选窗口。
- [ ] 上传/核SHA/执行只读审计；核实际服务、配置、nginx、scope和Key分组。
- [ ] 找到真实Run及MEDIA_RESULT_NOT_AVAILABLE/RUN_TOOL_CALL_LIMIT是否确实记录；区分R33/R34与两次Run。
- [ ] 核媒体操作是否受理、task_id、发布结果、预算具体上限与工具次数；无凭据/计费推理调用。
- [ ] 填完限制清单的“线上实际值”与按scope可选模型，注明缓存vs实时、当前vs历史。
- [ ] 向用户逐项回答原三部分，并保持方案未开发状态。
- [ ] 如果因权限/日志不足无法确认，明确缺口，不猜根因，不主动修复或上线。

停止点：当前无后台开发、无在跑部署、无付费调用；公网检查完成，私有审计阻塞于工具环境缺指定SSH socket。下一会话从连接与只读取证继续，不重跑小验证、不重复部署、不复述旧规划当新进展。
