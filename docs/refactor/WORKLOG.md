# 北极星一期重构工作记录

2026-10-29 AUTO 闭环：先前路由前失败定位为手动成功 Run 未写回当前 scope/revision/adapter 的运行验证。新增严格写回，相关31项离线回归PASS；真实同版同临时账户手动Run `ca0a9a93-f169-422e-8057-a4bc463bc93f` completed并写入验证，AUTO Run `7d990fef-7515-4643-a36a-2a9fa2473181` completed，解析到已验证模型，预算1模型/0工具/0重试，历史可见。无mock，Key进程退出/临时加密库移除。见 `evidence/F1-live-auto-product-20261029.md`。r11旧归档不含新代码，须新修订冻结；目标机仍未验。

2026-10-29 AUTO 续测：用户重新授权既有 Key 余额；单次 `agent-auto-r1` 本地真实产品 Run `32c1b6f8-a12a-429b-b947-196a5ceaa686` 在路由前失败 `NO_ELIGIBLE_MODEL`，reasonCodes `CAPABILITY_UNKNOWN`/`RUNTIME_UNVERIFIED`，无模型选择、回复或可证实付费请求。Key 进程退出且临时加密库移除。手动 A→B 的成功 Run 未转成绑定当前 scope/revision/adapter 的持久验证，AUTO 按设计拒绝；见 `evidence/F1-live-auto-preflight-20261029.md`，需补可信验证写回后再测。

2026-10-29 交付包补证：用户已将 PT 资产上传桥 R2 包转给 Gemini；主线不编辑其独占文件。冻结 r11 SHA `0c8fd82cfaac5c13c5c20e2e475a9f76cb37a085096f2238c2cc62ba051e75a1` 解包后，macOS 本机实体依赖三项业务回归 3/3；Linux/amd64 Node22 一次性容器重新解包、干净 npm ci --ignore-scripts 后同三项 **3/3 PASS**。最初本机软链接触发 DSH_ENTRY_UNTRUSTED，实体安装布局后通过。证据 `evidence/r11-archive-business-20261029.md`。尚待 R2 主审及产品接线、真实图生视频、目标部署回滚；r11 非可部署包。

本文件是 Codex 开发过程记录，**不是正式《北极星总文档》**。用户于 2026-10-16 授权从 T00 开始；正式总文档在整体验收后由用户根据实际结果发布。本记录及本地 v1.11 不取代正式总文档，不提前宣布任务包 D 或旧架构修订稿作废。

### 2026-10-29 F2同版真实CSV产品链

真实PT文本模型在本地产品入口对合成CSV `amount\n0\n2\n2\n` 完成已确认列预览与一次csv_analyze工具调用，Run `70a6a87a-e740-4cbf-ac08-991904bec522` completed；导出CSV解析sum=4，GET200/hash吻合、匿名401、历史可重开，预算1工具/2模型/0重试。无传输mock，临时Key进程与加密库已清理，见 `evidence/F2-live-csv-product-20261029.md`。合成样本不能代替目标用户文件/浏览器/目标机验收。

### 2026-10-29 r11真实文生视频产品复验

显式单次授权文生视频Run `54336668-9c1e-4df5-9e78-90108fc90b02`：PT外部task成功，Run completed，托管MP4 2,030,749字节SHA256 `c2da40eeaeaf8372233098851bb9c95cc3a1d9b6aad6241ecda848c29b77825f`，登录态GET200/hash吻合、匿名401、历史同一本地URL；预算1工具/2模型/0重试，临时Key进程退出且临时加密库已清理。见 `evidence/F1-live-agent-20261029-t2v-r2.json`。确切r11归档在Linux/amd64 Node22.23.4干净tmpfs npm ci后生产闭包472包/30,091文件PASS，日志 `evidence/r11-linux-node-20261029.log`；未执行归档内业务测试。无画面语义人工核验；图生视频、同版CSV/AUTO/费用、目标机部署/回滚仍缺。

### 2026-10-29 文生视频远端成功后的产品失败与 r11 修正

真实同版受控文生视频只提交一次POST，PT任务 `task_rG4FqFS5NyefXXurkTdCz8H5Mi0HfM0K` 已成功；原Run `d0b913f6-23da-4f08-80bf-d5fe75f66015` 的外部操作为succeeded，但本地结果主机不在当时资产白名单，托管媒体为空，r10把Run误标completed并保留模型已展示话术。只读GET任务状态确认成功及结果主机，未再提交。r11对显式媒体任务在写入/推送成功答复前要求唯一成功media_route及同Run托管URL；缺失时Run failed、历史固定提示核对外部状态、禁止自动重提。离线独立门禁、四媒体HTTP/锁定SDK、活动归档绑定3/3 PASS；非沙箱全量217套件211/6（6项旧候选/lock来源绑定失败）；r11 SHA `0c8fd82cfaac5c13c5c20e2e475a9f76cb37a085096f2238c2cc62ba051e75a1`，381成员/180绑定源码，构建与审计PASS。尚未证实真实视频本地托管、归档Linux业务测试或目标部署。Gemini上传桥R1主审阻断，R2独立包已备，主线不接入R1。

#### 2026-10-22 当前候选：candidate-17

PT技术团队确认 `supported_endpoint_types` 是可信任务能力映射：`anthropic`、`openai`、`openai-response` 表示聊天，`image-generation` 表示图片生成，`openai-video` 表示视频生成；不再要求逐个模型人工确认类型。规范化器原已采用这五项映射，本轮新增直接回归断言覆盖五类及非隐式能力；`node --test tests/regression/model-capabilities-review-test.mjs` 7/7 PASS。候选-17代码包与 unit 未变化，SHA-256仍有效。部署清单第4步安装、第6步切换及回滚命令块已增加 `set -euo pipefail`，避免粘贴执行时前序失败仍继续；此文档改动不影响候选包 checksum。

本轮 T15–T18 独立审计又发现候选-17上传步骤引用打包者绝对路径、服务器 checksum 未自动失败、解包目录存在时仍可能继续。已改为维护者下载目录 + 本机自动 SHA 校验，远端 `sha256sum -c`/gzip/tar 检查与 awk 门禁，解包命令块加入 `set -euo pipefail`。对真实 candidate-17 归档清单运行同款 awk 检查输出 `SQL_MIGRATION_FILES=19`、`FORBIDDEN_PATHS=0`、`APPLEDOUBLE_PATHS=0`。后续复核发现 `/healthz` 还需断言 JSON `ok===true`（HTTP 200 的错误体不能通过）；第5/6步与回滚已改为curl + Node JSON断言，增加5秒连接/15秒总超时，并以合成正响应验证 `HEALTH_OK=true`。解包目标改用排他 `mkdir` 消除检查与创建之间的覆盖竞态。最终独立复核通过，8个bash命令块均经 `bash -n`，`git diff --check` PASS，候选包和unit hash未变；目标部署与真实Run仍待外部执行。

最终独立复核已确认清单第1–6步的校验、fail-fast、排他解包和限时 JSON health 门禁闭合；8个 bash 命令块通过 `bash -n`，归档 awk 输出和 SHA 均与候选一致。维护者可按编号清单执行，但未授权 Codex 远程部署，也没有目标机回传。

#### 等待产品/业务一次性确认

① Key替换/撤销遇到在途Run：等当前Run完成、旧进程退出，还是立即取消；账户禁用的授权角色与受审计入口。② T08代表性图像/音频/视频样本、答案/拒答标准及分类型验证额度。③ T09试点文件、可信计算答案、原件与派生内容保留/删除边界。④ T13 Skill发布/禁用授权；T14联网域名与来源展示要求；T17外部依赖矩阵责任人/来源与失效处理。相关能力保持fail-closed或未验收，收到输入前继续推进独立本地工作。

#### 2026-10-22 后续并行审计与线上 CI 状态

主 agent 重新检查 GitHub `tjj1234/pt-test`：公开 API 显示 `main` 为 `a2adbee64c326653dbf5bfed3f918dd09f96589d`、`protected=false`、required checks 关闭且列表为空；最近 workflow run #95 (10/16) failure，早于当前拆分的 PostgreSQL job；本地 HEAD `b09b1e1` 没有 hosted PR run。分支保护专用 API 返回403，但 branch endpoint 已明确报告未保护。`.github/workflows/ci.yml` 仍是未提交本地改动，不能声称 hosted CI 已验；T15 门禁继续未通过。

T02 只读审计证实 `api_keys` 覆盖后，DSH 进程仍仅按 tenant 复用并持有 spawn 时 Key；heartbeat 也不核对 credential generation。用户决策未回前，不实现会隐式决定在途 Run 撤销语义的进程切代。T05 审计确认 raw BYOK 由 `dsh-adapter.cjs` 注入 child，当前 DSH provider 依赖该 env；真修复需 host-owned OpenAI-compatible gateway、每Run额度/权限绑定及 OS 出网隔离，仅删除 env 会破坏聊天路径。T13/T14 不能在缺发布授权/域名/网络边界契约时开放；T17 无决策本地子切片已新增三份 candidate lockfile 字节哈希与锁定版本清单，见 `evidence/T17-lockfile-endpoint-provenance-20261022.md`，T17/AC23 仍 incomplete。

PT 技术团队新确认的 supported_endpoint_types 映射已通过独立代码审查落实。复核发现 textChatQualificationMaps() 原先为每个静态目录 ID 人工覆写 textChat=true、文本 I/O 和聊天 endpoint，可能覆盖可信字段的图片类型或显式聊天否定；已移除合成任务/模态/endpoint override，仅保留确认启用的 localPolicy 与 adapter 登记。model-capabilities-review-test.mjs 6/6、受控单 POST 1/1、归档只读 UI 25/25 PASS，详见 evidence/T06-qualification-override-20261022.md。candidate-16 因该资格绕过作废。

candidate-17 在 candidate-16 的冻结归档基础上更新 shell/server.cjs 与 shell/public/app.js 后以 USTAR 重封。archive SHA-256 480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964，unit SHA-256 a5abf2112af069331c621232ea50033c0b30e5ef08ff50280bf0b15dd0fb8869。主 agent 与独立只读复核确认 318 members、全 USTAR、0 PAX/GNU extension、0 AppleDouble/禁用路径、19 migrations；package 中 server/app 与工作区 2/2 匹配。清单另加 Node ≥20.6、r5 service/health 基线、checksum 强校验和迁移预检；只有所有检查通过才单独备份 unit。一次验证 URL 使用 ?northstarNoChatRetry=1，关闭前置 ACK 丢失时的第二次 POST；若唯一 POST 收到响应头前失败，必须记 unknown/manual_check、禁止重发，并按用户/对话/时间核对唯一 Run/provider 计数。维护者唯一有效清单为 candidate-17 部署命令清单，candidate-02至candidate-16均作废。

修复既有审查夹具与契约：旧 schema 测试直接构造历史 session，不再调用依赖新 disabled_at 列的当前 login repo；能力样例改用可信 openai 和真实 adapter endpoint；UI harness 修复中文 URL 路径、带 query 的模型目录响应、select options、详情覆盖和选模上下文。全量默认回归在允许 loopback 的环境下 node scripts/run-regression.mjs 为 117 suites / 117 PASS；沙箱内同命令曾因 loopback EPERM 产生环境失败，提权复跑后全通过。此结果是回归套件证据，不提升 T00–T18 或 AC01–AC24 的整包状态。candidate-17 尚未交给目标机执行；线上资格字段与唯一真实 Run 尚无回传。

#### 2026-10-22 当前候选：candidate-16

用户确认 `/v1/models.supported_endpoint_types` 可直接可信映射：`anthropic/openai/openai-response`→聊天，`image-generation`→图片生成，`openai-video`→视频生成。复核 candidate-12 时发现仅有 `supported_endpoints` 别名也可能使 AUTO 合格；candidate-12作废。candidate-13的映射隔离通过独立审核，但首次候选未在手动router二次检查 endpoint compatibility，且unit Description错标为Candidate 12；candidate-13/14不应部署。当前实现把 endpoint compatibility 作为每个任务状态并由手动与AUTO router共用；手动不匹配明确返回 `ADAPTER_ENDPOINT_MISMATCH`，`server.cjs`与UI也呈现具体错误。直接定向测试 **37/37 PASS**，包含真实HTTP/PGlite对手动端点不匹配的拒绝与错误文案验证；旧模型目录回归 **66/66 PASS**，`git diff --check` PASS。

candidate-15 的独立复核曾通过，但随后新增 T10 FIFO 阻塞缺陷使其作废。candidate-16 从该冻结包仅替换 `shell/runtime/artifact-open.cjs` 并更新 unit 版本标识，纳入非阻塞打开特殊文件后再由 `fstat` 拒绝的修复。candidate-16 归档 SHA-256 `c4d5133b057fc65a1298a0977ba5b28a10672486ba065319eaecc8aba47b1431`，unit SHA-256 `468190ada69a15777c0d623ff901408722f6029ac3673c51a70e0d56f4a0c3e8`。本地与独立只读审计通过：318个USTAR成员、0 PAX/GNU扩展、0 AppleDouble/禁用路径、19 migrations；PT确认的 `supported_endpoint_types` 能力映射与 `openai-chat-completions` adapter配对均与代码一致。T10 定向回归8/8 PASS；目标Linux仍需复验。唯一维护者清单：[candidate-16](北极星受控试运行部署命令清单-20261022-candidate-16.md)，candidate-02至candidate-15均作废。本次仍仅切shell，analytics保持现有r3，business/attribution不切换。尚无目标机资格字段或真实模型回复，不改变T06/T07/T03/T10或整包验收主状态。

#### 2026-10-22 candidate-16 全量回归与 T15 PostgreSQL 门禁

隔离全量回归 `node scripts/run-regression.mjs` 共 **116 suites，111 PASS/5 FAIL**；五项均为 independent review fixture 与当前 schema/可信能力/UI `/api/models` 响应契约不一致，逐项归因及边界记于 [`T15-local-ci-execution-20261022.md`](evidence/T15-local-ci-execution-20261022.md)。因此没有全量回归通过结论，也未将失败计为 candidate-16 文本资格链路的产品代码缺陷。T15 PostgreSQL 16 隔离门禁经批准在沙箱外重跑 **3/3 PASS**，临时 localhost/tmpfs 容器已停止、移除；hosted Actions、required-check/branch protection 与 T15/AC 其余验收仍待证明。candidate-16 checksum 未变化，包内能力归一化文件 SHA-256 与当前源码一致。

T16/T18 独立只读复核发现 candidate-16 清单需加强目标侧 preflight：切换前核验当前 systemd ExecStart 确为预期 r5、EnvironmentFile 存在且可读；通过候选包 `openPg()` 只读比较 `schema_migrations` 与包内19项迁移，只有完整一致才允许备份/替换 unit，以免服务启动在未知 schema 上执行 migration。该检查已加入 candidate-16 清单第5步；不改候选包字节或checksum。仍没有目标机部署、数据冷备/恢复、真实DSH及应用升级回滚证据，T16/T18和AC19/20/24保持原状态。

#### T08/T09 试点输入与 CSV 文档链路复核（2026-10-22）

独立只读复核当前 T08/T09 与 AC08–10/21：聚焦组由 `CSV parser/source/analysis` **22/22 PASS** 与 `document HTTP` **1/1 PASS** 组成，合计23/23；`northstar-t08-upload-to-runner-jsonl.mjs` PASS（14项摘要断言）。TXT/MD 已保留 UTF-8 源字节范围、总长度和截断边界；CSV 计算器有精确十进制与歧义拒绝逻辑，但尚未进入真实 chat/Run/UI 闭环。未发现能在现有产品契约下安全认定的本地缺陷，因此不扩写支持格式或猜单位/地区规则。T08仍为untested（附件输入子范围partial），T09仍partial，AC08/09/10/21仍untested。外部待办单列：T08需代表性真实/语义真实多模态样本、标准答案/不可识别区域标准、当前 key 有权限且有额度的 image/audio/video endpoint；T09需试点文件/答案样本及原文件/派生数据保留与删除边界。该探针是loopback/in-process fixture，不含真实provider或socket级外连监测，不能抬升任务状态。

#### T00 契约与任务存储当前复跑（2026-10-22）

主 Agent 复跑 `node --test tests/regression/phase1-contract-test.mjs tests/regression/phase1-contract-review-test.mjs tests/regression/task-store-test.mjs tests/regression/task-store-review-test.mjs`，**40/40 PASS**。范围包括契约反例修复、身份/事件语义、幂等冲突、持久任务状态与恢复；存储部分依赖 PGlite/本地夹具，不证明真实 PostgreSQL、服务入口全部契约调用、跨进程或生产部署，因此 T00/T01 与整包状态不变。

#### 2026-10-22 PT endpoint 可信映射与 candidate-11

用户确认 `/v1/models.supported_endpoint_types` 的可信能力语义：`anthropic`、`openai`、`openai-response` → 聊天；`image-generation` → 图片生成；`openai-video` → 视频生成。`shell/models/capabilities.cjs` 据此按精确枚举值推导任务和对应文本 I/O，并记录来源字段；未扩展其它端点值，也不推导音频/理解类任务。显式 task=false 保留优先级，显式冲突模态仍会阻止资格；PT endpoint 类型与本地 OpenAI-compatible Chat Completions adapter 分层匹配。`shell/model-catalog.cjs` 仅给确认的聊天端点补动态 chat adapter，手动路由可在 permission、policy、任务和 I/O 均通过后放行并标记 `verificationRequired=true`；AUTO 仍要求运行时验证。定向回归 **36/36 PASS**（能力、目录同步、手动/自动 router、旧展示目录），`git diff --check` PASS。

基于冻结的 candidate-10，仅替换归一化与目录同步两处运行时代码，重新生成 candidate-11。归档 SHA-256 `ff8ec33e28a6db964658dbf87576b495fe1e6dec91df7110967163604132bc53`，unit SHA-256 `10dfe7741f98980eb8e09abf2b0609e1b8471e6da12155042cca47fe419942b4`；审计 318 members、19 migrations、0 PAX/GNU 扩展头、0 AppleDouble/forbidden paths，包内两处能力文件与工作区字节一致。维护者当前只应执行 [candidate-11清单](北极星受控试运行部署命令清单-20261022-candidate-11.md)，candidate-10 已加作废提示。尚未部署、尚未看到维护者输出、尚未进行目标机资格核验或真实模型 Run；既有一次验证额度仍为1次请求/0重试/0工具/180秒，Phase 1 严格验收状态不变。

复核后撤销 candidate-11：endpoint compatibility 曾从 `supported_endpoints` 别名取得任务映射，超出用户确认可信字段范围。当前资格逻辑新增独立 `ptEndpointTasks`，仅由 `supported_endpoint_types` 派生并计入 capability revision；测试补充别名字段不得单独使 AUTO eligible。另经部署清单独立审查，明确本次只切换 shell，analytics 保留 r3 服务，business/attribution 不部署，避免归档含三组源码但 unit 仅切 shell 的歧义。candidate-12归档 SHA-256 `31f7683321654ef09f5c20ff0307886211b8028b7dc9096e4c37f5a0044524ed`，unit SHA-256 `cfeff4a288ff4472d6e0679285edbd27ccada14cdfe3c0a7ece7b1df3d44aead`；318 members、19 migrations、0扩展头/AppleDouble/禁用路径，包内能力文件与当前工作区字节一致。部署清单：[candidate-12](北极星受控试运行部署命令清单-20261022-candidate-12.md)；candidate-10/11均已加作废提示。端点资格定向测试36/36 PASS、`git diff --check`通过；尚未部署或发出模型请求。

独立切片审查：T03新增production UI pre-header ACK loss回归1/1：代理在真实`/api/chat` admission后、UI收到headers前断开，生产`runChat`用相同body/key重试，确认同Run ID、fake runner一次、完成及单轮历史；审查通过，详见`evidence/T03-preheader-ack-loss-ui-20261022.md`。另一既有HTTP用例覆盖headers后SSE断开。边界仍为真实浏览器/provider/PG未覆盖。T04 cancel+sibling lease 测试新增 barrier期间 `cancelling` 和 lease释放前 `cancelled`+仍由A持有的确定性断言，指定PGlite测试1/1 PASS；仍不等同真实PG多连接与真实DSH。部署清单独立审查确认candidate-12的归档/unit checksum、USTAR、318成员、19 migrations、预算1/0/0/180秒及旧候选作废提示均一致。

## 2026-10-19 续接：T07 预算与最终候选绑定

### T03 最短TTL、慢取消与双HTTP/真实PG SSE

独立审查实际复现三处缺陷：TTL1000续租周期过晚；remote cancel在heartbeat等待executor收尾导致两层租约过期；未来observer cursor污染共享水位。主Agent修 `execution.cjs`：周期为TTL/3且最小100ms、heartbeat异步发cancel继续保活、不用observer after提升共享publishedSeq。修复前反例FAIL、修复后新增独立4/4与既有execution/queued联合6/6 PASS。

最终资源收口：heartbeat对同Run只发一次cancel，避免慢收尾每tick给同一未settled Promise追加回调；该小改在PG验证后完成，最终PGlite/observer/execution/queued/store/review联合 **15/15 PASS**。不把PG的TTL3000测试写成TTL1000/慢cleanup极值已真实PG验收；后两者的证据来自真实PGlite/store。

Docker Desktop本轮启动成功，临时PG16容器仅localhost动态端口+tmpfs，无宿主volume/依赖安装；两个独立库验证。既有Run lease与新增conversation/真实锁等待/heartbeat/cancel专项Node汇总5/5 PASS；主Agent新增两个真实HTTP服务+独立writer pool的SSE测试1/1 PASS，marker→实时live→terminal屏障排除replay假阳性，未来cursor不干扰正常观察者，重连仅取后续事件。测试流/启动均有总Abort deadline和finally清理。代码交叉审查PASS，证据 `evidence/T03-heartbeat-sse-postgres-20261019.md`。验证Agent已精确删除专属容器并复核No such container，两个tmpfs测试库随之释放；Docker Desktop与镜像缓存保留不擅删。无模型/工具付费请求，T03整体与真实浏览器/生产故障恢复仍未验收，全部未提交/推送/部署。

### T16 配置升级、覆盖层门禁与干净 CLI 发布子集

三子Agent持续分工，主Agent接线。新增 `settings-upgrade.cjs`：仅tracked、未修改且旧baseline配置hash等于旧template hash的纯模板允许显式离线升级；已adopt定制配置也拒绝整模板替换（独立反例发现后修复），必须人工merge/adopt。旧配置/基线独立复制保存，双文件发布有journal，部分失败明确要求恢复；rollback校验journal hash、四文件hash和当前pair仅属old/new，支持故障重试与真实进程退出后的dead-owner token恢复。CLI接upgrade-settings/inspect-settings-recovery/rollback-settings；不做静默覆盖或在线升级。

主Agent新增bootstrap-policy：冷spawn拒绝home/workspace `.env`、home `cordis.patch.yml`、home/profile局部node_modules及pending settings journal；lstat拒绝包括dangling symlink，访问错误fail-closed，不读配置内容、不删除文件。检查发生在makeProfile之后、日志/child之前。shared profiles/node_modules、祖先解析路径、已安装依赖闭包及OS沙箱仍未闭合；存活runtime复用不重新加载这些层，不保证对同uid绕锁写者隔离。

最终12文件联合 **55/55 PASS**（settings升级/CLI/版本、bootstrap、profile及真实ready）；settings与bootstrap独立28/28，独立CLI升级与故障回滚通过。`tests/probes/northstar-clean-release.mjs --online`在/private/tmp选择性发布源码中用npm ci禁install scripts完成安装，DSH主包20文件完整性及空home真实CLI ready/idle通过；没有复制node_modules/真实runtime/env，没有模型/工具任务。最终probe含signalCode断言已由主Agent再次在线完整运行PASS；默认offline仍ENOTCACHED，不能宣称离线重建通过。probe清理隔离release/HOME/profile/logs，宿主项目依赖未变；复用宿主npm cache可能新增缓存，Docker后续用于T03验证属另项。此为CLI发布子集，不是完整HTTP/静态UI打包，也不是全部依赖逐包完整性校验。T16整包仍不通过，未提交/推送/部署。

### T16 生产 profile 发布输入与 settings 审阅基线切片

用户再次明确要求子 Agent 持续工作，本轮三人分别负责 profile 依赖模块、settings 版本模块与独立审查，主 Agent 接 Adapter/维护CLI/真实CLI夹具。`profile-dependencies.cjs` 从 shell lock 提取精确 bundle version/resolved/integrity，原始 lockfile 与 `.npmrc` 摘要写入受管 profile 文件；配置与摘要变化触发现有 stale/rebuild 门禁。独立审查发现非法 SemVer 与 SRI 长度仍被接受，已修复并补反例，专项7/7 PASS。

`settings-version.cjs` 提供只读 inspect 与显式 reviewed+三个expected hash 的 adopt，CLI新增 `inspect-settings/adopt-settings`；不改 settings YAML，不自动确认、不把adopt当迁移、不接启动阻断。旧基线备份，发布失败可重试，未知/损坏/不安全元数据拒绝。独立审查发现额外字段可能泄露以及null基线TypeError，已改严格四字段schema并补反例。settings模块7/7+CLI2/2 PASS。维护命令、状态优先级及故障边界见T16审计。

最终交叉复核追加关闭日期解析接受秘密注释和hash数组强制转换：日期仅接受自身生成的canonical ISO，hash严格字符串；独立9/9复验及额外日期/数组夹具均PASS，临时夹具清理。独立审查结论为本切片PASS，无剩余切片阻断；不扩大为T16整包验收。

真实 CLI 测试去掉人工profile/node_modules软链，验证DSH自身共享fallback可启动，并补protocolVersion与三项capability断言。最终9文件联合 **36/36 PASS**；parent RPC另10个断言PASS（实现者外实例验证）；`git diff --check`及共享接线语法PASS。分支/完整HEAD仍为上文值；无安装依赖、无真实模型/工具付费调用，测试临时目录已由夹具清理，全部未提交/推送/部署。此切片仅关闭发布输入记录与settings审阅状态缺口；已安装依赖闭包、实际配置迁移、干净发布重建、OS隔离及生产升级回滚仍未通过，T16不标整体完成。

### 断线后现场恢复与 T16 入口证据补录

断线后重新核对分支及完整 HEAD，仍为 `feature/northstar-phase1-refactor-20261016` / `b09b1e13720cd16cd7538999d4c63386920b367c`；大量未提交实现、证据和 `wb copy/` 均在。`git diff --check` PASS。无法仅凭现存文件证明断线瞬间所有内存任务的结果，故重新运行聚焦验证，不沿用未落盘的通过状态。

发现已有 `dsh-installation.cjs`、release manifest、manifest 生成脚本与 adapter 接线尚未记入 T16 审计。现仅接受仓库 packaged DSH；显式参数或 DSH_JS 不匹配立即拒绝，不回退全局安装。启动前验证固定版本、完整文件集/hash、vendor SHA-256/npm integrity、精确 shell lockfile hash、路径 owner/mode 与 symlink；host 验证结果进入 runtime 返回证据，不冒充 child 自报版本。完整依赖闭包仍不在已安装文件验证范围。

本次重跑：installation/runtime-release/manifest/CSV parser/source/router/model-snapshot 七文件 **52/52 PASS**；profile 路径/lifecycle/维护CLI/失败前置/真实DSH ready 五文件 **18/18 PASS**。真实 CLI 使用隔离临时 profile，不发模型或工具请求；测试夹具清理其临时目录。未提交、推送或部署，T16 整包不通过。下一步优先固定生产 profile 的精确依赖闭包及 settings 版本迁移，再做干净发布重建；真实PG、多实例SSE、Google/PT和生产验收缺口继续保留。

现场核对：分支 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`；10月18日大量实现仍未提交，保留全部既有文件及 `wb copy/`。本轮串行推进，不调用子 Agent，不提交/推送/部署。

复核发现旧 router 要求在候选选择前传入已消费的 admission，无法绑定最终模型估价，且无合格候选也可能消耗额度。修正为纯 `routeTextTask` 只选候选；新增 `admitTextTask(input, { budget, estimateCost })` 在选定模型后取得该候选估价，再调用既有 budget.admit 一次，返回 admission 由执行方 settle。手动不回退、未知能力拒绝边界保持。聚焦回归 `node --test tests/regression/task-router-budget-test.mjs` 3/3 PASS；覆盖拒绝候选零消费、候选估价绑定、预留/结算、调用额度和未知费用拒绝。未接 catalog/server，不标 T07 或 AC05 通过。

下一工作项仍为 T16 父路径信任与显式 rebuild/recovery，再串行接 T07 对话级偏好、T09 CSV 来源契约。T16 审计仍明确列有未关闭阻断；本轮没有把静态审查当生产打包验收，也没有真实 PG/Google/PT/浏览器/部署证据。

### T16 路径、显式升级与恢复切片

本轮用户明确要求子 Agent 持续分工：一个实现 lifecycle，一个独立复核 T07，一个独立复核 T16；主 Agent 负责路径模块、Adapter、离线 CLI 与集成。T07 独立审查发现 null 候选准入抛错和异步估价 rejection 导致进程退出，均修复并补反例，router **6/6 PASS**。T16 新增 `profile-paths.cjs`、`profile-lifecycle.cjs`，Adapter 接入 make/rebuild/recover，维护入口 `scripts/northstar-profile.cjs`；POSIX 父路径/文件 ownership 和写权限检查、settings exclusive 发布、staging/backup/journal、显式恢复已实现。独立审查另发现 managed 文件可被 group/world 写、journal 创建但尚未备份时无法恢复，修复后路径+生命周期 **15/15 PASS**。CLI 回归 **1/1 PASS**；宿主RPC **10 断言 PASS**；真实隔离 DSH CLI ready **1/1 PASS**，无模型/工具调用。旧RPC夹具依赖缺失settings继续启动的历史行为，现按fail-closed契约改真实模板；非法协议manifest明确报MANIFEST_INVALID。

最终集成追加：reviewer 发现 profile 拒绝发生于日志FD打开之后，重复拒绝会泄漏FD；已将 profile/env/identity 校验前移，独立回归1/1 PASS。联合命令 `node --test tests/regression/profile-paths-test.mjs tests/regression/profile-lifecycle-test.mjs tests/regression/profile-maintenance-cli-test.mjs tests/regression/profile-startup-failure-test.mjs tests/regression/dsh-cli-profile-ready-test.mjs tests/regression/task-router-budget-test.mjs tests/regression/task-budget-provider-test.mjs` 最终 **33/33 PASS**；另 parent RPC **10 断言 PASS**。所有新增/改动实现语法与 `git diff --check` PASS。reviewer 自建临时目录已精确清理，未修改真实DSH_HOME、未安装宿主依赖。

所有维护要求先停止使用同home的runtime；`--offline`是操作者声明，不是进程自动检测。无owner空锁需人工核实，未实现fsync断电持久性、同uid敌手隔离或Windows ACL，均不标生产安全完成。更新 T16 审计包含命令与限制。分支/HEAD未变，全部未提交、未推送、未部署。下一切片：T07 对话级模型偏好与执行链接入，其后 T09 CSV 来源；T16 的实际DSH入口/依赖锁、settings版本迁移和干净发布重建仍需收口。

### T07 对话偏好、排队快照与路由接线（限定验证通过）

三个子Agent分别承担对话存储、catalog接线/独立复核、HTTP/UI独立验收，主Agent串行修改server/UI/chat-request/store。migration018新增对话`model_preference`；新建对话快照用户默认，旧null首次读取COALESCE绑定；带conversationId的模型API仅影响该对话，不带ID才修改新对话默认。UI切换会话重载模型，拒绝迟到GET/POST污染当前视图，模型加载与保存期间禁止发送。manual/AUTO统一走纯routeTextTask能力、权限、policy、适配、可用性门禁。catalog显式availability仅来自成功scope快照，静态fallback不授予资格；独立反例发现fresh/backoff缓存未即时应用权限撤销，已修并独立复验。

新提交请求以schemaVersion3持久化服务端modelSelection快照，排队执行读取原选择，再核验资格，手动不静默换模型；requested/resolved与未知upstream记录在Run state(action=model_selection)。合法v3先完整canonical校验再剥服务端metadata计算v1/v2兼容幂等指纹，附件证据不剥。实际HTTP验证改偏好后同键仍返回原Run、零重复执行/消息；改消息409。queued恢复纳入v1/v2/v3并保留external operation防重提条件。旧v1/v2无历史模型快照，按执行时对话偏好兼容；模型准入/费用尚未接统一runner预算，不标T07整包或AC05通过。

验证：store独立1/1；catalog独立8/8；router独立6/6；真实HTTP+PGlite偏好/重启/queue/幂等独立1/1；模型UI43断言、对话UI43断言PASS；受控Google/HTTP既有集成1/1（loopback沙箱EPERM后授权重跑通过）。核心联合回归43/43 PASS（snapshot/attachments/conversation/catalog/router/queued/store/execution/CSV parser/source），命令见本轮工具记录。独立证据`evidence/T07-conversation-model-20261019.md`。均无真实Google/PT/供应商模型调用，不等同生产PG/浏览器E2E。

### T09 CSV 来源上下文（限定验证通过）

CSV parser已补7组反例，发现Buffer路径TextDecoder和parser重复剥BOM导致内容丢失，修复ignoreBOM后独立7/7 PASS。新增csv-source纯模块，按原bytes/hash+ref hash+RnCn绑定来源、保空值/0/多行物理坐标、不推断header/type；只序列化完整cell前缀并标总量/省略/首个省略坐标，品牌+深冻结拒绝伪造source。独立parser/source14/14 PASS。server上传时拒绝非法CSV；读上下文检查租户/realpath/symlink/no-follow/inode/size并有界读取，对比原capture，失败明确拒绝。当前来源metadata进attachment.status，文本上下文带版本与坐标；不宣称答案引用已校验或可点击来源UI完成。

独立审查发现context失败发生于消息保存之后，现已前移至normal/regenerate/branch首次写历史前，拒绝不再留下悬空user或截断旧历史；事件写入错误不吞。另补原用户消息documentEvidence供再生/分岔复用原版本，新旧合法内容变化也必须拒绝；遗留无snapshot文档再生显式DOCUMENT_SNAPSHOT_REQUIRED，不能以重传同URL伪造历史版本。受控CSV HTTP独立最终1/1 PASS（上传、原bytes、空/0、坐标/截断、跨租户、失败历史保留）；原文件未变再生成功，同长度合法CSV变更后regen/branch精确CHAT_ATTACHMENT_CHANGED、历史逐字段不变、runner无新增。无snapshot旧文档历史不能借当前请求evidence绕过校验。限定切片通过，证据`evidence/T09-csv-source-20261019.md`；不标T09整包或真实模型引用验收。

## 2026-10-18 最新工作区快照

### 当晚接手位置（用户准备休息时）

三个子 Agent 本轮均已交付，当前无正在运行的子任务。T07 新增 `models/task-router.cjs` 与 API 文档，限 textChat、显式资格过滤、手动选择不回退；预算复用 `budget.admit()`，会消费计数/预留，接线须先确定候选/真实估价并保证 settle，不可把它作为无副作用候选筛选。尚未接 catalog/server，未运行功能测试。T09 新增 `attachments/csv-parser.cjs`，保留空值、逻辑行列和物理位置；字节限制已前移到复制/解码前。尚未接上传/检索/UI，未运行功能测试。T08 输入契约核对已落文档：SDK 图片需 attachment ref/service，当前聊天实际只有 text block；真实 PT 图片/音频/视频理解未实现验收。

T16 首次生成已有同文件系统 staging、回读 hash、锁与 rename；独立审查确认父路径 symlink/写权限、非协作 rename 竞争、陈旧锁恢复和 staging 回收未闭环，不能据此标生产安全。T03 双租约自校验和终态持久化期间保活已改，取消跨层静态审查未见错误成功映射；最新修改未完成运行验证。

下次接手顺序：①独立复核 T07 router 的预算 admission 与候选绑定，避免错误消费/跨候选复用；②完善 T16 路径可信边界和显式恢复；③串行接入 T07 对话级模型偏好及 T09 CSV 来源契约；④在获得验证指令后补聚焦运行证据，再推进真实 PG/Google/PT 与部署验收。10月21日整体验收上线仍有明显风险。不得把静态复核或纯模块交付计作整包完成；用户文件不清理，代码不自行提交/推送/部署。

本次续接：三个子 Agent 已完成前一切片并重新分配交叉审查。T03 新增 migration017 数据库 conversation lease，正常提交与 queued 恢复在转 running 前获取租约；会话消息落库事务同时校验 Run 与 conversation 的 owner/expiry。SSE 重放使用序号水位和持久事件回补；停机在 scheduler drain 后结束残留 HTTP 响应。实现 Agent 报告串行、queued 恢复、含 active SSE shutdown 的 HTTP 集成各 1/1 通过；当前正在由未参与实现的 Agent 静态复核，不据此宣布整包完成。

T16 实现 Agent 报告补齐精确 peer 依赖后，真实 DSH CLI 在隔离 profile 到达 ready，空闲 250ms 仍存活；这只证明受控启动，没有真实模型调用或生产长时间运行证据。全部业务工具现经宿主 RPC，child 不再接收 dashboard master、tenant token 或端口；BYOK 和 OS/文件系统沙箱仍是独立边界。旧条目中的 CLI 缺包阻塞和 child scoped token 描述由本段覆盖，详见 T16/T05 专项文档。

主 Agent 已接入当前标签页的刷新恢复：sessionStorage 只保存 conversationId/runId，刷新后按 runId 回放，不重新提交 chat；终态或 401/403/404 清理记忆项，临时网络错误保留。独立静态复核未发现阻断；完整浏览器刷新场景尚未验证。另按本地 SDK 的 turn/end 契约补识别 aborted，并避免取消后已有部分文本被标为成功；这两处最新修正尚未运行验证。后续顺序：完成租约与 CLI 兼容层交叉审查、处理发现、补齐验收证据；真实 PG、真实 Google/PT、部署与整体验收仍未闭环。全部代码保持未提交、未推送、未部署。

项目整体目标为 **2026-10-21 验收上线**，工程质量第一。实际全范围状态见 [验收事实矩阵](ACCEPTANCE-STATUS-20261018.md)，当前完整验收与上线条件未获证明，日期风险很高。新增 [外部依赖盘点](EXTERNAL-DEPENDENCIES.md) 与 [T16打包审计](T16-PACKAGING-AUDIT.md) 是静态交接材料，均不等同任务完成。

T03 已把内建媒体工具改为宿主 RPC，宿主通过独立可注入的 `media-run-handler.cjs` 执行并持久化 intent→taskId→result；取消会 drain 宿主回调后再由 executor settle，避免过早释放 lease。未知提交可保 lease 写人工核查；明确未进入 fetch 的取消记录为 not_submitted，已发 POST 的未知结果绝不重提。provider worker 已接启动/停机，stop 会 drain 进行中的查询与写回；默认 pending 词表为空，未知状态进入人工核查，实际 provider 状态词表仍未验证。预算计数随 Run usage 事件持久化，配置缺省会明确记录 unconfigured，模型/内部重试/真实费用仍无完整覆盖。详细边界见 [T03增量证据](evidence/T03-rpc-provider-budget-20261018.md)。

本轮实际验证：旧store/execution/review夹具首次6/9，按新leaseOwner契约修复夹具后9/9；新增保lease人工核查覆盖后review文件8/8。预算/provider专项最终9/9（含shutdown drain），RPC受控6/6，宿主媒体生命周期7/7；受控Google/HTTP集成1/1。实现agent另报告媒体mock80/80、runtime contract26/26。均未发真实DSH模型或付费请求。真实PG验证尝试受Docker daemon不可连接阻塞，已启动Docker App但仍未获得daemon连接，未新建容器或安装宿主依赖。本轮真实PG、浏览器、多实例和生产验收均未通过。

追加进展：migration015提供每Run多个external operation，宿主与独立query worker已切到子表；逐operation查询租约不获取/清理Run执行租约。Run按未解决操作聚合waiting_external/reconciliation，取消/终态不回转；详情与独立operations接口提供租户隔离有界分页。宿主真实PGlite集成8/8含两次提交、重复intent零额外POST；ops store+worker6/6。T04 server/UI已按conversation并发/停止隔离，UI41/41、模型UI34/34；runner现按session队列并隔离turn数据，真实DSH SDK+实际runner+确定性LlmAdapter probe通过1/1，验证A媒体RPC挂起时B完成、取消隔离与热会话真实adapter模型变化；这仍非真实PT模型证据。T06目录同步已接已有能力生命周期、scope缓存、singleflight、失败退避和未知能力；无可信complete证据不下架模型，AUTO/手动执行要求已验证适配，不能以名称/endpoint推测资格。

安全追加：DSH入口发现已修为优先查找打包的shell/node_modules，仓库本地DSH bin可被找到。子进程不再得到全局dashboard HMAC master，改为宿主签发当前tenant的token；GA executor的scoped路径拒绝tenant mismatch。子进程环境24断言及GA跨tenant前置拒绝专项通过；这不代表OS/文件系统沙箱已验收，T05仍有独立安全门槛。DSH CLI boot仍受缺少`@deepseek-ai/cordis-plugin-group`阻塞，依赖锁定修复中。

当前文件归属覆盖下方历史“批0”约束：主Agent负责`media-run-handler.cjs/runtime/usage.cjs`、adapter复制/凭据隔离、集成测试与本记录；provider agent负责CLI依赖锁定与真实SDK probe；budget agent负责T11的tool-calls/016迁移/用量UI；review agent负责queued恢复的server/execution/store共享接线。各切片完成后由其他实例复核；不切分支、不清理用户`wb copy/`或任务包v1字面`x V`。全部工作仍未提交、未推送、未合并、未部署。

## 开工约束

集成分支：`feature/northstar-phase1-refactor-20261016`。起点：`a2adbee64c326653dbf5bfed3f918dd09f96589d`。T00–T18 仅在该分支实施，不合并 main、不部署。全部完成后仍须 Claude 整体验收及全新 Claude Code 完整测试，不能以 Codex 自测替代。

每次交付记录任务、分支、完整 commit hash、文件与接口／迁移变化、验证命令和环境、证据时间／ID、外部阻塞及结论。证据文档不能记录秘密，未知不能当通过。

## 批 0 文件归属（2026-10-16）

| 角色 | 专属改动范围 | 当前任务 |
|---|---|---|
| 主 Agent | 六共享接缝、集成、工作记录 | T02 集成／T01、T00收口；处理T10审查修复与集成 |
| 子 Agent A | 独立基线／验收，不改实现 | T01 Google-only存储政策独立复核完成；后续按依赖轮换 |
| 子 Agent B | 隔离模块实现，避开共享接缝 | T04纯调度已交付；开始T05 schema校验模块，尚未独立验收 |
| 子 Agent C | 独立安全／维护审查 | T10产物路径反例审查已完成；FAIL修复后复验PASS |

`server.cjs/tenant.cjs/persistent-runner.mjs/public/app.js/public/index.html/public/styles.css` 本批唯一集成人为主 Agent，子 Agent 不修改。各 Agent 不自行切分支、提交或修改他人文件。独立验收分配给未参与该项实现的实例；最终 Claude 测试另行执行。

## 当前状态

| 任务 | 过程状态 | 证据与下一步 |
|---|---|---|
| T00 | 契约与受控SDK验证通过；部署/配置基线待收口 | 契约与受控DSH SDK验证见`0e2acc83849a8203a80ed5c1cb1cd892d990eabd`；2026-10-20 新增 source-generated `run-persistent` 候选快照，preflight 9/9 且 `ready=true`（仅 offline-static-only）。仓库候选文件与当前 builder/lock/npmrc 自洽；部署机实际 profile、真实服务/网络和升级回滚仍未验证，不能据此关闭 T00。详见[`evidence/T00-dependencies.md`](evidence/T00-dependencies.md) |
| T01 | PGlite迁移与边界测试通过；真实PG/打包待验 | `cafe3b414f77ce5d4591699ea1c7378175a7b4da`统一默认迁移源、PG fail-closed及事务原子迁移；策略校正与独立审查提交`0e738384c37924e2911fc68c659ec891950e1667`；当前策略联合10/10，真实磁盘PGlite覆盖旧数据保存、旧token撤销、实际受控OIDC callback新session重启持久。真实PostgreSQL、干净打包和生产恢复未验，不标整体完成 |
| T02 | Google 登录本地集成限定验收通过；待正式配置与全链路验证 | Google OIDC底层`5ec2d442cdea1b3a5e2f3ac6c44591c61cc4d201`；集成提交`98c0411f8ec101e48ff1aff1cf6397ece0356663`，证据更新`fa91c6bcb20fdc368df7f51e855b3007f11683c8`。adapter独立验收与联合测试通过；server/UI独立集成复核3/3、绑定反例独立2/2、实现冒烟1/1；OIDC／存储聚焦回归52/52（2项loopback测试在批准的沙箱外权限重跑通过）。可信绑定同步撤销旧Session；配置及真实Google、目标HTTPS、浏览器体验仍待环境验证。证据`docs/refactor/evidence/T02-integration.md`、`T02-integration-review.md`、`T02-binding-review.md`。T02未整体完成 |
| T03 | store／执行服务及基础 HTTP 接线完成，整包仍进行中 | 接线 commit `f484924376bf01645a7f709a35631599b8c1e169`；HTTP排队取消 commit `6b72810b7cea80bf1fccb608ecf6a836688822bf`；游标重连与跨租户边界验收 commit `d77aa9e1b55bda3a90a968e8ca90d6a996955c3a`。新增 `/api/runs` 查询、事件（JSON/SSE及游标回放）、取消；旧 `/api/chat` 纳入持久 run、幂等重放、durable SSE投递与启动恢复。浏览器断线后事件续读实现于 `c579960d6b14aa2c5e7e3d7d8926a773c0326f2e`；worker lease fencing 与两个服务/连接池间的持久取消请求通过隔离 PGlite 回归9/9及真实 PostgreSQL 16 验证1/1。真实浏览器断线、生产多实例故障恢复与 queued 重调度尚未验收；预算熔断、外部 provider 查询/reconciliation闭环尚未完成，不标T03整包完成。详见`docs/refactor/evidence/T03-http-integration.md`与本工作记录后续条目。|
| T04 | 纯调度模块独立通过，真实runtime并发待实现 | `06e88e46df22cfd393e2382354dc340575438a36`；复验19/19；尚未证明DSH SDK同进程真实并发、取消收敛、事件与资源边界 |
| T06 | 能力生命周期与资格目录本地接线已实现；未部署、未证明线上可调用 | `21098eb92133f0a341f4548a23d6789cacd74ad4`；模型目录现按当前 key 的 `/v1/models` 返回 ID 设置 `permission=true`，未列出的旧模型权限未知；用户确认的 textChat policy、OpenAI-compatible adapter 与能力覆盖已接入本地候选。无当前 key 的线上目录回传、目标环境发布或真实运行验证，不标整体完成 |
| T05 | Registry Schema校验子范围 PASS；整包仍未完成 | commit `39d324dd32de9fbf39c49749f2c07798ef6677a2`；Ajv精确直接依赖、非法输入在logger/executor前拒绝、版本竞态和stale executor首验缺陷均独立复验通过（18/18）。首验FAIL→修复→PASS证据见`docs/refactor/evidence/T05-schema-review.md`。DSH直连工具桥接及完整权限/报告/沙箱仍未验 |
| T10 | 产物路径子范围修复并独立通过，整包未完成 | commit `33210cbf8a9d79b68aa9f2a39ad7a48ac65efc77`；`artifacts.cjs` 跨平台反斜杠归一化、拒绝盘符相对路径及C0/C1控制字符；实现75/75 + 边界1/1，独立反例发现DEL/NEL后修复复验通过，见`docs/refactor/evidence/T10-artifact-path-review.md`。产物归属、持久化、下载与文档包格式仍待验 |
| T07–T09、T11–T18 | 子范围 partial / 未验收 | T07 有对话偏好、队列快照、router 与候选接线；T09 有来源保护、CSV 解析及确定性聚合；其余仍按各 evidence 的范围记录。T07 首次手动候选可带 `verificationRequired=true`，AUTO 仍需运行时验证；线上 ID、真实模型 Run 与整包/AC 证据尚缺。不会以模块自测替代端到端验收 |

### 2026-10-16 · T03 执行生命周期服务子范围（过程记录）

新增 `shell/tasks/execution.cjs`，用注入式 executor 接通已验收的持久 store 与 T04 scheduler：幂等 replay 短路、串行事件持久化、终态记录、按 runId 取消并等待执行器收敛。新增真实临时磁盘 PGlite 集成测试 `tests/regression/task-execution-test.mjs`。独立首验 FAIL 抓到 rejected event tail 未终态化、晚完成与取消回执不一致两项；修复并加入反例后，原独立 reviewer `/root/architecture` 限定复验 PASS（联合测试7/7，两个原反例独立受控 probe 均闭环）。命令 `node --test tests/regression/task-execution-test.mjs tests/regression/task-store-test.mjs tests/regression/task-store-review-test.mjs`：7/7 PASS，Node v24.14.0，无外部 PG／网络／DSH／PT 调用。证据 `docs/refactor/evidence/T03-execution-service.md`。此结论仅是服务模块子范围；不宣称 T03 完成。HTTP/SSE／重连、旧 `/api/chat` 接线、worker lease 与重启恢复扫描、预算和外部 provider 查询仍未交付。

### 2026-10-16 · 前端框架评估结论

PM 同意：本期保留现有原生 HTML/CSS/JavaScript，不做全量 Vue 迁移；Vue 可作为后续渐进演进方向，优先考虑状态复杂且边界清晰的新页面（如任务中心、用量日志），聊天页须等 SSE、取消、附件和产物行为通过真实浏览器验收后再评估迁移。采用 Vue 不等于前后端部署拆分；若后续启动，可独立构建静态产物，由现有 Node 服务同源提供页面与 `/api/*`，继续使用同源 Cookie/SSE。此项为路线决策记录，不是本期新增实现承诺；若变更为一期范围，须先修订 T16、工时和验收标准。

### 2026-10-16 · T03 持久 Run 到 HTTP/SSE 的接线（过程记录）

将 `/api/chat` 接入持久 run 生命周期，新增 run 查询、事件分页／SSE游标回放与取消路由；新请求在executor启动前即取得runId和queued事件。legacy SSE仅从已持久化事件投递，终态帧在state与done事务提交后发送；executor在ready前失败通过执行结果竞速收敛，避免HTTP悬挂。独立审查发现queued→running与取消CAS竞争，修复为REVISION_CONFLICT后重读重试，并新增`globalLimit=1`确定性模块反例；另扩展双身份HTTP集成测试，真实排队第二个用户请求并通过Run API取消（测试夹具只延迟首任务）。独立复核该CAS修复PASS；HTTP集成1/1通过，模块回归21/21，Node v24.14.0，本地PGlite与受控身份，无真实Google、DSH/PT请求。**待补**：浏览器断线重连、真实多进程PG、worker lease、预算与provider reconciliation；所以只记录接线子范围通过，不宣布T03整包完成。完整证据见`docs/refactor/evidence/T03-http-integration.md`。

未进行真实Google授权、PT模型/媒体付费调用、生产PostgreSQL或部署验证。`.env`不读取；测试临时环境不继承Key。子Agent两次遇到平台用量限制后已按轮换方式继续；不降低独立验收要求。当前未合并main、未部署、未push；全任务仍需Claude整体验收和全新Claude Code测试。

### 2026-10-17 · T03 浏览器流断开后的持久事件续读（实现子范围）

提交 `c579960d6b14aa2c5e7e3d7d8926a773c0326f2e` 为旧 `/api/chat` SSE帧增加持久 `id` 序号；浏览器记录最后序号，读取流结束或报错后通过 `GET /api/runs/:id/events?after=...` 补读 delta、step、artifact，收到 done 后刷新目标对话。轮询最长30分钟，瞬时断网会从最后游标重试。新增集成断言确保 legacy SSE 暴露游标。验证 `node --test tests/regression/google-login-integration-review-test.mjs` 1/1 PASS（本地HTTP、临时PGlite、受控身份、dry-run；沙箱内一次因 loopback `EPERM` 失败，授权沙箱外重跑通过）；`node --check shell/public/app.js`、`node --check shell/server.cjs`、`git diff --check` PASS。该测试未真实模拟浏览器网络中断，也未证明真实PostgreSQL/多进程行为；浏览器端到端断线验收仍待补。T03 的 worker lease／故障恢复、预算熔断、外部provider查询与reconciliation仍未实现，故不标记T03完成。

### 2026-10-17 · T03 worker lease 基础接线（过程子范围）

新增迁移 `013_run_worker_leases.sql`，为 Run 保存 owner、expiry、heartbeat；创建新 Run 时在同一事务内绑定 runtime owner，执行服务定时续租，终态清租约；另提供竞争获取、续租、释放接口。服务启动只恢复无租约或过期租约的 queued/running/cancelling/waiting_external 任务；有效租约任务不被其他启动实例中断。过期的外部等待任务进入既有 unknown/pending_query reconciliation 路径并清租约。隔离存储/执行回归 `node --test tests/regression/task-store-test.mjs tests/regression/task-store-review-test.mjs tests/regression/task-execution-test.mjs` 9/9 PASS；集成 `node --test tests/regression/google-login-integration-review-test.mjs` 1/1 PASS（受控身份、临时PGlite、dry-run；loopback在沙箱内EPERM后授权沙箱外通过）；语法与`git diff --check` PASS。真实PostgreSQL多实例行锁/时钟/故障时序未验；跨实例取消与排队调度仍为进程本地，此切片不是完整 worker 协调器，不代表 T03 完成。

### 2026-10-17 · T03 worker lease 写入 fencing（限定验证通过）

代码复核发现执行服务虽在失去续租时请求本地 scheduler 取消，但持久事件与状态转换此前没有验证 lease owner；旧 worker 在失去租约后仍可能尝试写入。现在执行服务为运行态转换、事件和终态转换传递进程 owner，store 在锁定该 run 后用数据库时钟检查 owner 与未过期状态，拒绝失效 worker 的写入（`LEASE_LOST`）。远程 cancel 在 controller 不持有本地 scheduler 时持久化 `cancelling`；lease owner 的心跳观察该状态并取消本地 executor，运行中状态仍以 executor 最终收敛为准。新增 `tests/regression/task-store-postgres-integration-test.mjs`，以两个独立连接池覆盖并发租约竞争、过期接管、旧 owner 写入拒绝、新 owner 写入，以及不同执行服务间远程取消。验证：`node --test tests/regression/task-store-test.mjs tests/regression/task-execution-test.mjs tests/regression/task-store-review-test.mjs` **9/9 PASS**；真实 PostgreSQL 16 容器下 `PT_PG_DSN=postgres://postgres@127.0.0.1:55432/northstar node --test tests/regression/task-store-postgres-integration-test.mjs` **1/1 PASS**；修改代码/测试文件 `node --check` 与 `git diff --check` PASS。PG 容器只绑定 `127.0.0.1`、未挂载宿主机数据卷，测试后已停止并自动删除。该证据不等于生产多实例故障恢复、queued run 重新调度、SSE 跨实例广播或 provider reconciliation 验收；T03 仍未完成。

### 2026-10-17 · 暂停停点

用户要求暂停休息。当前实际 HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，分支 `feature/northstar-phase1-refactor-20261016`；未提交改动为 `docs/refactor/WORKLOG.md`、`shell/tasks/execution.cjs`、`shell/tasks/store.cjs`、`tests/regression/task-execution-test.mjs`、`tests/regression/task-store-test.mjs`，新增未跟踪 `tests/regression/task-store-postgres-integration-test.mjs`。用户已有未跟踪 `wb copy/` 必须原样保留。当前 lease fencing 与跨执行服务取消限定验证通过，结果和命令见紧上方；未提交、未推送、未合并、未部署。整包 T00–T18 仍为0/19完整完成，已有8项子范围交付；T03尚缺真实浏览器断线、生产多实例故障恢复与queued重调度、跨实例SSE广播、预算熔断和provider reconciliation。

环境记录：为真实PG验证临时启动了只绑定localhost、无宿主机数据卷的PostgreSQL 16 Docker容器，测试后已停止并自动删除；`/opt/homebrew/Cellar` 未安装 PostgreSQL。一次错误的 `brew install postgresql@16` 在PG formula安装前已中断，但Homebrew自身完成更新并准备了portable Ruby辅助环境；因此不能声称宿主机零改动。后续验证只用Docker；若清理Homebrew自身更新状态，先评估其对用户其他开发环境的影响，不要直接清空Homebrew缓存或删内部文件。

下次恢复顺序：①先核对当前branch、HEAD、`git status --short`及用户期间的新改动；②保留`wb copy/`，审阅上述未提交diff；③若代码无冲突，重跑PGlite 9/9及Docker PostgreSQL集成1/1；④继续T03：先处理多实例事件广播及queued run恢复/调度，再补预算熔断与provider reconciliation；真实浏览器断线验证另列，不把本地集成等同生产验收。维持不合并main、不push、不部署，除非用户之后明确改变授权。

### 2026-10-18 · 恢复核验与跨实例 SSE 事件读取（实现待专项验收）

恢复时分支仍为`feature/northstar-phase1-refactor-20261016`，HEAD仍为`b09b1e13720cd16cd7538999d4c63386920b367c`；保留`wb copy/`及全部停点未提交改动。额外发现用户在任务包v1.0末尾新增字面`x V`，原样保留。初次`git fetch origin main`因沙箱无法写`.git/FETCH_HEAD`失败，获准提升权限后刷新成功；当前远端`origin/main`为`a2adbee64c326653dbf5bfed3f918dd09f96589d`，与记录基线相同。

在`createRunExecutionService.subscribe`增加可选身份作用域的持久事件轮询（500ms），HTTP Run SSE与旧`/api/chat`回放订阅传入身份，从共享数据库补读其他进程发布的Run事件；进程内事件继续即时分发。变更位于`shell/tasks/execution.cjs`与`shell/server.cjs`。验证：既有`task-store`、`task-store-review`、`task-execution`回归9/9 PASS；两个修改文件`node --check`及`git diff --check` PASS。该回归未覆盖带身份的跨进程订阅轮询；仍需双服务实例 SSE 专项验收及真实PG事件时序验证，因此仅记录实现切片，不宣称跨实例广播通过。

本切片的独立审查发现：`/api/chat`内部持久订阅原先在正常完成、断开和重放路径未清理，造成500ms轮询与响应闭包泄漏；高序号先到可能吞掉缺失事件；replayed chat待发送事件可能被实时帧越过。已将内部订阅清理绑定Run settle，并覆盖重放完成/断开、正常chat断开/settle与初始回放异常；序号发现缺口时从持久事件补读，重放帧进入串行队列；按无活跃订阅条件清理Run缓存。修复后既有存储/执行回归重跑9/9 PASS，`node --check`与`git diff --check` PASS。仍无专项双实例SSE/资源回收测试；审查提出的并发backfill最后事件竞态和replay串行问题已纳入修复，但这些新路径尚未被独立动态验证。

并行隔离切片：`shell/tasks/provider-reconciliation.cjs`提供查询策略，未知taskId只返回manual_check，已知taskId只调用注入query接口，429/5xx/异常做有上限退避；`shell/tasks/budget.cjs`提供纯逻辑预算器，不内置产品额度，调用方须注入限制，成本受限且缺少估算或实际费用证据时阻止后续动作。两个模块由子Agent分别实现，未触碰共享存储/执行/HTTP文件，均未提交。provider模块有静态及注入探针证据；预算模块仅语法检查。两者尚未接入Run持久记录、DSH调用/工具执行、超限取消及reconciliation状态落库，不能视为T03闭环。

独立复审这两个隔离模块后发现并收紧了策略边界：预算模块现在复制并冻结额度配置、拒绝空限制；估算与实际费用字段各只读取一次，结算缺证据、null或getter异常时置`costUnknown`并阻断新 admission；时钟异常或回拨返回`RUN_CLOCK_UNKNOWN`。provider 模块不再依赖通用成功词；需显式注入provider状态提取器及成功／失败／进行中白名单，状态集复制为小写且互斥，未提供或冲突映射时不发查询并转人工核查；重试HTTP范围、Retry-After、审计时间与审计字符串也作限界处理，非重试型4xx即使由adapter作为异常抛出也转人工核查。两位隔离实现者均对最终修订作只读复核通过。当前仅做语法检查与diff检查，未对本轮策略收紧补专项动态测试；不宣称策略已运行验收。

本次未改恢复语义：queued请求目前没有可重建的完整DSH执行上下文，启动不能据精简审计request自动重放；过期Run继续安全转为interrupted，待实现持久执行描述与可恢复runtime入口后再设计重调度。预算/调用次数/重复工具调用上限、provider状态查询与unknown结果闭环仍未实现。当前无提交、push、合并或部署。

### 2026-10-16 · 今日停点与下次恢复入口

**停点**：专用集成分支 `feature/northstar-phase1-refactor-20261016`，记录时 HEAD 为 `1eea5911a42c35ae4e4800680e989ffd357e3481`；分支起点仍按开工授权核对 `a2adbee64c326653dbf5bfed3f918dd09f96589d`。今天已提交的 T03 HTTP/SSE 范围及独立复核见上文与 `docs/refactor/evidence/T03-http-integration.md`；重点回归为 `node --test tests/regression/task-store-test.mjs tests/regression/task-execution-test.mjs tests/regression/task-store-review-test.mjs tests/regression/session-scheduler-test.mjs tests/regression/run-events-contract-test.mjs`（21/21）以及 `node --test tests/regression/google-login-integration-review-test.mjs`（1/1）。本地验证使用 Node v24.14.0、临时 PGlite 和受控身份；不是生产PG、真实Google、真实DSH/PT或浏览器断线重连验收。尚未合并 main、未部署、未push。工作区中 `wb copy/` 是用户已有未跟踪目录，恢复时必须原样保留、不清理、不暂存。

**仍未完成**：T03 的浏览器断线后 Last-Event-ID 实际重连体验、真实多进程 PostgreSQL 与 worker lease／故障恢复、预算熔断，以及外部 provider 状态查询和 reconciliation；T03 不得标记整包完成。其他未交付任务按本文件依赖批次和四份已授权文档继续。真实生成验证若后续确有必要，先向用户索取可用测试 key 与明确费用上限；当前 `.env` 中 `nSpb` 余额 `$0.033` 不足以做真实生成，且本次工作没有读取 `.env`。

**下次启动顺序**：先运行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`，确认仍在上述分支、保留 `wb copy/` 并核对用户期间的新提交；再阅读本文件的“当前状态”和 T03 证据，按未完成项继续 T03，完成后由未参与实现者独立复验，再转入后续依赖任务。任何状态或基线与记录不符时先核清差异，不覆盖他人改动；继续开发仍遵守不合并 main、不部署的授权边界，直到所有任务、Claude 整体验收和全新 Claude Code 测试均通过。

### 2026-10-18 · Provider reconciliation store 静态修订

新增 `shell/db-migrations/014_run_external_reconciliation.sql`，持久化 `external_query_attempts`、`external_next_query_at`、`external_last_query`；`shell/tasks/store.cjs` 增加 due 查询、`claimExternalReconciliation()` 和租约校验结果写回。独立审查发现并推动修复：manual/耗尽状态不会因 NULL 时间再次进入 due；认领由事务内行锁 + lease + revision + 数据库时钟完成，认领时预增最多 8 次的查询计数并写状态事件；写回需要 lease owner 仍有效；查询中 worker 崩溃只会消耗一次计数，恢复后按次数继续或转人工核查，恢复状态同样递增 revision 并追加事件；恢复扫描保留 resolved 与 manual_check，避免把终态/人工项重新打开。外部 succeeded/failed/cancelled 仅把 provider reconciliation 标记 resolved，Run 仍是 waiting_external，后续执行/终态协议未接线。

**本切片验证边界**：独立审查认为事务更新与审计事件原子，迁移结构与 PostgreSQL 语法静态可接受；本轮只跑语法与 diff 静态检查，尚未执行迁移、SQL 集成或并发动态测试。due list 是候选列表，调用方必须先调用 claim API 成功后才可触发 provider 查询；模块尚无运行调度器和 provider adapter，无法证明跨进程端到端行为。下一步先复核 store 的状态流与旧测试兼容，再实现调度接线；预算模块依然未接入模型/工具/重试边界。继续保留未提交状态、不推送、不合并、不部署。

### 2026-10-18 · T03 接线审计补充

独立调用链盘点确认，全仓生产路径尚未调用 `recordExternalIntent()`、`recordExternalTaskId()` 或 reconciliation API。`shell/server.cjs#handleChat` 调用 tenant/runtime；工具实际执行在 DSH 子进程 `shell/persistent-runner.mjs`，media executor 进入 `business/media/powertokens.cjs#callMediaRoute()` 后执行付费 POST 并自行长轮询（视频最长本地守护一小时）。因此持久查单 store 目前没有真实 task 可查。接线必须通过子进程协议完成双阶段 parent acknowledgement：POST 前 parent 落 intent 并应答；POST 返回 taskId 后 parent 落 taskId 并应答，子进程收到确认后才继续轮询；异常/进程崩溃时不得重新提交，未知 taskId 转人工核查。provider metadata 需标记图片/视频端点，worker按 Run user 解密 BYOK；启动扫描不是持续后台调度器，需独立 worker。

预算路径审计确认，Run 容器位于 `execution.cjs`，实际 `handleChat()` 在 server 后续逻辑中等待 DSH；DSH工具 execute 在 `persistent-runner.mjs`，`tools/registry.cjs` 的 execute 不是聊天Run工具入口。可在 runner 每个工具 execute 前做 admission，但模型请求前钩子与内部 retry 计数当前没有显式接缝；当前持久 usage 只有 token 数，不含币种费用，媒体结果亦无费用收据。因此不得把最终 usage 或工具日志转换成估算费用，也不得报告模型请求/重试额度已受硬限制。下一步按“先定义跨进程 external intent/taskId 确认契约并做受控断点验证，再接只读 status worker；预算先实现有依据的工具/时长限制，模型/成本等 SDK/证据接通后再启用”推进。此处为只读架构审计，未改调用链、未运行动态验证。

### 2026-10-18 · 北极星项目整体验收上线目标

用户明确：**整个北极星项目的 deadline 为 2026-10-21，目标包含项目验收与上线**，不是仅 T03，也不是单纯的开发汇报日期。此日期适用于当前项目整体，任务范围仍以任务包的 T00–T18 与 AC01–AC24 为准；不得把局部 T03 切片完成等同于整体完成。主 Agent 需尽快复核各任务包/分支的真实状态，按验收与上线门槛倒排并组织独立并行工作，在期限前给出是否具备验收、上线条件的证据化结论。质量与工程质量优先；不以缩减验证或夸大完成度来满足日期。

### 本轮收口状态

HEAD仍为 `b09b1e13720cd16cd7538999d4c63386920b367c`，分支不变；新增018迁移与上述实现全部留在未提交工作区，未合并/推送/部署，用户既有文件未清理。当前43/43核心聚焦回归、独立HTTP偏好1/1、CSV1/1、既有受控Google/HTTP1/1、UI43+43断言PASS，修改实现语法与diff检查PASS。这里的HTTP Google使用fixture，不是真Google授权；PT模型预算和实机生产验收仍开放。下一切片优先：T16实际入口/依赖锁和干净发布可复现收口；T08真实输入契约仍需可用provider验证，不能靠上传UI替代。

### 2026-10-20 · T03 queued Run 恢复专项复核

恢复核对确认分支 `feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`；工作区仍有大量已有改动，包含 `wb copy/`，均未清理。运行 `node --test tests/regression/queued-run-recovery-test.mjs`，1/1 PASS：两个执行服务并发 dispatch 时单次认领，受支持的持久聊天请求完成；legacy、运行中、带凭据字段及存在付费子操作的 Run 不会重放。静态核对确认 server 启动时执行过期 lease 恢复并启动500ms queued dispatcher；`git diff --check` PASS。尝试查询 Docker 时 daemon socket 不存在，因此本轮未能重跑真实 PostgreSQL 多实例 SSE 专项；不把本地存储夹具结果提升为 PG/生产验收。下一步先恢复 Docker 后重跑 `run-sse-multi-instance-postgres-test.mjs`（需隔离临时PG DSN），随后按本文件既定优先级继续 T16 干净发布/实际入口验证。无实现文件修改、无提交、push、合并或部署。

### 2026-10-20 · T16 发布/profile 回归复核

按上一轮已记录优先级，运行实际 DSH 入口/安装、发布 manifest、profile 路径与生命周期、settings 升级及 bootstrap policy 共8个专项文件，`node --test ...` **67/67 PASS**；验证仅覆盖本机文件与受控临时目录，不能代替全新 npm 安装、生产依赖闭包、OS 隔离或预发布升级回滚。此条记录时真实干净发布探针尚未运行；当日后续隔离离线尝试结果见下方汇总。`git diff --check` PASS；实现文件未改动，只有本工作日志新增本轮结果；继续保持未提交、未推送、未合并、未部署。项目整体验收与上线仍未达成。

### 2026-10-19–20 · deadline 前两日进度汇总

| 切片 | 已完成与证据 | 当前结论 / 未完成项 |
|---|---|---|
| T03 Run 恢复与队列 | 10月20日 `queued-run-recovery-test.mjs` **1/1 PASS**：并发执行服务只认领一次；合法持久聊天请求完成；legacy、运行中、含凭据字段及有付费子操作的 Run 不重放。启动恢复及500ms queued dispatcher 已静态确认。 | 本地夹具通过不等于 PostgreSQL 多实例。Docker daemon 未运行，最新双实例 SSE 专项未复跑；真实浏览器刷新/断网、生产故障恢复仍未验。 |
| T03 付费操作与 reconciliation | 此前 `media-run-lifecycle`、`external-operations-store`、`external-operations-worker` 联合回归 **14/14 PASS**（PGlite/mock，历史运行）。确认 POST 前 intent 持久化、taskId 在轮询前落库、未知结果转人工核查且不重提、查单只查询已知 taskId并最多8次，子操作不会擅自完成父 Run；当前 media 生命周期 **12/12**，worker 专项 **5/5**。 | 三文件联合组未在本次增量后重跑；新增父 Run 聚合断言仍是 PGlite，不验证真实 PostgreSQL 跨进程 ack 丢失或 provider。 |
| T08 输入/多模态边界 | 附件及 media 定向回归 **10/10 Node tests、80/80 media.route 子测试通过**（mock fetch，无真实模型/PT/媒体调用）。加固后的实际 `persistent-runner.mjs` 子进程经 JSONL 收到合成文本标记，fake adapter捕获请求只有text block。HTTP探针另覆盖真实上传、durable Run/worker、`imageNote`及生产prompt格式；14个汇总语义断言/输出项通过，含快照、正常regen/branch、旧消息缺证据拒绝、改图拒绝、fixture capture不增加及历史messages深比较不变。 | 真实HTTP探针使用合成图片字节、fixture模型/tenant入口，不证明有效图片解码或模型视觉理解；legacy无快照用preload模拟，不是生产旧数据迁移实测。stage敏感过滤为best-effort路径/名称规则，不扫描内容；合成正反向规则覆盖service-account、access-token、token.js、私钥、轮转日志及备份命名，当前树排除`shell/.npmrc`；384依赖链接限制在可信checkout node_modules roots。probe使用loopback HTTP但未做socket级外连监测；T16 probe隔离复核 PASS（scope-limited），不等于T16发布或生产验收。官方主状态为untested；仅附件输入/持久化子范围为partial。 |
| T16 发布/profile | 8个实际入口、安装完整性、manifest、profile 路径/生命周期、settings 升级与 bootstrap 回归 **67/67 PASS**；`dsh-runtime-release-manifest`本机核验另PASS（DSH CLI `0.1.1-rc.2`，20文件与manifest/vendor/lock一致）；隔离 staging 的真实 shell HTTP smoke 通过 health、登录页/资源与 fixture 同源 API。 | 隔离缓存 clean-release 在 npm ci 因 **ENOTCACHED** 退出，未到该干净发布流程的 DSH CLI ready/idle。manifest check仅确认本机DSH单包；HTTP smoke不是目标浏览器/生产环境验收；完整依赖闭包、目标OS隔离、预发布升级/回滚仍未验。 |

**项目门槛与期限：** 用户设定的项目整体 deadline 是 **2026-10-21，目标为完整验收并上线**。截至本汇总，所有新增结果仍是模块级或受控环境证据，T03/T08/T16 有上述明确缺口，T00–T18 / AC01–24 的整包独立验收和生产部署证据仍未闭环，当前不能判定 ready。**质量第一**：10月21日不降低验收门槛、不把 partial 改写为 PASS、不用 mock/本地测试替代真实环境；若目标环境或关键证据不足，必须如实报告未达成及阻断项。所有工作区内容仍未提交/推送/合并/部署，用户目录 `wb copy/` 保留。

### 2026-10-20 · T08 历史图片重放校验缺口发现、修复与聚焦验证

首次隔离HTTP探针曾 **FAIL**：改写原图片后，对原会话 `regenerate:true` 仍到达 tenant fixture并返回成功。T03/T16静态核对确认历史用户消息只有图片URL、没有原 `sha256/size`，regenerate/branch会重新读取当前文件；此项按T09 CSV再生先例应fail closed，不能移除失败断言。现已窄修复：新消息将图片快照写入既有conversation JSONB；branch/regenerate在保存历史和调用tenant前按同租户原快照校验，并用同一读取Buffer组装 data URL，避免TOCTOU。`node tests/probes/northstar-t08-upload-to-runner-jsonl.mjs` **PASS：14个汇总语义断言/输出项**覆盖auto/data URL、text2image省略、>10MiB回退、坏格式/跨租户拒绝、快照持久化、未变图片regen/branch通过、旧历史缺快照regen/branch拒绝、改图regen/branch返回 `CHAT_ATTACHMENT_CHANGED`且fixture capture数不增，并深比较确认拒绝前后conversation messages不变；owned staging清理PASS。stage复制过滤为best-effort路径/名称规则，不扫描内容；合成正反向覆盖service-account、access-token、token.js、私钥、轮转日志和备份名，当前树排除`shell/.npmrc`；384依赖链接realpath限制在checkout内可信`node_modules` roots。探针使用loopback HTTP，不做socket级外连监测。`node --test tests/regression/chat-request-attachments-test.mjs` **1/1 PASS**，另 `node --check`、`git diff --check` PASS。旧历史缺快照由preload模拟 `conversation.get`，不是生产遗留库迁移验证；无真实provider/模型调用或有效视觉理解验证。T16 probe隔离复核 PASS（scope-limited，不等于发布/生产验收）；T08官方主状态为untested，仅附件输入/持久化子范围为partial，整包不计PASS。

### 2026-10-20 · 最新并行跟进与总进度口径

#### T04 取消 ack 早于 done 的 adapter waiter 窄修复

此前静态审查发现 `job.abort()` 会在 runner `done` 前删除 waiter 并 resolve，runner 的 `aborted` acknowledgement 也可能早于 turn 后续收敛。T03 窄修复为：已派发任务的 abort 仅发送取消并保留 waiter，`aborted` 只标记 acknowledgement/拒绝晚到 RPC，最终等 `done` frame 收尾；pre-abort guard 覆盖 waiter 创建前已取消路径。T03 运行 `node --test tests/regression/t04-adapter-abort-drain-test.mjs` **1/1 PASS**；T16 对代码与测试作独立静态 review **PASS，未重跑**。证据见 [`evidence/T04-adapter-abort-drain-20261020.md`](evidence/T04-adapter-abort-drain-20261020.md)。该回归使用受控 JSONL `FakeChild`，证明 abort ack 后 A 不 settle、pre/post-ack 迟到 RPC 不触发 A handler、B 请求仍成功且 A 只在显式 `done` 后 cancelled；它不证明真实 runner `whenIdle/flush`、PG conversation lease 或生产资源收敛。此前纯 scheduler 19/19 与 controlled DSH SDK probe 1/1 是不同证据范围。T04 保持 `partial`，AC02/AC03 保持 `blocked`。

**T04 扩展 timeout 回归与 deadline 更新（10月20日）：** 先前的 `t04-adapter-abort-drain-test.mjs` **1/1 PASS**仅为 abort-ack/迟到RPC窄回归的历史结果。加入共享 child timeout 场景后的同一命令 `node --test tests/regression/t04-adapter-abort-drain-test.mjs` 显示 **pass 5, fail 0, cancelled 1**：顶层 Promise 未结算，整文件不是 PASS。后续 T03 统一 waiter grace 修复通过 standalone probe（[`tests/probes/t04-abort-timeout-escalation-20261020.mjs`](../../tests/probes/t04-abort-timeout-escalation-20261020.mjs)），T16 独立静态复核未见此前“A abort 后始终无 `done` 时缺少有界 escalation”的阻断；然而整文件仍有一个未结算 Promise，不能记为回归 PASS。没有真实 DSH SDK、生产共享进程、PG lease 或 Run recovery 证据。总进度仍为 **T00–T18 0/19、AC01–AC24 0/24**；距10月21日 deadline仅一天，按当前证据完整验收上线很可能无法达成，若期限前门槛未补齐应如实记录未达成。T04继续 `partial`，AC02/AC03继续 `blocked`，计数不变。

T14只读 profile/source 盘点见 [T14-profile-and-source-audit-20261020.md](evidence/T14-profile-and-source-audit-20261020.md)：当前生成的 `run-persistent` 依赖合同仅显示 base bundle，settings 与旧 web-profile 快照不构成加载证据；来源/失败态/URL安全/注入专项回归未见，T14、AC15/AC16状态不变。

T17 静态来源盘点见 [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md)：源码/锁文件/模板盘点子范围已完成，T17整包与AC23仍为 `untested`，不改变验收状态计数。

T09 文档解析只读缺口盘点见 [T09-document-analysis-gap-audit-20261020.md](evidence/T09-document-analysis-gap-audit-20261020.md)：现有 CSV 来源/快照回归仅为聊天附件子范围，来源 token 不证明答案引用正确；聊天路径未覆盖 Office/PDF/ZIP、golden 确定性计算或可点击来源。T09 保持 `partial`，AC10/AC21 保持 `untested`。

T03 对 `queried` 审计字段缺陷已作窄修复：已知 taskId 且 host 完成轮询后记录 `queried:true`，同步直返成功记录 `false`；首次结果写入失败后重试成功会返回已有生成结果，不重发 POST/轮询。`media-run-lifecycle-test.mjs` **12/12 PASS**；未参与实现者独立复核并补充最终 mock store 状态断言，主 Agent再次复跑通过：重试成功后 taskId 保留、外部操作记录状态 `resolved`；两次写入均失败时 taskId 仍可供核查、操作 `accepted`、父 Run `waiting_external`、reconciliation `needs_reconciliation` 且没有结果审计记录。另在 `external-operations-worker-test.mjs` 补父Run聚合与终态不回转断言，PGlite专项及主Agent复跑 **5/5 PASS**：成功查单后父Run仍 `running/not_required` 且无 `done`；父Run原为 `failed` 时子操作成功不改变父状态或重复 `done`。这些状态来自受控 mock/PGlite，不是 PostgreSQL 最终生产行验证，也不代表真实 provider 或多实例验收。T08 加固后的实际 `persistent-runner.mjs` 子进程经 JSONL 收到合成文本标记；隔离子进程环境与正常超时退出清理经过检查，fake adapter 捕获请求只有 text block，无 image modality；`paidCalls=0`，`networkAccess: none-by-design`（进程内 fake adapter，未配置 PT adapter），不代表 socket/包级监测。该 probe 未走 server 上传/持久化/worker 组装链路，也未使用有效图片字节。T16 安装依赖下真实 CLI ready 专项 **1/1 PASS**，验证 protocol/capabilities 及 idle 存活，无模型/工具调用，临时 profile 已清理；新增隔离 staging 本地 HTTP smoke **PASS**，覆盖真实 shell server + PGlite 的 health、未登录跳转、登录页/2个资源、fixture登录后同源 `/api/me` 与 `/api/conversations`，正常退出及 staging 清理通过；身份/模型/DSH均为fixture。此前 online clean-release 仅验证选择性 CLI 发布输入并复用宿主 npm cache，本轮隔离 offline clean-release 在 `npm ci` 因 `ENOTCACHED` 未到 CLI 启动，二者是不同运行。app artifact integrity probe 主 Agent复跑 **PASS：222 个 allowlisted checkout 文件；18 个顶层 HTML 中带引号且以 `/assets/` 开头的 `src`/`href` 引用存在；manifest SHA-256 `bad6324b93ff1ee56fa4b4242b7c4e2b21964511900445e48a2f63e2b1f4dd4b`**，临时 staging 已清理；范围限于 `shell`、`business/media`、`business/attribution`、`analytics/backend`、`analytics/lib`、`analytics/schema` 六个指定源码根，不核对 Git index/实际发布清单，不含媒体/字体等未列扩展，不覆盖嵌套HTML、`srcset`、CSS/JS动态引用，也不代表完整 `server/backend`、`public/**`、源码/运行时/依赖闭包或HTTP/同源/API/部署升级验收。

整体数字使用任务包验收口径：截至本记录，**T00–T18整包 PASS为0/19，AC01–AC24端到端 PASS为0/24**。T任务按每项唯一主状态互斥统计为11项partial、5项untested、3项blocked；AC状态为12项blocked、12项untested。此数量是整包被证明完成的比例，不代表“代码完成率”；项目没有任务权重或可加总的验收子项百分比，因此不编造加权开发完成率。deadline为2026-10-21，质量优先；当日如真实环境与独立验收证据仍不足，结论必须是未达成。

T11 本轮追加 `response-usage`、`tool-calls-usage-evidence`、`task-budget-provider` 三个专项 **17/17 PASS**；主 Agent复跑通过，独立范围审计确认 T11=partial 合理，证据见 `evidence/T11-usage-evidence-20261020.md`，仅证明 response usage 观测、unknown 保留、按 Run/response 写入与摘要以及有限 admission/查单策略，不证明真实账单、网络尝试或内部 retry 计数。另有一条失败 Run UI 局部回归，证据见 `evidence/T11-failed-run-ui-20261020.md`；只覆盖失败终态 SSE 到 UI 的步骤数据保留与提示顺序，不证明后端持久化/replay 或工具状态与 usage 联合记账。T03 新增 `persistSteps` 窄修复，failed 与 stopped/timeout Run 均保留已观察到的成功/失败 tool step 状态；受控 HTTP/PGlite `node --test tests/regression/chat-usage-failure-accounting-test.mjs` **1/1 PASS**，T16 静态复核 **PASS（未重跑）**。fixture 将 `runDshForUser` 替为受控 fake runner；未端到端覆盖 adapter call-only/no-result 帧、真实 SDK 取消或 timeout 的 Run terminal DB 断言。取消/中断整包行为仍未完成验收。任务包尚缺真实重试与运行关联、热切换日志一致性、停止/超时/崩溃计量、媒体计量、权限及完整用量/日志 UI 和真实账单来源。预算模块已有 `actualCost` 输入接口，但生产 runner 未接入成本证据；AC13 仍 blocked，阻断理由为缺少已连接的真实成本来源，不是没有接口。AC22 仍 untested。

**T08 补充与状态澄清（10月20日最终复核）：** 上述 `persistent-runner` 说明只对应runner文本块探针。新增HTTP输入探针现为 **14个汇总语义断言/输出项PASS**，并完成生产图片快照修复；拒绝变更图片的regen/branch路径在fixture前失败且deepEqual确认历史未变。T03与T16独立review已完成，结论为各自证据范围内PASS。T08验收表主状态仍为 **untested**，附件输入/持久化子范围为partial；T08计入5个untested，不改变0/19及0/24整包比例。

### 2026-10-20 · ACK_LOST恢复回归与 T16 DSH 单包核对

T03 `external-operations-worker-test.mjs` 新增 PGlite commit-after-success/ACK_LOST 回归，专项由 **5/5 增至 6/6 PASS**：真实 `recordQueryResult` 事务先成功，测试再于store API边界注入一次ACK_LOST；状态仍为 `succeeded`，查询结果事件仅一条，父Run仍running且无done，恢复扫描 `processed=0`，不重复provider query、结果写入或事件。T16 reviewer确认场景构造有效；它模拟事务成功后的API回执丢失，不是PG COMMIT网络回执丢包、跨进程重启或多实例故障注入。

T16 本轮只读命令 `node scripts/northstar-dsh-manifest.mjs check --manifest shell/runtime/dsh-release-manifest.json` **PASS**：本机DSH CLI `0.1.1-rc.2` 的20个文件与manifest/vendor tar/lock一致。该结果不证明transitive依赖闭包、干净安装、生产profile、目标OS或升级回滚。T08 前端路径审查发现再生/分岔拒绝错误虽由server SSE返回，但旧历史存在时前端仅重绘历史、没有展示提示；该缺口已按下段完成窄修复、20/20定向回归并经T16复核。所有项目状态仍受整包门槛约束。

### 2026-10-20 · SSE错误可见性与T11失败记账排查

T08 将附件历史regen/branch拒绝的server `obj.error`作为非持久化sysline显示，同时保留现有messages；`needKey`继续使用专用提示。当时运行 `node --test tests/regression/ui-run-resume-review-test.mjs` **20/20 PASS**，T16独立复核通过（前端SSE处理单元边界，不是HTTP/PGlite端到端）；其后新增一条 T11 失败 Run UI fixture，当前该单文件 **21/21 PASS**，证据见 `evidence/T11-failed-run-ui-20261020.md`。新用例仅验证失败 SSE 的步骤数据传递及错误提示顺序，不证明后端持久化/replay 或工具状态与 usage 联合记账。当前失败 assistant 历史仅存 `text/ts`、不存 steps；通用工具 `args/result` 尚无已验证的通用脱敏，安全历史表示待 T03 确认，不得将 UI fixture 解读为可持久化 raw steps。其后整体Run失败保留工具原状态的后端窄修复及 `chat-usage-failure-accounting-test.mjs` 联合fixture已落盘；先前一次运行在 `freePort` 监听处因 `EPERM` 失败、未进入服务断言，提权重跑已中止；随后在获准loopback环境实跑 `node --test tests/regression/chat-usage-failure-accounting-test.mjs` **1/1 PASS**，此前EPERM执行问题已解决。该用例通过真实 shell HTTP + PGlite 验证工具状态及run/response usage写入，`runDshForUser`为受控fake runner；不证明真实DSH/provider或费用、失败assistant历史steps持久化/replay、adapter call-only/no-result帧或真实SDK取消/timeout的Run terminal DB行为，也不构成T11/AC整体通过。T03加固fixture setup/cleanup，清理此前owned临时目录并确认无同前缀残留；`node --check`及目标diff-check通过。取消/中断残余：任务包未明确停止/超时时已成功工具的工具级终态；局部修复与受控fixture保留已观察到的成功/失败步骤，但不覆盖真实SDK取消/timeout及其terminal DB断言。manifest单包、SSE UI和ACK_LOST证据均不将相关整包/AC状态改为PASS。

T13 只读代码与回归审计确认现有租户技能目录仅首次复制，未见版本/hash/Run pin 或可信 PM 发布禁用入口；当前回归只证明目录创建，T13/AC15 维持 `untested`，详见 [`evidence/T13-skill-release-audit-20261020.md`](evidence/T13-skill-release-audit-20261020.md)。

T15 CI 静态盘点后新增 `attribution-regression` job：Node 20/22 下依次 `npm ci` 安装 analytics、shell、business/attribution，再逐文件运行归因、quality、skills tracking audit 与 GA connector 回归。静态路径核对通过，未运行测试或验证 Actions 实际执行/required-check 设置；仍无浏览器/移动、AC矩阵总跑或性能基线 job。job 的覆盖范围与边界见 [`evidence/T15-ci-gate-audit-20261020.md`](evidence/T15-ci-gate-audit-20261020.md)；该增强待 CI 实跑，T15 保持 `blocked`，AC 状态和整包数字不变。

T18 部署/恢复只读审计见 [`evidence/T18-deployment-recovery-audit-20261020.md`](evidence/T18-deployment-recovery-audit-20261020.md)：运维文档给出目标流程；现有 profile/settings 局部 upgrade/rollback 代码与受控回归不覆盖应用 DB、附件或 BYOK 主密钥生产恢复。`/healthz`仅反映进程存活，未见告警触发/恢复演练或已验证目标部署环境。建议补一份PGlite冷备到独立目录恢复的命令级runbook，执行前仍只是文档改进；T18/AC24维持 `blocked`，总体状态不变。本轮未运行测试。

### 2026-10-20 · 今晚候选与部署分层建议（状态不变）

#### 今日停点与下次恢复顺序

停点：分支 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`。工作树有大量既有修改和新增文件，均未提交／推送／部署；保留所有现有文件及 `wb copy/`，不要 reset、清理或覆盖用户改动。deadline 为 2026-10-21；目标是先形成可审阅的测试服务器候选，不降低整包验收条件。

本轮完成：新增仓库 source-generated `run-persistent` profile candidate（12 files，manifest SHA256 `935c4a38f6b81094adebbb0cd8432db5a46228d6977b73cdd80ed996121e3f12`）；快照目录与祖先 symlink 会 fail closed。复核命令：`node scripts/northstar-profile-snapshot.mjs check` PASS；`node --test tests/regression/northstar-preflight-test.mjs` **9/9 PASS**；`node scripts/northstar-preflight.mjs` exit 0、`ready=true`、scope=`offline-static-only`；本次 scoped `git diff --check` PASS。它没有证明目标机 profile 一致、真实 DSH 完整启动、数据库、HTTPS、Google 外部登录或目标机发布。

下次恢复顺序：①取得目标测试服务器 OS/Node、部署入口和用户指定的现存 Google 登录制品/commit（不要在聊天中传 secret）；②识别并冻结不含新 OIDC、也不由未验证 T03 durable 付费执行接管的精确候选基线；当前 checkout 没有旧执行或旧 Google 登录的可验证切换开关，HEAD 已含 durable `/api/chat`；③走在线 clean-release 路径，在目标机验证 profile、启动、health 与回滚。离线流程已因 `ENOTCACHED` 失败，不列为候选；在线证据目前只覆盖本机选择性 CLI 子集，尚非目标机发布验收。T03 waiter-grace standalone probe通过，但完整 `t04-adapter-abort-drain-test.mjs` 仍 `pass 5, fail 0, cancelled 1`；不要据前者升级为整文件 PASS。未取得目标机与旧制品信息前，不生成或部署假定候选。

**建议明日只沿在线 clean-release／部署路径推进候选；离线 `ENOTCACHED` 不是候选路径，也不代表代码失败。** 当前集成分支有大量未提交／未跟踪改动，尚无冻结的不可变候选，故不应直接将当前工作树作为生产版本。T00 source-generated repo candidate 已生成 12-file manifest（SHA256 `935c4a38…121e3f12`），preflight 9/9、`ready=true`；这证明该生成候选通过本地预检，不是生产机快照或目标机发布验证（[`evidence/T00-dependencies.md`](evidence/T00-dependencies.md)）。T16 在线隔离 `npm ci`＋空 HOME 的真实 DSH CLI ready/idle 只覆盖本机选择性 CLI 发布子集，不能冒充完整目标机发布验证；最新离线 clean-release 在 `npm ci` 因隔离 cache `ENOTCACHED` 退出，未运行该干净发布流程的 ready/idle。8 项专项 67/67、本机 manifest 与 staging HTTP smoke 是限定检查，不证明完整发布产物／依赖闭包／目标 OS／生产升级回滚（[`T16-PACKAGING-AUDIT.md`](T16-PACKAGING-AUDIT.md)、[`ACCEPTANCE-STATUS-20261018.md`](ACCEPTANCE-STATUS-20261018.md) 第17–19、65行）。

候选边界：明日在线 clean-release／部署候选须先冻结源并在目标机验证，不把当前未冻结的 T03 执行路径变更作为生产切换项。若主张保留旧执行路径，须选择并核对确切的已部署旧制品；不能声称当前 checkout 有回切开关——当前 `/api/chat` 已提交 durable `taskExecution` 并执行 `executeDurableChat`（`shell/server.cjs:921–934,1851–1905,2119–2128`）。T02 证据记录 commit `98c0411` 接入新的 Google OIDC，并退役旧密码入口；但仓库证据无法识别用户所指的既有 Google 登录实现或生产制品（[`evidence/T02-integration.md`](evidence/T02-integration.md)）。候选应以用户指定的当前已部署版本／旧 Google 登录实现为基线，不擅自带入此 checkout 的新 OIDC；当前工作树没有可验证的旧 Google 回切开关，须拿到确切旧制品或 commit 后确认。这里不以密码流程替代 Google 登录。T03 的 queued/lease/provider恢复仍有局部证据；T04 最新统一 waiter grace standalone probe 通过，T16 独立静态复核未见此前“A 无 `done` 阻断”；但完整 timeout 回归文件仍为 `pass 5, fail 0, cancelled 1`，不可记作文件级 PASS，且尚不证明真实 SDK／生产数据库收敛（本记录 T04 段及 standalone probe [`../../tests/probes/t04-abort-timeout-escalation-20261020.mjs`](../../tests/probes/t04-abort-timeout-escalation-20261020.mjs)）。若做 staging，仅用冻结副本、独立 DB/profile/workspace 和专用测试身份；当前 staging HTTP smoke 使用 fixture 登录／模型／DSH，不能当真实 SSO 或业务验收。

其余模块的证据强度按“子范围可信度”分层，不改主状态：较强的受控本地证据包括 T01 PGlite/storage（[`evidence/T01-storage.md`](evidence/T01-storage.md)）、T02 当前分支 Google-only OIDC 本地 HTTP 接线（[`evidence/T02-integration.md`](evidence/T02-integration.md)）、T08 附件输入 14 个汇总语义输出项（[`evidence/T08-input-audit-20261020.md`](evidence/T08-input-audit-20261020.md)）、T09 CSV 来源子范围（[`evidence/T09-csv-source-20261019.md`](evidence/T09-csv-source-20261019.md)）、T11 response-usage 17/17（[`evidence/T11-usage-evidence-20261020.md`](evidence/T11-usage-evidence-20261020.md)）与受控 fake-runner HTTP/PGlite 1/1（[`../../tests/regression/chat-usage-failure-accounting-test.mjs`](../../tests/regression/chat-usage-failure-accounting-test.mjs)）、T16 CLI/profile/staging 子范围（[`T16-PACKAGING-AUDIT.md`](T16-PACKAGING-AUDIT.md)）；均不等于对应整包或生产验收。较高风险／仍需实证的是 T00 profile 与部署快照、T02 真实 Google/HTTPS 浏览器及首次 BYOK→AUTO、T03 durable Run/多实例与 provider 收敛、T04 真实 session 并发和取消/timeout、T16 离线依赖闭包与目标 OS。T05/T06/T07/T10 仅有模块或接线子范围；T12 无专项验收，T13/T14/T17 主要是静态盘点，T15 尚未实跑 CI，T18 无生产部署/恢复演练。deadline 仍为 2026-10-21；当前整包计数继续 **T00–T18 0/19、AC01–AC24 0/24**，T/AC 状态不变，完整验收上线尚无 ready 证据。

### 2026-10-21 · 线上模型资格阻塞处理（尚未发布）

线上 r5 已证明登录、PG身份持久化与 HTTPS health；未证明模型调用。用户确认使用既有受控 Google 账号试跑并自行监控余额。主 agent 本地完成首段 T06/T07 修复：目录接口/选择/聊天改为按认证用户解密 BYOK，并把用户 ID、key hash、base URL 纳入既有目录缓存 scope；移除服务级全局目录刷新；无 key 时 unknown 静态项不再假装 `chat=true`。`/api/models` 返回各模型 router 拒绝原因，UI 可显示当前阻塞阶段。独立审查后明确 `/v1/models` 列表出现只证明目录可见，不足以授予执行 permission；因此此证据仍 unknown/fail-closed，未设置静态白名单或伪造运行验证。新加 `metadataFields`/`capabilityFields` 只读字段名投影，方便后续核对真实 PT 元数据结构，不暴露原始值，也不提升权限。受控候选 run-budget 限为每 Run 1 次模型请求、0次工具调用、0次自动重试、180秒；此为请求/时间上限，非货币限额。6个修改过 JS 文件 `node --check`、`git diff --check` 通过；未运行测试、未调用模型、未部署。下一步是依据真实字段语义/官方契约接可信 permission、policy、adapter 与 revision-bound verification；router 通过后才制作候选包，并由维护者部署后做一次无工具简单文本 Run。正式总体验收保持 T00–T18 0/19、AC01–AC24 0/24。

并行安排已启动：主 agent 继续线上 T06/T07→T03 资格与受控运行线，并维护整包状态；3 个子 agent 分别接手 T12 记忆/上下文预算隔离切片、T15 CI/验收差距证据、K1–K3 旧诊断与用户协助项文档复核。子任务避免触碰 T06/T07 共享服务端/UI 文件，禁止线上操作、付费调用和测试；主 agent 收回后集成审查。此轮仍以单工作位主 agent 加最多 3 子 agent 的并发上限执行。

### 2026-10-21 · 当日停点与明日冲刺入口

用户明确今天收工，明日以“继续北极星”恢复；当前不要部署、不要请求用户运行服务器命令、不要发起模型调用。两条工作线及四个工作位已记录在[模型资格阻塞修复计划](北极星模型资格阻塞修复计划-20261021.md)：主 agent 继续线上 T06/T07→T03 受控闭环与集成；三个隔离切片均已交回：T12 在 `shell/memory.cjs` 增加向后兼容、默认 4000 UTF-16 code-unit 的确定性记忆字符预算和遗漏摘要（不是 token/整体上下文预算，T12/AC14 仍未通过）；T15 新增 CI token 权限差距记录，建议后续评估 `contents: read`，未改 workflow 且 T15 仍 blocked；K1–K3 已在部署清单标为 r5 历史诊断，当前用户无需执行或准备，新候选部署后再只读查看 `/api/models` 的少量字段名。子任务均未运行测试、未操作服务器、未调用模型。

主线当前本地改动包括按用户 BYOK scope 读取目录、明确 router 拒绝原因、`metadataFields`/`capabilityFields` 安全字段名投影，以及试运行 Run 上限 1 次模型请求、0 工具、0 自动重试、180 秒；线上仍为 r5，权限/能力/策略/adapter/verification 证据尚不足，故 fail-closed。今天已完成语法与差异空白静态检查；没有测试、付费调用或部署。**明日恢复顺序：**①检查工作区与上述三个切片的实际 diff，做 targeted 静态审阅；②继续 T06/T07 可信证据接线与无付费资格判定；③仅在 router 有合格候选后冻结/构建发布包并更新带行号的部署清单；④由用户逐条执行部署；⑤满足门槛后才做已授权的一次简单文本 Run。T00–T18 仍 0/19、AC01–24 仍 0/24；试运行不等于一期验收。

### 2026-10-22 · 双线恢复、并行审查与资格阻塞

用户要求线上部署线与完整重构线并行，并要求主 agent 加 3 个子 agent 均有明确任务。主 agent 继续 T06/T07 用户 BYOK scope、可信模型资格证据接线与候选判定；3 个子 agent 分别审查并修订 T12、T15、T18，未触碰 T06/T07 共享文件。T12 预算现按最终注入格式计数（前缀、行间换行及内容），保留 `memoryLines()` 数组接口；仍未覆盖数据库全量读取成本，也未完成 T12/AC14。T15 workflow 顶层新增 `permissions: contents: read`；未触发 Actions、未核验仓库设置/branch protection，T15 仍 blocked。T18 审计更新了 r5 在目标试运行主机部署及用户回传的登录/PG会话/HTTPS health 结果；未独立访问线上，备份恢复、告警、应用级回滚、RPO/RTO 和独立交付证据仍缺，故 T18/AC24 blocked。三项均未运行测试；主 agent 对当前 diff 执行 `git diff --check` PASS。

T06/T07 主线静态审阅确认：服务端调用链没有向目录注入可信 `permission`、`localPolicy`、adapter 或 revision-bound verification，故 router 继续 fail-closed。官网公开的 GLM-5.3 页面列为 Chat 并说明 OpenAI-compatible chat endpoint；这可作为模型文本能力来源候选，不能证明当前用户 Key 的调用权限或 DSH runtime verification。证据已补入 `evidence/T06-capabilities.md`；未访问用户账户、部署或发起模型调用。线上 r5 不含当前本地未提交候选改动。

今日继续验收：T03 完成受控真实 UI/HTTP/存储断流恢复切片。浏览器发出 1 次 `/api/chat` 并创建 1 个 Run；强制关闭 SSE 后，客户端通过同一 Run 的 events 端点恢复，最终显示完成。记录为 [T03 浏览器断流恢复证据](evidence/T03-browser-disconnect-recovery-20261022.md)。本次只使用本机 harness 身份、模型和回复 fixture，无付费模型或线上请求；T03 与 AC 项仍不整体通过。

T18 复核找到 profile-only restore-backup 的既有边界，并确认应用级数据库/附件/workspace/配置备份恢复能力缺失；`profile-maintenance-cli-test.mjs` 受控 fixture **1/1 PASS**，只覆盖 profile rebuild 旧内容保留及无效恢复请求拒绝，不覆盖成功恢复，更不代表应用级数据恢复。细节与合成数据 PGlite 最小实现清单见 [T18 部署恢复审计](evidence/T18-deployment-recovery-audit-20261020.md)。T18/AC24 继续 blocked。

T13 可验证切片为 Google 登录回调前创建租户 `.dsh/skills` 目录，定向 fixture **1/1 PASS**；但当前仅首次复制共享技能目录，没有发布版本/hash、禁用状态或 Run pin，常驻 DSH process 按 tenant 复用使原地升级无法证明旧 Run 保持旧版本。审查与任务包六项验收缺口见 [T13 工作区技能目录回归](evidence/T13-workspace-provisioning-regression-20261022.md)。T13/AC15 仍未通过；按新增持久发布和 Run 版本固定边界，原 2–4 人日可能需增加约 3–5 人日，待 DSH loader 契约确认后重估。

本地隔离 CI 复核：语法入口 327/327 PASS；101-suite regression **88 PASS / 13 FAIL**，归因测试 **24/25 PASS**。13 项中有 6 个 loopback bind `EPERM`、3 个缺少隔离 `PT_PG_DSN`、2 个 legacy PGlite schema fixture 缺 `model_preference`、1 个 T04 abort-drain 实际/预期终态不符、1 个 UI archive 测试引用未定义 `setBusy`。获准隔离重跑确认前三个 listener 用例通过后按主 agent要求在第26项前中断，exit 130，剩余未复核；Docker daemon 不可用。精确范围、干净副本边界和 CI 缺口见 [T15 本地 CI 执行记录](evidence/T15-local-ci-execution-20261022.md)。结果不代表 GitHub Actions，T15 仍 blocked。

T05 独立负向探针以合成 Key 验证 child 能从环境变量读取 `POWERTOKENS_API_KEY`，预期发现 **1/1 PASS（安全缺陷被复现）**；既有 env-isolation **26/26 PASS** 仍明确 Key 注入，不能据此声称 child 密钥隔离。仓库候选 unit/部署清单还存在同身份文件读权限、出网/命令沙箱和生产 profile 扩展清单缺失；其中目标机权限结论为静态配置推断，未独立线上核验。BYOK 要留在 host 需更换 DSH/provider 架构，单删 env 无法保持现有 provider 请求。验收清单和界限见 [T05 子进程安全独立复核](evidence/T05-child-isolation-review-20261022.md)。T05 partial、AC16 blocked、AC12 untested 状态不变。

完成整包工期暂估为再 6–10 个工作周，前提是四个工作位持续并行且目标服务器、真实 PT 资格信息、独立验收及时可用；等待外部证据会延长日历周期。该区间不是任务包承诺：v2 文档中具备数字的条目原估算合计 57–95 人日，T02/T16/T17/T18 仍待重估，且已有 11 项 partial 没有可累加权重。严格验收仍 T00–T18 为 0/19、AC01–AC24 为 0/24。当前工作树既有改动和 `wb copy/` 保持原状；未提交、推送、合并、部署或调用模型。

### 2026-10-22 · 候选部署命令草稿与三项隔离切片

用户指定继续沿用 r2–r5 的维护者手动部署流程，明确不提供本会话 SSH。已核验现有 T06/T07 受控候选归档 `release-artifacts/northstar-controlled-trial-20261022-candidate-02.tar.gz` SHA-256 `a05fa82476b90ae9d16a5e3fc80bd88902f08f1ec795f5f875c9126d4afd47d9`，包含 19 个 SQL 文件，未含 env/secrets、node_modules、Git 元数据或 AppleDouble；归档中的 server/catalog 已包含用户确认的按 PT 列表设置 `permission=true`、enabled textChat localPolicy 及 OpenAI-compatible chat-completions adapter。新增 `release-artifacts/northstar-shell-candidate-02.service`，SHA-256 `be296a55fbf28fabecf9604b85387ae04804057a3c2d6a93db781738f472b80a`。逐条上传、校验、依赖安装、systemd 切换、health、`/api/models` 资格核验、一次受控 Run 与回滚命令见[部署清单草稿](北极星受控试运行部署命令清单-20261022-candidate-02.md)。这是 T06/T07 定向候选，不是整合完的 Phase 1 发布；其归档未包含之后新增的 T09/T13/T17 切片。未部署或调用模型；线上具体获准模型 ID 仍待维护者按该包部署后回传。

本轮主 agent 加 3 个子 agent 的隔离任务均已交付：T09 新增确定性 CSV 聚合（sum/count/min/max、精确十进制与来源坐标），focused parser/source/analysis **22/22 PASS**；T13 新增 skill 内容快照 hash 与 Run pin 纯模块，定向测试 **3/3 PASS**，尚无 DSH loader 的 Run 级不可变版本加载接线；T17 新增本地锁文件依赖版本及缺失 baseURL 配置错误探针，定向测试 **2/2 PASS**，未覆盖 UI 提示、生产依赖或完整来源矩阵。证据分别见 `evidence/T09-deterministic-csv-analysis-20261022.md`、`evidence/T13-skill-release-snapshot-primitives-20261022.md`、`evidence/T17-local-profile-config-evidence-20261022.md`。这些是隔离子范围，不改变各任务或 AC 的整包状态。

用户已确认 T09 聚合规则选项 A：现阶段继续拒绝语义不明的日期、单位/币种和地区数字格式，不推断、不换算；待试用收集真实用户文件样本后，再按具体样本逐项扩展允许格式和换算规则。当前无待用户确认的 T09 事项。完整任务包仍未整体验收；候选发布与一次受控 Run 也不会改写 T06/T07/T03 或 T00–T18、AC01–AC24 的整体状态。

随后将 T06/T07 当前工作树模块与 T09/T13/T17 三个隔离切片做联合聚焦回归：`node --test tests/regression/model-catalog-lifecycle-test.mjs tests/regression/model-capabilities-test.mjs tests/regression/task-router-budget-test.mjs tests/regression/csv-parser-test.mjs tests/regression/csv-source-test.mjs tests/regression/csv-analysis-test.mjs tests/regression/skill-release-snapshot-test.mjs tests/regression/t17-profile-dependency-config-test.mjs`，**60/60 PASS**。这是本地模块级回归，无真实 PT 网络请求、线上部署或付费模型调用；不替代 `/api/models` 目标环境核验、真实 Run 或任务包独立验收。

#### 当日续进展：首调修复与 candidate-03

独立复核发现 candidate-02 的 UI 禁用了后端已准许 `verificationRequired=true` 的手动首调模型，T10 下载路由还可跟随租户 workspace 中的跨租户 symlink 返回私有文件。已修正 UI 资格门槛与标签，并令下载路由拒绝路径组件 symlink、以 `O_NOFOLLOW` 打开最终文件；HTTP 回归现为 **1/1 PASS**（仅证明该复现路径被拒绝，不覆盖并发路径替换风险）。UI/路由聚焦组合 **12/12 测试通过**，其中 UI 套件 **45/45 断言**；原 artifacts **75/75**、边界 **1/1**、T13 快照 **3/3** 均 PASS，语法和 `git diff --check` PASS。T13 路径 helper 增加 Windows drive、非 NFC 及大小写冲突拒绝；hash 发布映射、持久化与 DSH 按 pin 加载仍未接线。

candidate-02 已明确作废，未改写；新的定向候选为 [`candidate-03`](../../release-artifacts/northstar-controlled-trial-20261022-candidate-03.tar.gz)，SHA-256 `e557a71e816206a3b415ea404eaa47e8f278fc9a54bafd4206c26605709bb7e7`；systemd unit SHA-256 `610872a32535c39136dfccd1211e524a7835ffe61b7b0c7e217df14dd966dddc`。归档经检查有 19 个 SQL migration，未见 `.env`/secrets、`node_modules`、Git、AppleDouble 或 traversal 路径；包含新的首调 UI 和 symlink 拒绝代码。维护者执行清单为 [`candidate-03 命令清单`](北极星受控试运行部署命令清单-20261022-candidate-03.md)，含编号、checksum、安装、health、资格门槛、额度、验证与回滚；旧清单已标作废。复核还指出 `npm ci --ignore-scripts` 会跳过 node-pty spawn-helper 权限修复，故新清单改为以无特权 `northstar` 用户运行锁定安装脚本、检查 helper 可执行位并恢复候选文件 root 所有权。这仅为试运行所需启动依赖核对，不算工具能力验收。

尚未在目标机部署、访问线上 `/api/models` 或发出模型请求；候选模型 ID 和真实 Run 返回仍待维护者按清单执行后回传。T06/T07/T03、T10/AC11、T13/AC15 及整体验收状态不因这些本地切片改写；严格验收仍 T00–T18 **0/19**、AC01–AC24 **0/24**。T09 继续按用户已确认的 A：拒绝含义不明的日期、单位/币种、地区格式和换算，待真实试用样本再逐项扩展。当前无待用户确认的业务事项。

#### candidate-04 归档元数据纠正（用户复核后）

用户在 candidate-02 解包件中发现数百个 `._*` AppleDouble 文件。复盘确认先前只查归档路径名不够：candidate-02 与其衍生的 candidate-03 没有字面 `._*` 条目，但每个文件带有 `com.apple.provenance` PAX xattr（316 个），macOS 解包可据此生成 AppleDouble；此前“无 AppleDouble”的结论不成立。candidate-02/03 清单现均标作废。candidate-04 从现有 candidate-03 内容重打为 USTAR，SHA-256 `ad9b34477cbce39987a3bd5d528f1da114ac93b172663b0808df1c62eb661b25`；对应 unit SHA-256 `d9704aecc30a39942a85bcc54302bdf68dc58f826fd4146f7e6b09e561df19e0`。Python tar 检查为 316 个成员、0 PAX、0 Apple xattr/元数据、0 AppleDouble/`__MACOSX` 路径、19 个 migration；独立解包后 `._*` 文件与 `__MACOSX` 目录均为 0，app/server 与工作区哈希一致。维护者当前应只使用 [candidate-04 清单](北极星受控试运行部署命令清单-20261022-candidate-04.md)。目标机尚未部署或验证。

#### candidate-05：T10 竞态修复后的新候选及 AppleDouble 复核（2026-10-22）

candidate-04 不含随后完成的 T10 `openat` 目录句柄固定和硬链接拒绝修复，现已作废。维护者当前只应使用 [candidate-05 命令清单](北极星受控试运行部署命令清单-20261022-candidate-05.md)：归档 SHA-256 `560980df860ca7c550099e95e3ed2f203361fa189156c57ee49f455767c2844b`，systemd unit SHA-256 `f1137c9e10da4729ed7ca5a45e6d5bc020ba74f1adf4956e72f680b18b234018`。本轮复核归档 317 成员、0 PAX、0 Apple xattr/元数据、0 `._*`/`__MACOSX` 路径；独立解包 317 项后文件树中 AppleDouble 文件及 `__MACOSX` 目录为 0。归档含 19 个 SQL migration。candidate-02/03/04 均不得用于部署。目标机尚未部署，线上资格与真实 Run 未验证；T06/T07/T03 与整包状态不变。

#### candidate-06 与本轮资格/T09推进（2026-10-22）

三项隔离审查：T06/T07 确认 `/v1/models` 当前凭据返回 ID 到 `permission=true` 已实现；localPolicy/adapter/能力 override 此前只覆盖静态 YAML ID，动态返回模型仍无法放行。现已在目录同步增加按成功快照 ID 展开已确认 qualification defaults，并新增 fixture 覆盖：动态返回模型获得 permission、启用策略、adapter 与 textChat/text 模态；手动路由成功且 `verificationRequired=true`，AUTO 继续拒绝未验证模型。目录/能力/router 组 **34/34 PASS**；`google-login-integration-review-test.mjs` 与 `ui-model-switch-test.mjs` **2/2 PASS**（后者 45/45 断言）；均未访问 PT 或调用模型。实际 key 返回了哪些 ID，仍待维护者按部署清单第7步回传。

candidate-05 未包含动态资格修复，故停止使用并重打 [candidate-06](../../release-artifacts/northstar-controlled-trial-20261022-candidate-06.tar.gz)，SHA-256 `edb93d9fe31c4663e2f8d30967fcedb53c7a7e86a77f1121b19b2cfc45161b89`；systemd unit SHA-256 `2f6d0ee45505010972a872dfb047df6038eb8fb3cac89b34a0928ae0921186ae`。独立解包检查 317 成员、0 PAX、0 Apple metadata、0 `._*`/`__MACOSX`、19 migrations，且包内 server/catalog 字节与本轮工作区相同。新维护者清单为[ candidate-06 部署清单](北极星受控试运行部署命令清单-20261022-candidate-06.md)。该候选限 T06/T07 资格、T10及已有部署依赖，不含本段新 T09 分析器改动；它仍不是 Phase 1 发布。candidate-05/04 及更早包全部作废。

T09 独立审查发现点分三位数字的区域歧义：`1.234` 既可为小数也可为地区千位分组。按用户选项 A，现拒绝此类 `[+-]?[1-9][0-9]{0,2}.[0-9]{3}`，保留 `0.125`、`1234.567` 等控制值；CSV analyzer/parser/source 聚焦组 **22/22 PASS**，`git diff --check` PASS。未新增格式，T09/AC13 主状态不提升；无真实文件样本且缺完整上传/聊天/Run/UI/持久化接入。

用户询问 candidate-04 是否可用于这次纯文本资格 Run。结论：不建议。candidate-04 的基本 symlink 路径修复仍有检查/打开间目录替换竞态，且未覆盖硬链接；即使不主动调用历史预览/导出，服务端漏洞端点仍随包暴露。candidate-06 包含后续 `openat` 固定目录与硬链接拒绝修复；Darwin 本地测试不等于目标 Linux 验证。维护者仍按 candidate-06 手动执行清单；只有收到目标机回传才可报告部署、模型 ID 与 Run 结果。总体 T00–T18 **0/19**、AC01–AC24 **0/24**；T10/T16/T18及其 AC 状态不因本地切片或打包变化。

#### T03/T12/T15 本轮隔离实现与复核（2026-10-22）

三名子 agent 分别交付互不重叠切片，主 agent 复核并联合重跑定向组。T03：初始 `/api/chat` POST 在 fetch 传输失败且未获 response 时最多重放一次，复用完全相同的 serialized body 和 `Idempotency-Key`；已有Run刷新仍为GET。`ui-run-resume-review-test.mjs` **22/22**、task execution/store **2/2 PASS**；边界是两次均在 `X-Agent-Run-Id` 到达前失败后无法刷新恢复。此新自动重放不进入 candidate-06：受控真实 Run 的批准额度是 0 retries，candidate-06冻结为单 POST，避免其自动 HTTP 重放与本次额度口径冲突。T03/AC04仍未通过。

T12：显式 `maxChars:0` 不再回落默认4000，零预算下不注入记忆；新测试 **1/1 PASS**，`memory-context-budget-test.mjs` 的 mock/PGlite回归通过，语法和 diff-check通过。其它 T12范围仍缺长对话压缩、来源/确认元数据、用户控制和热会话删除失效；T12当前列 partial，AC14不变。

T15：默认 regression runner 不注入数据库凭据，三个真实 PostgreSQL suite 拆入独立 runner mode，并在 CI 添加 Node20/22 + PostgreSQL16 disposable service job。分组测试、Node语法和 Ruby YAML结构检查通过；未运行 PG suites/hosted Actions，也未检查 branch protection。T15仍 blocked。主 agent联合执行 T03/T12/T15所涉回归 `node --test tests/regression/ui-run-resume-review-test.mjs tests/regression/task-execution-test.mjs tests/regression/task-store-test.mjs tests/regression/memory-zero-budget-test.mjs tests/regression/memory-context-budget-test.mjs tests/regression/regression-plan-test.mjs`，**27/27 PASS**。证据分别见 `evidence/T03-idempotent-ambiguous-post-retry-20261022.md`、`evidence/T12-zero-budget-boundary-20261022.md`、`evidence/T15-isolated-postgres-ci-gate-20261022.md`。T13/T17早前受控子项现从untested更正为partial；T00–T18仍0/19整包PASS，AC01–AC24仍0/24端到端PASS。

#### 2026-10-22 续进展：T02禁用、T03/T07/T11修复、回滚探针与candidate-09

三名子 agent 完成新的隔离切片。T02 新增 migration 019 和仅供可信服务端调用的 `setAccountDisabled`：禁用时同一事务设置状态并撤销现存 sessions；session 读取与密码登录过滤禁用账号，Google 身份回连也拒绝创建 session；重启升级、禁用、重启登录拒绝和重新启用测试合计 **25/25 PASS**。证据 `evidence/T02-account-disable-20261022.md`；没有公开管理路由，因此操作授权流程、真实 Google/OIDC、目标 PostgreSQL仍未验，T02/AC01保持partial/blocked边界。

T08/T09 对 AC08–10/21 做了按任务包要求的独立缺口复核，新增 `evidence/T08-T09-AC08-10-21-audit-20261022.md`；未发现可不依赖真实多模态端点/真实用户文件且不引入产品假设的本地生产修复。T09 继续按用户确认的 A 拒绝未明确日期、单位和地区数字格式；T08/T09/AC 状态未提升。

T16/T18 审阅发现旧 candidate-07 回滚命令只验证本机 health，现补 public HTTPS `/healthz`，并声明任一失败即回滚未恢复、禁止模型请求并保留现场；本地清单结构/静态门禁检查 PASS，新增 `evidence/T16-T18-candidate07-rollback-health-gate-20261022.md`。未执行目标机回滚或数据/密钥恢复，T16/T18与AC19/20/24状态不变。

主 Agent 修正 T07 明确错误语义：`/api/models/select` 返回稳定 `MODEL_NOT_EXECUTABLE`、精确 `reasonCodes` 与对应中文说明；执行时权限/能力已变化的拒绝通过 durable completion 与 legacy/run SSE 终态保留同一有限原因码，AUTO 仍独立要求已验证资格。`conversation-model-preference-http-test.mjs` **1/1 PASS**：选择 unsupported textChat 模型返回 `TASK_UNSUPPORTED`；选中后撤销 permission 的 Run 在执行处失败并报告 `PERMISSION_UNKNOWN_OR_DENIED`，fixture 确认未触达 DSH。初次回归发现 completion sanitizer 丢弃数组；补入最多8个去重且长度受限的 code 后复跑通过。证据 `evidence/T07-manual-router-error-reasons-20261022.md`，T07仍partial，AC05/07仍未通过。

T03 修正 stop API 返回字段并在本地 UI 对上游状态 unknown/manual_check 展示“本地已停止但上游可能仍在运行”；UI 回归 **23/23 PASS**，语法和目标 diff-check通过。该 UI 增量在候选中被选择性移植到无重试 app.js，未带入当前工作区同文件中的自动幂等重放代码，遵守本次真实资格 Run 的 **0 retries** 额度；刷新/replay后警示仍不可恢复，且未证明真实上游仍运行，AC03/T03保持未通过。证据 `evidence/T03-AC03-upstream-stop-disclosure-20261022.md`。

T11 新增 `run-budget-event.cjs` 白名单投影，run-budget事件现在保留 maxModelCalls/maxRetries/maxOutputTokens 等限制以及 `maxRetries:0`、`maxToolCalls:0`；不会从凭据补入费用金额。专项 **2/2 PASS**，语法检查通过，见 `evidence/T11-run-budget-event-limits-20261022.md`。这只证明限额事件形状，不证明真实调用/费用计量或 AC13/22。

T13/T14/AC15 隔离审计：skill hash/Run pin 尚未接 DSH loader；当前 profile 禁止 `tool-skill`/`tool-web`，没有真实网页 fetch 调用点，未加无调用方 URL helper。发布/授权、不可变存储/Run pin隔离、来源/时间/失败态/redirect与SSRF、注入隔离仍缺，详见 `evidence/T13-T14-AC15-integration-audit-20261022.md`。T13 partial，T14与AC15未验收。

主 Agent对 T02/T03/T07/T11 与模型目录切片做联合复跑：9 个测试文件（Google/OIDC、存储升级、router/catalog、manual selection HTTP、run-budget-event 与 stop/replay UI）合计 **68/68 PASS**；`ui-model-switch-test.mjs` 另有 **45/45 assertions PASS**。联合组仍为本地/fixture/PGlite，不构成目标 PostgreSQL、真实 OAuth 或真实 provider 证据。

candidate-07/08 因后续 T07错因、回滚、T03/T11接线相继作废；当前唯一受控资格清单为 [candidate-09](北极星受控试运行部署命令清单-20261022-candidate-09.md)。归档 SHA-256 `98dc73ec9ce408192aef887497b6c5b15142c6b5fa8084d5528eacd473c58eec`，systemd unit SHA-256 `c73244dca79b04a2853db7afd11d42e20e5f6c1c4468e7b3fce244b168ecf932`。USTAR归档独立解析318 members、0 PAX、0 Apple元数据、0 AppleDouble/`__MACOSX`、0 forbidden paths、19 SQL migration；stop disclosure选择性进入无重试UI，预算事件helper已包含；T02迁移019与T03/T09/T12其他独立切片仍不在资格包。候选未部署；需维护者依编号/校验和执行清单并回传部署health、目标模型资格、唯一一次Run和原样结果。

补充 T13/T14/AC15 隔离审计：skill hash/Run pin 仍是未接 DSH loader 的纯模块原语；当前 `run-persistent` profile 禁止 `tool-skill`/`tool-web`，`web-search-pro` 配置不代表联网工具已加载。产品没有现成网页 fetch 接口，不应加无调用方的 URL helper 或开启外网。缺失 PM publish/disable授权、不可变技能存储、Run pin加载与历史Run隔离，以及来源/访问时间/失败态、redirect/private地址拒绝、注入隔离证据。详见 `evidence/T13-T14-AC15-integration-audit-20261022.md`；T13保持partial、T14/AC15未验收。

本轮不改变全局验收：T00–T18严格整包仍 **0/19**、AC01–AC24仍 **0/24**；agent 子项与 candidate Run 均不改写其他任务状态。工作区原有改动和 `wb copy/` 保留；未提交、push、merge、部署或发起付费模型请求。

#### 2026-10-22 candidate-09 清单复核修订

独立复核发现部署清单对 USTAR 的远端检查只用 `file` 判断通用 POSIX tar，无法单独证明格式；现明确记录本地对 checksum 对应 tar headers 的全量 USTAR/无 PAX 与 GNU 扩展头审计，远端 checksum 一致即绑定该审计；复核包内 `shell/.npmrc` 仅含 `legacy-peer-deps=true`，没有凭据。修正 systemd Description 从 Candidate 05 为 Candidate 09；service unit 新 SHA-256 为 `c73244dca79b04a2853db7afd11d42e20e5f6c1c4468e7b3fce244b168ecf932`，归档 SHA-256 保持 `98dc73ec9ce408192aef887497b6c5b15142c6b5fa8084d5528eacd473c58eec`；清单同时写明候选输出上限 128 tokens。`git diff --check` 通过。没有目标机部署、线上探测或模型调用；严格验收仍为 T00–T18 0/19、AC01–AC24 0/24。

并行验收补充：T13/T14 增加 `t13-t14-profile-fail-closed-test.mjs`，当前 run-persistent profile 明确禁用 `tool-skill`/`tool-web` 且只装 dsh-base；主线复跑与 T17 配置错误脱敏测试合计 3/3 PASS。T17 负例确认缺失 `baseURL` 的配置错误保留 provider/model 上下文，合成 API key 不出现在错误消息或 stack。证据分别见 `evidence/T13-T14-profile-fail-closed-regression-20261022.md`、`evidence/T17-config-error-secret-redaction-20261022.md`。这些是 fail-closed/脱敏子项，不证明功能已开放，不改变任务或 AC 状态。AC23 的设置页错误呈现暂不实现：当前 `/settings` 只管理 PT Key，没有 provider/profile mutation API 或错误契约；需产品方明确可编辑字段、提交入口与失败呈现。T13/T14 仍需明确技能 Run pin/发布授权、准入插件版本、联网域名和 fake-target；缺项继续 fail-closed。

T09 TXT/MD 上下文改为代码点安全前缀，并向 Run 上下文标注源 UTF-8 byte range、total bytes、first omitted byte及截断态；HTTP fixture覆盖短BOM多字节完整文本与长多字节截断文本，断言片段是原文精确前缀且 offset 正确。csv-document HTTP + parser/source/analysis组复跑 **23/23 PASS**，语法检查通过。T10 新增父目录已固定后叶子被换成跨租户 symlink/hardlink 的确定性回归2/2 PASS；主 Agent联合 openat/artifact/T09回归 **29/29 PASS**，`node --check shell/server.cjs` 与 `git diff --check` PASS。两者均是本地限定层，不抬升任务状态；T10仍需Linux目标验证，T09仍缺真实样本、引用UI和删除闭环。T09变更不进入 candidate-09资格包，因为该冻结包仅面向模型资格一次Run；包checksum保持不变。

主 Agent 再将 T03 durable UI、T07 手选/路由、T11 budget event、T06目录、Google auth/upgrade、T09文档HTTP/CSV、T10 artifact openat、T13/T14 fail-closed、T17 profile config 合并复跑：**100/100 PASS**，`node --check shell/server.cjs` 与 `git diff --check` 通过。这仍是本机/PGlite/fixture；没有 hosted Actions、目标 Linux、Google live、PT key、线上 health 或真实模型调用证据，严格状态不提升。

#### 2026-10-22 candidate-10 校验、T04/T12/T15复核与团队最小准入评估

先核对现场：分支仍为 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，复核时工作区有245项既有修改/未跟踪内容，随后新增三项独立回归测试及一份T12证据记录并保留全部既有内容。candidate-09 在目标 CLI 启动门禁因 DSH manifest 中的 lockfile SHA 过期而返回 `DSH_LOCK_MISMATCH`，不再可用；candidate-10 更新派生 manifest 后，本机 check PASS（DSH `0.1.1-rc.2`、20 files），manifest 与 `shell/package-lock.json` 实际 SHA `96c89082800cc682307a61436d115f5d080bb40a6f3c53a08c0478023fc993f3` 一致。冻结包仍为 USTAR candidate-10：318 members、0 PAX/GNU扩展、0 AppleDouble/forbidden paths、19 migrations；归档 SHA-256 `1d51e49e2c20330f29d5ddd749360fbbfcf8266bd4cf2093ec265b45d074e070`，unit SHA-256 `f89966536df6d60f6a86531206227df34fd310c2da61618fda11e4a80c49ee78`。维护者只应使用 [candidate-10清单](北极星受控试运行部署命令清单-20261022-candidate-10.md)。目标机未部署、未回传健康/资格/真实Run输出。

T04 独立复跑先确认 lockfile 与 manifest hash 相同，再运行 `node --test tests/regression/t04-adapter-abort-drain-test.mjs tests/regression/dsh-cli-profile-ready-test.mjs tests/regression/persistent-runner-real-sdk-rpc-probe.mjs`，**7/7 PASS，0 fail/skip**；覆盖四个 adapter abort/drain 场景、真实 DSH CLI readiness 和真实 SDK/runner harness。T04仍partial：目标环境真实任务重叠、conversation lease/session资源释放、上游停止及 Linux 行为未验，AC02/03不变。

T12 独立复核重跑 `memory-session-invalidation-http-test.mjs` **1/1**、`memory-zero-budget-test.mjs` **1/1**、`tenant-mock-smoke.mjs` **14/14**、memory-context-budget mock/PGlite聚焦组、`node --check shell/server.cjs` 及 `git diff --check` 均通过。HTTP回归验证记忆POST/DELETE只关闭当前租户热会话；失效失败时返回明确503并报告数据已保存/删除、上下文刷新未确认。该用例对 `closeDshSession` 注入记录器，未证明真实DSH RPC刷新；长对话约束、来源治理及文件/网页内容升级防护仍缺。T12 partial、AC14 untested。

T15 runner plan 复核 `node tests/regression/regression-plan-test.mjs` 的11项断言通过，覆盖三项PG suite分组、唯一执行、mock helper排除、重复输入及缺项/未知模式拒绝。当前工作流源码含 Node20/22 + PostgreSQL16 service job，但 GitHub 可查95条历史 Actions 无当前 HEAD 的运行，最新仍是旧 workflow；branch protection 查询403，空rulesets列表不能证明 required-check不存在。记录见 `evidence/T15-actions-and-required-checks-audit-20261022.md`。本地PG suites仍因无 disposable DSN 未运行通过；需把当前workflow放入 hosted Actions 实跑，并由仓库管理员确认required-check。T15仍blocked。

团队提前使用的范围结论（历史结论candidate-16已作废）：手动选模型与能力不匹配明确报错已有T07本地HTTP/PGlite和候选实现证据，可先于AUTO、T08、T09作为文本试用门槛；当前最早须维护者部署candidate-17、当前用户至少一个模型通过资格检查、并完成既有批准的单次真实验证Run之后开始。该一次验证授权不自动覆盖后续多成员/多次调用；团队扩用还需各自key按返回目录逐用户校验，并另行明确预算范围。该准入判断不改写T07或任务包整体验收状态。

本轮只更新文档状态与本地复核证据：T00–T18仍0/19整包PASS，AC01–AC24仍0/24端到端PASS；candidate包尚未部署，未调用模型，未提交/push/merge。工作树和 `wb copy/` 保留。

主 agent 对团队最低标准涉及的 T07 路由/能力/API/UI 做独立聚焦复跑：`node --test tests/regression/model-capabilities-test.mjs tests/regression/model-catalog-test.mjs tests/regression/task-router-budget-test.mjs tests/regression/conversation-model-preference-http-test.mjs tests/regression/ui-model-switch-test.mjs`，**27/27 TAP tests PASS**；目录脚本另报 **66/66**，UI模型切换 **45/45 assertions**。覆盖未知/不匹配模型 fail-closed、资格模型手动首调、选择API/执行原因、UI 不发送被拒请求及对话异步隔离；均为本地fixture/PGlite，无线上Key或模型请求。满足用户提出的最低代码行为门槛，但不代替维护者目标部署与一次已授权真实Run。

T04 另补 `t04-conversation-lease-pglite-fencing-test.mjs`，主 agent复核测试内容并重跑 **1/1 PASS**。用隔离本地PGlite验证活动conversation lease拒绝第二个Run、expiry后successor接管、旧owner不能写history或release新lease、新owner续租、被拒写入不改变history。此为本地store fencing证据；真实PostgreSQL锁竞争、DSH session生命周期和目标Linux仍未验，T04/AC状态不变。

T04再补 `t04-cancel-releases-conversation-lease-sibling-pglite-test.mjs`，主 agent检查并重跑 **1/1 PASS**。双execution service共享本地PGlite的同一conversation：A取消后仍停在executor cleanup barrier时，B保持queued且无法进入；cleanup释放后A持久化cancelled并释放lease，B再进入并completed，最终lease行清空。与stale-owner fencing测试合计2/2。这里只验证本地store/service间的租约交接，不证明真实PG多连接锁、真实DSH上游或UI；T04仍partial。

T03 另补 `t03-lost-ack-completed-replay-test.mjs`。独立子 agent 的 HTTP/UI/service 联合为 **25/25 PASS**；主 agent检查新增测试并单独重跑 **1/1 PASS**。本地PGlite中Run已持久化并完成、模拟首ACK丢失后用同body/idempotency key重提，得到同一终态Run、无第二次execution、fake provider调用仍为1次。测试直接调用Run execution service，不经过HTTP/SSE或真实provider；它补的是既有幂等窗口，不解除真实网络丢响应、目标PG、多实例恢复或provider查单缺口，T03/AC状态不变。

T12 新增 `memory-untrusted-upload-boundary-http-test.mjs`；主 agent对上传Markdown→chat→tenant调用与记忆未变断言作独立复核后再次运行 **1/1 PASS**（真实本地HTTP + PGlite、`PT_CHAT_DRYRUN=1`、无模型请求）。恶意“写入trusted system memory”文本留在标有 `UNTRUSTED_TEXT_EXCERPT` 的参考文件通道，送给执行层的 memory 参数只有此前用户显式保存的偏好，`/api/memory` 前后保持一致。测试边界仅此Markdown上传路径，不覆盖workspace/网页/工具主动写入和真实DSH；证据见 `evidence/T12-untrusted-upload-memory-boundary-20261022.md`。T12仍partial、AC14仍untested。

PT技术团队再次确认 `supported_endpoint_types` 任务语义：`anthropic`/`openai`/`openai-response`=聊天，`image-generation`=图片生成，`openai-video`=视频生成；据此不再需要逐模型人工确认。candidate-17 已按此规则生成任务和 I/O 来源事实，并只把聊天任务连接到本地 OpenAI-compatible Chat Completions adapter；本次聚焦复跑 `model-capabilities-test.mjs`、`model-catalog-test.mjs`、`model-capabilities-review-test.mjs`、`task-execution-test.mjs` **27/27 PASS**，目录旧回归 **66/66 PASS**。归档及 service checksum 仍为 `480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964` 与 `a5abf2112af069331c621232ea50033c0b30e5ef08ff50280bf0b15dd0fb8869`；无需因该确认重打包。尚无维护者部署回传，故没有目标机资格结果或真实模型响应，T06/T07/AC状态不因本地复跑提升。

主 agent 在当前工作树复跑 `artifacts-test.mjs`、`artifacts-boundary-test.mjs`、`t10-artifact-openat-leaf-race-test.mjs`、`t10-artifact-openat-nonregular-test.mjs`、`t10-artifact-tenant-symlink-audit-test.mjs`：**6/6 Node tests PASS**，其中旧路径归一化脚本 **75/75**，新增叶子 symlink/hardlink 替换和 FIFO 非阻塞拒绝均通过，HTTP租户 symlink拒绝通过。该结果说明旧 Actions 日志里反斜杠路径断言在当前工作树已修复；没有当前 HEAD 的 hosted Actions 结果。本轮运行平台为 Darwin，未验证目标 Linux `openat`/`koffi` 行为或完整产物 provenance，T10/AC11仍partial。

三项隔离复核并入：T02 密码/Google登录的 session insert 现在与 account disable 对用户行加锁串行化，避免禁用删除 sessions 后迟到 login 又签发可被重新启用复活的 cookie；`google-auth-test.mjs` **18/18 PASS**。不改变 Key rotation/常驻 DSH child 生命周期，旧Key替换/撤销的在途Run策略与禁用操作员/入口仍待产品/运营决策。T17 新增 `t17-candidate-lockfile-provenance-test.mjs`，把candidate归档hash、三份锁文件字节/哈希、代表依赖版本/source/integrity声明绑定，**2/2 PASS**；未访问registry或重打包。T05 独立复核确认child仍持有 `POWERTOKENS_API_KEY`，现有环境隔离回归期待此行为，无法作凭据隔离证据；安全host gateway需per-Run host授权预算及目标Linux egress隔离，未做半截改动。

T15 本地CI扩展复核：在一次性 PostgreSQL16 容器上运行 `node scripts/run-regression.mjs --postgres`，三个隔离PG套件 **3/3 PASS**；容器已停止并由 `docker ps` 确认不存在。当前Node v24的默认回归 **118/118 PASS**，`node scripts/ci-check.mjs` 检查352个JS文件、0失败，`git diff --check`通过。Workflow列出的25个attribution文件中 **23通过**；`a7-acceptance.test.js` 与独立 `wire-funnel-collect.test.js` 均因最后 `git diff --stat HEAD` “shell基础文件未修改”断言失败，因为本地Northstar工作树包含未提交shell改动；wire业务功能断言在该环境保护断言前通过。其余HTTP listener测试在受限沙箱首次遇 `listen EPERM`，授权沙箱外重跑6文件 **30/30 PASS**。结果不是Node20/22或hosted Actions证据；A7与wire应在干净提交态重跑，当前HEAD仍无hosted run、required check仍未确认。上述新增证据只更新本地切片，不提升T02/T05/T15/T17整体状态；T00–T18及AC01–AC24仍未达到整包严格验收。

#### 2026-10-22 · 并行验收续进展：T02、T08/T09、T10、T13/T17、T15

主 agent 加 3 个隔离审查位完成当前切片：T02 登录/禁用两种锁顺序回归 **19/19 PASS**，其中 disable-first 等待由 adapter seam 模拟，生产 PostgreSQL 锁调度仍未验证；证据 `evidence/T02-login-disable-serialization-20261022.md`。T08/T09 上传、附件、CSV parser/source/analysis 与 HTTP **24/24 PASS**，语法检查通过；审查没有发现适合绕过缺失产品输入的安全补丁，T09继续拒绝不明确格式，见 `evidence/T08-T09-audit-continuation-20261022.md`。T13/T14 保持 fail-closed；T17 candidate-lockfile 回归2/2及A7范围验证通过，但无 hosted CI 或完整外部依赖 provenance。

T10 将 candidate-17 归档在临时 Linux/AMD64 workspace 解出，分别以 Node 20.20.2 和 22.23.4、Linux x64 Koffi 3.3.3 运行 openat、叶子竞态、FIFO 和租户HTTP边界，两者均 **8/8 PASS**，证据 `evidence/T10-linux-amd64-candidate17-20261022.md`。初次7/8由测试子进程白名单未继承临时 `NODE_PATH` 导致加载宿主 macOS Koffi；改在候选临时副本的标准 node_modules 路径装 Linux依赖后复跑通过，未修改测试以回避失败。它仍是容器级Linux证据，不代替维护者目标主机验证。

T15重新运行 workflow 列出的 attribution/quality/GA **25/25 文件通过**：19个 `tests/attribution/*.test.js` 文件回归19/19，余下6个 quality/tracking/GA connector文件内部测试30/30；A7历史范围脚本PASS。此前矩阵提及的两项脏工作树保护断言失败已拆为独立历史commit CI job，现地功能/历史范围分别通过。本地Node24不能替代Node20/22；当前HEAD仍无 hosted Actions，required-check enforcement 未证。默认118/118、PG16 suites 3/3、352 JS 语法0失败为先前已记录结果，未提升整包验收。

需业务方确认（仅影响对应未验收项）：T02谁有权及通过何入口禁用账号、在途Run遇Key撤销时继续或取消；T08可用理解端点、代表媒体、答案/拒答标准及分类型验证额度；T09代表文件/预期计算和原件/派生内容保留删除边界；T13技能发布/禁用权限与Run级不可变加载；T14准入插件/版本、联网域名/重定向策略及来源展示要求；T17外部依赖责任人、来源和失效策略。上述问题不阻塞 candidate-17 由维护者部署后的资格读取，但没有维护者回传，线上模型资格与一次真实Run仍未观测。T00–T18及AC01–AC24整体状态保持未验收。

#### 2026-10-22 candidate-18 与独立验收续进展

PT 对 `supported_endpoint_types` 的确认已由 candidate-17 能力/router 逻辑及映射回归覆盖：三种 chat endpoint → 聊天、`image-generation` → 图片生成、`openai-video` → 视频生成；不再逐模型人工核验。后续预算摘要修复将非法/负数/缺失用量从误报的 `0` 改为 `null`，同时保留真实的 `0`，并接入持久 `run_budget` 事件投影；证据为 `run-budget-summary-test.mjs` 与 `run-budget-event-test.mjs`。为纳入此 runner 变更，从经审查的 candidate-17 输入生成 candidate-18。归档 SHA-256 `eb6e9cdbc931eafe4d215596b354fc498d283638a99f00f356900ed58de94f37`，unit SHA-256 `ed3b4de17f4c27fdf5552ed5b3fdc9730e77ba816e9437851473ee45db70cfa8`；USTAR/成员/路径/migration/source-byte audit **3/3 PASS**，详见 `evidence/candidate18-budget-summary-release-20261022.md` 与 candidate-18 numbered runbook。已不再建议维护者使用 candidate-17。清单中的受控真实 Run 仍限 1 HTTP request、0 retry、0 tools、180秒；本机未替维护者安装或运行模型。

本轮三条隔离线索并入，详见 `evidence/parallel-acceptance-slices-20261022.md`：T01 post-auth repository 初始化失败清理回归 **3/3 PASS**，仍缺真实 PostgreSQL、clean install与目标恢复，且 `auth.initAuth` 内 migration failure cleanup 未覆盖；T09 对日期/货币/百分比/单位歧义值及 PDF/XLSX/DOCX/PPTX/ZIP 的拒绝边界回归 **23/23 PASS**，未加入任何转换规则，仍缺试用文件/标准答案/Run引用与派生数据删除证据；T14 profile/lockfile fail-closed 回归 **8/8 PASS**，web tool 仍关闭，尚无 handler、域名/重定向/SSRF或进程级 egress 验收。T03/T04 worker在 cancelling 状态崩溃时不重放已知付费操作回归 **4/4 PASS**，仍只为本地fixture/PGlite证据。

综合受影响回归 **42/42 PASS**，`node --check shell/persistent-runner.mjs`、candidate 打包脚本语法检查及 `git diff --check` 均通过。工作区保持既有脏改动并继续增长，未清理/覆盖无关文件；未部署、未对PT/模型/registry发请求、未提交/push/merge。当前结论仍为 T00–T18 **0/19 strict full PASS**、AC01–AC24 **0/24 end-to-end PASS**；线上资格和唯一真实Run须等维护者按最新 candidate-20 清单部署并回传后核验。

最新需业务决策：T12 已确认编辑/删除已发送给上游的记忆时取消对应的活动Run；T05 仍待确认 BYOK 在 Run 中撤销/轮换后的中止策略，以及 web/CLI/bash/MCP 的开放边界。T14 需确定准入插件/精确版本及 owner、初始搜索/读取域、redirect 跳数与跨域/HTTPS规则、DNS解析到私网/loopback/metadata的拒绝条件、来源呈现格式和child联网边界。在对应契约明确前维持保守行为；其余 T02/T08/T09/T13/T17/AC18 业务输入沿用前文未决清单。
# 2026-10-22 当日增量：记忆修改时停止既有 Run

## 当日收尾复核：T12 HTTP取消与T18合成恢复原型

T12 新增 `tests/regression/memory-change-cancel-http-test.mjs`，用真实本地认证HTTP路由及PGlite Run store验证记忆POST/DELETE只取消活动Run、保留queued Run、删除后GET为空；DELETE远端取消未确认时返回503且持久Run为`cancelling`。27项断言、1/1 suite PASS。独立复跑首次在sandbox内因loopback `listen EPERM` 失败，获准在sandbox外重跑后通过。execution service在preload fixture边界stub；未请求模型，未证真实provider取消、多实例传播或目标PG。

T18新增 `shell/runtime/data-backup.cjs`、`scripts/northstar-data-backup.cjs` 和合成回归：PGlite与固定文件allowlist离线打包/恢复、不覆盖目标、拒绝PG配置、密钥分离、manifest/payload SHA校验和损坏拒绝。独立审查发现manifest父子树关系校验缺失，已补充校验和合法SHA但file-as-parent的恶意manifest测试；定向 **7/7 PASS**。路径级检查仍有并发TOCTOU；SHA不认证来源；flag不检测停写；无PG原生备份、目标机、签名加密、保留/RPO/RTO或生产恢复演练。详见 `evidence/T18-synthetic-backup-restore-20261022.md`。该CLI不接入启动/部署，也未包含在candidate-23。

最终 `node scripts/run-regression.mjs` **130 suites / 130 PASS**，Node24、dirty worktree；T12及T18新套件均包含。candidate-23 SHA未变、未部署；维护者未回传清单执行输出。T00–T18仍 **0/19 strict full PASS**、AC01–AC24仍 **0/24 E2E PASS**。该增量只更新局部证据，不改变总体验收状态。

用户确认：用户修改/删除的记忆内容若已发给上游模型且对应 Run 仍在执行，取消该 Run。`shell/server.cjs` 的记忆 POST/DELETE 路径现在先保存变更，再按当前用户和租户分页查找活动 Run 并请求取消，随后关闭其 DSH 对话会话；Run 只有进入持久化 `cancelled` 才计入成功。远端仅进入 `cancelling`、或取消/枚举失败时，接口返回 `503 MEMORY_CONTEXT_INVALIDATION_FAILED`，不会声称已停止；记忆已保存/删除的事实仍在响应中明确给出。新增 `shell/tasks/memory-run-invalidation.cjs` 与 `tests/regression/memory-change-cancels-active-runs-test.mjs`。

验证：记忆取消专测与执行服务取消回归 2/2 PASS；既有 HTTP 记忆会话刷新回归授权后 1/1 PASS；`node --check shell/server.cjs` 与 `git diff --check` PASS。沙箱第一次运行 HTTP 回归因 localhost bind EPERM 失败，经授权在沙箱外重跑通过。当前尚未验证部署环境多实例传播、真实 PT 上游取消、真实 PG。

发布边界：candidate-18 已包含 runner 预算计数修复及 T06 endpoint 能力映射，但早于 T12。candidate-19 曾包含 queued Run 取消；candidate-20 收紧为只取消已进入执行/等待外部结果的 Run，queued Run 保持不变。最新 candidate-21 再纳入 T01 `initAuth` migration-failure cleanup；archive SHA-256 `81cc6cd4467c2ef34f320ca40f71e25c10e43f50ecfcda021614948988b0140a`，unit SHA-256 `fd1ce0025cc06c384a7ff13ec5a7c7115bf22f73e9ac025cfac559f67019ed7f`，322 USTAR 成员、20 个 migration、无 AppleDouble。candidate-19/20/21包回归4/4；记忆Run取消及storage init/upgrade测试5/5，合计9/9。当前清单为 [candidate-21](北极星受控试运行部署命令清单-20261022-candidate-21.md)。包基于未提交工作区，尚未目标机部署；受控模型 Run 未执行。

### T15 / AC18 独立工作流审计

证据：`evidence/T15-AC18-local-workflow-audit-20261022.md`。Node 24 本地核查：CI 语法 358 文件通过；default regression 123/123；一次性 PostgreSQL 16 regression 3/3，容器已清理；A7 范围 verifier 通过；attribution 25 个测试文件通过（含 30 项 TAP）。workflow 中迁移 job 已纠正为“迁移文件存在性”，避免把4个 `test -s` 误报为 SQL 执行/语法测试。AC18 仍未完成：缺首字、排队、解析、生成、渲染的分阶段测量、同条件 P50/P95、真实目标浏览器/移动证据；本地结果也未覆盖 clean commit、Node 20/22 hosted Actions 与 clean install。

#### 独立验收三线（2026-10-22）

三位子 agent 完成隔离只读核查；均未改生产代码/部署/联网。T00–T04 各有局部证据但缺目标环境闭环；T05仍确认 DSH child 环境含明文 `POWERTOKENS_API_KEY`，host gateway 与 OS 网络/文件/命令隔离未完成，AC16 blocked。T06/T07资格链：当前key `/v1/models`可见ID→`permission=true`、textChat策略 enabled、PT支持endpoint按用户确认映射；当前key router/手动路由定向测试 **43/43 PASS**，只证明本地 fixture/执行路径、不证明线上资格或真实Run。T08/T09：媒体理解端点未接入（当前媒体上传及 text block 不等于模型理解）；受限 TXT/MD/CSV与CSV来源追踪局部通过，deterministic CSV analyzer 未接Run/UI，缺PDF/Office解析、引用界面及派生数据删除；parser/source/analyzer/upload/media/UI局部测试37/37、媒体mock 80/80、上传UI139/139。T13仍未把hash/pin接Run/loader；T14 web tools保持disabled且无allowlist/SSRF/child egress边界；T17虽candidate锁与源码一致但缺完整责任人/来源/到期/闭环；T18候选包/清单仍无目标机升级回滚演练，且缺数据库/文件/密钥恢复RPO/RTO。详见并行证据和各T任务独立报告；相应业务输入须在`ACCEPTANCE-STATUS`最前段汇总。

完整默认回归复跑：`node scripts/run-regression.mjs` **126 suites / 126 PASS**。首跑仅旧candidate-17发布测试失败，因其将冻结server/UI字节错误要求与当前源码相同；已将该历史检查改为对candidate-17包成员固定哈希复核，随后完整回归全绿。该修复只纠正历史快照测试条件，不修改任何产品行为。此为当前dirty worktree的Node本地证据，不是 clean checkout、Node20/22 hosted CI或完整Phase 1验收。

#### candidate-22 受控部署包复核（2026-10-22）

candidate-21 随后被 candidate-22 取代。最新包将 T01 `auth.initAuth` 在 migration 或 default-admin 初始化失败时关闭数据库句柄并保留原始错误的修复一并冻结；同时包含 runner 预算计数修复、PT endpoint 能力映射及 T12 只取消已发送上下文对应的活动 Run（queued 保留）。archive SHA-256 `0921e28b73727dec8ba9503d0bb1bd035c0e43e904df16f60f68acfa694be0f3`，unit SHA-256 `5e22ae8e8f0b98f032373c49362bcafcacc37c20fdf3a8686cc1cf2a06490862`；322 USTAR 成员、20 个 migration、无 AppleDouble。候选归档、T01 初始化清理/升级及 T12 记忆取消定向回归 **11/11 PASS**，`git diff --check` PASS。维护者唯一有效清单为 [candidate-22](北极星受控试运行部署命令清单-20261022-candidate-22.md)。目标机仍未部署；线上 `/v1/models` 权限、router 放行和真实模型回复均未观测，需维护者按编号清单执行并回传脱敏输出。本地证据不改变 T06/T07 或 T00–T18、AC01–AC24 整体验收状态。

#### candidate-23：账号限流、并发放宽及历史产物恢复（2026-10-22）

按用户要求将三项改动合并到当前最新候选，不另发单项包：`/api/chat` 限流 key 从 IP 改为已认证 `me.user.id`，默认 `PT_RATE_CHAT_PER_MIN=35`；`PT_RUNS_PER_USER=4`、`PT_RUNS_GLOBAL=16`。新包 `shell/northstar-limits.conf` 由 systemd 在 `/etc/northstar/northstar.env` 后读取，让候选值覆盖共享文件旧值；两项并发是每个 shell 进程内的调度额度，非跨多实例数据库全局锁。T10 另修复成功 Run 的 artifact 元数据持久化和历史会话重开恢复：server校验产物后与assistant消息一起保存，UI仅按相对路径/扩展名重建同源预览链接并清理旧会话面板。

router 同步收紧为只有 `state.endpointCompatible === true` 才可放行；缺失证据返回 `ENDPOINT_COMPATIBILITY_UNKNOWN`，明确不匹配仍返回 `ADAPTER_ENDPOINT_MISMATCH`。候选归档 SHA-256 `30568c8ea3f1c02369342b4338c9f484e64f61441a82491f0b5050c2afa2d4e2`；unit SHA-256 `12062c15b0195efb19a3116bf9da4006bf66db78f80bacae2e8dd17bf9eec072`；323 USTAR成员、20 migrations、无AppleDouble。限流 HTTP + 调度器 **15/15 PASS**；T10 HTTP/DB **1/1**、UI **62/62**；router及上述行为聚焦组合 **31/31 TAP PASS**；candidate19–23历史/当前包检查 **6/6 PASS**。定向复核通过；命令清单为 [candidate-23](北极星受控试运行部署命令清单-20261022-candidate-23.md)。目标测试机未部署；限流与并发值只在候选包生效，当前线上仍是旧配置。此次本地证据不改变 T00–T18 / AC01–AC24 整体验收状态。

后续 router fail-closed 集成复核：完整 `node scripts/run-regression.mjs` 首轮 **128 suites / 121 PASS / 7 FAIL**；失败均来自 7 个预期成功的合成模型目录 fixture 未给 `states.textChat.endpointCompatible=true`，router 正确拒绝未知兼容性，生产门禁不应放宽。补齐 chat usage、conversation preference、CSV HTTP、Google login、memory injection、T03 replay 与 T03 UI retry fixtures；保留 task-router 缺字段负例。7项独立复测 **7/7 PASS**，完整 default regression 随后 **128 suites / 128 PASS**。更新 T12 旧审计说明：其“在途Run不在保证范围”仅代表当时快照，现已由用户决定取消已发上游的活动Run并实现；真实上游停止、多实例PG/DSH回执仍待验证。同步修正 [验收矩阵](ACCEPTANCE-STATUS-20261018.md) 旧候选hash为当前candidate-23 hash，并更新最新回归计数。`git diff --check`、修改的7个测试文件语法检查 PASS。该本地 Node24 dirty-worktree 结果不代表clean checkout、hosted CI或T00–T18/AC整体验收。

#### T03 runner 诊断、T03 media reconciliation 与 candidate-24（2026-10-22）

修复 `persistent-runner.mjs` 失败收尾缺少 `error` 的路径：预算超限、用户取消、shutdown、SDK aborted/未完成、空/空白文本均发出安全稳定 code 与诊断；避免把SDK原始异常透传；server completion frame 保留code。adapter waiter定向覆盖 code/error传递及非用户停止语义。聚焦 runner/adapter/media 回归 **8/8 PASS**，Node语法检查和 `git diff --check` PASS；完整默认回归 **131/131 PASS**。两项历史冻结包用例调整为校验不可变candidate自身内容，不再要求旧包字节等于当前源码。

媒体路径审计确认本地图片轮询默认120秒超时不是PT任务取消；已获task id后，同一外部操作的重试worker仅GET查单，不会再POST。去重边界为 `runId:requestId`，新Run/新requestId仍可形成新收费操作；3次截图发送实际触发次数与账单金额只能用维护者的Run/operation日志和PT usage/billing核对。T11产品用量视图没有媒体provider费用/币种，不能从chat token统计倒推。截图截断暂不能证实与runner异常同根；线上DSH子进程stdout/stderr和每次Run终态日志仍是必要外部证据。用户提交的“hello”失败原因及媒体三次真实扣费记录已单独向维护者索取；没有SSH/目标机权限，未对PT发起媒体调用。

基于未部署candidate-23生成candidate-24，只更新 `shell/persistent-runner.mjs` 与 `shell/server.cjs`；归档SHA-256 `246706043e98a6b15fc0ac79db4515fada50f74d34fb67d525c28df2fb6d0d9e`，unit SHA-256 `d458a1158d9f7c461298af563b3aac20a29c6c25d4d2eee30923bbcba37369d3`，323个USTAR成员、20 migrations、无AppleDouble，包校验 **7/7 PASS**。维护者清单为 [candidate-24](北极星受控试运行部署命令清单-20261022-candidate-24.md)。候选未部署；此前批准的真实验证额度仍仅为1次文本请求、0重试、0工具、180秒，不包括图片生成。T03/T11、T06/T07及总体验收状态均未因此变更。

#### T03/AC04 幂等键恢复与 candidate-25（2026-10-22）

补齐双重 preheader 失败后页面重载找回未知 Run 的路径：浏览器只持久化 `{conversationId,idempotencyKey}`，后续以同 key owner/tenant-scoped GET 查询并通过原 Run events GET 恢复，未知时继续锁住会话，不发新的聊天 POST。会话切换时仍启动原会话的恢复；服务端返回的 conversationId 必须与记录匹配。UI隔离回归测试按场景清理storage/句柄，保留产品 fail-closed 锁语义。验证：UI conversation isolation **43/43 PASS**；UI run resume **24/24 PASS**；candidate历史包/当前包断言 **8/8 PASS**；store测试通过。包含 T03 loopback HTTP 的组合命令遇到 sandbox `listen EPERM`，随后按审批要求单独在本地 loopback 环境重跑 **1/1 PASS**；语法、Python打包脚本编译和 `git diff --check` PASS。证据见 [T03/AC04 幂等键恢复](evidence/T03-AC04-idempotency-key-recovery-20261022.md)。

从不可变candidate-24生成candidate-25，仅overlay `shell/public/app.js`、`shell/server.cjs`、`shell/tasks/store.cjs`。Archive SHA-256 `0c6cd34d6bba56c6434768653c0285a10e500caab5a0ddb16b9515cd82a239ad`；unit SHA-256 `56e469177320a6a87d7be0e2c647305493ed1b20d80f11df257696dea6b94e52`；323 USTAR成员、20 migrations、无AppleDouble/禁用路径。维护者清单：[candidate-25](北极星受控试运行部署命令清单-20261022-candidate-25.md)。候选未部署、无线上模型/媒体请求。修复计时器夹具后完整默认回归 **131/131 PASS**。严格状态仍T00–T18 0/19、AC01–AC24 0/24。维护者尚需回传 `hello` 子进程/Run日志及三次图片请求的PT账单对账材料；这些依赖已单独列明。

#### T03/AC04 sessionStorage fail-closed 与 candidate-26（2026-10-22）

独立验收复核发现 `rememberPendingSubmission()` 在 sessionStorage 写失败时吞错、仍继续 POST；页面重载后可能丢失恢复凭据。现改为成功持久化恢复键后才启动 Run/POST；写失败明确提示“这次请求未发送”，不锁会话、不访问网络。UI run-resume **25/25 PASS**；模型切换 UI harness补 sessionStorage后 **45/45 PASS**；candidate immutable/package regression **9/9 PASS**。候选26绑定后的完整默认回归 **131/131 PASS**。修正 candidate-25历史校验：candidate-25 app/server/store 以冻结字节hash核验，避免工作区变更污染旧候选判定。

candidate-25 包内 `app.js` SHA-256 `4b97e21130e19e0851794e955b598010eea9d7d196bc743123be0ffe82294f5d`，不含此 fail-closed 修复，归档仍保持不变。candidate-26 从其不可变归档仅overlay `shell/public/app.js`：归档 SHA-256 `aeeeec81d1afe686e71d63f67a0887523fe7c39d2c5753ee1cb922667d54f419`，unit SHA-256 `9940ea1559b2e4ba28911df2ce36f28ebf66a4e874665fc61dd6059f1c1bb4bb`；323个USTAR成员、20 migrations、无AppleDouble/禁用路径。维护者清单：[candidate-26](北极星受控试运行部署命令清单-20261022-candidate-26.md)。候选尚未部署；线上资格、受控文本Run，以及 `hello` 子进程日志与三次媒体账单材料仍待维护者回传。此修复不扩大一次文本请求、0重试、0工具、180秒的线上授权，也不改变T03/AC04和整体严格验收状态。

#### T03/AC03 shutdown终态一致性与 candidate-27（2026-10-22）

独立审查发现 runner 的 `RUN_INTERRUPTED` 安全诊断会沿 adapter 与 completion payload 传递，但 durable execution service 仍把非用户取消的失败一律落为 `failed`，与 Run contract 的 `interrupted` 终态不一致。现按显式 `outcome.interrupted` 或诊断码 `RUN_INTERRUPTED` 映射到 `interrupted`；补充持久 Run 状态与 `done` 事件诊断码回归。定向执行层/runner **2/2 files PASS**；candidate 绑定检查 **10/10 PASS**；新清单8个 bash 块语法检查通过；随后 `node scripts/run-regression.mjs` 全量 **131/131 suites PASS**，`git diff --check` PASS。已知 shutdown runner 夹具的 release hook 原本已存在，因此本轮没有重复修改。

从不可变 candidate-26 仅 overlay `shell/tasks/execution.cjs` 生成 candidate-27：归档 SHA-256 `91cf2af7a033c89d108b703ca9c39ee085d75f8db988ad44b3b6c808ecca367d`，unit SHA-256 `ea50acb72e28910957273a108cf9c21f5c2e00331933f655615e7ed76769809a`，323个USTAR成员、20个 migration、无 AppleDouble。独立清单复核发现第2步把压缩流直接交给`file`的错误，已改为检查解压后的 tar 流；对实际候选返回 `POSIX tar archive`，8个bash块均通过`bash -n`。详细证据：[T03 shutdown终态修复](evidence/T03-run-interrupted-terminal-state-candidate27-20261022.md)；唯一最新维护者清单：[candidate-27](北极星受控试运行部署命令清单-20261022-candidate-27.md)。候选未部署；线上 qualification/文本Run、`hello` DSH child日志及三次媒体Run/PT账单仍待维护者回传。没有图片调用。本修复不改变T03/AC03或T00–T18、AC01–AC24整包验收状态。

#### T18 dirfd 原语前置切片（2026-10-22）

为现有 PGlite 备份原型准备独立 Darwin/Linux dirfd 原语，新增 `shell/runtime/backup-fs.cjs` 与 `tests/regression/northstar-backup-fs-test.mjs`。`pinDirectory`逐段`openat(O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`固定目录；相对打开、独占创建、mkdir/unlink/link与fchmod均使用固定句柄。确定性测试在pin后rename原目录并建立同名替代目录，确认后续I/O仍落在原inode；同时覆盖symlink/path traversal拒绝。Darwin helper测试 **2/2 PASS**、Node语法与diff检查通过。安全枚举目前显式失败关闭，没有接入 `data-backup.cjs`；Linux ABI、源一致性与真正备份/恢复竞态仍待验证。完整边界见 [T18 dirfd 原语证据](evidence/T18-dirfd-primitives-20261022.md)。T18/AC24继续blocked。

#### Candidate-28、T06逐模型权限与当前验收边界（2026-10-22）

按用户已确认的规则，从不可变 candidate-27 仅覆盖 `shell/model-catalog.cjs`，生成 candidate-28：归档 SHA-256 `1d50a46516ad1d3501889c3caaa814967a77e02e8b8bda9edcc1cb1f669789f4`，unit SHA-256 `ccb75eeb1e36abe5602066beebe6fc206003969308d434e6f4df344b9d8b4b61`。目录响应中出现的 ID 对当前 key 赋 `permission=true`；缓存中省略的ID不获授权；页是否完整与逐ID授权分开，只有有完整性证据才允许 removed/tombstone。candidate28 USTAR 单文件 overlay、hash、目录清单绑定专项 **2/2 PASS**；323 members、20 migrations、无AppleDouble/禁用路径，实际解压后 `file` 报 POSIX tar archive；维护者清单8个 bash 块通过 `bash -n`。唯一最新编号清单为 [candidate-28](北极星受控试运行部署命令清单-20261022-candidate-28.md)，candidate-27 清单已标明被取代。候选尚未部署；目标 `/api/models` 字段与获准的一次手动文本Run仍待维护者执行和脱敏回传。证据：[candidate-28 package verification](evidence/candidate28-package-verification-20261022.md)。本变更不改变T06/T07或整包状态。

三子 agent 本轮独立核验：T00–T05 的失败 `code/error` 已以本地 HTTP + PGlite fixture 断言经过terminal event持久化与同幂等键replay，专测 **1/1 PASS**，详见[evidence](evidence/T03-failure-diagnostic-http-replay-20261022.md)；queue/setup/bad-JSON 等非Run异常口仍需审计原始错误回显。T06–T12 确认 current permission/localPolicy/endpoint mapping/manual router path 已在本地接线；新HTTP fixture用真实model-catalog接收 fake PT partial page，经`/api/models`、手动选择及dry-run `/api/chat`进入所选模型执行边界，**1/1 PASS**，详见[evidence](evidence/T06-paginated-current-key-http-router-20261022.md)。候选28单文件 overlay及hash专项 **2/2 PASS**。T13–T18 确认 T18 helper 尚未接 `data-backup.cjs`，因此没有消除实际 path-based TOCTOU；Darwin enumeration 现有 **3/3 PASS**，Linux enum ABI仍 fail-closed。T16依赖闭包不可凭lockfile简单遍历证明：还需锁定npm Arborist、固定平台并从可信tarball生成逐文件manifest，相关策略问题已向发布方单独确认。最新全量本地回归 `node scripts/run-regression.mjs` **133/133 PASS**，包含T03失败诊断replay及T06分页权限HTTP集成夹具。项目严格验收仍T00–T18 0/19、AC01–AC24 0/24。

#### T03 诊断出口安全性及媒体半句回复根因比较（2026-10-22）

T00–T05 子 agent 完成 runner 非 Run 控制异常出口收敛：setup、queue、malformed JSON/frame、unsupported command 使用固定安全 `code/error`，不回显原始帧、租户字段或异常秘密文本；新增 `persistent-runner-control-errors-test.mjs`，与并发 runner 测试 **3/3 PASS**，语法及局部 diff 检查通过。该后续修改尚未进入candidate-28，candidate-28包与部署清单不包含本次增量。

媒体回复截断与“退出码 null”的直接路径比较已补入[T03/T11案例记录](evidence/T03-T11-media-timeout-and-truncated-reply-20261022.md)：当前 DSH aborted/incomplete 路径会带安全诊断，由 server 落库为 `（DSH 执行失败：...）` 加已产生文本；截图中两条只有模型回复前缀，没有失败包装，故不支持二者是同一个直接收尾路径，仍不能排除更低层的共因。定案须取得维护者提供的 hello Run/child ID、带时间戳 DSH stdout/stderr、SDK finish reason/终态事件，以及三次图片 Run/operation/task ID、POST/poll/终态记录和对应脱敏 PT usage/billing 行。代码仓库没有 PT 媒体账单来源，Usage 页的 Chat Tokens 不能推导图片费用。三次媒体请求尚未在线重放；早前授权的一次文本/零重试/零工具/180秒额度不包含真实图片生成。

T11/AC22 独立审计确认 `chat_usage` 只记录 SDK 可见的 response tokens，费用字段仍 unknown；`run_external_operations`有 task/query lifecycle 而无 PT费用，且 Usage 页面不读这些记录。定向usage/media回归 **38/38 PASS**，UI usage **22/22 PASS**，全部 fake/PGlite。

T13–T14 子 agent 新增实际 DSH profile 启动可观测性探针：有效 config 显示 `tool-skill disabled`，但 CLI ready 帧不暴露 live agent/plugin registry；探针正确返回 `BLOCKED_UNOBSERVABLE`，未伪报验证通过。相关T13/T14聚焦测试 **2/2 PASS**；T13/AC15状态不变。项目整体验收和线上资格验证状态均不因这些本地证据改变。

#### 2026-10-22 下班停点：candidate-29 尚待独立核验

本次用户报告的 runner 诊断缺口已修复并有聚焦验证：控制协议坏 JSON/非法帧、未知命令、setup/queue 异常改用固定安全 `code/error`，不回显输入或异常秘密文本；`persistent-runner-control-errors-test.mjs` 与 runner 并发测试 **3/3 PASS**。媒体半句与“退出码 null”做了代码路径比较并补入 `T03-T11-media-timeout-and-truncated-reply-20261022.md`：若 DSH turn 以 aborted/incomplete 失败，server 持久化文本会带 `（DSH 执行失败：...）` 前缀；截图两条可见回复无该前缀，因此不支持它们属于同一个直接收尾路径，但线上共同的低层原因仍未知。已将需维护者一次性提供的 hello Run/child 日志、三次图片 Run/operation/task 日志及对应 PT usage/billing 行写入证据。没有访问目标机、没有做真实图片调用。

candidate-29 已从不可变 candidate-28 单文件覆盖 `shell/persistent-runner.mjs` 并生成，323个成员；当前归档 SHA-256 `e060ebbfed060e8b2d61366d926475abf35a2c178a1b66283b871ec32608cc1f`，service unit SHA-256 `0e56a95c8b43df985a197d0ea32a08cb3614b5eb4436de2dc1bb23498fe7c3c6`。部署清单旧文案曾因机械替换保留 candidate-27/model-catalog 叙述，已手动改成 candidate-29/runner 说明；随后尚未重新做清单完整性检查。`scripts/package-northstar-candidate29.py` 仍会从 candidate-28 旧清单生成有误的说明，需要改成生成正确 lineage，再验证 builder 可复现、USTAR 原始头、无 AppleDouble/禁用路径、仅一个 overlay 文件变化、20 migrations、8个命令块 bash 语法与所有 checksum。**candidate-29 未完成发布审计、不得交维护者部署、未部署。**

本轮最近一次完整回归仍为 candidate-28 工作区的 `node scripts/run-regression.mjs` **133/133 PASS**；T11媒体/usage 专项 **38/38 PASS**，usage UI **22/22 PASS**；T13运行时探针专项 **2/2 PASS**（探针本身以 `BLOCKED_UNOBSERVABLE` 如实 fail-closed）。这些不验证 candidate-29 全量回归或线上行为。整包严格状态仍 T00–T18 **0/19**、AC01–AC24 **0/24**；candidate-29 以外的dirty工作区、`wb copy/` 与此前未提交文件均未清理、未提交。

**下次精确恢复边界：**先检查 `git status --short` 保全用户工作；修复 candidate-29 builder 的 runbook 生成逻辑（不得覆盖既有产物前先校验内容/hash），确认手动修正后的 candidate-29 文档和 builder 输出一致；然后核验归档 header/member/path/checksum/unit、8个部署命令块语法和 candidate-28 单文件差异，产出候选审计证据并更新最新清单索引。完成上述核验后再决定是否替换candidate-28为最新维护者清单；仍只等待维护者执行及回传。随后继续T03/T11外部日志/账单核对与剩余Phase 1切片。未获额外授权时不部署、不触发模型或媒体请求、不commit/push/merge。

#### 2026-10-22 下班停点：candidate-31与T11分页待收敛

本次继续修复 runner 控制错误传递：`dsh-adapter.cjs` 对 setup 前失败与已关联 session 的安全错误码/说明进行结算，未关联错误只记安全 warning，不中止其他 Run；新增 fake-child 回归与 RPC 测试共 **11 assertions PASS**，语法及 `git diff --check` 通过。该证据仅覆盖本地适配层，仍需目标机 DSH stdout/stderr 才能诊断 `hello` 为何触发失败。Candidate-30 从 candidate-29 单文件覆盖生成并通过发布结构独立审计：归档 SHA-256 `dcabffe5cfc04e4280e92e221cc5c15e4c64379134be1747c59ac401ffb21559`，unit SHA-256 `116cda02601ebef2dbb8a39d53787f03defe69ca16d669fe17ecb76fda7f3175`；323个成员、20个 migration、USTAR、无 AppleDouble/禁用路径。它未含T11用量UI，不能作为包含该功能的最终候选。

T11 新增媒体外部操作用量 API/UI：按 user 与 tenant 隔离，仅投影安全字段，费用和币种明确显示 unknown；本地HTTP/PGlite测试 **1/1 PASS**，UI用量断言 **24/24 PASS**。独立审计发现接口仍缺稳定分页/下一页，且媒体按滚动天数筛选、工具按日历日筛选，语义尚待产品确认。已开始 candidate-31（candidate-30基底、四文件T11 overlay），当时记录归档 SHA-256 `c006237dd8d48fcae71f13f852f772ec4a87fc986696c6d2d1007088cab01fa8`、unit SHA-256 `17991a2eed391b3270e9bc85e572849146f988e7f410d20c02b80c14312c2a9e`；但分页实现与打包并行，随后来源文件发生变化，candidate-31可复现性/发布测试失败。该哈希仅记录停点当时产物，不代表有效候选；不得交维护者部署。分页编辑已中止，需先检查当前diff，再完成实现及定向回归，之后重建候选与runbook并独立核对。

T18 Linux x64 离线探针确认环境没有编译器/headers，workspace也没有 Koffi Linux x64 binary；未猜 ABI、未接入生产备份路径。T18/AC24仍未完成。项目严格验收仍 T00–T18 **0/19**、AC01–AC24 **0/24**；未部署、未调用模型或媒体服务。最新完整默认回归仍是先前 candidate-28 工作区 **133/133 PASS**，本次新改动不包含在该全量结果中。工作区原有 dirty 与 `wb copy/` 均保留，未提交。

**待业务方确认：**T11 用量筛选采用日历周期（推荐，统一现有工具用量）还是滚动24小时/7天/30天；T16 的固定目标Linux平台与npm Arborist/依赖闭包策略。**待维护者提供：**hello失败对应的DSH子进程stdout/stderr；截图三次图片Run的operation/task、POST/poll/终态日志及对应脱敏PT用量/账单行。该资料才能核对真实扣费和线上根因。

**明日恢复步骤：**先复核 `git status --short --branch`、HEAD、目标文件diff及agent停止状态；检查分页改动是否落盘，完成分页与日期筛选语义（先读取业务方答复），补齐API失败分支和下一页测试；重建candidate-31或后续编号包，确认builder `--check`、归档hash/unit/runbook一致、USTAR成员/禁用路径/AppleDouble、精确overlay及编号命令语法；再做独立发布审计和适用的全量回归。之后才可把具体清单交维护者；目标机执行及已授权的单次文本验证仍以维护者回传为准。今日无后台agent工作；不部署、不调用模型/媒体、不commit/push/merge。

#### 2026-10-23 T11 分页、日历日口径与 candidate-32

恢复时核对分支 `feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`；工作区有360项既有改动/未跟踪内容（包括 `wb copy/`），全部保留。旧candidate-31复现检查失败，确认其封包字节已与当前overlay源码不一致；没有覆盖candidate-31产物。基于不可变candidate-30建立candidate-32，并将 `listRecent` 的 today/week/month 窗口改为与 `tool_calls` 相同的 `date_trunc('day', now())` 日历日下界，保留按不可变operation UUID倒序的稳定游标分页。工具日志代码已使用该日历日口径，故采用工作记录原建议，无需新增业务决策。

验证：媒体用量 HTTP/PGlite回归 **1/1 PASS**（用户隔离、limit/nextCursor、第二页、calendar-week 边界、today排除旧记录、raw provider payload不暴露）；UI用量回归 **26/26 assertions PASS**（加载下一页追加内容、末页隐藏按钮）；candidate-32发布审计 **2/2 PASS**（USTAR headers/323唯一members/20 migrations/路径审计、四文件overlay与当前源字节一致、runbook checksum/复现/8个bash块语法）；相关Node/Python语法检查及 `git diff --check` 通过。归档SHA-256 `c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3`，service SHA-256 `4c26ab4acf9347556e0e3bdedea822090862331b8f31a1d5ef0c25802a996bc5`。唯一当前candidate清单为candidate-32；目标机部署、health、rollback与模型资格/受控文本Run仍待维护者执行回传。没有部署或模型/媒体调用；T00–T18仍0/19整包PASS、AC01–AC24仍0/24端到端PASS；未commit/push/merge，工作区与 `wb copy/` 保持原状。

#### 2026-10-23 candidate-32继承项复核、成功路径用量与T16门禁方案

更正候选范围说明：candidate-32不只“携带一项全新T11逻辑”；它从candidate-30继承 candidate-28 引入的聊天账号限流 **35次/分钟**、Run并发 **4/账号、16全局**，以及candidate-24起持续收敛的DSH安全失败诊断。候选归档直接检查确认 limiter key 为 `me.user.id`，候选限额文件值为35/4/16；DSH runner/adaptor含稳定安全错误说明，子进程close路径返回 `DSH_PROCESS_EXIT` /“常驻 DSH 进程退出”，不依赖 `exitCode=null` 文案。候选结构回归增加上述继承断言，仍 **2/2 PASS**。这些代码在candidate-32中，但目标机是否部署生效待同事回传。

T11 本轮改动为媒体外部操作用量分页与统一日历日边界；没有改动成功路径token写库逻辑。candidate-32所含 `server.cjs` 已在成功完成分支调用 `persistUsage()`；本轮将 `chat-usage-failure-accounting-test.mjs` 扩为成功、失败、停止三路径，HTTP/PGlite fake-runner 用例 **1/1 PASS**，成功Run按 `run_id/response_seq` 持久化prompt/completion/total与coverage。此为本地fake runner证据，不代表真实DSH/PT账单验收；媒体费用仍 unknown。

用户确认 T16 目标固定为 Linux/amd64，并同意用锁定版本Arborist + 逐文件manifest校验依赖闭包。按candidate-32原部署清单Node最低20.6先选择 `@npmcli/arborist@8.0.5`（registry metadata声明支持 Node `^18.17.0 || >=20.5.0`），作为精确devDependency写入shell manifest/lock。新增 `scripts/northstar-dependency-closure.cjs`，核对Arborist installed/lock生产依赖图身份，并逐包记录安装后文件hash；拒绝未锁定/版本不符依赖、必需边缺失、link package、越界symlink及多余生产包。明确 clean locked `npm ci` 是来源信任边界；manifest记录实际安装字节，不独立重算tarball SRI。另按Arborist报告锁定添加 `react@18.3.1`、`react-dom@18.3.1`，补齐use-sync-external-store及react-virtual的必需peer边；不改candidate-32冻结归档。首次独立复核发现多余生产包未拒绝，已补实现与回归；再从Linux clean install的EBADENGINE警告发现production `@earendil-works/pi-ai@0.82.1`需Node >=22.19、`commander@15.0.0`需>=22.12，故验证helper运行时门槛调整为Node >=22.19；candidate-32清单最低值20.6低于此依赖声明，但目标机历史安装版本为24.22，因此当前部署不受影响，按用户指示该文档差异留待后续候选修正，不改已发清单。Node 20试跑于manifest生成前停止。再锁定 `semver@7.8.5` 并检查实际安装生产闭包的194个 `engines.node` 声明；另加稳定码点排序；helper回归 **9/9 PASS**。先前Darwin/arm64扫描（468 packages / 30,066 files）发生在多余包门禁前，只是历史探索结果，不代表强化后的检查通过，也不能当作Linux证据。

T16 Linux/amd64实跑已完成：隔离 `node:22-bookworm-slim`（Node22.23.4、npm10.9.9）只读挂载项目后复制到容器内，clean `npm ci` 安装621包；Arborist 8.0.5生成manifest **PASS：472生产包/30,091文件**，再clean `npm ci` 后 `--check` 独立重建 **PASS**，194个生产包engine声明均满足。另将checker改为允许受支持的不同Node版本，只忽略生成器与checker的Node版本元数据，其余依赖身份、锁hash、安装文件hash必须匹配；跨版本逻辑单测覆盖。Node24.22 Docker镜像拉取遇Docker Hub EOF，未声称完成目标主机版本实测。当前package-lock SHA-256 `795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912`，manifest SHA-256 `bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe`。完整逐文件manifest见 `evidence/T16-dependency-closure-linux-amd64-node22.23.4.json`。T16闭包验证切片通过；仍需在后续release candidate冻结manifest、helper源码、Arborist/semver lock integrity、Node镜像/版本和候选输入后完成发布绑定。Node20.20.2试跑发现生产依赖engine不兼容后已在生成manifest前停止。candidate-32仍未改动并由同事部署。安装Arborist/React依赖后npm报告整个shell lock tree有8项audit advisories（3 moderate/5 high），本轮未分类/修复；Arborist及semver均为devDependency，不进入生产closure及candidate-32。

三子agent并行只读复核均已返回：T11成功分支调用 `persistUsage()`、本轮fake-runner HTTP/PGlite测试证明按run/response序写入token与coverage，但真实SDK事件提取及DSH/provider端到端仍未证明；另发现落库异常会被捕获记日志，业务响应仍可能成功，需保留为存储故障风险。T03继续由本地验证支持：失ack完成重放、断开后同key重放、媒体poll timeout query-only/no-resubmit三条回归 **3/3 PASS**；仍无candidate-32目标机health/日志、模型资格/真实Run或PT账单feed，因此线上T03根因和媒体对账未评估。整包验收仍T00–T18 **0/19**、AC01–AC24 **0/24**。

candidate-32依用户安排交同事部署，我未操作目标机；三项“是否纳入候选”的正确判断是已由candidate-32继承，无需另排candidate-33。后续工作不等待目标机回传：继续推进本地重构，回传到达后再核对部署/回滚/受控Run及T03外部证据；在干净Linux/amd64环境复跑npm ci、生成并独立check closure manifest后，按后续candidate绑定。所有目标机与PT侧证据仍由维护者提供；未commit/push/merge/deploy。

#### 2026-10-23 继续重构：依赖engine核验与T11用量持久化重试

用户明确candidate-32部署清单中的Node >=20.6与依赖实际要求不一致，但目标机历史安装Node24.22，本次部署不受影响；只需在后续候选更新文档。遵照此范围，未修改candidate-32归档或已发清单。T16 helper新增精确 `semver@7.8.5` devDependency，并对Linux实际安装的生产闭包逐包检查 `engines.node`，把声明写入manifest；通过Node22.23.4下 clean `npm ci`、manifest生成和第二次 clean `npm ci` 后独立 `--check`。最终值：472个生产包、30,091个文件、194个engine声明满足；package-lock SHA-256 `795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912`，manifest SHA-256 `bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe`。本地T16 helper **8/8 PASS**。

针对独立审计发现的T11落库异常被吞后仍报告成功，给带 `runId + usageEvidence` 的幂等写入增加一次短重试，仅对PostgreSQL瞬时连接/事务错误启用；旧式非幂等写入不重试。两次失败仍以安全错误码、Run ID和尝试次数记错误日志，仍不会把模型响应改为失败。扩展HTTP/PGlite fake-runner回归，注入一次SQLSTATE 08006后确认重试成功且原Run的usage row仍完整，测试 **1/1 PASS**。这降低一次性连接抖动导致漏记的概率，但持续数据库故障仍可能出现成功响应而无usage row；真实DSH/provider事件采集未验证。

候选边界：改动后复跑candidate-32发布审计，结构测试曾因工作树 `shell/server.cjs` 已不再字节等于candidate-32中冻结文件而失败，重现builder `--check`也会得到不同归档。这是后续T11源改动导致的预期漂移，不是candidate-32归档或已发清单被修改；归档SHA和清单保持原值。为继续独立验证已将candidate-32测试改为核验冻结归档/清单哈希、USTAR结构、包内限流与DSH断路诊断，并排除server当前源快照比较；它不再声称从已前进工作树重建candidate-32。冻结结构/清单回归 **2/2 PASS**。当前工作树因此不能再被声称为candidate-32可复现来源，后续候选需明确吸收此server改动及T16 lock/helper/manifest输入后重新构建、审计。当前T16 helper + T11 HTTP/PGlite回归 **10/10 PASS**，含单次瞬时写入故障重试；和candidate-32冻结检查合并 **12/12 PASS**，语法和本轮触碰文件的`git diff --check`通过。仍未部署、commit、push或merge。

三路子Agent并行只读复核的后续优先级：T03先补隔离HTTP服务进程重启后按同key查回已accept Run、恢复事件/终态且不重复POST/provider执行，并覆盖运行中进程死亡后的interrupted语义；T11再评估数据库提交后ACK丢失重试的幂等证据，持续数据库故障仍可能让成功响应缺usage row；T16若形成candidate-33草稿，须从candidate-32不可变包显式覆盖server、package.json/lock、.npmrc、closure helper与manifest，绑定独立unit/runbook和hash，不能复用candidate-32 builder或把整个dirty工作树打包。以上均是本地下一步，不能替代真实DSH/provider、目标机或PT账单证据。

#### 2026-10-23 部署状态更新：candidate-32 已上线

用户报告 candidate-32 已部署上线。此项更新覆盖上文“目标机部署待回传”的历史状态；目前只记录部署状态，尚未收到目标 health/启动日志、回滚检查、受控 Run 或PT账单证据，因此不提升 T00–T18 或 AC01–AC24 验收状态。candidate-32归档与已发清单仍按原 SHA 冻结。继续本地重构，不等待目标机材料；收到回传后再核实目标Node实际版本、版本生效情况与用量落库。

#### 2026-10-23 candidate-32 上线后阻断：模型目录 unknown，AUTO 无候选

用户报告对话仍不可用：模型项显示“目录状态未确认”，AUTO也不可执行。三路只读复核一致：candidate-32 的 UI 文案来自 `/api/models` 每个模型 eligibility 的 `AVAILABILITY_UNKNOWN`；router 在权限、能力和runtime资格前先检查目录整体 availability，所以所有模型会同样被拒，AUTO也返回无候选。目录代码只在当前用户/当前key作用域成功同步后产生 available；缺key/解密失败或首次 PT `/v1/models` 请求失败时会显示 YAML 静态模型并保持 unknown。候选包中的 `model-catalog.cjs`、`catalog-cache.cjs`、`task-router.cjs` 和 `app.js` 与当前工作树一致；candidate-32单页同步只可能造成缺页模型 unavailable，不足以单独解释 unknown。下一诊断只需当前登录会话一次脱敏 `GET /api/models`：`ok, syncedAt, syncError, models.length` 与1–2项的 `id, availability, permission, eligibility.code/detail.reasons[].code`；不得提供Key、cookie或请求头。若是通用fetch失败，再按错误类别查service日志与上游HTTP状态，期间不发聊天/模型请求、不放宽fail-closed门禁。

本地修补已完成：`fetchPtSnapshot` 现返回稳定错误类别（HTTP状态、超时、网络、无效JSON、空/不识别响应）；目录缓存写失败不再静默，API回传 `availability` 与不含凭据/用户标识的 `catalogDiagnostics`，服务日志只记错误类别、HTTP状态、失败次数和模型计数。Key缺失与解密失败分开记录，异常原文不回传。前端在目录unknown时显示原因并把阻断建议改为检查目录同步，不再让用户切到同样不可用的AUTO；路由仍fail-closed。模型目录诊断及HTTP/API集成 **4/4 PASS**，UI模型切换 **47/47 PASS**，Node语法与触碰文件`git diff --check`通过。

按T16闭包计划从冻结candidate-32生成仅本地 candidate-33-draft：基底SHA仍为 `c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3`；draft归档SHA `7507bb696228e1756c5afba2609d0cfde7559a0fefe4825fba59eefe7c70193c`，service SHA `550390488200bb578339a0b792e073f53442f1bfb27d9f367d6ea63fac8c9e13`，325成员（5个显式覆盖、2个闭包文件新增）；builder含精确成员/USTAR路径/内容差异审计，连续 `--check` 重建通过。draft随包加入T16 helper与472包/30,091文件manifest，目标Linux/amd64，Node >=22.19。draft说明见[evidence](evidence/candidate33-model-catalog-diagnostics-draft-20261023.md)。它只解决诊断与文案，并不预先解决此次线上首次目录同步失败的实际环境根因；没有用户授权，不部署、不发送给维护者。candidate-32归档、unit、已发清单hash复核仍分别为`c10fcc…972e7d3`、`4c26ab…a996bc5`、`9c252a…be9eb`。

本轮延续复核：candidate-33 builder `--check`再次PASS，归档/服务SHA与上述记录一致；目录诊断及conversation HTTP用例合计 **5/5 PASS**，UI模型切换 **47/47 PASS**，修改文件语法检查与`git diff --check`通过。此次复核没有新增线上证据；需等当前登录态 `/api/models` 的脱敏字段或目标机安全日志，才能判断candidate-32实例首次目录同步失败的环境根因。candidate-33仍是本地草稿，未部署或交付。

用户回传当前candidate-32的 `/api/models`：HTTP 200、`syncError=Model catalog unavailable`、`syncedAt=0`、`models.length=24`。与candidate-32归档源逐字对照，`Model catalog unavailable` 是 `ensureModelCatalog()` 对 `getCatalog()` rejection 的通用fallback；因此可排除普通缺Key（返回另一文案）和已分类的PT上游HTTP错误，确认目录缓存/同步/合并处理内部抛错，24项为静态fallback，尚不能从响应反推具体抛错点。candidate-32 catch不记录异常类型/代码，故现有实例无法补取该信息。

为下一诊断增补安全分类：server仅记录固定错误类别/已知系统错误码，API `catalogDiagnostics.errorCode`回传固定码，不保留原始异常、路径或凭据；UI显示该安全诊断码，同时保持unknown阻断。HTTP故障注入确认异常文本和任意未知异常码不进入API或日志；目录/API回归 **5/5 PASS**，UI模型切换 **48/48 PASS**，语法与`git diff --check`通过。candidate-33原草稿继续保留，另生成candidate-33-draft-r1：SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`，service SHA `550390488200bb578339a0b792e073f53442f1bfb27d9f367d6ea63fac8c9e13`，325成员，builder `--check`可重复通过。证据见[evidence](evidence/candidate33-model-catalog-diagnostics-draft-r1-20261023.md)。r1只是定位用的本地草稿，不会自行修复当前candidate-32故障；要取得具体异常码需经独立包/运行手册审计并由用户确认候选后才能部署，再读取该端点的安全诊断码。未部署、交付、commit、push或merge。

独立核查r1 service unit时发现其工作目录仍指向未版本化匹配的 `controlled-trial-20261022-candidate-33-draft`，因此r1不交付且保留原件。新建draft-r2，将unit的WorkingDirectory、EnvironmentFile、ExecStart统一改为 `/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell`；归档内容与r1一致，SHA仍为`bcc466…1d0fdc77`，unit SHA更新为`eeda8f…8136105`。独立对比冻结candidate-32归档确认325个成员、变化恰为5个覆盖+2个新增、全USTAR；unit三处路径匹配版本目录；r2 builder `--check`通过。运行手册和独立部署审查尚未完成，因此r2仍仅供本地审阅，未部署或交付。

完成candidate-33 draft-r2专用诊断部署清单：[清单](北极星诊断部署清单-20261023-candidate-33-draft-r2.md)。内容限定为备份、健康检查和登录态 `/api/models` GET，不含模型调用；保留Linux/amd64、Node >=22.19、Arborist+逐文件manifest closure检查、严格checksum和candidate-32回滚。原有bash命令块通过`bash -n`，r2包审计与可重复构建通过。用户随后明确授权按清单执行并把当时的ZIP交同事；并行审计发现交接ZIP未同步清单修订，另修正切换失败回滚要求和health步骤边界。**当前须以rev4 ZIP替换旧包后再继续；** ZIP完整性、5个成员字节与工作区一致性及6个bash块`bash -n`均通过，尚无目标机执行回传。

#### 2026-10-23 candidate-33 r2 交接包修订

用户报告已将此前candidate-33诊断部署包交同事，并授权继续本地工作。三个子agent并行复审发现旧ZIP内runbook（8,980 bytes）落后于工作区，缺少unit/env可读性检查、candidate-32运行路径断言与四项unit精确路径核对；同时切换失败后回滚规则不足，且health检查与切换命令块重复。现已更新runbook：`install`、`daemon-reload`、`restart`、`is-active`任一失败必须立即运行回滚块；切换命令、两端health、API诊断各自独立，失败停止门槛明确；status证据同步授权范围并标记旧包过期。

新交接包为 `release-artifacts/northstar-diagnostic-handoff-candidate-33-r2-rev4.zip`，SHA-256 `953fcd4b26e0155248c8c6957dfde91df418b00230c2b4d57bd0338636ab52a0`；ZIP内5个文件逐字节匹配工作区，`testzip()`通过，6个bash块通过`bash -n`，`git diff --check`通过。候选归档SHA仍`bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`，unit SHA仍`eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105`。旧ZIP需停止使用并改发rev4；截至本记录，无目标机回传，无法确认同事是否已执行任何部署步骤。没有模型/聊天调用、目标机操作、commit、push或merge。

#### 2026-10-23 T03 lease recovery 与 T11 usage evidence 并行收敛

T03 lease recovery新增周期sweep：启动先恢复到期lease，随后每5秒最多恢复100个；single-flight、`unref`、停机清timer并等待in-flight，SIGTERM先于异步初始化完成时由shutdown gate阻止late timer。错误回调再抛错也不会造成unhandled rejection，下一tick可重试。lease recovery不再按宽泛JSON外形跳过待检查队列；dispatcher只对SQL筛入扫描批次的请求用canonical replay validator。无效queued Run原子转`interrupted`并写`RUN_REQUEST_NOT_REPLAYABLE` done事件。dispatcher有效claim上限与候选扫描预算分离，扫描最多100条；invalid在`limit=1`时被终结后，同一claim调用仍可claim后续valid Run。聚焦PGlite/定时器组合回归 **10/10 PASS**，命令：`node --test tests/regression/queued-run-recovery-test.mjs tests/regression/queued-run-conversation-serialization-test.mjs tests/regression/lease-recovery-sweep-test.mjs tests/regression/t03-lease-recovery-sweep-test.mjs tests/regression/t03-cancelling-crash-recovery-test.mjs`；覆盖invalid+valid同批、全invalid有界退出、并发同会话串行、expired lease终结且不重复执行、single-flight/logger异常/停机门禁。HTTP same-key断线测试代码已静态审阅，能证明mock runner只调用一次、同key读回原Run及terminal event；尚未运行本机loopback，不能外推真实provider执行/计费或响应头之前丢ACK。T03仍是局部证据，不提升整项或AC验收。

T11 response usage新增严格总量语义：四项分量完整时，`totalTokens`必须等于四项安全整数之和；溢出或矛盾显式total以固定`USAGE_EVIDENCE_INVALID`拒绝；分量不全不再猜测input+output，只有上游明确给出的total保留并仍标partial/unknown。UI对partial已知值显示“覆盖不完整”，模型分布不展示其数值或比例柱。usage/SDK/落库/用量UI聚焦回归通过，UI断言 **26/26 PASS**；ACK-loss HTTP/PGlite夹具由agent报告 **1/1 PASS**。这些均为本地fixture/PGlite，非真实DSH付费调用或线上账单证据。迁移016保留旧`total_tokens`且历史cache分量不可还原；当时记录的“后续建议新增semantics migration”已由下文migration 020实现取代，目标库历史行数仍未盘点。

本轮包边界和交叉依赖复核未发现新增交付阻断。冻结产物仍未变化：candidate-32 archive/unit/runbook分别`c10fccd5…972e7d3`、`4c26ab4a…a996bc5`、`9c252a88…58be9eb`；candidate-33 r2 archive/unit/rev4 ZIP分别`bcc46626…1d0fdc77`、`eeda8fde…8136105`、`953fcd4b…6ab52a0`。rev4已知需替换旧ZIP，但目前只确认“应替换”，送达同事与目标机回传仍未确认。r2归档包含相关路径的旧快照，当前`server.cjs`、`tasks/store.cjs`、`tool-calls.cjs`、`runtime/usage.cjs`、`public/app.js`与包内成员不同，本轮改动不在冻结r2中。

不得从当前dirty tree直接打包下一候选。若仅纳入T03/T11，逻辑生产覆盖暂为`server.cjs`、`tasks/store.cjs`、新增`shell/tasks/lease-recovery-sweep.cjs`、`tool-calls.cjs`、`runtime/usage.cjs`；接受UI coverage展示时再加`public/app.js`。当前完整`server.cjs`还包含其他任务的既有改动，必须先筛选/审查hunks；测试与证据不进runtime包。新候选需从冻结candidate-32命名基底、显式overlay/addition allowlist和源码哈希映射开始，并锁定unit/runbook/ZIP、Arborist闭包、逐文件manifest、Linux/amd64及Node>=22.19证据。未部署、交付、commit、push或merge。

#### 2026-10-23 candidate-33 r2线上诊断码与并行重构增量

用户回传candidate-33 r2线上 `/api/models`：HTTP 200、`syncError=Model catalog unavailable`、`state=internal_error`、`errorCode=MODEL_CATALOG_INTERNAL_TYPE_ERROR`、`upstreamStatus=null`、`lastSuccessfulAt=null`、`failureCount=0`、`modelCount=24`。HTTP 200只表示诊断API成功响应，模型目录同步仍失败；24项为静态fallback。错误码由server把无已知`error.code`的`TypeError`归类产生，说明目录调用链有TypeError逃逸至外层catch，但不包含抛错阶段/具体操作，不能仅凭此码定位缓存、合并或本地策略路径。锁定的`fetchPtSnapshot`将请求/JSON异常收敛为`PT_NETWORK_ERROR`或`PT_INVALID_RESPONSE`，因此常规网络/JSON失败应落入其他分类；`upstreamStatus=null`本身不证明请求未发出。`failureCount=0`由`catalogFallback`固定填入，是“内部异常时未取得持久化失败计数”，不能解释为没有失败。candidate-33 r2继续冻结。

本地新增安全阶段诊断切片：固定9项`failureStage`（scope、qualification、cache_read、fetch_or_parse、merge、local_update、cache_write、projection、fallback_projection）通过`/api/models`返回并写入安全事件；stage由allowlist双重校验，异常message/stack/path/credential不进入接口或结构化日志。internal_error使用`failureCount:null`及`failureCountKnown:false`，日志不再把未知计数投影成0。failure-stage专项 **3/3 PASS**、目录诊断专项 **3/3 PASS**、HTTP/API脱敏与`PT_LOG_DIR`指向普通文件的日志故障回退 **1/1 PASS**；最终组合 **7/7 PASS**，授权loopback环境重跑。HTTP回归对9阶段服务层投影采用fake `getCatalog`回调注入；真实server qualification预处理阶段仍未做故障注入。线上TypeError根因仍未确定；只有未来诊断版本的stage回传可继续定位。candidate-33 r2保持不变。

以冻结candidate-33 r2为基底生成本地candidate-33 r3诊断草案，显式patch仅覆盖`server.cjs`和`model-catalog.cjs`，其余323/325个归档成员逐字节不变；其他六个工作区运行成员差异均排除。`scripts/package-northstar-candidate33-r3.py --check`可复现通过，独立T16 audit确认六项输入绑定、锁定Arborist 8.0.5、manifest 472 packages/30,091 files、Linux/amd64（Node `x64`别名）和unit hash；此为归档绑定审计，不是新鲜Linux安装或目标机验证。依赖输入继承r2并逐字节保持；最终切换前仍需目标侧closure `--check`。当前 r3 仅本地诊断草案，不可部署；候选unit标记`DRAFT ONLY - NOT FOR DEPLOYMENT`。部署手册须继续保持审阅稿，直至目标机只读快照能确认实际FragmentPath/drop-ins及可精确回滚映射；不得把unit文件等同有效配置。API诊断回传需含`failureStage`及`failureCountKnown`。线上TypeError根因未定，r2未改动/重建/交付。

后续在一次性`node:22-bookworm-slim` Linux/amd64容器中，从r3归档新鲜解包并`npm ci --no-audit --no-fund`，安装621包后执行包内closure `--check`，实测 **FAIL: MANIFEST_MISMATCH**。另一次相同平台新鲜安装生成临时manifest，对比确认仍是472个production packages、30,091个文件；唯一差异在`node_modules/@deepseek-ai/dsh`的`resolved`元数据：冻结manifest含原构建目录绝对路径`file:/tmp/northstar-t16/shell/vendor/...tgz`，不同安装根会改变Arborist记录值。此项揭示原T16清单不可移植；r3仍冻结，但明确发布阻断、不得交付。需从冻结r2另建r4，修helper对本地tarball的稳定来源记录并重新生成manifest；保留lock identity、integrity和逐文件hash校验，并在不同绝对根验证一致性。当前两次安装均不涉及目标机、聊天或模型调用。

便携来源修复后，helper定向回归 **12/12 PASS**。从冻结r2在`/work-a`与`/different/work-b`两处各自clean `npm ci`，portable manifest的closure `--check` **2/2 PASS**（Node v22.23.4、Linux/x64、各621 installed packages、472 production packages/30,091 files）。随后从冻结r2仅四成员overlay生成本地candidate-33 r4草案：`server.cjs`、`model-catalog.cjs`、closure helper、portable manifest；其余321/325成员逐字节继承。r4 archive SHA-256 `665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c`，unit SHA-256 `ee7f9118190278ea0c7289eb70d94c754191a30f58152bf33e10841f1a8fe772`。r4归档自身在模拟immutable release路径新鲜Linux/amd64安装后包内closure `--check` **PASS**；builder复现与独立T16四成员/锁文件/DSH tarball SRI/manifest/unit审计 **PASS**。这是本地诊断草案，unit仍标`DRAFT ONLY - NOT FOR DEPLOYMENT`；最终可执行runbook/交接ZIP及目标机实际r2 systemd快照与回滚映射仍未完成，线上TypeError根因仍需stage回传。r2/r3旧产物未改、未交付r4、未部署或模型调用。详细证据见[evidence](evidence/candidate33-r4-portable-closure-20261023.md)与[r4草案](evidence/candidate33-model-catalog-diagnostics-draft-r4-20261023.md)。

T11 migration 020为usage增加口径标签；存量`total_tokens`保持原值，旧行幂等标记`legacy_unclassified`。summary只对同一受信collector标签、完整且安全的total求和；混合、legacy、unknown不显示历史合计。独立复核及迁移/UI回归通过；另修复跨记录SUM溢出仍误标complete的边界，溢出改为`totalTokens:null, coverage:partial`，纯unknown维持unknown。最新定向验证`node --test tests/regression/tool-calls-usage-evidence-test.mjs tests/regression/usage-dsh-sdk-shape-test.mjs tests/regression/ui-usage-token-summary-test.mjs` **6/6 PASS**（UI子断言28/28）；迁移及UI集成套件 **18/18 PASS**（该次运行早于跨行溢出修补）。

maxCost admission拒绝现使用锁定DSH `LlmError`及固定解释；runner fixture通过锁定SDK错误归一化保留`RUN_COST_UNKNOWN`，普通Error仍归一为`UNKNOWN`并转成安全通用失败文案。缺少可信价格估算时，在模型调用前失败；这只是fail-closed门禁，不是已实现实际成本计算。定向runner/事件/summary验证 **6/6 PASS**，语法及限定diff检查通过。候选包/目标机未更新；上述目录诊断仍需阶段级证据才能判断真正根因。

#### 2026-10-23 r4 草案复核及 T03/T11 聚焦验证

主Agent复跑 `python3 scripts/package-northstar-candidate33-r4.py --check` 与 `python3 scripts/audit-t16-candidate33-r4.py`，均 **PASS**：r4 archive SHA-256 `665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c`，325个成员中仅四项 overlay、其余321项与冻结r2逐字节相同；Linux/x64 portable manifest 472 production packages/30,091 files。独立只读复核未见新产物一致性阻断。r4 runbook草稿已标明归档内manifest/helper路径与精确锁定的Arborist/semver版本；仍有目标机systemd有效配置、回滚映射、最终冻结值及ZIP哈希占位，故不可执行、不可交付部署，线上TypeError根因未定。

主Agent聚焦复跑 `node --test tests/regression/external-operations-worker-test.mjs` **7/7 PASS**。新增PGlite场景证明：已知taskId在fixture HTTP 200且供应商状态未映射时，一次只读GET后操作持久进入`manual_check`，保留taskId和查询审计；同库下一tick不重查，父Run保持`waiting_external`。独立审查确认这只覆盖同进程PGlite与注入的query-only adapter，未证明重启、多实例、真实PT或付费提交，不提升T03/AC04整体状态。T11 SDK形状用量聚焦复跑 **5/5 PASS**；独立审查发现缺少`sourceEventSeqs`或引用不全、message与chunk用量冲突时可能仍标可信，正在收敛该边界；r4不包含此T11改动。`git diff --check` **PASS**。未交付r4、未操作目标机、未发模型请求、未commit/push/merge。

T11上述歧义边界已补最小保护：同turn/step存在未引用usage chunk时，不把message与chunk计作两笔已证实响应，改为单条未知；已引用chunk与message token分量冲突时也降为未知，避免错误可信总量。新增两条聚焦用例；主Agent复跑 `node --test tests/regression/usage-dsh-sdk-shape-test.mjs` **7/7 PASS**、`node --check shell/runtime/usage.cjs`及`git diff --check` **PASS**。T03用例进一步在同一PGlite存储上重新创建worker实例，`manual_check`仍不被重新查询；聚焦套件复跑 **7/7 PASS**。这仍不等于操作系统进程重启或真实provider验证。以上均未进入r4诊断包。

随后三路只读复核继续。冻结r2静态路径把线上目录TypeError的候选阶段按代码证据排序为`merge`、`local_update`、`projection`；常规fetch/JSON异常及cache read自身已有错误收敛。线上r2仍没有`failureStage`，所以排序只是待验证假设，不能宣布根因；r4若完成独立发布门槛，可用单次已登录`GET /api/models`的安全阶段码缩小范围，不回传Key、原始模型记录或缓存内容。交付仍需目标机只读systemd基线；已把五步采集清单交用户转发同事，未等待回传而继续本地工作。

T11第二轮复核指出重复引用同一chunk、引用未来chunk及同step漏引后续chunk也可能误计为可信。已在collector中将重复引用涉及的响应、未来引用、以及引用后又出现同step未引chunk的歧义证据降为未知；新增三条对应用例。主Agent复跑SDK形状用量套件 **10/10 PASS**、语法和`git diff --check` **PASS**。T03把未知供应商状态用例提升到关闭PGlite存储、同数据目录重开、运行启动恢复并重新创建worker；仍保持`manual_check`、只发生一次GET/零POST且父Run不被误终结，套件 **7/7 PASS**。这覆盖存储重开而非独立OS进程/真实PT。T11/T03均未进入r4归档；线上目录仍不可用。

#### 2026-10-23 不等待目标机回传的三路继续工作

用户表示稍后回传目标机五步只读基线，并要求先继续其他工作。三路子Agent并行：①冻结r2模型目录TypeError阶段只读审计和假响应fixture；②T11用量事件及落库链路只读复核；③T03独立OS进程恢复夹具。目录本地fixture发现旧scoped cache若仅有展示型模型 `{id,chat}`（或`models:[null]`），即使假上游HTTP503，强制同步失败快照在`mergeSnapshot()`处理旧模型时仍可抛TypeError；r4固定阶段码能指向`merge`。这只提出可验证的缓存结构假设，目标机缓存尚未读取，不能据此认定线上根因。详见[阶段假设](evidence/candidate33-r2-typeerror-stage-hypotheses-20261023.md)。r4 runbook审阅稿已把四个overlay成员的当前归档SHA补全，但候选ID、目标机systemd配置、回滚映射与最终ZIP仍未冻结，仍不可执行。

T03新增两个真实Node子进程顺序写入/重开同一隔离PGlite目录的[专项夹具](../../tests/regression/t03-external-manual-check-process-restart-test.mjs)：首进程假HTTP200未知供应商状态后持久`manual_check`，次进程启动恢复及worker tick后无第二次GET/POST，taskId/查询审计与父Run waiting_external仍在。子Agent报告 **1/1 PASS**；主Agent已只读检查夹具代码，未向真实provider发请求。T11再对同seq不同payload重放及跨step usage引用降级可信语义，专项 **12/12 PASS**，语法与`git diff --check` **PASS**。保活请求尚无`chat_usage`证据是独立成本可观测缺口；正常主对话成功/失败/停止分支均接入Run用量落库，但本地fixture不证明线上真实用量。三路改动均未进入r4候选；未交付、部署、模型调用、commit、push或merge。

第三轮独立复核判定T03跨OS进程夹具**限定PASS**：只证明child `manual_check`在新查询worker中不再被查询；fake HTTP没有POST不代表其他提交执行器整体安全，未覆盖真实PT、服务级启动链或并发租约。T11保活路径复核：默认关闭；若显式开启，会按活跃租户发真实BYOK请求，但pulse waiter仅返回聚合usage，丢失runner已有的逐响应`usageEvidence`、失败/超时证据与预算字段，成功只写日志。后续正确接入需独立heartbeat attempt/usage账本和派发前账户级预算，不混入人工`chat_usage`，未知结果占额度且不自动补发；当前不打开该开关，不把单Run `run-budget.json` 当货币总上限。

r4 runbook独立审计发现原稿要求在自身写入runbook SHA及包含它的ZIP SHA，形成不可冻结的循环引用。已改为先冻结runbook、再构建ZIP，二者SHA只记在不放入ZIP的包外发布校验表；当前仍只有不可执行审阅稿，目标机配置/回滚与候选身份占位未完成，未生成ZIP或交付。

后续只读设计评估明确：若未来`failureStage=merge`且目标机证实旧scoped cache形状损坏，修复应先区分缺失/有效/无效/读取错误并深度校验模型结构；无效缓存不可作为权限、运行验证或AUTO证据，不能把旧`chat:true`迁移为授权。原文件需受限备份、核对哈希后才考虑新鲜目录重建，备份失败保持fail-closed；当前无目标机路径/缓存证据，不清理或改写缓存。T11保活独立记账[方案](evidence/T11-heartbeat-usage-design-20261023.md)已形成：开关默认关闭，若未来启用，派发前须有授权及账户预算，按heartbeat attempt/response序单独幂等落库，未知成本占额度且不自动重发，不能混入人工`chat_usage`。此为设计，不是生产实现或验收。

T03只读审查发现child操作已`manual_check`、父Run旧`externalState=null`时，`/api/chat/stop`原先只看父字段，可能错误回传`upstreamMayStillRun=false`。主Agent在external-operations store新增按身份校验、Run行锁保护的`EXISTS`查询，采用成功/失败/取消三终态的补集判定child未决，无100项分页截断；查询形状或执行异常不静默当作false。stop响应合并父Run `needs_reconciliation`、旧externalState和child状态，child查询失败则保守为true。独立只读复核未见租户/竞态阻断；隔离PGlite+真实localhost HTTP[定向夹具](../../tests/regression/t03-child-manual-check-stop-http-test.mjs)由子Agent报告 **1/1 PASS**，覆盖有child manual_check与无child两分支，无真实provider。主Agent对两处生产文件运行`node --check`及全局`git diff --check`均PASS；仍需独立浏览器/UI和真实外部任务验收。

后续可见性缺口：`/api/chat`常规与幂等重放SSE目前均未转发child `state.operationStatus`；持久`/api/runs/:id/events`虽保留事件，聊天UI不展示待人工核对状态。此项未在本切片修改，不能因stop提示修正就宣称T03完整对账体验完成。

T03继续处理事件可见性：主Agent只把持久child `state.operationStatus==='manual_check'` 映射成旧聊天SSE的固定 `{operationStatus:'manual_check'}`，常规与幂等重放均使用原事件序号，不传operationKey、taskId、provider原文。前端固定提示和断线补读由子Agent在独立文件推进；由于父Run `done` 会关闭SSE，晚到child告警仍只能经Run详情读取，不能宣称实时覆盖所有对账。独立审查还指出过期查询恢复先锁child再锁Run，与正常claim/record的Run→child顺序相反。主Agent改为候选查询先`FOR UPDATE OF r SKIP LOCKED`锁Run，再经`operation(..., true)`锁child，原UPDATE仍以状态/租约过期条件约束；`external-operations-worker-test.mjs` **7/7 PASS**、语法与`git diff --check`PASS。此为本地锁序修复，尚无真实PostgreSQL并发死锁压力证据或T03整体验收。

T03前端切片收敛为“历史提示：外部任务状态未确认，需在运行记录中核对；当前状态以运行记录为准。”，不假称当前仍为`manual_check`。常规SSE与断线后持久事件补读可触发本页提示；切走A对话时只标A未读，回A后历史重绘再展示，不向B写入；不拼taskId。子Agent报告专用UI **4/4 PASS**、既有恢复UI **25/25 PASS**、语法和限定diff检查PASS。提示只是本页历史通知，不是刷新后持久核对入口；父Run先done而child状态晚到仍不会经已关闭聊天SSE到达。独立审查确认仅`manual_check`固定状态进入旧SSE，原持久seq保留，未暴露操作键或上游任务ID。

查询恢复锁序独立复核未见新正确性阻断，但指出审计次数应使用已锁定child行，主Agent已修正；提交恢复路径也改为先`FOR UPDATE OF r SKIP LOCKED`锁Run、再锁child，统一锁序。聚焦 external store+worker 套件 **8/8 PASS**，语法和`git diff --check`PASS。该证据仍是本地PGlite，不能代替真实PostgreSQL并发交错验证。

T11锁定SDK源码复核发现实际目标路径的全零占位风险：pi-ai OpenAI completions 流先把usage初始化为全零，在无上游usage帧的成功/错误结束时仍会经DSH无条件传出usage chunk；原collector会把它当可信零。主Agent将四分量全零SDK usage一律降为未知，不把可能付费的缺失证据记为零；真实零也暂时无法确认，需未来下层usage-present证据位。子Agent补成功message、失败chunk两例，SDK形状聚焦 **14/14 PASS**，正数路径仍通过。详见[锁定源码证据](evidence/T11-locked-sdk-zero-usage-20261023.md)。该改动尚未进入任何线上候选；无真实PT账单核对。

本轮手改r4构建器生成的说明文件一度导致builder `--check`失败，仅为说明文件漂移，归档/unit未变；已将生成说明恢复至构建器输出，另将新假设记录在独立evidence及WORKLOG，重跑 `python3 scripts/package-northstar-candidate33-r4.py --check` **PASS**。T03/T11新代码仍不在冻结r4草案内，目标机五步基线待回传，线上模型目录依旧不可用。

#### 2026-10-23 目标机第一轮基线回传

用户转述目标机只读结果：Linux/x86_64、Node v24.22.0、`northstar-shell` active，FragmentPath `/etc/systemd/system/northstar-shell.service`、无drop-in；ExecStart 的server及WorkingDirectory均为当前candidate-33 r2 release，EnvironmentFiles为外部`/etc/northstar/northstar.env`和r2发布目录内限额文件，服务用户/组northstar/northstar。此项确认目标平台与r2实际服务入口，尚缺unit真实路径/权限/哈希、文件可读性、目标新路径是否已存在、local/public health输出及原始退出码；不据此启动切换。已准备并交用户转发[第二轮逐步只读清单](北极星r4目标机只读文件与健康采集-20261023.md)，r4 runbook补入“用户转述、待原始证据核对”的基线注记。未操作目标机、未授权或交付r4。

#### 2026-10-24 第二轮目标机摘要与功能优先级

用户回传的第二轮只读摘要：当前r2 unit为普通文件、0644、root:root、970字节，`readlink -f`指向自身；SHA-256为`eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105`，与冻结r2 unit预期一致。外部env为普通文件、0640、root:northstar、1081字节；r2限额文件为普通文件、0644、root:root、125字节。r4目标路径`test -e`退出1；本机及公网`/healthz`均回`ok:true`且pid同为123507，uptime相差95秒。尚未收到r4目标路径`test -L`的退出码，以及健康检查原始输出和退出码；这些留在最终发布门槛，不阻断本地功能开发。本次仅收到用户摘要，未直接登录目标机。r4仍是本地不可部署诊断草案，线上目录TypeError根因未定。

本轮重新运行`python3 scripts/package-northstar-candidate33-r4.py --check`、`python3 scripts/audit-t16-candidate33-r4.py`及`git diff --check`均PASS；T03 external operation store/worker与T11 SDK usage形状三文件组合`node --test`为22/22 PASS。r4仍仅四成员overlay，T03/T11较新代码不在该草案中；本地回归不提升完整T/AC验收。用户将今日优先级改为功能而非新包。对用户提出的建议，T07采纳来源可观察性和变体解析/故障重试分离，但显式手动选择不得被环境变量或内置映射静默替换；T03同会话免重复确认需限制于已定义且不扩大权限的操作范围；T09逐列类型表只报告证据、模糊日期保持text；T10生成导出需独立模块，XLSX仅在日期语义确定时写真实日期单元格。绘制新图表不是现有T08的读图验收，应另定T05/T09/T10能力范围；是否纳入一期待用户确定。当前代码尚未实现这些新增切片，不计完成。

用户指出单一工作位估算遗漏子Agent并行能力，主Agent已纠正排期假设，启用三个互不覆盖文件的子Agent：T09 CSV列证据、T10 CSV导出模块、T07/T03只读边界审计；主Agent负责共享`server.cjs`接线及独立复核。T09新增`attachments/csv-column-profile.cjs`，仅对真实不可变CSV source作全列证据扫描，不猜表头、不转换单元格；仅简单小数及有效ISO日期可分类，斜杠日期、混合列、前导零编号保留文本，缺失与零分开。主Agent在`server.cjs`的CSV上下文路径增加有界列证据前缀，剩余字符预算继续使用原`renderCsvSource`完整cell/省略坐标契约；低预算（<900剩余字符）保留原路径，不声称每次都展示列判定。T10新增独立`exports/csv.cjs`，对显式类型表做确定性CSV输出、拒绝模糊日期/数字并中和电子表格公式型文本；尚未接API、产物登记或XLSX/PDF writer。主Agent复跑新模块、既有CSV source及真实localhost HTTP/PGlite四文件组合 **16/16 PASS**，`node --check shell/server.cjs`及`git diff --check` PASS。T07审计确认当前router无变体来源链，手动模型不静默回退；T03确认目前只有`awaiting_confirmation`状态而无可复用确认记录/批准/恢复协议，不能直接添加会话布尔缓存。上述均为局部功能及审计，不提升T00–T18或AC计数，亦不在冻结r4草案内。

用户进一步纠正交付定义：模块可以逐批实施，但每批给用户的必须是同一版本可正常对话、真实切换模型、并可通过Agent实际调用当前PT目录中已获准且产品宣称支持的模型/任务能力的完整Agent。已另立[增量交付门槛](INCREMENTAL-AGENT-DELIVERY-GATE-20261024.md)。只读纵向核查：聊天模型偏好→router→DSH task frame已在本地接线，但线上r2目录仍`MODEL_CATALOG_INTERNAL_TYPE_ERROR`，无真实回复/上游A→B切换；媒体四类生成有UI→持久Run→host工具→PT调用的代码路径，但业务路由固定三个模型、未覆盖真实目录全部合格model×task，当前受控预算`maxToolCalls=0`会禁止media工具，真实目标机四类调用未验。T10已有本地历史产物恢复和安全下载证据，但同路径不可变版本/Run-call归属及完整格式导出仍缺。此前把T10报成额外2–3日历周错误地重复计入共享T03/T04/目标验收；改按约5–10有效工程人日与主线并行计，不据此宣称T10已完成。此前“全一期6–10工作周”仅为四工作位和外部证据及时到位的粗估，不能作为新完整Agent交付定义下的承诺日期；先取得真实目录model×task矩阵并修核心阻断，再重估首批。

#### 2026-10-24 全范围代码复盘与10月26日功能交付重排

用户明确首个功能交付包目标为10月26日，要求复盘此前六工作日规划，每包说明新增的完整可用功能。重新核对现场分支/HEAD/diff，保留全部既有修改；按T00–T18对照主要生产入口及调用关系，形成[代码复盘与完整功能交付计划](FUNCTION-DELIVERY-REPLAN-20261024.md)，同步修订增量交付门槛。该复盘覆盖任务范围，不冒充全仓逐行审计或全量真实验收。

关键结论：text router仅支持textChat；四类媒体固定三个模型且当前试验预算为零工具；CSV计算、导出及技能snapshot/pin尚无生产调用方；多模态理解、全格式文档、生产隔离与恢复仍有实质缺口。首包建议为10/26对话/真实切换/四类媒体创作，当前高风险且不可交付；随后建议10/29 CSV分析与导出、11/2持久运行记录与用量核对。六日按10/26–11/2周一至周五计，是本次建议窗口；未找到旧口头六日的逐日原始范围，不将其等同现存六至十工作周粗估，也不承诺六日完成全一期。后续图片/办公文档/音视频理解、联网、记忆、技能发布及最终总验收均明确保留。

本轮10个聚焦测试文件48 tests PASS、0 FAIL、0 SKIP，涉及目录阶段码、路由预算、模型快照、CSV计算/列证据/导出、SDK usage、技能快照、记忆预算和runner并发；git diff --check通过。测试仅支持本地模块可复用，不提升完整T/AC状态。未改生产实现、未调用真实PT、未部署、未commit/push/merge，未启动子Agent。下一实施入口为F1目录故障与真实model×task范围收敛，再完成媒体路由/预算/启用面安全和同候选验收；r4仍为诊断草案，不作为功能交付包。

#### 2026-10-24 F1媒体资格入口与旧目录缓存复核

用户授权使用其PT Key进行真实模型测试，并说明Key余额可作为测试经费；本机当前`POWERTOKENS_API_KEY`未设置，工作区默认`secrets/master.key`不存在，尚未找到可安全读取的本地Key路径。已向用户询问Key所在路径和本轮媒体测试总费用上限。未执行真实PT请求，也未把聊天中密钥写入文件或日志。当前`run-budget.json`仍为1次模型、0次工具、0次重试、180秒、128输出token；它不是费用上限，且会阻止媒体验证。目标环境的可用Key、真实目录模型×任务矩阵、媒体单价/账单证据与启用预算仍是F1前置。

本地接通持久Run媒体工具的宿主资格入口：`server.cjs`给`createMediaRunHandler`注入`resolveMediaRouteForRun`，后者使用与提交相同的Key强制刷新scoped目录，只接受fresh、无错误、当前scope的已验证AUTO media路由；目录异常与工具传入模型/端点覆盖均固定错误码拒绝，外部提交意图之前失败。该入口不自行授予媒体策略、适配或runtime验证，故当前没有这些可信证据时会明确拒绝，不能计作四类真实媒体功能完成。`media-route-admission-run-test.mjs`覆盖同Key、路由身份、目录失败、未授权、未验证及工具覆盖；与媒体生命周期、目录阶段诊断组合 **21/21 PASS**，`server.cjs`语法及`git diff --check` PASS。另在目录生命周期测试加入旧展示型scoped cache+PT 503用例：无TypeError、不可授予旧model权限、原字节备份；该组与入口测试 **14/14 PASS**。这些是本地fake/PGlite层证据，不能证明线上r2的TypeError根因已确认或F1可交付。

下一步：收到安全Key访问路径后，仅在明确的请求/费用范围内取得当前Key的脱敏目录model×task矩阵，确认哪些项目具备适配与真实调用资格；再完成媒体本地策略/adapter/预算/用户入口闭环，并在同一冻结候选做真实对话、A→B切换与四类媒体结果/恢复验收。r4仍为不可部署诊断草案；本轮未打包、部署、commit、push或merge，T00–T18/AC整体验收计数不变。

#### 2026-10-24 PT真实目录、付费探针与响应时间

用户在本轮提供PT测试Key，并明确授权使用该Key的全部现有余额。Key仅通过关闭终端回显的临时进程标准输入传入；未写入工作树、命令参数、证据或输出。先做只读目录：HTTP 200、82项、无显式下一页，响应头/JSON完成833/840 ms。真实目录当前代表记录只有`id`、`supported_endpoint_types`，没有逐任务/输入输出模态；本地catalog新鲜归一化通过，82项、无TypeError，故不能据此定案线上r2 TypeError根因。随后两次直接PT短文本请求均HTTP 200并返回所请求模型身份：`deepseek-v4-pro` 4179/4184 ms、reported usage 88+27=115；`qwen3.5-flash` 3033/3037 ms、reported usage 15+203=218，后者completion报告值高于所设32 max_tokens，故token参数不能当费用上限。修复当前dirty lock与DSH发布manifest单一SHA失配后，本地真实DSH单模型Run `ok=true`，首delta/完成4824/5079 ms；同一DSH会话A→B两轮均`ok=true`，A首delta/完成2985/2986 ms、B为819/1228 ms，但DSH结果没有上游实际model ID，不能据此签署真实切换。

直接媒体模块每类最多1次POST、零重试：`seedream-5-0-260128`文生图HTTP 200并得结果URL，17529/17538 ms；用该图作参考的图生图HTTP 200并得结果URL，39565/39576 ms。`wan2.7-t2v`文生视频POST在10551 ms传输失败，未收到HTTP响应/task ID，未知是否执行或计费，**不得自动重提**；`wan2.7-i2v`图生视频单独POST在1056 ms得HTTP 403，1066 ms结束，无结果。已请求用户查PT控制台约2026-10-24 10:49:24 UTC的T2V任务/账单及I2V脱敏403原因。没有实际账单金额、目标浏览器/持久Run/历史恢复证据；成功图片探针也不能算F1交付。请求到首增量/完成、媒体POST/完成时间与范围见[独立证据](evidence/F1-pt-live-probes-20261024.md)。

真实目录揭示泛化`openai`端点亦出现在图像、视频、语音模型；旧映射会把58项归为textChat，其中27项仅凭该泛化端点获得聊天资格，17项还带明确媒体端点。主Agent从`PT_ENDPOINT_TASKS`和动态chat adaptation条件去掉泛化`openai`推断，保留明确`anthropic`/`openai-response`或显式任务事实。重新用真实目录归一化：textChat 31、textToImage 11、textToVideo 29、imageToImage/imageToVideo均0；后两类需要官方页加逐模型受控登记和运行验证，不从名称推断。相关capability/catalog/media/DSH安装回归 **66/66 PASS**、DSH manifest check PASS、`git diff --check` PASS。`shell/runtime/dsh-release-manifest.json`随当前dirty lock更新仅一个SHA字段，经仓库生成器和DSH安装校验核对；此为本地测试工作树，未进入冻结r4或任何可部署候选。当前F1仍不可交付，T00–T18/AC完整验收计数不变；未打包、部署、commit、push或merge。

#### 2026-10-24 PT账单面板与wan轮询经验复核

用户补充[PT用量面板项目](https://github.com/PowerTokens/pt-usage-dashboard)及wan Skill踩坑档案。只读核对README与`fetch_pt_server.py`确认：精确逐笔用量和余额通过网页登录`_Bearer`会话访问PT私有控制台API；已提供的模型API Key不能读取这些账单，仍需脱敏导出/任务记录进行本次视频未知结果与403归因、费用核对。面板脚本在某些分页失败时可能只警告并继续，因此看板合计需完整性审计才能作为验收账单。已向用户列明所需脱敏字段，不要求在聊天中粘贴会话Cookie。详见[真实探针补充复核](evidence/F1-pt-live-probes-20261024.md)。

wan经验对照找到一处实际轮询缺口：原`business/media/powertokens.cjs`把任何非空未知状态都当作正常进行中、清空异常计数；现仅明确`pending/queued/running/processing/in_progress/submitted/created/waiting`重置，未知枚举和缺失状态均累计到40次熔断。媒体路由与生命周期聚焦 **13/13 PASS**、`node --check`及`git diff --check` PASS；测试未覆盖真实PT未知枚举长轮询，不提升F1交付状态。PT I2V HTTP403仍无脱敏错误体/账单证据，未照搬其他项目的错误分类或付费目录失败放行策略。记录的单次延迟尚不能构成优化前后P50/P95结论；无新增付费POST、无重复提交T2V。

#### 2026-10-24 PT账单证据边界更新

用户确认没有本次测试Key对应账户的登录权限，无法查看PT控制台任务或账单；此前请求的脱敏导出/截图撤回，本轮跳过该项，不再将其作为用户待办。`wan2.7-t2v`传输失败且无HTTP响应/task ID，是否生成或扣费仍未知，保持不自动重提；`wan2.7-i2v`的HTTP403原因未证实。直接API响应时间、成功图片及本地DSH证据继续独立保存，实际金额保持未知，不能据usage或标价补算为账单。后续F1可继续做不依赖该账户登录的路由、持久Run与目标浏览器验收；本轮只更新证据边界，无新模型调用或发布。

#### 2026-10-25 F1媒体结果识别边界

恢复前已核对当前分支`feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`、现有dirty工作区和`wb copy/`，均保留。针对媒体轮询发现的误报风险：原逻辑在失败状态判断前接受任意递归HTTP URL，可能把状态查询、输入或错误帮助链接当作生成结果。`business/media/powertokens.cjs`现先判失败状态；只从结果容器与URL字段递归读取候选，进行中状态不凭URL提前完成；同步POST明确失败也不报告成功。新增`media-result-url-boundary-test.mjs`覆盖失败响应带旧产物URL、完成响应仅含状态URL、同步图片失败带URL及正常嵌套产物。聚焦Node **19/19 PASS**，既有媒体路由脚本 **80/80 PASS**，`node --check`及`git diff --check` PASS。测试全为本地模拟；无PT付费调用、部署、提交、推送或合并。

F1仍不可交付：当前Run预算为1次模型、0次工具且非货币上限，真实Agent入口四类媒体、A→B上游身份、结果重开和目标机证据未闭合；旧T2V未知提交不自动重试，I2V 403原因与实际费用未知。下一步继续收敛当前Key的model×task资格与媒体启用预算，再在同一冻结候选做浏览器到持久Run的真实验收。10/26为高风险目标，不降低完整Agent门槛；T00–T18/AC01–AC24整包计数不变。

#### 2026-10-25 F1三子线与共享入口集成

按用户要求三子Agent同时推进，分别负责模型资格、runner预算、前端恢复；主Agent负责共享`server.cjs`、集成复核与结论。模型线新增 `buildMediaQualificationMatrix()`：对同Key新鲜目录逐模型×四任务报告`ROUTE_READY`或首个阻断码；`/api/models`现返回该只含模型ID/固定状态码的矩阵，失败目录明确`MEDIA_CATALOG_UNAVAILABLE`。媒体路由新增**任务范围明确的本地策略**要求；仅启用textChat或未列出任务的模型策略不能授权媒体。离线[82项资格矩阵](evidence/F1-media-qualification-matrix-20261025.md)记录T2I提示11、T2V提示29、I2I/I2V专属提示0；当前保存证据不能签署任何四类AUTO组合，非断言线上实时可用数为零。

预算线修复持久会话首次以零工具预算启动后，后续显式预算Run无法调用已注册工具的问题：工具注册与每次执行审批分离，模型/工具/重试缺预算均fail-closed。发布`run-budget.json`仍为1次模型、0次工具、180秒；合成同会话验证证明零工具Run无host RPC、下一次显式2模型/1工具Run可完成合成媒体，普通文本及GA/热切换聚焦24/24 PASS。零工具时模型仍可能看见工具而尝试后遭拒，是待目标体验验证的限制；不因测试自动开放付费调用。

前端历史与Run补读现在对`media_route`/`media.route`步骤显示图片/视频进度或失败核对提示，不展示原始prompt、输入URL、provider结果；成功媒体URL仍传给渲染器，每条消息/Run的任务类型独立。子线相关UI检查304项PASS，本地模拟不能证明目标浏览器资源实际加载。共享聊天入口把显式生成类型保存在用户消息，重新生成/分岔沿用原类型，冲突或给旧普通问答注入类型、缺参考图均在模型执行前拒绝；HTTP/PGlite fake tenant覆盖保存/恢复/拒绝和`/api/models`矩阵返回。旧conversation HTTP fixture把仅泛化`openai`端点的聊天断言改为显式`anthropic`端点，与当前真实目录语义一致。

主Agent最终交叉运行9个F1/媒体/HTTP聚焦文件 **20/20 tests PASS**，四个生产JS文件语法及`git diff --check`均PASS；上述是本地与合成传输证据。当前环境没有`POWERTOKENS_API_KEY`也没有默认`secrets/master.key`；已询问安全Key读取方式，未回显或保存Key，未进行新PT请求。真实同Key资格、媒体策略审定、费用约束、目标Agent对话/A→B/四类生成及重开、发布回滚仍未完成。旧未知T2V不自动重提。F1不可交付，10/26目标高风险；整包T00–T18/AC计数不变。未部署、commit、push或merge，`wb copy/`与既有dirty内容保留。

#### 2026-10-25 F1续工：Run关联、上游身份与媒体提交基址

用户要求主Agent与三个子Agent全速并行，并给外部Gemini一份独立任务。跨日现场复核仍在`feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，dirty工作区和`wb copy/`保留。三条隔离线分别推进媒体审阅/应用、真实A→B身份、失败任务Run核对；主Agent负责共享`server.cjs`、业务媒体调用及集成。Gemini可读取[独立媒体资产耐久性任务包](GEMINI-F1-MEDIA-ASSET-PACKAGE-20261025.md)，只在指定新文件工作，不给Key、不发真实请求、不碰共享文件；当前尚无其交付证据。

媒体入口现要求目录与实际POST使用同一官方PT基址，不同网关在付费意图前返回固定`MEDIA_GATEWAY_MISMATCH`；等价尾斜杠在业务POST组装时归一化，避免`//v1`。目录/网关/入口/尾斜杠聚焦 **7/7 PASS**。媒体审阅builder与应用器由子Agent做隔离原型：只接受明确任务、当前scope与能力版本，首次应用不制造AUTO验证，应用器要求原子CAS与管理员确认；尚无生产CAS、真实审阅记录或调用入口，不能放行媒体。

服务端将可信持久`runId`写入成功及失败的助手历史消息，不在失败历史保存原始工具参数；前端仅对精确Run ID展示“查看本次运行”，通过已鉴权只读`/api/runs/:id`显示白名单状态，不猜历史归属。Run上游模型身份新增规范化事件：配置模型与锁定SDK从上游流式chunk保留下来的回报身份分列，缺失记unknown；目前SDK只在回报ID与请求ID不同时留`responseModel`，故不能靠无回报证明真实A→B。主Agent的本地HTTP/PGlite历史/Run事件回读与前端专项 **3/3 PASS**，模型身份证据/媒体结果边界/审阅builder组合 **14/14 PASS**；均非真实PT或目标浏览器验收。

用户提供的测试Key仍可用于授权探针，但无对应登录账户账单；本段没有新付费POST，旧T2V未知提交不重投。当前发布预算仍0工具、四类媒体没有当前scope的AUTO验证，目标同版本浏览器闭环与发布证据缺失，F1不可交付，10/26目标继续高风险。未commit、push、merge、打包或部署。

#### 2026-10-26 原会话恢复与中断核对

原会话`01a16d63-5f24-7d82-9217-cff3b2f7972c`在2026-10-25 03:32 UTC附近收到用量限制错误，三个当时运行的子Agent亦报告同一错误，工作因此中断；不能据此推断五小时内任务已完成或确定额度消耗原因。恢复时分支仍为`feature/northstar-phase1-refactor-20261016`、HEAD仍为`b09b1e13720cd16cd7538999d4c63386920b367c`，大量既有dirty改动及`wb copy/`保留。`git diff --check`通过；媒体审阅应用、DSH同会话A→B身份记录、历史Run详情入口、媒体网关一致性及图片CSP的聚焦本地测试10/10通过。未进行新PT调用、打包或发布。此项仅确认中断后本地切片可复核；真实同Key完整Agent、四类媒体、结果重开、费用与目标发布回滚证据仍未闭合，F1不可交付。

用户要求本长会话先收尾，不再启动新子Agent；下次新会话仍维持三子Agent并行，但各自以`fork_turns: "none"`接受短任务说明与独占文件范围。已核对Gemini独立任务的三份新增文件并复跑单测20/20 PASS、全仓JS语法423项无失败；独立审阅发现候选错误消息可回显恶意Content-Type中的token、`arrayBuffer()`路径在上限检查前整块读入、无效资源限额与不配合取消的注入fetch问题，故暂不接入。完整交接、原会话时间/token记录及剩余依赖见[2026-10-26 F1交接摘要](HANDOFF-20261026-F1.md)；Gemini后续独占加固任务见[GEMINI-F1-ASSET-INGEST-HARDENING-20261026.md](GEMINI-F1-ASSET-INGEST-HARDENING-20261026.md)。本轮无新PT请求、无发布、无提交。

#### 2026-10-26 F1 恢复后媒体历史渲染边界

复核交接文件与现场分支/HEAD，保留 dirty 工作树及 `wb copy/`。发现 `chat-media.js` 对历史媒体 URL 直接设置播放器地址，并可由下载失败分支传入 `window.open`；加载失败提示还把完整 URL 写入页面，可能暴露签名参数。现仅接受 HTTP(S) 且不含内嵌用户名/密码的媒体地址，视频封面允许同类地址或受限大小的 JPEG/PNG/WebP base64 缩略图；兜底提示不再展示 URL。原有上传首帧预览保持可用。聚焦 UI 套件 **141/141 PASS**，`node --check shell/public/chat-media.js` 与 `git diff --check` PASS。此为浏览器渲染边界修复，不解决上游结果资产持久化、租户鉴权下载或真实 Agent 验收；隔离 Gemini 候选文件未编辑，未进行 PT 调用、打包或发布。

用户再次提供并授权使用 PT 测试 Key。同 Key 只读目录经获准网络执行两次 HTTP 200、82 项；与 10/25 快照相比，模型 ID 不变，仅 `mimo-v2.6-flash` 与 `mimo-v2.6-pro` 的端点提示从空数组变为 `openai`。Key 经关闭回显的标准输入传入临时探针，未落盘；脱敏差异、耗时及证据边界见 [10/26 目录复核](evidence/F1-current-key-directory-delta-20261026.md)。只读目录不证明媒体任务授权或适配/运行验证，未发送生成 POST，旧 T2V 未知结果不重提。当前本地 `localhost:3002/healthz` 无响应，目标同版本 Agent 验收尚未开始。

用户提出使用 `mmdn814@gmail.com` Google 账户登录以协助目标验收。通过现有 Chrome 会话打开 `https://agent-fat.adorado.top/`，账户设置页确认当前登录邮箱正是该地址，无需重新登录；页面显示已绑定 PT Key 末尾 `8EWG`，与本轮测试 Key 不同，未修改绑定。进入已部署 Agent 对话页后，模型区域直接显示 `MODEL_CATALOG_INTERNAL_TYPE_ERROR`。这是目标浏览器实时只读观察，证明当前部署的目录入口仍有阻断；未发送聊天/媒体请求，也不能由本机同 Key 目录 HTTP 200 推断线上错误根因。当前页面由 Chrome 的“⭐ 北极星登录”标签组保留，供后续人工观察。

继续对照线上 r2 与当前 dirty 工作树：r2 页面只有 `MODEL_CATALOG_INTERNAL_TYPE_ERROR`，没有可用于定位的 `failureStage`。当前工作树的 `catalog-cache.cjs` 已具备深度规范化模型校验、无效缓存原字节备份与读取 fail-closed；聚焦夹具明确覆盖旧 `{id,chat}` 展示缓存及失败刷新不再抛 TypeError。目录生命周期与阶段码两文件 **14/14 PASS**、`git diff --check` PASS。此为尚未部署的本地证据，不能反推线上根因；下一步需目标 r2 的脱敏错误日志或经完整发布门槛批准的诊断候选原始阶段码，不能直接清缓存或把当前 dirty 工作树部署上线。

用户按先前给出的时间窗口未查到 `model_catalog_internal_failed`。复核 `shell/logging.cjs` 发现该事件写入 `PT_LOG_DIR` 或默认 release 根目录下的 `logs/app-YYYY-MM-DD.log`，不是常规 `journalctl` 输出；此前只给事件名与时间而未指出日志文件位置，需纠正。目标 r2 默认路径应为 `/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/logs/app-2026-10-26.log`，但若目标环境配置了 `PT_LOG_DIR` 应以实际值为准。尚未取得目标文件或事件，不把未查到 journal 解释为没有发生目录错误。

用户随后回传目标应用日志固定字段：2026-10-26 UTC 01:36:44 至 02:55:33 有 25 条 `model_catalog_internal_failed`，均为 `MODEL_CATALOG_INTERNAL_TYPE_ERROR` / `TypeError`。这确认错误持续复现，但 r2 无 `failureStage` 和可安全回传的堆栈，不能从异常类确定根因。历史部署配置文档显示 `PT_RUNTIME_DIR=/var/lib/northstar/runtime`、`PT_LOG_DIR=/var/lib/northstar/runtime/logs`；下一步可由维护者以 northstar 服务用户对该目录下 `model-catalog-*.json` 做只读结构汇总，只回传文件数、解析状态、模型记录形状计数，不回传 Key、scope 哈希、模型 ID 或缓存原文。此结构检查只能验证旧缓存假设，若有多个 scope 也不能自动认定哪一个是当前 Key。

用户回传目标目录缓存只读结构汇总：6 文件、不可读 0、非法 envelope 0、null 记录 0、旧展示记录 0、rich 记录 480。旧展示/null 缓存假设由此减弱；汇总不含当前 scope 定位、深层字段验证或失败阶段，线上 r2 的 TypeError 根因仍未确定，未清理缓存。Gemini 交付隔离资产摄取候选、31/31 原测试及报告；主 Agent 复核后修复超时清理挂起、底层 fetch 未中止、伪造错误码和响应访问器异常泄露等边界，定向测试 **37/37 PASS**，模块语法与 `git diff --check` PASS。该候选未接入生产；内容真实性、DNS/出口、租户资产存储、鉴权下载、Run/历史归属与外部终态一致性仍未闭合。未进行真实 PT POST、部署、提交、推送或合并；F1 仍不可交付。

#### 2026-10-26 F2 并行启动与 CSV 产物入口

用户授权在 F1 目录 TypeError 与目标真实验证尚未闭合时并行推进 F2，明确任务完成后继续下一项。两名子 Agent 隔离新增：`shell/tasks/csv-analysis-adapter.cjs` 将明确列/起始行/操作和源 SHA 绑定已有确定性计算，组合测试 12/12 PASS；`shell/exports/csv-analysis-result-candidate.cjs` 以不可变来源重算后映射带原始坐标、空值/缺列区分的 CSV 表，组合测试 15/15 PASS。两者均未接生产。给外部 Gemini 的下一份一次性新文件任务包见 [F2 CSV 列选择任务包](GEMINI-F2-CSV-COLUMN-SELECTION-PACKAGE-20261026.md)，仅限新候选、测试与报告；当前工具没有直接派发 Gemini 会话的能力，需用户转交。

主 Agent 使现有租户产物服务与面板识别 CSV：`runtime/artifacts.cjs` 接受 `.csv`，`/api/artifact` 用 `text/csv` 且强制附件下载；前端历史产物经本地路径重新构建下载链接，CSV 不放入 iframe。产物与 UI 三文件定向测试全部通过，其中 UI 64/64 检查通过，语法及 `git diff --check` PASS。此处只补既有产物链识别，尚无 F2 生成结果的 Run/产物登记、鉴权用户入口、文件版本与重开验收；F1/F2 均未判交付。未调用 PT、部署、提交、推送或合并。

后续主线接通本地 CSV 宿主工具路径：`csv-run-source.cjs` 复用现有 `readVerifiedChatAttachmentBytes`，只从当前 Run 的快照和租户上传路径取得不可变 CSV；`csv-run-handler.cjs` 再要求来源属于当前用户回合的文档列表、SHA 和显式操作/列/起始行，返回精确结果及有界来源坐标。`csv.analyze` 已通过 registry 定义、host RPC、server 和 persistent runner 接线；预算限制仍照原有 Run admission 执行，当前发布配置 0 工具调用会拒绝实际执行。综合 11 个相关测试文件 **26/26 PASS**，全仓 `ci-check` 检查 434 个 JS 文件、失败 0，`git diff --check` PASS。尚未完成全量结果的 Run 归属 CSV 文件写入、历史重开及真实浏览器验收；因此不能把本地接线升级为 F2 完成交付。

随后新增 `csv-run-artifact.cjs`，复用已存在的目录 fd 原语在 `csv-results/<runId>/` 独占创建临时文件、fsync、硬链接发布再移除临时名；目标 `openTenantArtifact` 可读且最终 nlink 为 1。Run handler 现在基于同一不可变 CSV 重新计算并生成带来源坐标的完整 CSV，写入租户/Run 路径，发出 `artifact` 事件，返回模型的证据列表只保留有界前缀与遗漏计数。聚焦 Run source/handler/artifact/export 七项测试全 PASS，包含目标读取器重开及产物扫描发现。仍需同版本 HTTP/PGlite、真实用户下载、历史重开和预算可用性验收；当前仅本地模块与注入边界证据。

用户纠正子 Agent 上下文策略：本轮两名 F2 子 Agent 使用了 `fork_turns: "all"`，对明确隔离的新文件任务是不必要的上下文与额度开销。后续同类任务使用 `fork_turns: "none"`，在短任务说明中写全目标、现有入口、独占文件、验收和禁止操作；只有任务确实依赖完整会话隐含状态时才考虑继承。已读取全局 `~/.codex/AGENTS.md`，其中仅规定 Documentation Style，不要求全量 fork。本轮不额外启动子 Agent。

用户明确 PT 尚无按 Key 查询用量/账单的公开 API，F3 不等待该接口：每次真实调用记录请求模型、实际回报身份、计费参数、用量与状态，按调用时 PT 官方定价版本计算可审计估算；证据不足保留未知，旧未知付费结果仍不自动重提。已更新 [完整功能交付计划](FUNCTION-DELIVERY-REPLAN-20261024.md) 的 F3 定义，并写出 [PT 接口需求草案](PT-KEY-USAGE-API-REQUEST-DRAFT-20261026.md)，草案未发送。PT 官方价格页 2026-10-26 可访问，但价格随模型/模态/参数变化；不能把静态当前价当成历史实际扣费。用户要求的独立子 Agent 默认 `fork_turns: "none"` 已作为新增记忆便笺写入，未修改记忆主文件。

F2 产物历史链补充真实本地 HTTP/PGlite 验证：构造已登录用户及租户工作区 CSV 文件，模拟同轮助手返回 CSV 元数据；`/api/conversations/:id` 重开保留本地规范化链接，鉴权 `/api/artifact` 返回 200、`text/csv; charset=utf-8`、附件下载头及原始 CSV 字节。`t10-artifact-history-persistence-test.mjs` **1/1 PASS**。该用例模拟 DSH 返回，不证明真实模型调用或线上 F2 用户闭环。

用户宣布即将提供图片/视频生成的新需求背景，要求先暂停这部分开发；F1 中的媒体模型/任务路由、资格、费用边界、资产保存与真实付费探针均暂停修改或执行，等待新背景核对。F2 CSV 工作继续，F3 本地台账可先推进文本调用的通用契约，媒体计费维度待新背景确认。外部 Gemini 的 F2 列选择候选三个新文件已落盘，主 Agent 复跑定向测试 **16/16 PASS**；仍是纯函数候选，尚未连接用户显式预览/确认入口。当前不把该测试计作 F2 完成交付。

用户进一步确认图片/视频生成整块挂起，允许先完成其他部分；原 F1 媒体验收和累计完整 Agent 发布因此仍不可签署，F2/F3 非媒体开发不必停。F2 已接已鉴权 `POST /api/csv/selection-preview`：先按当前租户捕获文件哈希，再用既有安全附件读取器验证字节，返回 Gemini 候选的列名/样本/判定类型。前端 CSV 附件提供表头行、数据起始行和列号输入，预览通过且类型为无歧义十进制才可确认；确认的来源 SHA 与坐标随聊天请求持久保存，Run 工具只接受与当前回合确认值完全一致的选择。低上下文预算下选择说明已压缩，不挤掉原 CSV 单元格渲染契约。`csv-document-http-test.mjs`、`chat-request-attachments-test.mjs`、`ui-chat-doc-upload-frontend-test.mjs` 分别通过，后者 57/57 检查；这些仍是本地/PGlite/DOM 桩证据，目标真实 Agent 的 CSV 工具调用和完整用户重开尚未验证。

Gemini 的 F2 CSV 列选择候选与证据报告完成交付后，主 Agent 在当前工作树复核定向测试加原 CSV 分析/列画像测试 **29/29 PASS**；候选已接入预览和 Run 的保守 decimal 准入。补前端异步预览版本号：用户修改范围或发起更新请求后，旧请求的成功/失败回包均不得覆盖当前选择状态。复跑 CSV HTTP 与 UI 前端用例 **2/2 PASS**，前一轮 F2 定向组合 **6/6 PASS**；`ci-check` **439 个 JS 文件、0 失败**，`git diff --check` 通过。F2 仍缺真实模型触发的同轮工具调用与目标环境用户闭环；运行预算当前 0 工具调用，不能用纯函数或本地模拟证据替代交付验收。图片/视频生成仍挂起。

继续 F2/F3 非媒体开发：复核 `shell/runtime/run-budget.json` 当前 `maxToolCalls: 0`、`maxModelCalls: 1`，因此 CSV 工具虽然已注册，真实 Agent 尚无法调用并再由模型组织结果；正式启用前须给 CSV 场景配置有界工具/模型调用并做真实 Run 验证，不能把测试桩结果当用户闭环。F3 新增 `shell/usage/text-cost-estimate.cjs`，仅针对有上游模型身份、明确 token 用量及版本化 PT 官方文本定价快照的单次响应估算 USD；缺少任何计价证据返回 unknown，已知零用量才返回零金额。该模块尚未连接请求时持久台账，也未内置任何实际价格。定向测试 **3/3 PASS**，`ci-check` **441 个 JS 文件、0 失败**，`git diff --check` 通过。媒体计价维度仍待用户背景。

用户交回 Gemini 的 Word/PDF/Excel 文档导出候选并同意纳入后续重构范围；主 Agent 复跑候选 **8/8 PASS**，在 `FUNCTION-DELIVERY-REPLAN-20261024.md` 后续队列补为“办公表格与报告导出”，另写 `DOCEXPORT-main-review-20261026.md` 记录接线阻断：PDF 中文缺嵌入字体/映射、XLSX 依赖未进 Shell 目标闭包、输入字符串总量和同步超时边界不足、单元格类型/工作表名/视觉布局待验。该模块尚未接 Run/下载/历史，不算功能完成。审阅同时修正 F3 文本费用估算：DSH/pi-ai 的普通输入、缓存读、缓存写为互斥用量，逐项乘各自价格，四类计数必须均有证据；缺任一计费维度为 unknown。F3 与导出候选组合测试 **11/11 PASS**，`ci-check` **441 个 JS 文件、0 失败**，`git diff --check` 通过。

新增只涉及三个新文件的 Gemini 单任务包 `GEMINI-DOCEXPORT-INPUT-GUARD-PACKAGE-20261026.md`，要求独立输入总字节/字符和结构类型门禁，不与主 Agent 的 F2 Runner 文件重叠；待用户转交 Gemini。主 Agent 同时新增 `f2-csv-real-sdk-runner-test.mjs`，使用锁定 DSH SDK、实际 `persistent-runner.mjs`、有界 2 次模型/1 次 CSV 工具策略及确定性模型传输。首跑在模型请求前失败，诊断为 CSV 工具输出 schema 的嵌套 object 缺显式 `additionalProperties`；修正后同一测试通过，实际经过工具 RPC、CSV 主机处理器、产物写入、第二次模型响应，预算观测为 2 model/1 tool。与 CSV HTTP、Run handler、产物历史本地测试组合 **4/4 PASS**，`ci-check` **442 个 JS 文件、0 失败**，`git diff --check` 通过。该证据仍是确定性模型传输和本地运行，未改变出厂 0 工具策略，真实 PT 模型/目标登录与同一用户闭环未验收。

2026-10-27 用户确认 Gemini 输入门禁包已转交。F2 新增独立 `run-budget-csv.json`（2 次模型、1 次工具、同键 1 次、0 重试、只允许 `csv_analyze`），默认 `run-budget.json` 保持 1 次模型/0 工具；服务端仅在本轮 Run 存在已验证的单个 CSV 选择时向租户 Runtime 传 `budgetProfile: csv`，经 DSH adapter 的任务帧到 runner 按固定文件名加载，任意其他 profile 被拒。锁定 SDK 测试从源配置复制双策略，证明 CSV Run 可执行并生成产物，默认 Run 的相同工具请求在主机 RPC 前被拒；CSV HTTP 测试证明正常/重新生成选择 CSV 策略、未确认 CSV 保持默认。配置文件加入受控 profile 快照和预检清单，快照 `write`/`check` 通过，manifest SHA-256 `879b58e56982a227c9aa3e392204065aaf282fbe79735dcb35b45ef72e999408`，该值仅为当前源码候选、不是已部署版本。组合 19 项 node tests PASS，DSH repository-local manifest check PASS（20 文件），`git diff --check` PASS。目标真实 PT/Google 登录与完整同用户流程仍未验证，不能签 F2 发布。

Gemini 完成并落盘文档导出输入门禁三个新文件；主 Agent 在现工作树复跑候选 13/13 与既有导出 8/8，通过后发现段落无累计上限、布尔单元格超出任务包约定，以及 JSON 控制字符可能使实际序列化字节数超过粗估。已在门禁补段落上限、行数分配前预检、确切序列化字节复核和严格单元格类型；`document-export-candidate.cjs` 入口现在只向生成器传门禁的深冻结副本。原测试按新的 fail-closed 错误码和 null 文档契约修正，新增生成前 getter、过量段落、布尔拒绝集成测试。组合 **23/23 PASS**，`ci-check` **444 个 JS 文件、0 失败**，`git diff --check` 通过。Word/PDF/Excel 仍是未接 Run 的候选，PDF 中文、XLSX 目标依赖与同步超时中断问题继续阻断发布。

2026-10-27 用户补充 `北极星总文档-v1.10_1.md` §4.8b，确认 DSH 版本升级必须走新分支、精确版本、26 项契约测试与真实对话冒烟、全过后方可合并 main；涉及插件/bundle 还须同步 profile 快照。当前 `0.1.1-rc.2` 已具备 Skill registry、推理强度、压缩、搜索底层机制，缺口在北极星 Adapter/Runner/预算/产品入口，无已证实的升级必要。用户随即决定 F1 只按原范围验收普通对话与模型切换；调节思考深度和 Skill 发布、上下文压缩、联网搜索一起移入下一期候选，待有余量再排，不阻断 F1/F2/F3。计划与复用审计已同步；图片／视频开发的既有挂起状态不变，F1 的其他原定验收项不因本次决定缩减。

继续 F3 非媒体台账：已审阅 Gemini 文档导出输入门禁并完成加固/接线，复跑门禁与生成器 23/23 PASS。为 Gemini 准备仅新建三个文件的 `GEMINI-F3-PRICE-SNAPSHOT-SELECTION-PACKAGE-20261027.md`，由用户转交，不触及当前共享文件。主 Agent 新增鉴权 `GET /api/runs/:id/usage?after=&limit=` 与 `toolCalls.usageByRun`，按拥有者 user/tenant/workspace/Run 联合限制，按 DSH response 序号分页展示已持久化 token 证据；未绑定官方价格时费用保留 null/unknown，不推断免费。首轮 HTTP 测试暴露工作区 ID 函数位于路由之后，移到 Run 路由之前；复跑登录 HTTP 集成及用量存储测试 **3/3 PASS**，`git diff --check` 与语法检查通过。此为本地只读入口，不代表 F3 的调用时价格版本固定、价格估算、导出或真实 PT 端到端已交付。

F3 用量详情继续复用既有 `model_identity_evidence` Run 事件：按 `responseSeq` 与 `chat_usage` 分页行关联，只有上游响应显式报告模型时返回 `providerReportedModel`，否则保留 null/unknown；不新增第二份模型身份表，也不把 Run 选择的 `selectedModel` 冒充上游身份。定向 DB/HTTP 测试验证有报告/无报告、分页、跨用户与跨工作区拒绝，组合 **3/3 PASS**，语法和 `git diff --check` 通过。用户提供的四类 PT 消费日志样例已脱敏摘要在 `evidence/F3-PT-BILLING-LOG-SAMPLES-20261027.md`；媒体计费仅记录证据，开发继续挂起。

F3 增加 `GET /api/runs/:id/usage.csv?after=&limit=`，与 JSON 用量接口共享鉴权分页查询，仅将当前页响应导出；复用 `shell/exports/csv.cjs` 的类型化 CSV 与公式注入防护，未知 token/费用明确输出 `unknown`，不把空值写成零。定向 CSV、DB 与登录 HTTP 集成 **7/7 PASS**，语法及 `git diff --check` 通过。此导出是单页下载，未提供跨页整本台账导出或价格版本记录；F3 完整核对流程仍未交付。

2026-10-27 主 Agent 复核并接收 Gemini 的 F3 价格快照选择候选：`shell/usage/price-snapshot-selection-candidate.cjs` 与 `tests/regression/f3-price-snapshot-selection-candidate-test.mjs` 已由上轮落盘，任务包要求的第三个文件 `docs/refactor/evidence/F3-price-snapshot-selection-gemini-20261027.md` 本轮补齐，写入输入输出契约、reasonCode 列表、现场抽查原始结果与未接线边界。复跑 F3 全部四个测试文件 **33/33 PASS**（`f3-price-snapshot-selection-candidate-test` 14、`f3-text-cost-estimate-test` 3、`tool-calls-usage-evidence-test` 10、`usage-dsh-sdk-shape-test` 6）；全仓 JS 语法 **328 个文件、0 失败**，`git diff --check` PASS。Gemini 任务包（`GEMINI-F3-PRICE-SNAPSHOT-SELECTION-PACKAGE-20261027.md`）所要求三文件已全部落盘。该候选仍是纯函数，尚未连接快照持久写入、调用时版本绑定、Run 台账或 UI；不代表 F3 整体完成或 PT 实际账单。

随后补 `GET /api/runs/:id/usage-all.csv`：仅对已结束的 Run 按 response 序号逐页读取全部已持久化文本响应用量，硬上限 5,000 行，超限返回 413 而不输出截断文件；复用同一个鉴权查询与 CSV 防公式注入模块，跨租户拒绝。DB 测试用 1 行分页跨越两条记录并验证超限拒绝，HTTP 集成测试验证拥有者可下载、其他租户 404；CSV/DB/HTTP 定向 **7/7 PASS**，末次 HTTP 回归 **1/1 PASS**，语法和 `git diff --check` 通过。完整导出仍仅覆盖已观察并持久化的文本响应，不代表 PT 官方账单或 F3 整体完成。

Gemini 价格快照选择候选交回后独立审阅：原选择器/文本估算器 **17/17 PASS**，但非法日历日期顺延、数组 Proxy/选项 getter 直接读取、未知嵌套字段未拒绝，阻断直接接线。主 Agent 使用 Node 原生 isProxy 和描述符验证、日历反查/毫秒精度以及平面字段约束补强；新增负向用例后 **20/20 PASS**，语法/空白符检查通过。报告的四文件 33 项和全仓 328 文件未与当前目录对应，已在证据报告注明。本轮暂不再派 Gemini 相邻候选，先由主 Agent 收敛持久快照、调用绑定与费用台账；不为价格录入新开未定义授权的公共 API。

F3 完成价格目录持久化与每次模型请求前的版本绑定本地链：新增 021 迁移、只追加的完整目录仓储及显式审核/离线 PGlite 维护 CLI；按来源内容和规范化价格计算目录哈希，旧记录不覆盖，相同导入幂等，调用之后才入库的目录不回填历史。Durable Run 经 Adapter 可选 recordModelIntents 到 Runner，使用既有宿主 RPC 保留名确认 `model_request_intent` 事件持久化后才继续 SDK 请求；事件包含 turn/step、意图 ID、所选模型、部分参数及完整价格快照，无价保持 unknown，写账失败拦截调用。新增 model-intent-v1 能力协商，缺能力旧 Runner 在派发前拒绝；不新增模型工具，不升级 DSH，不开启下一期能力。26 条旧契约断言 PASS；最终六文件定向组合 **24 tests PASS**（另含 RPC 脚本内部 11 条断言），全仓 451 JS 语法 0 失败，快照 write/check PASS，候选 manifest `0a7b5eefd52cf4cc90debe59e643211eb826ee904343887d32d26db8e3f7c471`。实际官网价格尚未录入、响应与意图的关联/估算/UI 未完成，真实 PT/目标环境验收未执行。详见 `evidence/F3-price-catalog-and-call-binding-20261027.md`。

F3 后续本地开发：在既有模型身份投影中保留 turn/step，新增 `bound-text-estimate.cjs`，按响应坐标唯一关联调用前价格快照，严格要求可信用量语义及上游身份；Run 用量 API 返回估算/版本/目录ID/原因，完成后保存 text_response_estimates Run 事件。CSV 附价格版本与币种等审计列，运行详情增加按需分页用量与完整 CSV 链接，显示非 PT 官方账单。DB/真实锁定 SDK 确定性模型/前端 DOM/成功失败中断用量/CSV 组合 **11/11 PASS**。发现锁定 pi-ai 丢弃同名上游模型证据，当前严格估算在真实普通响应可能一直 unknown；已异步请用户决定是否允许按请求模型估算并明确标注，收到决定前保持严格策略。官方价格页只读访问确认部分模型存在隐式/显式缓存价和上下文阶梯，尚未把缺失价格维度当作零导入；实际官方价格仍未入产品库。

用户提交媒体 Skill 提案后，主 Agent 经 GitHub 连接只读审阅固定 commit `0a601f4e91ae5993ddd275c1446290146bb7a4dd` 的引擎/Skill/MCP/踩坑/发布/许可证。除提案五项外，确认下载带 Key 至结果 URL、目录失败猜模型、任务 ID 直到整段CLI结束才由MCP收集、空结果成功、图生图未实现、静态估价等问题。用户纠正媒体仍属F1，并授权交Gemini并行；已写 `F1-PTVIDEO-PROPOSAL-REVIEW-20261027.md` 和 `GEMINI-F1-PTVIDEO-ENGINE-HARDENING-PACKAGE-20261027.md`，Gemini 仅交付上游补丁/离线测试/报告三个新文件，由用户转交；主 Agent继续F3，后续负责受控host/Run/资格/资产接线与F1四类媒体验收。未启用媒体工具、执行上游代码、发付费请求或向远端写入。

上述交接前最终验证：模型身份/切换、运行详情用量UI、Run用量DB、失败中断持久估算事件、锁定SDK CSV及CSV导出组合 **16/16 PASS**；全仓452 JS语法0失败；profile快照write/check通过，当前候选manifest `12009c6ef485a8509168ded8185baabc68bc000fc909c62f9dd3833c22f58fb2`，`git diff --check`通过。该结果没有真实PT调用、价格导入、媒体接线或线上发布证据。

继续 F3：核对 PT 官方价格页和 qwen3.8-flash 模型页，落一条真实 Standard 文本费率导入候选 `pt-text-prices-observed-20261027.json`，记录来源摘录、观察时刻与本地24小时新鲜度边界；未写产品库、未改变模型可用列表。相同隐式/显式缓存读取费率可映射当前合并读计数；其他模型阶梯/缺价不填零。新增官方费率算术/区间/无身份/重试歧义/异模型/缺用量回归；用量UI补未知原因文字。八文件定向组合 **33/33 PASS**，全仓453 JS语法0失败，profile快照check与diff check通过。缺上游身份时能否按请求模型估算的问题仍等待用户决定，当前严格策略保持；真实PT/目标用户流程未验收。

用户已接受本期按请求模型官方价估算、上游身份未知，未来PT接口用于补官方数据不阻断交付。已在Run估算路径启用显式requested-model依据，API/Run事件/UI/CSV带costBasis，未知上游ID不填成所选ID；异模型/多attempt/缺价与缺用量仍未知。六文件针对组合 **17/17 PASS**，语法和diff check通过。用户补充六项PT接口需求，确认第5项错误码细分无法实现；已扩充本地需求留档，路径仍是建议、不调用未开放API，credits及有限额Key/无限额账户余额语义分别保留。

用户交回Gemini媒体R1并强调原deadline10/21已延期。主Agent取固定上游blob在临时目录断网复跑 **50/50 PASS**，新增离线反例复现patch相对路径不可用、非image-01图生图被忽略、Seedance file://可过、HTTP超时超过总预算/晚到成功、结果保存钩子失败仍成功、TaskIdWriteError泄漏cause、模糊asset/content错误被错判协议未签。R1尚未通过主审；为避免桥固化错误，改派 `GEMINI-F1-PTVIDEO-ENGINE-R2-PACKAGE-20261027.md`，仅新建完整替换补丁/完整离线测试/报告3文件，由用户转交。主Agent继续F3与后续受控host接线，不向生产应用R1，不发真实媒体调用。计划顶部已恢复10/21为原deadline，历史10/26重排日期不覆盖延期事实。

2026-10-27 主 Agent 接收并执行 `GEMINI-F1-PTVIDEO-ENGINE-HARDENING-PACKAGE-20261027.md`：在独立临时目录检出固定 commit `0a601f4e91ae5993ddd275c1446290146bb7a4dd`，验证 `pt_video.py` blob `7a01e4131e8ea32dbebaa38a674533603debab24` 与 `mcp_server.py` blob `c13913f6314c6c28256b6f126ff14be58903a856` 完全一致。读取 `pt_video.py`、`pitfall-archive.md` 全文后直接完成加固。五项补丁：① 新增 `CancellationToken`（线程安全）、`threading/math` 导入；② 加固 `download_binary`——去掉 Bearer header，改用匿名 User-Agent，重定向处理器不传 Authorization，修复 pitfall-archive A.02 Key 泄漏路径；③ 重写 `poll_task`——增加 429 独立计数+指数退避（上限 60s）、连续 5xx 熔断（8 次）、未识别状态熔断（40 次）、可注入 transport/sleep/clock/_cancel，解决 A.02/A.03 已知短板，NaN/Inf/负数 timeout/interval 拒绝；④ 新增 `classify_error()`——稳定错误码映射，403 不断言 Key 失效，原始上游 body 不透传；⑤ 新增完整产品 API：`ProductRequest`/`ProductResult`/`ProductHooks`/`TaskIdWriteError`/`generate_for_product()`——显式 Key 必须传入/不回退 env config、`"auto"` 模型拒绝、image2image 明确 unsupported 并拒绝（不伪装文生图）、Seedance http media 拒绝/asset:// 通过、before_submit 失败 0 次提交、on_task_id 失败抛 TaskIdWriteError 且 task_id 保留、on_result 失败不重提、POST 结果未知不重提、超时/取消保留 task_id、cost_usd 始终 null、错误脱敏。`python3 -m py_compile` PASS，补丁净应用验证 PASS。任务包三文件全部落盘：`docs/refactor/candidates/powertokens-video-engine-hardening-20261027.patch`（30 KB，619 diff 行）、`tests/regression/powertokens-video-engine-hardening-test.py`（50 个离线 unittest）、`docs/refactor/evidence/F1-ptvideo-engine-hardening-gemini-20261027.md`（接口/能力矩阵/错误码表/主 Agent 接线要求）。测试覆盖：显式 Key 且无文件回退、before_submit 失败不发 POST、on_task_id 写账失败不轮询/不重提且保留 ID、正常提交/轮询成功（video+image）、连续 429/5xx/未知状态分别有界熔断、sleep/HTTP 预算、提交前后取消、POST 结果未知只提交一次、HTTP200 空图片/空视频结果拒绝、download 不携带 Bearer、错误脱敏、Seedance 正确包装及 http 素材拒绝、参数/资源上限、原 CLI 核心兼容（check/estimate/kind_of_model）。**50/50 PASS**，全仓 JS 语法 0 失败，`git diff --check` PASS。不修改任何已有 PT 文件，不接入 Run/DSH/UI/host/部署，不触发真实 PT 调用；F1 真实 PT 端到端与用户验收仍未完成。

### 2026-10-27 F3 请求模型估算：本地 HTTP→台账→CSV→重开数据库贯通
- 扩展 `tests/regression/chat-usage-failure-accounting-test.mjs`：隔离 PGlite 导入明确标记的虚构价格，模型替身经真实服务端内部 RPC 在两次响应前绑定价格；不访问 PT、不使用真实 Key、不发起付费调用。
- 验证同一 Run 的用量 HTTP 返回两笔 estimated/requested_model，providerReportedModel 保持 null；金额分别约 USD 0.0000202、0.0000253，快照版本 http-fixture-v1。全量 CSV 保留 cost_basis，两笔均为 requested_model。
- 持久估算事件保留同一口径；关闭服务后重新打开数据库，usageByRun 的完整响应与 HTTP 返回一致。暂时写入失败、提交成功但 ACK 丢失、持续写入失败仍只执行原有四次模型替身 Run，不重放上游调用。
- 本项 HTTP 回归 1/1 PASS；沙箱禁止监听 loopback，已通过提权运行本地测试。该证据属于离线集成，不代表真实 PT 调用、生产迁移或 F3 整体交付完成。

### 2026-10-27 F3 历史估算不随新价重算；同版本本地集成复核
- 在同一隔离 HTTP/PGlite 回归中，数据库重开后导入费率为原十倍的 v2 目录，确认新调用选择 v2，而历史 Run 完整用量投影仍与最初 HTTP 返回一致（v1、原金额、requested_model、上游身份 null）。无需回写历史估算。
- 三项定向集成 `chat-usage-failure-accounting-test.mjs`、`google-login-integration-review-test.mjs`、`f2-csv-real-sdk-runner-test.mjs` 合计 3/3 PASS。Google 测试为身份替身，CSV 为真实锁定 SDK 加确定性传输，均不证明真实 Google/PT 用户验收。
- `node scripts/ci-check.mjs`：453 个 JS 文件，0 失败；`northstar-profile-snapshot.mjs check`：14 文件 PASS（deployedProfileVerified=false）；`northstar-dsh-manifest.mjs check --manifest shell/runtime/dsh-release-manifest.json`：DSH 0.1.1-rc.2、20 文件 PASS。原默认预算仍为 1 model/0 tool；CSV 特定预算的离线通过不等于默认入口已能调用 CSV。
- Gemini R2 仍独占其三个新文件，本轮未编辑；不部署、不提交、不发付费请求。F1/F2/F3 继续保留真实链路与目标环境交付门槛。

### 2026-10-27 后续主审加固：不执行输入对象代码
输入门禁拒绝所有 Proxy（含已撤销及嵌套 Proxy）后再做反射；限制选项采用纯对象/自有数据描述符读取，拒绝 getter、Symbol 及自定义原型，不执行陷阱。未知字段/选项名不再回显。字符串先按 code point 上限作有界检查，再分配 JSON 转义副本，标题空白 trim 也置于长度检查之后。新增反例验证 getter/Proxy 执行次数为零、敏感键名脱敏、百万字符字段在 JSON.stringify 前拒绝。门禁加原导出组合 **25/25 PASS**；该加固不解除 PDF 中文/XLSX依赖/同步超时和产品链路阻断。

F2 预算更正：服务端对恰好一个已确认 CSV 选择已发送 budgetProfile=csv，tenant/adapter/runner及profile安装链路完整；默认0工具不构成已确认CSV场景的实现阻断。扩展 csv-document-http-test：模型决策替身调用真实宿主registry/CSV handler，验证同Run durable artifact、不可变来源SHA、CSV下载头、历史重开与跨租户404，1/1 PASS。此测试替换tenant调用，尚非穿过完整Adapter/SDK的一体证据；已派独占新测试文件子Agent补齐，fork_turns=none。

F2完整本地SDK/HTTP证据补齐：子Agent独占新增 `f2-csv-http-sdk-integration-test.mjs`，fork_turns=none；真实server/tenant/adapter安装托管profile/runner/锁定SDK及宿主handler，只有目录和模型传输启动器替身。1/1 PASS，验证上传→列预览确认→2model/1tool→Run completed→精确sum=4/来源SHA→同Run产物→MIME/下载头/鉴权→conversation和Run历史重开下载200。默认全量185套件回归已启动，结果待记录；无真实PT/Google外部验证、部署或付费调用。

默认全量首轮185套件：177通过、8失败。已修复旧全零SDK占位断言（真实非零响应内的0仍保留，新增全零未知反例），settings升级CLI隔离包漏带usage.cjs（子Agent仅改该测试，4/4通过），并把必须使用独立PostgreSQL的t03锁顺序测试归入既有--postgres门禁；未跳过其独立验收。响应/SDK/分类组合22/22通过。另5项candidate28/30/31/32与candidate17 lock来源绑定失败，证明旧候选不能代表当前源码，保留原断言/归档/校验值不改；不能据此宣称发布通过。第二轮默认184套件正在执行。
XLSX候选工作表名加固：清理非法字符/控制字符、大小写无关防重名、长标题预留后缀、避免截断代理对；改名以不包含原文的元数据标记。新增XLSX反读验证所有表格数据完整，导出+门禁26/26通过。PDF中文/排版、目标XLSX依赖闭包、同步生成超时等继续阻断产品接线。

### 2026-10-27 连续收敛后的默认门禁结果
第二轮 `node scripts/run-regression.mjs`：184套件，179通过、5失败；原始输出 `evidence/default-regression-20261027.log`。失败清单仅为candidate28/30/31/32 USTAR当前源码绑定与candidate17 lock来源绑定。归档、SHA与断言均保留，当前不可发布；需最终源码冻结后创建新编号候选并完成对应验收，不能把历史包自重建视为当前交付。先前用量断言、升级隔离包依赖问题已修复通过；PostgreSQL锁顺序测试归入--postgres且本轮没有独立数据库执行证据。全仓JS语法454文件0失败，profile14文件check通过（deployedProfileVerified=false），diff check通过。
用户允许自行选择本地或URL进行登录验收并配合。主Agent选择本地，但当前进程GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI均缺失，仓库根无.env/.env.local；已请求现有配置文件路径（不要求贴密钥），若配置仅部署端则用其URL明确区分版本。尚未启动真实登录或PT调用。GeminiR2尚未交回，仍保留其独占文件边界。

2026-10-27 用户给出FAT地址并说明Chrome已登录。主Agent实际读取现存登录首页/历史/聊天、模型弹层与同会话GET /api/models，复现MODEL_CATALOG_INTERNAL_TYPE_ERROR：availability unknown、modelIds空，24静态投影模型均未确认；不是登录失败。healthz ok=true、version1.0.0，但缺候选/源码身份。证据见evidence/F1-fat-browser-readonly-20261027.md。未重登、未切模型/发送聊天/付费，当前仍缺部署端具体失败堆栈与版本证据；不把本地F2/F3当部署端已包含。

用户明确FAT仍为最早故障版本，主Agent尚未交付新包；本次在线观察只作旧版基线证据。新增OPS-F1-CATALOG-READONLY-REQUEST-20261027.md：先取部署源码指纹/路径与2026-10-27 07:55–08:10 UTC已有目录错误，旧版无stack/failureStage则明确缺失，复用已有6文件/480 rich缓存摘要；不要求改生产加日志、清缓存、重启、部署或付费。

运维返回r2路径/PID与四源码SHA；主Agent从冻结r2 tar逐一计算，全部精确匹配。已确认旧logger写release/logs/app日期.log而非journal，旧server136行只记录errorCode/errorClass，故journal无输出不代表无日志，也不能要求旧日志补不存在stack。OPS清单追加仅输出PT_LOG_DIR/PT_RUNTIME_DIR路径的进程环境白名单读取及文件日志查询；不改线上、不清缓存。

2026-10-27 主Agent与fork_none子Agent独立复现冻结r2缺字段缓存TypeError。四源码SHA匹配线上；25例（5完整对照返回/20缺ptEndpointTasks或endpoints或输入输出模态wrapper全部TypeError），外部请求0，成功fixture刷新亦不能自愈（merge先处理prior）。新增开发回归保护原缓存字节备份、未知权限和稳定失败，catalog lifecycle12/12，stage+探针组合17/17。仅待运维匿名字段计数才能定当前线上根因。新单文件探针及OPS-F1-CACHE-SHAPE-REQUEST-20261027.md已准备，SHA=d32772b6f281fe5d3a7db02b25a76f0c0b55140afec39904b4607e3cbd0ce52a；不部署、不清缓存、不付费。详细证据F1-r2-cache-schema-main-review-20261027.md。

2026-10-27 Gemini 单任务包完成：PT Video 引擎 R2 主审修正（`docs/refactor/GEMINI-F1-PTVIDEO-ENGINE-R2-PACKAGE-20261027.md`）。在独立临时检出上游固定 commit `0a601f4e91ae5993ddd275c1446290146bb7a4dd`（`pt_video.py` 原始 blob `7a01e4131e8ea32dbebaa38a674533603debab24`）的基础上产出全量替换补丁与完整离线回归套件。逐项闭环主审复现反例：① 补丁头采用标准相对路径 `--- a/pt_video.py` 与 `+++ b/pt_video.py`，固定 commit 下 `git apply --check` 和 `patch --dry-run -p1` 均 100% 成功；② 对所有 `kind="image"` 模型禁止任意 `first_frame`/`last_frame`/`ref_images` 图生图输入（明确提示 unsupported，保证 0 次 POST）；③ Seedance 媒体输入采用 `^asset://[a-zA-Z0-9_.-]+$` 正则严格准入，排查 `file://`、`http(s)://`、空 ID 与非字符串输入；④ 轮询与等待全面改用单调时钟 `time.monotonic`，HTTP 超时严格截断为剩余时限，请求前、返回后、sleep 前后四道关卡核验截止与取消，“超时不因迟到成功而消失”；⑤ `on_result` 钩子失败明确区分远端成功与本地保存失败，返回 `ok:False`、`error_code="ON_RESULT_FAILED"`、`status="completed_local_save_failed"`，保留 `task_id`、结果 URL 及计费参数供对账，禁止二次付费重提；⑥ `TaskIdWriteError` 彻底脱敏，切断 `__cause__` 与 `__context__` 隐式链，杜绝泄漏私有标记或 Key；⑦ `ApiError(400, 'asset library content rejected')` 依据 PT 官方最新答复保留为 `MEDIA_REJECTED`，仅在存在强协议证据时判定协议未签；⑧ 提取共享的 `build_video_payload` 与 `build_image_payload` 纯函数，CLI 与产品入口共用，所有 enum 字段强转字符串，统一 transport 传参使离线测试可断言真实 body；⑨ POST 连接重置/超时异常统一标记为 `SUBMISSION_OUTCOME_UNKNOWN`，恰好一次 POST，禁止自动重试；⑩ 严格排查 Python `bool` 伪装 `int` 漏洞；⑪ API 调用配置 `_StrictNoRedirect` 禁止凭据重定向外泄，结果下载强制匿名。全套 59 项离线回归用例（启动即全局阻断 socket）**59/59 PASS**。独占产出 `powertokens-video-engine-hardening-r2-20261027.patch`、`powertokens-video-engine-hardening-r2-test.py`、`F1-ptvideo-engine-r2-gemini-20261027.md` 三个文件，未改动任何既有 PT 业务代码，不发真实网络请求，无新付费。主 Agent 后续负责 Python 宿主桥对接及真实出片验收。

运维形态回传命中：探针SHA正确，runtime=/var/lib/northstar/runtime；6有效cache共480记录全部缺ptEndpointTasks，其他已查形态无错误。现场与冻结r2 TypeError反例一致，进入单文件cache守卫backport候选阶段；不清现场缓存、不部署。Gemini媒体R2主Agent复跑59通过但独立8反例复现，仍阻断接线；新建R3独占3新文件任务包，主Agent继续catalog修复冻结。

单文件r5最小repair已冻结打包：northstar-controlled-trial-20261027-catalog-cache-r5.tar.gz SHA da4933064a310694c2ab12bfba49dd71b5d5be7fec993dbbe85fd3104a2af92b；独立builder --check可复现；325 USTAR成员仅cache模块内容变更，其余324成员及依赖/SQL/runner不变，unit/checksum另列。基底是已匹配线上r2，不包含当前F2/F3/媒体候选，不能称整期新版。5/5 backport+artifact测试通过，现场尚未切换。新增OPS-CATALOG-CACHE-R5-PREFLIGHT-20261027.md仅请求Node/unitSHA/node_modules类型/runtime权限/目标目录(test-e和test-L)/空间只读核对；不授权安装unit或restart，最终激活待目标核对和用户批准。

2026-10-28 接续运维r5只读预检回执，所有关键基线匹配（Node24.22.0、旧unitSHA、路径、runtime写权限、目标不存在、空间足够），尚无切换授权。完成独立stage/activate/rollback脚本与操作单，补只读单次输入字节校验后使用同一内存内容、受保护newunit副本，拒绝/tmp路径替换；暂存复制并比对原r2依赖，不npm更新。健康/PID/cwd失败自动恢复精确旧unit；未知unit拒绝覆盖。11/11本地替身测试通过，原包builder --check保持原SHA。交付文件夹新增脚本/激活操作单/外部5项校验清单；操作单要求空闲窗口，需用户批准后才由运维执行，不混称已部署。

运维询问数据库连接方式。已核对精确冻结r2 db-pg模块openPg/pgConfigured；新增独立northstar-r5-idle-check.cjs与补充操作说明，以清洁环境加载服务现有两env-file，显式PG检查、一连接/5秒SQL超时、只读事务，仅输出状态计数和idle，不启动应用初始化器或迁移。连接/未配置失败直接停止，不打开PGlite。SQL在隔离PG引擎验证空闲/忙碌与只读拒写，尚未目标实际连接。新脚本复制交付文件夹，旧激活包/5项校验清单不变。

2026-10-28 r5用户/运维已回传授权后实际激活：5项校验OK、stage325/依赖指纹38fe...15f、两项活动计数0、PID191830、新r5工作目录/health。主AgentChrome已有登录读取真实/api/models恢复fresh/errorCode=null/availabilityavailable/modelCount82；healthPID191830一致（02:51:48Z）。未聊天付费；旧基底仍错误把部分媒体openai端点推为可聊天，明确不借此扩大资格。待scope备份SHA0600与空闲重启复验，新增OPS-CATALOG-CACHE-R5-VERIFY-20261028.md。GeminiR3复核中，原67suite已复跑通过，仍有真实错误脱敏/状态标记等残余问题由主Agent最小覆盖；新Gemini结果门禁独立3文件包已准备，不再等共享宿主主线。

### 2026-10-28：R3 主审覆盖与 Python 进程桥（本地，未接产品）
- 保留 Gemini R3 原始文件；固定上游 + MIT 许可证 + R3 + 主审 overlay 引擎落盘，来源 SHA 有回归检查。原始 67 + 主审 15 项 Python 用例通过。
- 新增可信 JSONL worker/Node bridge：持久化确认前不 POST、不 poll；Key 仅 stdin；限帧/限输出、序号/请求关联、引擎哈希、进程看门狗、任务 ID/可能提交状态保留、未知结果不重提。真实子进程 + 假 provider 的 11 项桥测试通过。未注册产品工具或改变线上执行器。
- 结果门禁独立三新文件任务已准备供用户转交 Gemini。宿主 POST 阶段记录、候选门禁主审、Python adapter 准入及产品链路接线仍待完成。
- r5 运维激活与目录恢复已有证据；备份/空闲重启复验仍待运维回复。下一可上线受控包目标 10/30，完整 F1 高风险，未降低验收范围。详见 evidence/F1-ptvideo-main-bridge-review-20261028.md。

### 2026-10-28：非 fetch 执行器提交边界
- media-run-handler 新增可信 onExternalSubmissionStarted 回调：先有持久意图、再检查取消、再标记可能提交。兼容既有 fetch POST 观察；尚未启用 Python 产品执行器。
- 三个新增反例验证无 fetch 的提交断连进入 manual_check、不允许意图前提交、意图后未释放子进程仍记 not_submitted。与现有生命周期/四任务 SDK 宿主用例合跑 18/18 PASS。
- 周五 10/30 目标仍为可上线受控候选，不能承诺完整 F1 已验收。发布门禁仍包括候选结果校验器、同版真实链路、部署/回滚；不以测试通过代替真实调用或发布批准。

### 2026-10-28：r5重启复验恢复
- 运维两份旧缓存备份均哈希匹配、0600；重启PID192553/r5目录。首次curl502，随后主Agent03:27:46UTC独立公网HTTP200/ok=true/PID匹配，03:28UTC既有登录Chrome /api/models成功返回models。
- 当前不需追加重启或回滚；历史502原因未核实，不能标为确定启动瞬态。本次长JSON未重新计数或读取末尾diagnostics。目录修复范围证据已补，完整F1仍待真实同版链路。

### 2026-10-28：复用原则、结果门禁主审与宿主最小接线
- 用户再次明确优先复用DSH，能启用则启用、能接线只接线、确缺失才开发；已按明确请求写入长期记忆。搜索底层不算从零研发任务，下一期指产品接入验收。
- Gemini候选原首审47/48，Proxy/白名单/计费/冻结输入/URL/限额/真实前置schema问题由主Agent修正后52/52；保留原交付并追加主审证据。Python bridge现在使用实际结果门禁。
- 新Python执行器复用原route/准入/Run生命周期/GET恢复，新增独立adapter身份不继承JS证据。真实worker→Run宿主、参数/前置拒绝等14项通过；提交边界和GET-only恢复4项通过。图片/图生图仍既有JS，不做付费未知fallback。
- DSH manifest核对20文件0.1.1-rc.2通过，JS语法468文件0失败。完整回归首轮遇127.0.0.1监听EPERM，已获沙箱外本地夹具重跑权限，结果尚待收集。
- 新Gemini包：GEMINI-RELEASE-ARCHIVE-PREFLIGHT-PACKAGE-20261028.md，仅独占三个新文件、只读归档结构/资源门禁；由用户转交，不影响主线。
- 后续真实worker POST断连→Run manual_check反例通过，桥/宿主专项增至15项；provider查询映射复用注册adapter并保留GET-only，4项边界测试通过。发布门禁与复用原则记于 RELEASE-20261030-READINESS.md。

### 2026-10-28：完整默认回归与candidate-34草案冻结
- 获批沙箱外本地HTTP夹具重跑：191套件186PASS/5FAIL，失败仅旧candidate28/30/31/32源码绑定与candidate17 lock绑定。沙箱内166/191受EPERM污染，不作为业务回归结论。
- 新candidate34草案复用r4成员骨架/portable npm闭包，当前165源码SHA绑定、366成员、310文件，归档SHA27dc651494661f7bf657404a0fe091be9a3319be10f79506b826dedf18dbb14c。builder确定性check和独立audit及新增2项归档回归通过；未覆盖旧包，NOT_FOR_DEPLOYMENT。
- 源码及许可证/引擎、npm闭包输入、静态shell/media相对导入完整性已审；Linux安装/Python/PG/真实业务/目标发布门禁未关闭。详见 evidence/F1-candidate34-draft-20261028.md。

### 2026-10-28：candidate34独立Linux/Python与PG门禁
- 实际tar在Linux/amd64 Node22.23.4干净tmpfs npm ci（ignore-scripts）后，portable closure check PASS：472包/30091文件；复用闭包成功，未升级依赖。
- 同tar的worker4项/引擎主审15项在Linux Python3.12、无网络容器PASS。宿主镜像拉取官方Python新amd64层；未改现网Python。
- PG首轮3/4，独立诊断定位旧锁顺序夹具；只修fixture，保留LEASE_LOST/skiplocked/恰好一次审计/幂等恢复断言，重跑4/4。专属临时PG已停止自动删除。
- 已有generated profile快照先备份后更新，14文件check PASS。candidate34归档不变，新增归档2项仍PASS。媒体预算资格、真实同版业务、目标环境与新包发布仍待完成；不将这轮环境通过当作F1交付。
- 新包下一目标环境协助单 OPS-CANDIDATE34-PYTHON-READONLY-20261028.md：仅解释器路径/版本/标准库及服务身份，禁止重启/安装或回传凭据。现网Python仍未验证，隔离容器结果不能代替此项。

### 2026-10-28：目标Python只读回执
- 运维确认/usr/bin/python3为3.14.4、northstar用户可运行、最低版本及标准库检查通过；服务仍r5/PID192553 active。没有安装/切换/重启。
- 补同版本Linux3.14.4包内worker/引擎兼容性，不将先前3.12测试直接外推。
- 运维已确认先前502为启动未就绪瞬态，r5该次故障关闭；主线真实业务验收状态不变。
- 目标同版本Python3.14.4 Linux/amd64包内离线worker4/4、引擎主审15/15通过；目标解释器基础回执与兼容性门禁关闭，非真实PT验收。
- Gemini发布归档预检35项原套件PASS，但独立反例发现7类遗漏；主Agent最小修复并增6项后41/41，Node默认回归包装器2/2。candidate34结构预检366成员/310文件/56目录成功；原交付记录保留，追加主审说明，不宣称部署批准。

### 2026-10-28：受控媒体持久授权增量（尚未产品启用）
- 子agent fork_turns:none短上下文独占3新文件：media-grant-store-candidate、migration022、实际PGlite回归。主Agent复用existing externalOperations抽取createIntentInTransaction，接handler可信grant/receipt，不新增预算算法。
- atomic grant消费+slot+external intent+Run事件回滚/重开/隔离与宿主未知重试拒绝证据，联合21/21PASS。manual由可信grant选择，默认AUTO及server默认不变；没有开放媒体profile、HTTP签发或付费。
- candidate34旧草案不含本增量，其当前源码绑定应报漂移；不得覆盖或宣称仍代表当前主线，后续新修订再冻结。当前新migration亦需PG并发回归，旧PG4/4不外推。
- Gemini既有任务均完成。新独立包 GEMINI-MEDIA-RESERVATION-RECONCILIATION-PACKAGE-20261028.md，只三个新文件、核对后slot可否释放纯决策，无SQL/网络/自动重提。需用户转交，非重复旧归档包。

### 2026-10-28：测试经费Key与只读目录
- 用户再次提供测试Key并明确用于真实扣费测试；Key仅通过关闭终端回显的stdin送入临时只读探针，未写文件/argv/env/输出。初次无stdin进程在收到Key前退出，无请求；后续单次GET /v1/models成功。
- 08:24:26.755UTC HTTP200/82模型；返回只含id/object/created/owned_by/supported_endpoint_types，没有价格。无聊天/媒体POST，目录可见不当运行/任务资格或收费证据。
- 已异步询问本轮总credits与单次额度，待回复前不做付费请求；独立PG并发/发布接线继续。不得将测试Key内容记入handoff/日志/记忆。
- 受控授权PG16实际双backend并发通过：pg阻塞验证Lock、只有1个reservation成功，冲突方未消费无intent；callback四者rollback及reopen未知slot保留均通过，providerCalls0。专用临时容器已停止自动删除。
- 本轮测试Key只读目录82模型通过；官方价格页核对Qwen文本和Seedream34credits/image，仍按估算对待；Wan模型页面读取失败不猜报价。付费总额/单次额度问题仍待用户回复，不自动消耗测试经费。

### 2026-10-28：受控profile及暖会话输出上限修复
- 复用DSH既有Run guard/工具白名单，host可选media:<task> profile，严格180000ms/2model/1tool/0retry/512token并单task；default/csv不改，server未启用。真实SDK四任务+durablegrant联测通过，wrong-task零RPC、warm默认权限恢复通过。
- 独立审查抓到warm maxTokens继承512而预算报128，主Agent在每次agent/request/model-intent前应用当前cap，真实provider options断言512→128及复查通过；不以预算报告代替请求验证。
- Runtime26、RPC11、profile15文件/DSH20文件检查通过；JS语法475文件0失败。核对纯函数由子agent关闭taskType/时间/Proxy/可变Set等反例后53/53，尚未接DB释放。
- r3新完整草案369成员/168源码SHA，tar SHA44b1757736ddd425a4157917984f7138f36959ef6c9d5804e3b965cf6940bce4。构建check/独立audit通过；实际tar在Linux/amd64 Node22.23.4干净npm ci后closure472/30091 PASS，预算/四任务5/5 PASS。r1/r2不覆盖，草案不可部署。
- 下一阶段：产品签发/读取受控授权、核对释放事务、媒体报价与同版真实链路；付费额度异步问题仍待答，本轮仍0付费POST。

### 2026-10-28：Gemini核对记录确认与显式释放候选
- 核对用户写回原任务包43项交付；主审后纯函数53项复跑通过。保留原记录，追加主审及时间语义差异说明。
- 独立子Agent仅新建release候选/023/专项，主Agent及独立审查修正pending now-vs-clock_timestamp兼容、UPDATE RETURNING单行核验。显式host API，无HTTP/自动释放/付费。
- 实际PG发现host observedAt比DB updatedAt快1ms，移除契约外的跨clock先后假设，仍要求二者各自不早于reserved。第一次失败记录保留；修后本地53+12=65PASS，真实双backend Lock竞争→释放commit→新slot成功，旧grant消费/历史/未知/rollback/reopen全部通过。专用PG已stop自动删除。
- candidate34-r3保持原包，不含023及release模块；尚未产品启用/真实付费，测试credits总/单次额度仍待明确。

### 2026-10-28：周五剩余范围与Gemini新独立包
- 用户询问是否持续及周五剩余。明确回复结束后没有后台常驻工作；本轮已恢复核对。当前不能把r3草案/模块通过当可上线：产品授权/释放入口、真实模型资格/报价、同版真实业务、最终冻结回归和目标部署/回滚仍在关键路径。
- RELEASE-20261030-READINESS.md更新最新复核/目标顺序，完整F1周五高风险，未知不虚报百分比或“所有对话完成”。Key已收到且GET82通过，不再要Key；付费总/单次credits仍待答。
- 新Gemini独占3文件任务 GEMINI-F3-PT-CONSUME-NORMALIZER-PACKAGE-20261028.md：复用用户提供PT四类消费记录，保留credits/未知/舍入差异，纯归一无HTTP/DB/换汇，不等待PT未来API、不挡主线；旧三包不重复派。

### 2026-10-28：交接后 server 持久授权读取接线
- live branch/HEAD与交接一致，590条Git状态；保留历史脏改动、旧归档和Gemini独占文件，无commit/push/部署/付费。
- grant store新增按owned Run读取未过期/未消费授权，多有效授权拒绝。server以持久授权选择media profile，固定grant ID并由handler重读/原子消费；无授权不提高预算，CSV不变。
- 授权/预算12项、HTTP/SDK/CSV等6项通过；扩充实际server测试后该HTTP项复跑通过，验证host签发→profile、下一普通Run恢复默认、客户端伪造拒绝。不是19项独立测试，不是全仓全绿。
- 产品签发时序/显式核对入口仍未完成，F1未交付；旧r3不含本增量。详细断点及验证见 evidence/F1-server-controlled-grant-read-20261028.md。

### 2026-10-29：继续授权时序、核对API与r4冻结验证
- 后续接通等待确认→同Key路由核验→签发→媒体profile及持久消费；授权入口默认关闭，明确没有金额硬上限。已接owned预留列表/显式核对API，未知保留，原授权不复活；前端确认支持切会话与刷新重放。14项专项通过，原replay夹具补载新helper后25项通过。
- r4新草案SHA4a681c86cbc0689d9f7c4fc25fda1b78f0c027ba2bf1d082f0adc1cbf9df4d03，373成员/172源码绑定；build/check/独立audit/结构预检通过。旧包不覆盖，不可部署。
- 首轮全回归199套件171/28：21EPERM、6历史源绑定、1夹具；沙箱外重跑最终tmp日志跨环境丢失，不能报通过。Linux首次npm安装后closure漏manifest参数失败，待修正，不声称Linux门禁已过。
- 10/29重新核对HEAD与r4源绑定不变；启动Docker并重新执行回归，日志转入evidence持久保存。详细事实与待办见 evidence/F1-authorization-reconciliation-r4-20261029.md。没有付费、部署或commit；真实额度仍待明确。

### 2026-10-29：验证收齐与Gemini展示候选主审接线
- 沙箱外完整默认回归200套件194通过/6失败，均历史candidate源码/lock绑定；日志 continuation-20261029-regression-unrestricted.log。不是全仓全绿。随后新增展示/活动草案测试另记，不能把200当新增后全仓数。
- r4确切归档在Linux/amd64 Node22.23.4：npm ci(ignore-scripts)、closure472包/30091文件及23项全部通过。首次noexec挂载原生库失败日志保留；改隔离tmpfs为exec后通过。无网络Python3.14.4 worker4/引擎15通过。
- 新授权实际PG双backend：并发2确认只1grant、revision漂移拒绝、资格核验中取消拒绝，providerCalls0；专用临时PG已stop自动删除。日志 r4-authorization-postgres-20261029.log。
- 用户确认Gemini展示完成。原26通过但任务名错误/原型继承/日期/资源扫描有缺口，主审修正并追加6反例，实际server view→历史按钮→显式核对接通；联合63/63通过。原报告保留，详见 MEDIA-reservation-view-main-review-20261029.md。
- r5新草案374成员/173源码绑定，SHA cc8c799f77d5348c0e97cad08e545e199f93229486204292e03334e0bf49313b；builder/audit及活动草案门禁通过。当前严格门禁指向candidates/current-draft.json，旧包不覆盖。r5确切归档Linux/Python验证进行中，授权默认关闭，未付费/部署。
- F3归一原包也已出现完成报告；只读反例复现非plain usage与可变导出Set绕过枚举，新R2独占任务包已准备但未假定用户已转交，不改其原三个文件，不进入本轮r5归档。

### 2026-10-29：托管媒体、固定参数与真实SDK同版离线链
- r5实际包Linux55/55、Python19/19通过；随后默认回归203套件197/6，仅历史源绑定。r5不包含后续托管媒体增量。
- 用户确认Gemini落盘完成；主审修正pending碰撞误清理/可变品牌集合/ftyp盒边界/root错误及参数，22原项+8反例=30通过。复用安全目录句柄与openTenantArtifact，已接匿名DNS固定抓取→安全落盘→owned Run GET/HEAD/Range→SDK/历史与运行记录本地链接。
- 实际server重启保留文件/历史/SHA；上游成功但本地保存失败维持external succeeded，失败Run幂等重放不再POST。固定生成参数写同版确认事件，实际JS/Python参数断言；不是金额硬上限。联合62项通过，证据MEDIA-managed-writer-main-review-20261029.md。
- r6归档379成员/178源码，SHA765898fcbd64b55325a0c3c7443c408af57f4ce0884ce71219d4eac67179058f；build/check/audit/预检、Linux Node22.23.4 closure472/30091与104项、无网络Python3.14.4的19项通过；默认回归209套件203/6，仍非全绿。r6之后参考图绑定源码已变，不覆盖旧包。
- 新真实锁定SDK＋HTTP同server的四任务：每任务2模型/1工具/0重试、托管读取/历史/隔离通过；随后warm普通聊天恢复0工具/128输出。模型/provider/资产均替身，不算真实PT验收。日志managed-media-http-sdk-budget-20261029.log。
- 参考图增量：host强制当前上传、记录来源SHA，拒绝模型外来URL；图生任务不用经模型/RPC回传大段base64。Python视频输入桥仍缺，已确认既有upload_asset可复用；GEMINI-PT-ASSET-UPLOAD-HARDENING-PACKAGE-20261029.md独立三文件任务已准备，未擅称已转交。

### 2026-10-29：r7冻结与恢复入口收齐
- r7归档SHA be3f447800f23983aff5babfe3dc13bdb9ec2dcdcde1260507c57df666d94007，379成员/178源码；相对r6仅publisher/server/UPSTREAM状态三文件变化，依赖与Python引擎/worker不变。活动指针r7，旧包不覆盖，仍DRAFT_NOT_FOR_DEPLOYMENT。
- 完整默认回归210套件204通过/6历史绑定失败，原断言与归档均保留；日志continuation-r7-20261029-regression-unrestricted.log。确切归档Linux Node22.23.4 closure472/30091与15项通过，日志r7-linux-node-20261029.log；Python仅沿用r6哈希绑定19项证据。
- HANDOFF与READINESS顶端更新，避免恢复到r5状态。资产上传候选patch/tests已出现，报告尚缺，先只读审查，未接入vendor/产品；未付费、部署、提交或推送。
- 后续Gemini上传报告已出现；原27项通过但主审复现NaN期限、错误code泄漏、缺code假成功。保留原三文件，独立overlay与主审3项修正后30/30通过；CLI group/绝对deadline及宿主授权/恢复仍待处理，不接vendor、不改r7。详情evidence/F1-asset-upload-main-review-20261029.md。
- 公开PT页面静态CDN图片匿名GET真实DNS/TLS与有界流/签名通过，603179字节JPEG，SHA8c029afcbf746d8790609b7e566879336cac88b7623b659ab6b89d95e2e6588a；无Key/生成或上传POST，仅该静态示例网络证据，不算真实媒体验收。
- 上传主审继续收口：不明POST code保持unknown、bytearray在hooks前快照；独立overlay将CLI group路径复用同一核心并限制组名，产品拒绝group注入。原27+主审7=34通过，未改vendor/worker或活动r7；绝对deadline/已有task恢复/宿主独立授权仍待做。
- 后续新增GET-only已有task恢复并共享轮询，保存回调后重查取消/deadline且保留两个ID；原上传27+主审13+同临时引擎原生成15=55通过。overlay git apply --check与patch --dry-run通过；未接宿主恢复API/worker，绝对read deadline仍需进程边界保障。

### 2026-10-29：真实测试费用授权已更新
- 用户重新给Key，明确余额可用于测试、不足再申请，并补充约20美元；原credits数值等待解除，不再重复索要单次上限。只做最小用例、串行、未知不重提；金额为用户估数，API Key不能读网页账户余额/逐笔账单。
- 新交互probe使用TTY无回显stdin、Key仅进程内存，日志白名单字段；已获网络进程批准，先GET目录后低成本文本。provider预检不当成同版Agent验收。实际进度见evidence/F1-live-session-20261029.json。
- 实际目录82、qwen3.8文本200；Seedream单图1POST成功，实际2048×2048 JPEG153587字节下载/落盘/目视通过，但为provider probe，不是Agent媒体链。
- 真server/原生DSH产品A→B暴露意图listener读旧模型，离线同原生adapter＋意图门禁复现；调整注册顺序后两轮intent/POST一致，三项回归通过。修后qwen3.5→seed2lite真实同对话均completed、历史两条，每轮1model/0tool/0retry。细节F1-live-test-and-model-intent-fix-20261029.md。
- r8草案SHA143f373fae2dacdc0fa5a9d7d5ee5e0796f202b3f28d2ae7aa33de537c4d0543，build/audit及活动门禁通过。完整回归中断无最终数，心跳独立2/2通过，原截断失败保留。后续宿主review view接线又有新源码，r8不覆盖，待新冻结；当前7项文件/scope/revision/手动准入专项通过。

### 2026-10-29：真实产品文生图与上传桥任务
- r9草案SHA2f480cff790767d581e72c1f10f26ee07b3b920176b7087a43a762b478c8fd04，380成员/179源码；build/audit通过。后续工具schema修复使r9不再绑定当前源码，旧包不覆盖。
- 首次真实产品文生图已单次生成并托管，原生DSH因工具输出未声明managed而使Run失败；1工具预算阻断第二次生成。精确补schema后，锁定DSH SDK/RPC与同server四媒体离线2/2通过。新的显式单次授权真实产品文生图Run completed、外部succeeded、本地JPEG150097字节GET200/hash匹配、匿名401、历史本地媒体引用；预算2模型/1工具/0重试。证据见F1-live-agent-20261029-media-r6/r7.json与F1-live-test-and-model-intent-fix-20261029.md。只覆盖文生图，不宣称F1全量完成。
- Gemini新独立任务包GEMINI-PT-ASSET-UPLOAD-BRIDGE-PACKAGE-20261029.md已写好，仅五个候选/测试/报告新文件；尚未收到交付。主Agent负责Run/授权/产品接线。
- r10不可部署草案冻结SHA5f8c856e24f87101864e28ba208ba1b336d8faf1319e8f200af336a4fa2ddbcb，380成员/179源码；builder write/check、独立audit、活动指针严格绑定及原生DSH/四媒体HTTP联合3/3通过。未做r10全量/Linux目标机门禁，不能部署。
- r10非沙箱完整默认回归214套件208通过/6失败：f1-candidate34旧包、t16 candidate28/30/31/32旧包、t17 lockfile来源绑定；保留失败，日志continuation-r10-20261029-regression-unrestricted.log。沙箱内184/30受本地socket限制，单列日志不用于代码判断。Linux首轮npm ci --omit=dev安装474包后因缺校验脚本所需dev Arborist而MODULE_NOT_FOUND，命令错误日志r10-linux-node-20261029.log；完整锁定依赖重跑中，不能先报目标门禁通过。
- r10确切归档Linux/amd64 Node v22.23.4在隔离tmpfs容器中完整npm ci --ignore-scripts安装621包，生产closure清单校验PASS：472包/30091文件、Arborist8.0.5、package-lock SHA795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912；证据r10-linux-node-20261029-r2.log。仅证明依赖闭包，不含r10归档内业务测试或目标机部署。

### 2026-10-29：F3消费记录R2主审
- Gemini R2三文件已交付，原40项独立复跑通过。主审发现超长字符串会在16KiB限额前被完整UTF8扫描；保留原件，用独立叠加补丁做常数时间UTF16长度早拒、准确UTF8小范围计数。临时补丁重跑原40项及10MiB反例，主审测试1/1通过，见F3-pt-consume-record-main-review-20261029.md。因当前Key消费API未确认，仍为离线候选，不接Run/账单。
- Gemini上传桥五文件仍在进行中，用户明确尚未完成；只读临时测试不作交付验收，不改其独占文件。
- 用户随后确认上传桥五文件已交付；交付后独立复跑Node22/22、Python8/8通过。主审发现R1 worker将vendored固定`powertokens.ai/api/v1/asset/...`地址改成可传网关的错误路径，且事件顺序/回执/进程退出边界不足；R1不接线、不入r10。R2独立五文件任务包已写，详见F1-pt-asset-upload-bridge-main-review-20261029.md。
- F3只读刷新PT官网qwen3.8-flash标准文本费率：0.150/0.470/0.016/0.200 USD每百万token，生成2026-10-29观察候选；选择器窗口内selected、窗口前unknown。未导入产品DB、不重算历史、不当官方实扣，见F3-text-price-refresh-20261029.md。
- 真实图生图同版试验通过：产品上传源JPEG119992字节，Run绑定源SHA，手动资格与显式授权后1工具/2模型/0重试，外部succeeded、Run completed、托管JPEG120897字节owned GET200/hash匹配、匿名401、历史本地URL；无传输mock，临时凭据删除。文字回复不替代图片目视审查；详见F1-live-agent-20261029-i2i-r1.json。
### 2026-10-30：图生视频真实闭环与 candidate34-r13 发布门禁

首次真实 Run 因已提交资产上传的查询失败而停在工具预算，保留 task ID；匿名 GET-only 查询确认远端资产成功，未重传。主线加入已知 task ID 的有界 GET-only 恢复；第二次真实产品 Run `ec5acbc4-d9f4-433c-90a4-42625048e63f` 成功，资产与视频 external operation succeeded、托管 MP4 下载哈希吻合、匿名 401、历史重开可见。r13 草案归档 SHA `f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993`，184 源码绑定/385 成员，重建、审计、活动指针门禁 PASS；本地 Node 22/22、Python 21/21，确切归档 Linux/amd64 Node22 干净安装与闭包 472 包/30,091 文件、归档内图生视频顺序 4/4、Python3.12 编译/导入 PASS。完整默认回归 220 套件 214 通过/6 旧候选或 lock 来源绑定失败，candidate31 为超时；活动 r13 门禁单独 PASS。详见 [发布门禁](evidence/F1-candidate34-r13-20261030-release-gate.md)。公网旧版 health 正常；目标机 SSH 只读认证失败，r13 unit 仍为 DRAFT 且描述继承 r4；尚未部署。

r14 发布候选仅复用 r13 的逐字节相同应用归档（SHA 不变），并生成正确候选名/目标路径的 unit（SHA `ef51137bcd05ce82a5cbce366a6fc6596538d3d1378401927e43b8f9202a25d3`）和绑定清单；promotion `--check`、`cmp` 通过。状态 `PENDING_TARGET_PREFLIGHT`，运维只读采集见 [交接清单](OPS-CANDIDATE34-R14-TARGET-PREFLIGHT-20261030.md)。当前没有目标机授权入口、原始 unit/路径/备份映射，未传包/部署/重启；收到预检后再锁定执行与回滚命令。

运维交接 ZIP `release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14-handoff.zip` SHA-256 `c259bb3d57a0a3640e0f5ba0fb870ab531c664b11ce66886e22446ac0111aa34`，含归档、unit、绑定 JSON、内层校验和及只读预检文档；构建器 `--check`、`unzip -t`、外层校验和 PASS。此 ZIP 只供目标预检后的受控发布准备，不表示已上线。

运维完整执行清单见 [OPS-CANDIDATE34-R14-EXECUTION-20261030.md](OPS-CANDIDATE34-R14-EXECUTION-20261030.md)。最初 handoff-r2 中错误要求 Linux 专用 `spawn-helper` 路径；确切 Linux 安装显示该包的 `spawn-helper` 仅在 Darwin 预构建目录。改为真实 Linux PTY 启动测试，在确切 r14 归档的 Node22.23.4 容器中 `PTY_RUNTIME_PASS`，闭包仍为472包/30,091文件。**只交付 handoff-r3**：ZIP SHA-256 `1782eb26006de82a28d26c94c8fa9a5991d71eab12643ffacdac7db891f54ff6`，6成员，builder `--check`、`unzip -t`、外层哈希、七段 Bash 语法均PASS；r1/r2保留为历史，勿执行。目标 PostgreSQL 24迁移与现网差异仍须运维/DBA只读回传，未部署。
r14 部署期间的接续目标（2026-10-30用户确认）：完整重构交付目标为2026-11-03；核心目标明确写入正式v2.0任务包与剩余计划——放大DSH能力，尽量利用原生功能，只有确有必要才关闭或自研，逐项记录理由/证据/恢复条件。Gemini原生推理强度、原生长上下文两任务包已由用户转交。运维第4步EXPECTED24/APPLIED20，仅缺020–023、无额外迁移；补充文档OPS-R14-MIGRATION-GATE-20261030.md已加入本机PG原生备份、隔离恢复、仅执行迁移验证，三段Bash语法通过，未在目标执行。主Agent接续图片理解：已核对原生AttachmentStore.saveImages、ImageBlock.attachment、LocalAttachmentStore归一化/持久引用；当前生产Runner仍text-only，下一切片需可信附件字节→原生存储→图片消息→模型能力校验→真实SDK离线请求证据，不能另造图片解析/存储引擎。
2026-10-30线上r14故障：用户截图显示`Profile requires explicit rebuild`；确切r14归档离线探针`tests/probes/r14-profile-upgrade-offline-20261030.mjs`已复现PROFILE_STALE、验证原生维护API保留旧profile并重建校验通过。原部署清单漏了已有profile离线升级步骤，新增运维修复文档`OPS-R14-PROFILE-REBUILD-20261030.md`（四段Bash语法通过）。未操作目标机；须运维停服务、受限备份、用r14包内API重建后回传。AUTO无候选仍需修复profile后用一次手动成功Run核对，不能把截图视为Key失效。

同日主线图片理解增量：复用DSH AttachmentStore/admitEncodedImages、ImageBlock和pi-ai请求投影，新增有界宿主图片消息桥、精确任务路由、独立图片运行资格写回与冷历史重放；r14归档未改变，当前源码已前进不再可用r13 builder重建。图片消息/路由/资格/HTTP与原切换/媒体/CSV聚焦联合14/14通过；另Runner/并发/预算组合13/13通过。真实PT目录83项无明确image元数据，按PT官方qwen3.8-flash精确页面增加有来源事实与该模型原生input配置，未批量推断其他模型。真实OCR样本R7K2被模型读成RTK2，证据`F1-live-agent-20261029-vision-r1.json`保留INCOMPLETE。相同图片数量/颜色独立验收`F1-live-agent-20261029-vision-shapes-r1.json`：手动→图片AUTO→冷重建均completed且回答3/red/red，PASS；各1模型/0工具/0重试，Key进程退出、临时加密库删除、日志无Key。尚未冻结新候选、未验证目标机/全面OCR/音视频理解。
r15图片理解新草案已冻结：SHA b9ee729f7138f61bd3e0d247b7fe006ebf88bd1e5b511e609ffe25f735c2db67，187源码/388成员，build-check/audit通过；活动草案指针已改r15。完整默认225套件219/6，6项仍旧候选/lock绑定（31/32超时），日志已落evidence；确切tar Linux/amd64 Node22.23.4 clean npm ci含脚本、closure472/30091、图片业务10/10通过。详见evidence/F1-native-image-product-20261030.md。r14归档未改，运维仍按其profile修复流程执行。下一实现从文档输入/产物格式接线推进，先处理候选PDF中文编码和XLSX跨服务依赖缺口，不把已有候选测试当作产品完成。Gemini两包待交付回传，主Agent不等待它们才推进其他工作。

### 2026-10-30 接续：r14模型配置故障、r16冻结与Context R2主审
核对HEAD b09b1e1/feature/northstar-phase1-refactor-20261016及脏改动，保留全部既有工作和wb copy，无commit/push/部署。运维logs20261030确认25错误：UNKNOWN_MODEL12、RUN_MODEL_CALL_LIMIT8、INVALID_REQUEST1、旧UNKNOWN4；不将匿名日志逐条绑定模型或Run。
新增dsh-configured-catalog，按实际DSH home配置收紧chat/图片理解路由，旧缓存Adapter不能绕过；新模板只加两个有当前目录依据的DeepSeek ID，未伪造AUTO。Runner安全分类UNKNOWN_MODEL/NO_ADAPTER/INVALID_REQUEST。新增yaml2.9.1显式锁定，DSH manifest由原工具重新生成并校验（旧清单保留tmp）。实际原生离线链UNKNOWN_MODEL零HTTP→两个新ID同会话成功→上游400安全INVALID_REQUEST，所有实际请求128输出token，无外部provider调用。
r16不可变草案SHA5ca372213a0aa22a9b00777cfe51fccc6542f72b027f116afd3e5205cdeb5119，193源码/394成员，纳入DOCX/严格索引/新配置模块及新Linux生产闭包；build/check/独立audit和活动指针门禁PASS。Linux Node22.23.4干净安装closure495包/31007文件；确切归档closure+模型/DOCX业务PASS，首次测试因依赖未交付导出候选失败保留，改独立OOXML夹具后通过。证据r16-exact-archive-linux-20261030-r2.log。
目录收紧要求HTTP测试显式声明其原有虚拟DSH模型配置；已补齐对应夹具，无产品旁路。11个HTTP套件分批复跑通过，涵盖普通模型/媒体授权/CSV-DOCX/图片/上传安全/断线重放/产物历史；活动草案门禁及其他聚焦25项通过。默认回归首轮仍在执行，最终数待补，不能提前称全绿。
媒体新增只读配置预检scripts/northstar-media-config-preflight.cjs，不联网/不打印Key；缺配置exit2，结构通过不等于同Key资格。OPS-R16-CONFIG-REPAIR-20261030.md给出当前r14实际settings只读核验、升级/回滚顺序与媒体缺口。目标scope/revision/permission和受限CDN待回执；不得用本地review替代。
用户确认Context R2交付。原Context+Reasoning R2共8/8及两个本地HTTP探针复跑通过，但Context探针仍人工waterfall/emit而非加载原生压缩，主审反例复现无Run chat零计数放行、取消Run辅助调用仍dispatch；未接主线。锁定compaction-basic实际明确传agent.session.id与purpose=compaction，后续应复用该归属并增加可信一次性聊天准入、取消/时限/意图/usage。主审报告GEMINI-DSH-CONTEXT-R2-MAIN-REVIEW-20261030.md，反例证据dsh-context-r2-counterexamples-20261030.json。
默认完整回归最终232套件214通过/18失败（exit1）。随后11个配置夹具与活动草案指针1项独立复跑全部通过；余6项为既有历史candidate/lock绑定，candidate31/32为signal终止，非通过。未再跑整轮，不报全绿。最终证据见evidence/F1-r16-model-config-repair-20261030.md；构建check再次PASS。运行验证进程均已结束，不暗示回复后仍后台开发；后续优先取得目标实际settings与媒体scope/revision回执，完成r16目标发布预检/配置交付；上下文/推理继续按主审缺口修复，不启用不安全候选。
### 2026-10-30：线上实际settings回执与下一步运维小包
用户转回activeSettingsReadable=true/configuredModelCount=24，deepseek-flash、deepseek-v4-1-flash-260910、qwen3.8-flash均false，seed-2-0-lite-260228为true。证明实际home缺这些ID，但尚不知是否有运维编辑/受管基线，不能直接整份覆盖。r16源码check/audit/DSH manifest复核PASS，无应用源码变化或部署。
新增只读active-config-inspect脚本，复用目标r14已存在settings-version API；输出状态/哈希/匹配布尔，不输出配置正文或Key。读写不变/脱敏/基线编辑专项1/1通过。与既有媒体只读预检及OPS-R16-NEXT-ACTION-20261030.md封装4成员预检ZIP，SHA a567d54e69a4caf14ac39cc43df519890b969b6c5cb3bbb843c555c19efaa61c；builder write/check、ZIP、内层hash及2段Bash语法PASS。只读包不含应用/部署命令；可先发运维，服务不动。用户还需同故障账号浏览器媒体scope/revision回执，文档已含精确命令；配置未变无需重复媒体存在性检查。收到结果后锁定迁移/发布/回滚，不能通过改标签把草案当已部署。

### 2026-10-31：不等待运维，周一11-02目标与r17办公文档增量
用户明确继续开发、不等运维；交付目标按周一2026-11-02更新，替代旧11-03，范围/质量不缩减。基线HEAD仍b09b1e1，保留既有脏改动和wb copy。完整台账MONDAY-FINAL-DELIVERY-20261102.md。
复用现有ZIP/worker/Mammoth及锁定xmldom，新增XLSX原sheet/cell与PPTX原slide/paragraph文本提取，接上传/前端与Run上下文、源SHA/定位/截断覆盖；无公式执行/猜日期/外链读取。新增对话菜单Word导出，复用DOCX候选+输入门禁、有界worker与owned会话API，保留中文/原文与历史，明确不嵌入附件。不是模型主动文档产物或统一索引。
旧6类归档门禁改为对已哈希固定的冻结源码重建/验证，而非要求旧包等于今天源码；完整原测试tar保留，旧发布物不变，活动候选仍严格绑定当前源。12项旧门禁复跑PASS，无跳过套件。
r17草案冻结SHA63c9c22b8b54fdc599791d50453561c0a293ca84ea1651e544631dc612b23715，198源码/399成员；builder/check/audit/活动门禁PASS。Linux22.23.4 clean npm ci+closure495/31007；确切tar10/10业务+模型probe通过，另真实DSH SDK/HTTP上传→正文→Run→Word→历史同链在本机及确切Linux归档各1/1通过，无付费provider。完整默认236/236；扫描时自动发现Gemini推理R3测试，但未收到正式交付确认，不以此主审或接生产。独立PG16真实多连接4/4，临时容器已清理。
详细新增能力/证据/原失败/限制见evidence/OFFICE-PRODUCT-R17-20261031.md。源码已前进导致旧r16源绑定漂移是预期，不覆盖旧包。Context/推理R3独占文件保持不动；已异步询问推理R3是否交付，等待确认不阻塞其他工作。后续优先原生工具统一预算/Run门禁→提问/审批/联网及R3主审接线；其余完整范围和线上门禁未关闭。无部署、commit/push，所有本轮验证进程已结束。
### 2026-10-31：继续原生工具门禁、r19冻结及推理R3主审
在r17后未等待运维，继续补原生tools/execute的Run门禁：确切Agent对象+当前原生tool/call轨迹/名称、取消/过期/白名单/预算；防热Agent旧Run迟到调用。宿主包装器保留计数责任，真实SDK验证2次宿主工具仍计2，原生web_search显式允许1次计1、热撤销零provider。未默认开启任何原生工具，未增加默认预算，web_fetch/OS工具仍拒绝。
r18草案SHAadce48980852b8b27b51158b99da9d3f66a772c043e390cad2434611053672eb保留；复核发现热Agent跨Run还需原生call轨迹，独立修正后新r19冻结SHA7eb6d84fe8f2aa810f7f966071f0c11bed2b5a3a6f46b3ce10bc3b03dc6798eb，198源码/399成员。r19构建/check/audit/活动门禁PASS，确切Linux closure495/31007+5/5原生/媒体/CSV/Office同链PASS。完整默认冻结后239/239、0失败。r18过程238/238期间源曾变动，不替代r19门禁；R17本轮真实PG16 4/4的存储源码未变，不重复运行或虚报新PG结果。详见NATIVE-TOOL-RUN-GATE-R19-20261031.md。
推理R3任务文档已COMPLETED，按正式交付主审，原4/4和本地HTTP探针复跑通过；独立复现cwd加载未验证999.0.0同名包、reasoning=false全量Object.keys、任意wire被广告为支持、错误回显字段。候选SHAef4c41c3fcac0bdd23e126aafeb7be3843b1bd37ff9ba998e1ebb3b0487dcf77，原四文件不改/未接生产。锁定DSH自身已有规范化元数据及请求前档位校验，独立实际Llm服务probe通过0stream；主线不再叠加自建thinkingLevelMap验证器，后续做UI→Run→Runner产品接线。报告GEMINI-DSH-REASONING-R3-MAIN-REVIEW-20261031.md。Context R3仍无交付记录，自动发现测试不当验收。
下一主线：原生提问/审批的owned持久等待与UI、原生元数据驱动的推理选择、Skill发布及可信search provider；其余周一完整范围仍按台账关闭。当前无付费provider、部署、commit/push，旧脏工作与历史包保留。

### 2026-10-31：用户主动要求换新对话，完整交接后暂停
用户明确“稍等……总结完整摘要……新开/new再开始”，立即停止新开发，只做代码/Git/发布哈希/证据/运行状态只读核验及交接文档。最新HANDOFF-20261031-CONTINUATION.md为唯一优先续接入口，Git快照HANDOFF-git-status-20261031-CONTINUATION.txt。r19的198源码全部仍匹配冻结计划；没有新增推理产品接线代码，最后仅调查metadata RPC、UI→Run→Runner和可收费心跳生命周期风险。源码默认关闭心跳，但metadata-only子进程不能意外成为付费心跳目标。
主线未完成，不是在等Gemini；其两包接入不等于最终完整版。推理R3正式主审未过，改为复用原生resolveModelInfo/resolveCallWithInfo；Context R3三文件存在但证据报告缺失、无交付记录，继续保留独占边界。r19默认239/239及确切Linux5/5日志/归档SHA重新只读核对；本轮临时Northstar容器为空。未新增付费、部署、commit/push，未改生产源码或启动测试。交接完成后停止，等待用户手动/new；没有本助手后台开发任务。

### 2026-11-01：恢复主线、Gemini正式回报与6包并行队列
按HANDOFF-20261031-CONTINUATION恢复；分支/HEAD未变，r19 builder --check确认198源码绑定后才开发。当前adapter/Runner已新增model-info-v1独立元数据RPC，隔离metadata-only心跳目标，有限并发/超时/取消/能力协商/空闲回收；尚未接tenant/API/UI/持久Run，未完成产品闭环。新增RPC/原错误帧/父RPC联合3/3、实际SDK原生工具与metadata零模型调用联合1/1通过。源码现已前进，r19作为历史冻结包保留；未新冻结、未重新生成manifest或声称当前工作源码可部署。
用户确认推理R3与Context R3完整报告已写回，现均按正式回报主审；推理候选SHA仍ef4c41c3fcac0bdd23e126aafeb7be3843b1bd37ff9ba998e1ebb3b0487dcf77，已有4反例不因报告更新自动消失。两包单元共8/8；Context原localhost探针复跑通过，沙箱EPERM保留并获批外跑。独立新增dsh-context-r3-main-review-20261101.mjs复现5项controlled dispatch穿透：无活动Run chat、请求runId覆盖真实Run、缺意图记录器、await审计期间取消、创建流后首次消费前取消。JSON标BLOCKED_FOR_INTEGRATION，真实providerCalls0；原直接summarize非Agent自动/command入口，不能称Context已验收。
用户要求更多Gemini任务以加快11-02全量目标。已准备GEMINI-BATCH-20261101.md及6包：首批Context R4/可移植XLSX/音视频原生复用调查，排队跨资料检索/记忆来源范围/Skill原生loader调查。22独占输出路径无重叠、无已有文件冲突；不改主Agent共享接线。仅准备待转交，不暗示已派送/运行；最多3包同时执行。全量按期是目标，尚不能保证，不将6包覆盖当全量剩余范围。主Agent仍承担推理产品接线、主审、集成及其余完整台账；无真实付费、部署、commit/push。

### 2026-11-02：用户授权立即保险commit/push，独立于功能验收
用户要求不等待推理链收口，先保全两周未提交工作到tjj1234/pt-test远程新分支。执行分支backup/northstar-wip-20261102-safety，原HEAD b09b1e13720cd16cd7538999d4c63386920b367c；Gemini R3候选与所有共享未提交源码一起进入WIP保险快照，不混称已验收功能提交。现有源码/文档/测试/历史发布物/wb copy副本保留；浏览器临时痕迹、Python缓存和既有忽略的私钥/数据库/runtime/依赖不上传。详见INSURANCE-SNAPSHOT-20261102.md。此条在提交前写入，实际commit与远程成功以Git记录及push后ls-remote核对为准；不提前宣称成功。不merge main、不部署。

### 2026-11-02：第一条产品链本地验收关闭，准备独立功能提交
从已推送保险dae46d5创建feature/northstar-integration-20261102，保险分支不动。推理核心接线已在保险中；本轮新增真实浏览器脚本和通用northstar-chain-checks机械入口、旧Runner能力拒绝回归、最终UI修正。实际浏览器暴露更多按钮被.nav button覆盖遮住会话标题，已修CSS；保存档位时保留未发送输入，清空提示不再显示空红色警告。最终源码统一验证boundaries13/13、真实app.js DOM57/57、HTTP+真实Chromium/原生DSH SDK同链1/1，开始/结束源码hash无漂移。没有付费provider。主Agent批准LOCAL_CHAIN_CLOSED，报告REASONING-PRODUCT-LOCAL-ACCEPTANCE-20261102.md；不是生产/全量交付。活动归档仍旧r19，不修改其历史文件或假装新源码可部署。
复跑入口node scripts/northstar-chain-checks.mjs --chain reasoning --browser；输出固定JSON与完整文本日志，source绑定可verify-report。脚本覆盖其他六包机械入口，最多两个独立测试进程；是否接入仍由主Agent统一判断。Gemini批次文档的原有未提交交付汇总保持保留，第一条功能提交不混入其改动。

### 2026-11-02：Context R4主审阻断，检测网保留反例
首条本地产品链提交6c5a4cc已完成，未push新集成分支、未修改远程保险分支。Context R4原单元与localhost探针独立复跑通过，但新增context-admission-main-review-20261102.mjs的8项主审反例全部失败：缺准入证据/缺完整绑定/Infinity TTL、异步换Run、实际输出上限、审计原文泄漏、观测异常settle、未消费return。原auto:false+dummyAgent空历史/compact仍不证明真实Agent自动与维护Run手动压缩。结论BLOCKED_FOR_INTEGRATION，原件保留，未接Runner。主审报告GEMINI-CONTEXT-R4-MAIN-REVIEW-20261102.md，复跑与源码绑定在context-chain-checks-20261102.json，不能把原包通过写成已验收。
XLSX原单元/反读探针机械复跑通过，但仍需主审依赖解析/资源边界及产品接线，不算closed。新增CHAIN-ACCEPTANCE-20261102.md统一列各链证据、提交及未关闭范围。继续下一条可闭合产品链，不等待所有候选主审完成；Context修复保持明确独立阻断，不伪装全量交付。

### 2026-11-02：第二条本地产品链关闭——CSV分析Excel结果
Context阻断证据提交f186f34后继续独立XLSX链，不等待其他包。主审新增3项反例复现cwd依赖回退、非法limits/非法XML sheet名及无聚合文本限制；修正原候选（原件在保险dae46d5）并保留失败日志，合法隔离探针显式提供shell锁定依赖。原生csv_analyze新增可选outputFormat(csv/xlsx，默认csv)，宿主复用Word有界worker与安全发布/owned读取，Excel结果进入事件与历史产物面板，未增加模型/工具预算或依赖。联合回归发现原CSV及新XLSX事件SHA在扫描入历史时丢失，已合并持久宿主artifact元数据并保留SHA。
最终xlsx --browser机械命令3项均exit0，25文件开始/结束SHA无漂移：unit-review14/14（其中产物UI独立脚本64/64另列）、合法格式probe、HTTP原CSV/XLSX/Office-Word3/3；XLSX summary A2:I2精确值反读、无公式、SHA/匿名/跨用户/历史重开均通过，真实浏览器下载/刷新截图已目视核对。共享源码另跑reasoning --browser也全通过，26文件绑定验证通过。主Agent批准LOCAL_CHAIN_CLOSED，仅CSV分析Excel结果，不等于任意文档工具或全量交付。完整报告XLSX-RESULT-PRODUCT-LOCAL-ACCEPTANCE-20261102.md；当前准备独立功能提交，最终hash以Git为准，无付费provider或部署。Gemini批次汇总的原有未提交改动继续保留，不混入本链代码提交。

### 2026-11-02：串行闭合与远程保存检查点
本轮功能提交6c5a4cc（推理本地链）、0638d8f（CSV分析Excel本地链）；中间f186f34单独记录Context R4阻断，不算功能闭合。两条链在当前共享源码的绑定报告均验证通过；未跑最终全量发布验收、未部署、无真实付费provider。用户/Gemini批次交付汇总新增32行原样保留，另作进度文档提交，不混进两个功能提交。
按用户此前明确指定tjj1234/pt-test保存工作与当前逐条提交要求，将集成分支feature/northstar-integration-20261102推送同名远程分支；此条在push前记录，成功须以push回执与ls-remote同hash为准。不触碰main或backup/northstar-wip-20261102-safety。下一待闭合为跨资料检索/删除失效；Context仍8项主审失败及真实压缩入口未证明，记忆/Skill/音视频与全量剩余范围不降级为完成。当前没有本助手子Agent；机械测试已结束，浏览器夹具已关闭自身临时会话。

### 2026-11-03：r28有界交付、用户授权直接部署完成
用户将范围改为核心链＋三类标准媒体，排除Seedance全家族/图生视频及AV/PDF/OCR/联网审批/真实账单；Gemini后续包暂缓，新OAuth文档不采用。r28确切归档e4aa5e2042b831267acc6ce7ad620b6d8ba36d8e4d5163542ba6260c78e0d501，217源码/419成员；最终ZIP b4ca44ebde755b08710b51632f8d0837d0a531254c33ff0fc63258f64a5771db，45成员；263/263、Linux23+4+1、六链browser/source-log绑定通过。源码3deac76，交付062fe47，已推送同名集成分支。Context原R4阻断已被修复后的10项独立反例及产品链验收取代，历史blocked报告不再代表r28当前状态。
用户明确授权SSH自行部署后，目标锁依赖安装、Node24生产闭包/PTy通过；旧服务无有效Run租约，停机后PG备份真实隔离恢复及runtime/secrets/env/unit备份校验通过，隔离迁移24→29保留171Run。settings精确基线升级并重建profile，15:10:49北京时间切换r28，PID302282、active/running、无重启；217源码哈希、29迁移、171Run、公网HTTPS与app.js、登录页和认证边界通过。7账号只读fresh目录的Seedream T2I/I2I和Wan T2V手动资格通过，零付费生成，不伪造runtime verification或媒体AUTO。恢复点、实际日志及边界见evidence/R28-ONLINE-DEPLOYMENT-20261103.md；功能清单ONLINE-R28-FEATURES-20261103.md。不要把已上线、只读资格通过与真实付费业务验收混写。认证口令不入仓库和文档。

### 2026-11-03：用户要求准备/new，保存交接后停止新工作
新会话唯一优先交接为HANDOFF-20261103-R28-ONLINE.md，取代10月31日旧交接作为当前入口。r28部署、功能清单、精确产物、恢复点、未进行真实付费执行及范围约束已记录。SSH已退出且sudo缓存清除，公网验收浏览器已关闭；没有本助手后台部署/测试任务，线上服务继续运行。此后不继续开发或改线上，等待用户手动/new及新指令。

### 2026-11-05：R30已部署待QA，用户要求总结后/new
唯一恢复入口docs/refactor/HANDOFF-20261105-R30-QA-AND-PENDING-REVIEWS.md。R30已实际切换，PID339125、217源码/公网健康核实，273Run/29迁移备份隔离恢复通过；Bug-12降级，独立QA未完成。第二批Bug d3325a4待分诊，Gemini88dd344(23/23作者自测)待主审，不混线。部署误检查/app.js401触发回滚的主程责任及后续门禁已入PROJECT-REVIEW-LESSONS.md；实际正确路径/assets/app.js。无后台测试/部署/付费任务，当前主线仍bbd9997且脏工作保留，不重复部署或清理他人工作。等待用户/new后按交接队列恢复。
