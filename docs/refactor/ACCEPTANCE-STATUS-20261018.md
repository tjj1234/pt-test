# 北极星一期验收与上线事实矩阵（历史基线：2026-10-18；candidate-28更新至2026-10-22）

## 2026-10-22 当前复核增量（优先于下方历史快照）

最新全量默认回归 **133/133 PASS**（Node 24，candidate-28绑定、失败Run HTTP/replay及T06分页权限HTTP集成夹具、当前 T18 helper 接入后）；candidate-19至27 USTAR/历史候选绑定专项 **10/10 PASS**，candidate-28 包绑定专项 **2/2 PASS**。之前的candidate-24 mutable-source断言已改为校验冻结包自身hash；UI隔离夹具现在清理各用例的storage/活动句柄，并以快时钟完成未知状态轮询。pending-key UI恢复 **24/24**、storage fail-closed UI **25/25**、UI隔离 **43/43**；T03失败诊断HTTP持久化/replay **1/1 PASS**（loopback权限下），T06分页PT响应经`/api/models`→手动选择→dry-run chat **1/1 PASS**。T18 dirfd原语Darwin rename/replacement enumeration fixture **3/3 PASS**，Linux枚举专测在Darwin跳过；helper尚未接入data-backup。以上是本机dirty-worktree结果，不代表clean checkout、hosted CI、生产部署或目标环境验收。T03真实目标机日志、媒体账单与T18真实备份演练仍缺。

最新候选为candidate-28，SHA-256 `1d50a46516ad1d3501889c3caaa814967a77e02e8b8bda9edcc1cb1f669789f4`，unit SHA-256 `ccb75eeb1e36abe5602066beebe6fc206003969308d434e6f4df344b9d8b4b61`；从不可变candidate-27仅overlay `shell/model-catalog.cjs`，使当前 `/v1/models` 响应中实际列出的模型逐 ID 获得 `permission=true`，同时不把未确认完整性的列表当成目录删除证据。candidate-28尚未部署，维护者编号清单未回传输出，线上资格字段与唯一一次真实Run均未观测。严格总验收继续为T00–T18 **0/19 full PASS**、AC01–AC24 **0/24 end-to-end PASS**。以上本机dirty-worktree定向结果不代表clean checkout、hosted CI、生产部署或目标环境验收。

candidate-28 的当前本地证据与线上状态分离：`node scripts/run-regression.mjs` **133/133 PASS**；candidate-27新增持久终态专项 **2/2 files PASS**，candidate-28 USTAR 单文件 overlay/hash/runbook 专项 **2/2 PASS**，失败 Run 的 HTTP terminal/replay 字段专项 **1/1 PASS**，编号清单8个bash块语法通过。维护者清单尚未执行/回传，目标机T06/T07资格字段和唯一一次获准文本Run仍未观测；不能将本地PASS提升为线上资格或任何任务/AC整包PASS。

## 2026-10-22 后续增量：candidate-23、T01/T10/T12 与独立审计

需业务方确认：T05 BYOK 在Run中撤销/轮换是否立即中止；web/CLI/bash/MCP 暂停或逐项放行；T08 获准的图/音/视频理解端点、golden样本、拒答与额度；T09 试点文件、标准计算和源/派生数据删除边界；T13技能发布权限及run pin策略；T14插件版本/owner、搜索读取域、重定向/私网拒绝和child egress边界；T17依赖责任人/来源/过期策略；T18备份范围与恢复RPO/RTO/操作角色；AC18性能目标环境、模型/地区/网络、代表请求/样本数及付费预算。缺少产品输入的项不以本地证据替代。

用户已确认：编辑/删除的记忆若已发给上游且 Run 仍在执行，应取消对应 Run。`/api/memory` POST/DELETE 现在按当前 user/tenant 取消已处于 `running`、`waiting_external`、`awaiting_confirmation` 或 `cancelling` 的 Run，再关闭其 DSH 会话；queued Run 不受影响。只有持久状态达到 `cancelled` 才报告取消成功，远端仅进入 `cancelling` 时接口明确 503，不会误报成功。专测验证 active cancellation、queued 保留及 remote cancellation 未确认；本地执行服务与 T12 专测通过。未验证真实多实例目标、PG或PT远端运行中取消。

最新候选为 candidate-23，承接 runner 预算计数修复、PT `supported_endpoint_types` 可信能力映射、T12 活动 Run 取消、T01 `auth.initAuth` 初始化错误清理及 T10 历史产物重开恢复；聊天限流改按账号每分钟35次，Run并发提高到每账号4、每服务进程全局16。包内限额文件由 systemd 在共享环境文件后加载，覆盖旧值。router 只在 `endpointCompatible === true` 时放行，缺失证据也拒绝。含20个 migration、323个USTAR成员，无AppleDouble。archive SHA-256 `30568c8ea3f1c02369342b4338c9f484e64f61441a82491f0b5050c2afa2d4e2`，unit SHA-256 `12062c15b0195efb19a3116bf9da4006bf66db78f80bacae2e8dd17bf9eec072`。编号维护者清单位于 `北极星受控试运行部署命令清单-20261022-candidate-23.md`。它绑定未提交工作区快照，未部署；线上当前key模型权限字段、router放行模型及一次真实 1-request/0-retry/0-tool/180-sec 验证仍未观测。

T15 独立 workflow 审计：Node 24 本地 CI 语法 358 文件、default regression 123/123、一次性 PostgreSQL 16 regression 3/3、A7 scope verifier 及 attribution 25 个文件通过；迁移工作流标签已改为准确的“迁移文件存在性”。这些结果不是 Node 20/22 hosted Actions 或 clean install 证据。AC18 仍 blocked，缺目标浏览器/移动端、同条件分阶段性能采集与 P50/P95，需负责人确认环境、模型/地区/网络、样本及预算后再采集。T15/AC18 证据见 `evidence/T15-AC18-local-workflow-audit-20261022.md`。

三子agent当轮独立只读审计：T06/T07当前key permission→router本地资格切片43/43 PASS，但目标线上无模型ID/真实Run；T05 child仍可读BYOK，AC16 blocked。T08/T09没有真实多模态理解路径，局部测试不能证明媒体模型理解；CSV deterministic analyzer 未接Run/UI，AC08/09/10/21未端到端验收。T13技能hash/pin原语未接Run admission/loader；T14仍无网络allowlist/SSRF/child egress隔离；T17缺完整依赖治理；T18缺目标升级、数据库/文件/密钥恢复演练。详见 `docs/refactor/WORKLOG.md` 与分任务证据。2026-10-22 后续当前工作区 default regression **128/128 PASS**；仍不代表clean checkout、Node20/22 hosted CI或完整验收。

candidate-23 已取代 candidate-22，进一步包含 T10 assistant 历史产物元数据持久化和重开恢复、账号级限流及放宽的并发额度。T10 HTTP/DB **1/1**、UI探针 **62/62**；限流与 scheduler **15/15**；候选23结构和内容断言 **6/6**通过。candidate-22历史证据仍见 `evidence/candidate22-package-verification-20261022.md`；candidate-23证据见 `evidence/candidate23-package-verification-20261022.md` 和 [candidate-23维护者部署清单](北极星受控试运行部署命令清单-20261022-candidate-23.md)。最新完整本地 default regression 为 **128/128 PASS**（`node scripts/run-regression.mjs`，2026-10-22；Node24、dirty worktree）。candidate-23 未部署；T10仍partial（目标Linux实际文件/下载及失败停止路径未验），也不改变T01、T06/T07或整包验收状态。

## 2026-10-19 增量（以下历史快照按本节覆盖）

整包T00–T18及AC01–24仍无新增完整验收PASS。T07已接对话模型偏好、v3排队选择快照与受控HTTP/UI；T09已接CSV解析/来源/版本及再生历史保护，证据见对应20261019文件，均仍partial。T16已加入packaged DSH完整性、profile路径/生命周期/精确发布输入、settings显式登记及受限升级/rollback、未声明启动覆盖层拒绝；较早的12文件联合55/55已由后续入口/安装/manifest/profile/settings/bootstrap 8项专项67/67扩展。在线隔离npm ci和空home真实CLI ready取得CLI发布子集证据；离线干净安装因隔离cache `ENOTCACHED` 未启动，完整HTTP/UI产物、依赖闭包逐文件校验、OS隔离及生产升级仍未通过，AC19/20继续blocked。

T03追加发现并修复最短TTL续租过晚、远程慢取消阻塞heartbeat、未来SSE游标压制其他observer三处缺陷；真实PGlite/store和持久日志模拟联合6/6通过。真实PG租约专项5/5、两个真实HTTP实例SSE1/1通过，证据见`evidence/T03-heartbeat-sse-postgres-20261019.md`；这不等同浏览器断网或生产故障恢复。Google/PT真实用户链路、T08多模态、T09完整格式矩阵、T11真实费用、T15/18最终独立整体验收及部署仍是全项目开放项。当前分支/HEAD未变，全部实现仍在未提交工作区，未推送/部署。最新命令、限制和清理见WORKLOG，历史只读盘点不等于当前完整状态。

## 2026-10-20 增量（更新至项目 deadline 前一日）

T03 `queued-run-recovery-test.mjs` 1/1 PASS；运行恢复、队列与付费操作此前联合专项另有 PGlite/mock 14/14 PASS（本轮未重跑联合组）。针对已知 provider taskId 的 `queried:true` 审计字段和结果写入重试返回值已窄修复，`media-run-lifecycle-test.mjs` 12/12 PASS；独立复核补充并复跑最终 mock store 状态断言，覆盖重试与持续失败后的 operation/Run/reconciliation 状态。`external-operations-worker-test.mjs` 本轮补父 Run 成功聚合与终态不回转断言，PGlite专项及主Agent复跑5/5 PASS。以上不是生产 PostgreSQL 最终行或真实跨进程验收。Docker daemon 未运行，最新双 HTTP 实例 PostgreSQL SSE 未复跑；真实浏览器刷新/断网和生产故障恢复仍未验。

T08 附件/media 定向回归 10/10 Node tests、media.route 80/80 PASS，均为 mock fetch。只有 auto mode 或明确 image2image/image2video 分支会在文件可读且不超限时把 data URL 文本写入 `imageNote`；runner followup 为 text block，配置 route 是 text-only。加固后的实际runner子进程JSONL探针捕获请求只有text block；其中进程内fake adapter未配置PT adapter，不能视作socket/包级外连监测。合成标记不是有效图片payload。这些证据不证明模型接收像素或有视觉理解。真实HTTP历史图片回放证据与限制见下段；审计记录见`evidence/T08-input-audit-20261020.md`。

10月20日HTTP探针先定位并保留历史图片重放失败证据，随后窄修复已完成：新消息在conversation JSONB存ref/SHA256/size；regenerate/branch在消息保存和tenant fixture前按同租户原快照校验，并从同一已校验Buffer组装imageNote。`northstar-t08-upload-to-runner-jsonl.mjs` **14个汇总语义断言/输出项PASS**，覆盖上传、持久化、未变regen/branch、旧历史缺快照拒绝、改图regen/branch拒绝且fixture capture不增加；changed regen/branch两条失败路径均对比前后conversation messages深等，legacy模拟路径只验证错误和fixture capture。敏感路径过滤和384依赖链接realpath containment通过，owned staging清理PASS。`chat-request-attachments-test.mjs` 1/1 PASS。过滤是best-effort路径/名称规则，不扫描文件内容；合成规则覆盖service-account、access-token、token.js、私钥、轮转日志和备份命名，旧历史场景经preload模拟，不是生产遗留库迁移测试；probe使用loopback HTTP但未做socket级外连监测；无真实模型/provider或图像视觉理解。T03生产语义review PASS；T16 probe隔离复核 PASS（scope-limited），不代表T16发布/生产验收。T08官方主状态为untested，仅附件输入/持久化子范围为partial，整包口径不变。

T16 入口/安装/manifest/profile/settings/bootstrap 8个专项 67/67 PASS；`dsh-cli-profile-ready-test.mjs` 另以已安装依赖验证真实 DSH CLI ready/idle **1/1 PASS**，无模型/工具调用且临时 profile 已清理。新增隔离 staging 本地 HTTP smoke **PASS**：真实 shell server + PGlite、fixture身份/模型/DSH 下，health 200、未登录重定向、登录页、2个静态资源、登录后同源 `/api/me` 与 `/api/conversations` 均200；确认harness退出及owned staging清理。app artifact integrity probe **PASS：222个allowlisted checkout文件、18个顶层HTML中带引号且以`/assets/`开头的src/href引用存在**，manifest SHA-256=`bad6324b93ff1ee56fa4b4242b7c4e2b21964511900445e48a2f63e2b1f4dd4b`；不核对Git index/实际发布清单，不含媒体/字体等未列扩展，也不是完整源码/运行时/依赖闭包。隔离 cache 的离线 clean-release 探针在 `npm ci` 因 `ENOTCACHED` 失败，未执行该干净发布流程中的 DSH ready/idle；临时 release、HOME、日志和专用 cache 已清理，未联网重试。故 AC19/20 的完整依赖闭包、生产HTTP/浏览器、目标OS隔离与预发布升级/回滚门槛仍开放。

10月20日另运行 `node scripts/northstar-dsh-manifest.mjs check --manifest shell/runtime/dsh-release-manifest.json` **PASS**：当前本机 DSH CLI `0.1.1-rc.2` 的20个文件与release manifest、vendor tar及lock一致。该只读检查收窄本机单包内容/入口不确定性，不验证transitive依赖闭包、干净安装、生产profile、目标OS或升级/rollback；T16/AC19/20仍blocked。

T11 用量与 admission 局部回归 **17/17 PASS**，覆盖观测response累计、去重、unknown保留、预算fail-closed及provider worker有界查单；证据见 `evidence/T11-usage-evidence-20261020.md`。另有失败 Run 的 UI 局部回归，见 `evidence/T11-failed-run-ui-20261020.md`：只覆盖失败终态 SSE 到 UI 的步骤保留/提示顺序，不验证后端持久化、replay、工具状态与 usage 联合记账或 AC22；真实账单、内部网络/retry计数、失败/取消全链路、权限和完整用量/日志 UI 仍未验。

后续同日跟进：T03 修正 host 对 taskId 轮询结果的 `queried` 审计记录和持久化重试返回，`media-run-lifecycle-test.mjs` **12/12 PASS**（mock/PGlite）；独立复核补充最终 mock store 状态断言并复跑通过，但不是 PostgreSQL 最终行验证。T08 实际 runner 子进程探针经隔离环境运行，收到合成文本标记，fake adapter 捕获只有 text block、无 image modality；探针不含有效图片 payload或 server 上传/`imageNote`组装，网络隔离仅由进程内 fake adapter 架构保证。T16 artifact integrity probe 当前版本检查六个指定源码根中的allowlist checkout文件；18项引用仅指顶层HTML里带引号、以`/assets/`开头的`src`/`href`，不覆盖嵌套HTML、srcset或CSS/JS动态引用。222文件、18引用及manifest新hash已替代旧版199文件/旧hash结果；该probe与clean-release都不构成完整应用发布验收。

10月20日晚间增量：T03 `external-operations-worker-test.mjs` 扩展至 **6/6 PASS**，新增PGlite事务成功后API边界ACK_LOST恢复回归；只模拟store API回执丢失，不模拟真实PG网络故障。T08 附件失败SSE提示修复的前端回归当时为 **20/20 PASS**，T16独立审阅通过；错误以非持久化系统提示显示、原历史保留、needKey不重复提示。之后同一 UI 单文件新增一条 T11 失败 Run fixture，最新总数 **21/21 PASS**；它只证明失败 SSE 到 UI 的步骤数据保留及提示顺序，不证明后端持久化/replay、工具状态与 usage 联合记账或 AC22，详见 `evidence/T11-failed-run-ui-20261020.md`。当前失败 assistant 历史仅保存错误正文、不含steps；通用工具 `args/result` 无已验证的通用脱敏，steps安全历史表示待T03确认，不能据UI fixture持久化raw steps。之后整体Run失败保留工具原状态的后端窄修复及 `chat-usage-failure-accounting-test.mjs` 联合fixture已落盘；此前一次运行在 `freePort` 监听处因 `EPERM` 失败、未进入服务断言，提权重跑已中止；随后在获准loopback环境实跑 `node --test tests/regression/chat-usage-failure-accounting-test.mjs` **1/1 PASS**，此前EPERM执行问题已解决。该用例通过真实 shell HTTP + PGlite 验证工具状态及run/response usage写入，`runDshForUser`为受控fake runner；T03随后增加 `persistSteps` 窄修复，使受控 failed/stopped timeout Run 保留已观察的成功/失败tool step状态，T16静态复核PASS（未重跑）。未端到端覆盖adapter call-only/no-result帧、真实SDK取消或timeout的Run terminal DB断言；不证明真实DSH/provider或费用、失败assistant历史steps持久化/replay或T11/AC整体通过。T03加固fixture setup/cleanup，清理此前owned临时目录并确认无同前缀残留；`node --check`及目标diff-check通过。取消/中断残余：任务包未明确停止/超时时已成功工具的工具级终态；局部修复与受控fixture保留已观察到的成功/失败步骤，但不覆盖真实SDK取消/timeout及其terminal DB断言。T16本机DSH `0.1.1-rc.2` manifest/vendor/lock核对20文件PASS。上述均为模块局部证据，不改变总体0/19、0/24。

## 2026-10-22 增量（历史记录更新至 candidate-16）

### 之前变更：PT endpoint 可信任务映射（candidate-11，已作废）

candidate-11曾按可信值推导任务，但 endpoint compatibility 同时读取 `supported_endpoints` 别名，超出用户确认范围，现已作废。其历史 checksum 与后继包保留在工作记录供追溯。目标机没有部署 candidate-11。

### 历史变更：严格 endpoint 来源与 candidate-16（后由 candidate-17 取代）

PT确认的五个 `supported_endpoint_types` 值仅由该字段派生任务能力并记录来源；`supported_endpoints` 别名不产生可信任务或adapter兼容性。显式 task=false、冲突模态、permission、localPolicy仍按资格门禁执行。手动和AUTO router共用 endpoint compatibility 检查；手动首调不要求既有运行验证，端点不匹配会明确返回 `ADAPTER_ENDPOINT_MISMATCH`，AUTO仍要求当前能力revision的运行时验证。定向回归 **37/37 PASS**，旧目录回归66/66。candidate-15因T10 FIFO打开阻塞缺陷作废；candidate-16加入非阻塞打开后由`fstat`拒绝的修复，T10定向回归8/8 PASS。candidate-16归档SHA-256 `c4d5133b057fc65a1298a0977ba5b28a10672486ba065319eaecc8aba47b1431`，unit SHA-256 `468190ada69a15777c0d623ff901408722f6029ac3673c51a70e0d56f4a0c3e8`；独立只读审计确认318个USTAR成员、0扩展头、0 AppleDouble/禁用路径、19 migrations。维护者清单：[candidate-16部署命令清单](北极星受控试运行部署命令清单-20261022-candidate-16.md)。本次仅切换shell，analytics留在现有r3 unit，business/attribution不切换。candidate-02至candidate-15均作废；目标机尚未部署，没有资格API或真实Run输出，T06/T07、T03/T10及Phase 1整体验收状态不因此更新。

T06/T07：当前用户 PT key 的成功 `/v1/models` 返回 ID 按用户确认逐 ID 设置 `permission=true`，启用textChat本地策略；PT确认的endpoint映射已严格按 `supported_endpoint_types` 接入candidate-17，能力与来源追踪、手动adapter资格和AUTO验证门槛见上节。目录/能力/router定向组 **37/37 PASS**、目录旧回归 **66/66 PASS**；HTTP/PGlite回归确认手动endpoint不匹配返回清楚的 `ADAPTER_ENDPOINT_MISMATCH`。均为本地测试，不证明目标机实际模型目录或真实请求。按用户收窄的团队起步门槛，手动选模和明确mismatch可先于AUTO/T08/T09；维护者目标机仍未回传资格字段。

T09：按用户选择 A，点分且形如 1–3 位非零前导整数加三位小数（如 `1.234`）的值按地区千位/小数歧义拒绝；`0.125`、`1234.567` 保持接受。CSV parser/source/analysis 聚焦组 **22/22 PASS**，见 `evidence/T09-deterministic-csv-analysis-20261022.md`。本轮 TXT/MD 上下文增加 UTF-8 源覆盖范围、总字节与首个未展示位置；多字节+BOM HTTP回归1/1通过，见 `evidence/T08-T09-independent-review-20261022.md`。没有真实试用样本，未扩展允许格式；分析器仍未接入聊天/Run/UI/持久化，T09维持 partial，AC10/AC21维持 untested。

T03/T12/T15 并行切片：T03 初始 `/api/chat` POST 在 fetch 无响应时最多以同一 body/idempotency key 重放一次；UI/SSE **22/22**、store/executor **2/2 PASS**，仍缺浏览器刷新前后都丢响应等恢复证据，AC04不变。T12 修复显式 `maxChars:0` 被替换为默认4000并仍注入记忆；新回归1/1、既有 memory-context-budget mock/PGlite组 PASS，T12计为 partial，AC14按整包门槛不变。T15 将三项真实PG回归从无DSN默认组拆到 Node20/22 + PostgreSQL16 临时 service job；runner计划回归、语法和 YAML 结构检查通过，未运行 hosted Actions/PG job，T15仍 blocked。

T10 本轮增加确定性测试：父目录句柄固定后，将叶子替换为跨租户 symlink/hardlink，分别拒绝打开，Darwin 2/2通过；candidate-17 解包后的 Linux/AMD64 Node22.23.4回归 **8/8 PASS**，覆盖 openat、叶子竞态、FIFO和租户HTTP隔离，见 `evidence/T10-linux-amd64-candidate17-20261022.md`。目标主机复验、HTTP完整产物闭环、同UID隔离仍缺。T13 的 skill hash snapshot/run pin 原语3/3，T17 本地锁版本/缺失配置2/2及合成API key错误脱敏测试通过；当前 profile 对联网与skill工具的 fail-closed 防回归1/1。T12、T13、T17 的完整任务范围与 AC 均未通过。T13/T14/AC23 的产品边界待明确，未定义前保持 fail-closed。故当前 T 主状态统计为 **14 partial、2 untested、3 blocked**，AC 仍为 **0/24端到端通过**。

T10：candidate-04 仍使用 lstat/路径组件检查后再打开，目录在检查后被替换及硬链接边界未闭合；即便受控 Run 不触发历史预览/导出，服务仍暴露该接口，因此不应部署 candidate-04。candidate-17承接 `openat` 目录句柄固定、硬链接拒绝和FIFO非阻塞打开修复；本机及临时Linux/AMD64 Node22定向回归均为8/8 PASS。当前包checksum与格式见WORKLOG及candidate-17清单。T10/AC11仍partial，维护者目标主机行为和完整Run/artifact provenance、格式支持、同UID隔离仍未验。

历史快照说明（candidate-18 时点，已由后续增量取代）：当时尚无线上模型 ID、资格链路 Run 或原样回复；当时记录的 candidate-24 后又由 candidate-25 取代。当前候选尚未由维护者部署，线上字段和真实回复仍未观测。候选部署、一次受控试运行和整包验收相互独立：本地打包/测试不改变 T00–T18 严格整包 **0/19**、AC01–AC24 端到端 **0/24**。T16/AC19–20 与 T18/AC24 仍 blocked；各任务状态须按后续矩阵增量及目标机/独立验收证据更新。

10/22本地联合复跑新增覆盖T09 UTF-8 文本来源、T10叶子替换 race、T13/T14 fail-closed、T17错误脱敏，并合并 T03/T06/T07/T11 与 Google auth/upgrade、CSV、artifact测试，合计 **100/100 PASS**；`node --check shell/server.cjs` 与 `git diff --check` PASS。结果仍限本机/PGlite/fixture，未运行 hosted Actions、目标 Linux、Google live、目标 PT key 或线上模型，不作为整包 PASS。

**总体进度（严格整包验收）：T00–T18为0/19（0%）；AC01–AC24端到端通过数为0/24。** T任务按唯一主状态互斥统计为14项partial、2项untested、3项blocked；AC状态仍为12项blocked、12项untested。局部实现/测试已经覆盖多个任务，但项目没有定义可加总的子项权重，故不能据此换算可信的“开发完成百分比”。这表示尚无整包被证明完成，不表示没有代码进展。

**期限与判定：** 项目目标为 **2026-10-21 整体验收并上线**，质量第一，不降低任务包和 AC 的通过条件。截至本增量，新增证据都仍为模块/受控环境级；T00–T18、AC01–24 无整包完整 PASS，生产 ready 不能成立。若 deadline 到达时所需真实环境、独立复核或部署证据仍缺失，应记录未达成与具体阻断，不能将 partial 记作 PASS。当前改动仍未提交/推送/合并/部署；具体状态和验证边界以`docs/refactor/WORKLOG.md`最新条目及各 evidence 文件为准。

## 结论与判定口径

**历史判定（2026-10-20）：** 当时 T00–T18 没有任何任务有证据证明整包完成；现有证据是模块级、限定环境或实现子范围 PASS。T03 新增生命周期修复已有 12/12 定向测试与独立复核，但 PostgreSQL 最终行、真实 provider 和生产多实例仍未验；AC01–AC24 也没有一项能仅凭现有证据判定端到端 PASS。最新结论见前述 10/22 增量，仍不得把实现代码、过程记录、单元/模块测试或本地夹具结果提升为真实场景验收。

证据口径：`PASS` 仅表示任务包定义的完整场景、独立验收和所需目标环境证据均齐全；`partial` 表示存在已核对的实现/限定测试，但完整范围或环境门槛未过；`blocked` 表示存在明确依赖或缺失事实阻止验收；`untested` 表示未找到可支持实现/验收结论的证据。下表对每项同时区分“当前状态”和“已确认证据”；没有找到证据不等于断言源码绝无实现。工作记录用于定位证据，不作为 PASS 的替代物。

## 10/18 历史快照边界（非当前状态）

只读核对日期为 2026-10-18。当前工作树为 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`。`git worktree list --porcelain` 显示该集成工作树；另有 `/private/tmp/pt-doc-upload-validation`（detached、prunable）及 `/private/tmp/pt-m-ui-m1-validation`（`validation/m-ui-b-c-m1`、prunable）。本地分支除集成分支外均为 attribution、business、UI 等其他主题；远端分支也未被本次逐分支 checkout/验收，故不计作 T00–T18 交付证据。HEAD 是历史记录点，不代表当前工作树内容均已提交。

本次 `git status --short` 显示已有未提交修改：`business/media/powertokens.cjs`、`docs/refactor/WORKLOG.md`、两个任务包文档、`shell/persistent-runner.mjs`、`shell/runtime/dsh-adapter.cjs`、`shell/server.cjs`、`shell/tasks/execution.cjs`、`shell/tasks/store.cjs`、`shell/tenant.cjs`、两个 task regression 测试；另有未跟踪迁移 `014_run_external_reconciliation.sql`、budget/provider reconciliation 模块、PostgreSQL 测试夹具及用户目录 `wb copy/`。这些文件是工作区证据，不是分支提交或已发布产物；本文件不改变或清理它们。

截至10/18，证据目录 `docs/refactor/evidence/` 包含 T00、T01、T02、T03、T04、T05、T06 与 T10 的若干记录；当时没有 T07–T09、T11–T18 的独立验收证据包。T00–T06、T10 的证据本身也明确限定范围，不能覆盖相应任务整包；本历史快照由本文件前述10/19–20增量更新。

## T00–T18 实现与验收状态

| 任务 | 状态 | 已能核实的实现/证据 | 验收缺口与阻塞 | 依赖与可并行工作 |
|---|---|---|---|---|
| T00 基线、技术验证、共享契约 | partial | `T00-contract-review.md` 记录纯契约函数反例闭环 PASS；本轮重新运行契约与 task-store review **40/40 PASS**；`T00-dsh.md` 记录公开 DSH SDK＋受控本地模型/工具验证 11 项；10/20 增 source-generated `run-persistent` 候选快照 12 文件，manifest `935c4a38…121e3f12`，本地 preflight 9/9 后 `ready=true`。 | 该快照从仓库 builder/source、lock/npmrc 生成，不是生产机导出；真实 PT、产品进程链、生产 profile 加载一致性、真实服务/网络与最终部署基线仍未验，不能将离线 `ready=true` 当部署 ready。 | 所有包前置。候选快照便于冷启动重建；部署方仍需脱敏采集实际 profile/bundle/patch 加载证据。T17 可并行做依赖来源盘点，T01/T02 可基于冻结契约推进。 |
| T01 存储、迁移、打包 | partial | `T01-storage.md`、`T01-review.md` 与工作记录显示策略/迁移子范围和 PGlite 持久性回归通过；post-auth repository init失败清理与原错误保持回归 **3/3 PASS**，见 `tests/regression/storage-init-cleanup-test.mjs` 与 `evidence/parallel-acceptance-slices-20261022.md`。 | 任务包要求的真实 PostgreSQL、干净安装/打包、目标数据库升级与恢复未证；`auth.initAuth`内部migration/default-admin失败时的自有数据库句柄清理已有专项回归11/11，见`evidence/candidate22-package-verification-20261022.md`；仍缺真实PostgreSQL、干净安装/打包、目标数据库升级与恢复，T18依赖这些目标证据。 | 依赖 T00；可与 T02/T05/T06 的独立子项并行，迁移源与打包接缝需单一集成。 |
| T02 Google 登录、用户与 BYOK | partial | `T02-integration*.md`、binding review 记录本地受控 OIDC、身份绑定/撤销和 HTTP 集成限定复核通过；新增账户禁用、立即撤销会话、拒绝后续 Google 登录与重新启用路径，PGlite/升级组25/25 PASS，见 `evidence/T02-account-disable-20261022.md`。并发登录/禁用序列回归 **19/19 PASS**，覆盖login-first与disable-first两种顺序，见 `evidence/T02-login-disable-serialization-20261022.md`；disable-first锁等待由adapter seam确定性模拟，未证明生产PostgreSQL锁调度。 | 正式 Google OAuth 配置、目标 HTTPS、真实浏览器首次/再次登录与账户/BYOK 全链路未验；禁用仅有可信服务端方法，没有授权管理端点/运维流程，不能判新员工首次使用通过；BYOK替换/撤销仍未按凭据代次隔离长生命周期DSH进程，在途Run语义待业务决策。 | 依赖 T00；正式环境凭据/域名由部署方提供后可验，账户禁用操作者/入口及在途Run撤销策略待产品/运营确认，T01 数据升级可并行。 |
| T03 持久 Run、事件、恢复、预算 | partial（整包尚未通过，关键验收门禁未通过） | 除既有 store/HTTP证据外，10月20日 queued恢复1/1、外部操作/store/worker此前联合14/14、media host生命周期12/12通过；worker专项6/6；本轮初始 `/api/chat` POST 传输失败后以相同 body/idempotency key 重放，UI/SSE 22/22、store/executor 2/2 PASS；新增上游状态不明 stop UI **23/23 PASS**（`evidence/T03-AC03-upstream-stop-disclosure-20261022.md`）；本地PGlite“Run已完成但首个ACK丢失后同key重提”回归 **1/1 PASS**（`tests/regression/t03-lost-ack-completed-replay-test.mjs`），以及 production UI pre-header断线同key回归 **1/1 PASS**（`tests/regression/t03-ui-preheader-ack-loss-real-chat-retry-test.mjs`，详见[`evidence/T03-preheader-ack-loss-ui-20261022.md`](evidence/T03-preheader-ack-loss-ui-20261022.md)）；runner shutdown现将 `RUN_INTERRUPTED` 映射为 durable `interrupted`，持久状态/终态码回归见[`evidence/T03-run-interrupted-terminal-state-candidate27-20261022.md`](evidence/T03-run-interrupted-terminal-state-candidate27-20261022.md)。 | 终态重放探针在Run service层，不经过HTTP/SSE且provider为fake；传输重放不代表真实浏览器/网络丢响应验收；candidate-27已覆盖已持久化幂等键的页面刷新后GET-only恢复，并在sessionStorage写失败时fail closed、明确提示未发送；缺真实上游继续运行时验证、SDK turn收敛、conversation lease/资源释放；ACK_LOST不是真实PG响应网络故障证据。新增runner收尾稳定错误码/说明及媒体三次截断场景的T03验收口径见[`evidence/T03-T11-media-timeout-and-truncated-reply-20261022.md`](evidence/T03-T11-media-timeout-and-truncated-reply-20261022.md)，线上`hello`根因和媒体Run/账单关联仍待维护者日志。生产多实例、provider查单和费用闭环仍未验。 | 依赖 T00/T01/T05；这是 T04/T07–T12/T18 的关键路径。 |
| T04 多 Session 并发和隔离取消 | partial | 纯调度器19/19；adapter abort/drain、DSH CLI readiness、SDK/runner harness联合7/7；本地PGlite fencing与cancel/sibling交接各1/1。后者直接断言barrier期间`cancelling`，并在lease release调用前观测Run为`cancelled`且lease仍属A，随后验证B接管完成。 | 本地受控接线不覆盖目标环境真实对话任务重叠、真实PostgreSQL并发锁、真实DSH上游/session资源释放、目标 Linux 行为；AC02/03仍未验收。 | 依赖 T03、T05 执行契约；补目标环境多会话、取消及资源释放证据。 |
| T05 工具执行、报告和安全 | partial | `T05-schema-validation.md`、`T05-schema-review.md` 记录 registry JSON Schema 校验及版本边界子范围独立 PASS。2026-10-22独立子进程探针确认 DSH child 可读取 `POWERTOKENS_API_KEY` 明文；证据及替代隔离前置见 `evidence/T05-child-isolation-review-20261022.md`。 | BYOK当前在child环境中明文可读；同服务UID的数据库/主密钥/其他租户文件、child任意出网与命令能力也未隔离。需先实现host-owned model gateway及运行环境隔离，再验证DSH provider路径；AC16仍blocked。registry统一、可信权限、日志/报告关联、生产profile范围也未整体验收。 | 依赖 T00/T03；gateway设计可与工具 registry/权限审计并行，但模型调用出口与进程隔离需同一安全边界集成。 |
| T06 PT 模型能力目录 | partial | `T06-capabilities.md` 记录规范化模块和撤销边界测试；当前用户 BYOK key 建立独立 scope。成功 `/v1/models` 快照按返回 ID 授予 `permission=true`，textChat policy动态启用；PT确认的五个endpoint值只由 `supported_endpoint_types` 按任务和IO映射并记录来源；别名不得用于trusted endpoint compatibility。candidate-18为历史证据；candidate-26继承可信映射与资格门禁。 | 目标环境实时目录/分页、撤销与恢复生命周期、Linux DSH adapter/runtime revision verification、失败同步策略和每日调度均未完整目标验收；本地fixture不证明具体线上模型ID。 | 依赖 T00/T01；需维护者执行 candidate-26 清单第7步并回传脱敏 `/api/models` 资格字段。 |
| T07 AUTO 能力路由/模型切换 | partial | 已接对话模型偏好与排队选择快照；动态目录模型手动router fixture可 `verificationRequired=true` 首调，未知能力仍fail closed、AUTO继续拒绝未验证候选；手动不匹配`reasonCodes`从选择API/执行复核传至Run/SSE终态。HTTP/PGlite回归确认 `ADAPTER_ENDPOINT_MISMATCH` 可见。PT endpoint映射已接入候选链；candidate-26 包检查通过，目标真实Run仍待维护者执行。 | 尚无当前线上模型选择与一次真实Run；AUTO路由、热会话切换、混合任务及失败退化仍未完整验收；AC05/07不可验。 | 依赖 T03/T06；线上手动文本资格链路需维护者执行 candidate-26；完整多模态依赖 T08/T09。 |
| T08 图片/音频/视频理解 | untested（附件输入子范围 partial） | 附件租户/持久化/media序列化有本地mock回归；`evidence/T08-input-audit-20261020.md`及fake-provider探针确认runner输入只有text block。T08/T09组合复核上传/附件、CSV parser/source/analysis与HTTP **24/24 PASS**，详见 `evidence/T08-T09-audit-continuation-20261022.md`。 | 没有真实图像/音频/视频理解样本；当前可信endpoint映射只证明生成能力，不证明理解能力；仅 auto 或 image2image/image2video 分支在上传可读且≤10MiB时把图片data URL作为文本，不能证明模型接收像素；时间戳、采样、模型/格式矩阵及费用配额均未验。 | 依赖 T03/T05/T06；需确认可用且获授权的理解endpoint、代表样本、预期回答/拒答与分类型额度。 |
| T09 文档解析、引用、表格分析 | partial | CSV解析、来源/版本和再生历史保护见 `evidence/T09-csv-source-20261019.md`；确定性 CSV 聚合遵守用户策略 A，拒绝日期/单位/地区格式不明确输入，不臆造换算；TXT/MD 截断标注 UTF-8 源字节范围、总长度与首个未展示位置，多字节/BOM HTTP回归覆盖于 `evidence/T08-T09-audit-continuation-20261022.md`；日期/货币/百分比/单位歧义值及 PDF/XLSX/DOCX/PPTX/ZIP 上传拒绝回归 **23/23 PASS**，见 `evidence/parallel-acceptance-slices-20261022.md`。 | 未完成真实文件矩阵、可点击引用定位、恶意/损坏文件、跨文档/上传/聊天/Run/UI集成与标准答案、资源限额/删除验证；尚无真实试用样本，不扩展格式。 | 依赖 T03/T05/T06；需确认代表文件、预期计算及原件/派生内容保留和删除边界。 |
| T10 多产物、历史预览和导出 | partial | 路径归一化边界有旧局部证据；当前 `openat` 逐段固定目录句柄、拒绝 symlink/hardlink 实现，既有 helper 75/75；Darwin叶子竞态/FIFO覆盖通过。candidate-17 在临时 Linux/AMD64 Node 20.20.2 与 22.23.4 副本各执行 openat、symlink/hardlink、目录/叶子竞态、FIFO及HTTP租户隔离 **8/8 PASS**，详见 `evidence/T10-linux-amd64-candidate17-20261022.md`；候选SHA为 `480e97cd…1f964`。 | 容器不是维护者目标主机；artifact Run/call归属、持久化、历史重开、并发产物归属、多格式真实导出及同 UID 隔离未验，故不把 Linux 子集等同T10通过。 | 依赖 T03，联调依赖 T04；维护者部署后仍需目标机 GET/HEAD 与 symlink/hardlink 复核，产物关联仍需与事件/store接线。 |
| T11 用量、费用和日志 | partial | `evidence/T11-usage-evidence-20261020.md` 记录 response 用量累计、去重、unknown 保留、按 Run/response 存储摘要、预算 admission 和 provider 有界查单聚焦回归17/17；T03 `persistSteps` HTTP/PGlite用例1/1保留失败Run已观察的成功/失败tool step；budget事件限制投影局部回归2/2；candidate-26继承runner预算摘要与失败码修复。媒体外部操作intent/task/status/query audit已持久化，见 `evidence/T03-T11-media-timeout-and-truncated-reply-20261022.md`。 | 后端用例使用受控 fake `runDshForUser`；未端到端覆盖 adapter call-only/no-result 帧、真实 SDK 取消/timeout 的 Run terminal DB 断言。生产runner没有媒体provider费用/币种/usage来源；用量页不能从对话Token推算图片扣费，亦缺真实调用/重试计量、热切换、权限/UI完整验收。AC13仍blocked、AC22仍untested。 | 依赖 T03/T05/T06；媒体账单与真实计量需要 provider 账单来源及目标Run/operation记录。 |
| T12 上下文预算与记忆 | partial | 近期更新时间优先的有界快照和最终注入格式字符预算已有 mock/PGlite证据；显式零预算回归 **1/1 PASS**，见 `evidence/T12-zero-budget-boundary-20261022.md`；`/api/memory` 修改/删除后热会话失效、A/B租户隔离与失效失败响应 **1/1 PASS**，零预算 **1/1**、tenant lifecycle **14/14 PASS**，见 `evidence/T12-memory-session-invalidation-20261022.md`；Markdown上传→chat边界回归 **1/1 PASS**，见 `evidence/T12-untrusted-upload-memory-boundary-20261022.md`。 | 未验证真实 DSH RPC 刷新、历史请求撤回、长对话约束保持、新对话召回、记忆来源/范围可解释性；上传边界测试不覆盖workspace文件、网页或工具主动写入，完整上下文遗漏摘要仍未验。 | 依赖 T03；资料检索依赖 T09。完整治理和检索整合仍需后续推进。 |
| T13 技能目录与版本发布 | partial | 静态审计见 [`evidence/T13-skill-release-audit-20261020.md`](evidence/T13-skill-release-audit-20261020.md)；skill 内容 hash 快照与 Run pin 原语3/3局部测试通过；当前生产 profile 对 `tool-skill` fail-closed 防回归1/1通过，见 `evidence/T13-T14-profile-fail-closed-regression-20261022.md`。 | DSH Run loader 尚未按 pin 不可变加载；无 PM 发布/新旧任务稳定、回滚、权限和恶意技能边界验收。 | 依赖 T00/T05；需明确Run source pin与发布/禁用授权，并接入真实 DSH Run。 |
| T14 联网检索与来源 | untested | 静态 profile/source 审计见 [`evidence/T14-profile-and-source-audit-20261020.md`](evidence/T14-profile-and-source-audit-20261020.md)；当前生产 profile 对 `tool-web` fail-closed 防回归1/1通过，见 `evidence/T13-T14-profile-fail-closed-regression-20261022.md`；即使seed settings启用web-search/CLI，生产profile仍只挂base并禁用tool-web，含依赖检查 **8/8 PASS**，见 `evidence/parallel-acceptance-slices-20261022.md`。 | 未见来源可回查、网页读取/失败行为、注入隔离、URL/网络目标约束或真实浏览器加载证据。 | 依赖 T05/T07；需产品明确插件/精确版本、搜索/读取域名、重定向/私网拒绝、来源展示及child出网边界后再开放；没有真实handler/egress证据。 |
| T15 CI、独立综合验收、性能 | blocked | 当前 dirty worktree Node v24 最新默认回归 **131/131**（本机结果，非 T15 hosted 门禁）；更早专项 Node24/PGlite16 三套件3/3、workflow attribution/quality/GA **25/25 文件通过**（其余30 tests）与A7范围PASS，见 `evidence/T15-local-attribution-recheck-20261022.md`。这些结果均不能替代 Node20/22 hosted Actions。 | 当前 HEAD 无 hosted run；独立审计发现 required-check/branch-protection 未启用，见 `evidence/T15-actions-and-required-checks-audit-20261022.md`。仍缺 AC 场景总跑、真实浏览器/移动、性能基线与故障恢复；最终Claude独立整体验收及全新Claude Code测试未进行。 | 依赖 T02–T14 及 T16/T17；需当前 workflow hosted Actions 实跑和仓库管理员确认 required checks。 |
| T16 DSH runtime、Profile 与产物边界 | partial | `T16-PACKAGING-AUDIT.md`记录 packaged DSH入口/manifest、Profile/settings生命周期及受控真实CLI ready；入口/安装/manifest/profile/settings/bootstrap专项67/67，本机HTTP smoke通过。 | 隔离cache clean-release因`ENOTCACHED`未完成；无完整依赖闭包、独立发布产物、目标机Profile一致性/OS隔离及真实升级回滚；AC19/20仍blocked。 | 依赖T00/T01/T15；维护者需提供目标profile和clean release环境并执行升级/回滚。 |
| T17 外部依赖值治理 | partial | 静态依赖盘点见 [`EXTERNAL-DEPENDENCIES.md`](EXTERNAL-DEPENDENCIES.md)；本地锁版本/缺失 baseURL错误探针2/2；合成API key不出现在 adapter 配置错误消息或stack，见 `evidence/T17-config-error-secret-redaction-20261022.md`。candidate-17 三份锁文件哈希/PT endpoint来源见 `evidence/T17-lockfile-endpoint-provenance-20261022.md`；新增可执行包—锁文件绑定回归 **2/2 PASS**，见 `evidence/T17-candidate-lockfile-binding-regression-20261022.md`。 | 缺完整模型/provider/endpoint/版本/region/结果域名/超时/限额来源矩阵、负责人/验证日期/失效策略、生产错误配置可见及实际输出域名加载证据；本回归未下载重算registry tarball integrity、未证明目标机安装；T17与AC23均未完成。 | 依赖 T00；provider/profile设置编辑入口和错误呈现契约待产品确认，来源矩阵继续逐模块填来源与验证日期。 |
| T18 生产交付、恢复、维护 | blocked | 离线合成PGlite备份/恢复原型回归7/7，见[`evidence/T18-synthetic-backup-restore-20261022.md`](evidence/T18-synthetic-backup-restore-20261022.md)；dirfd 原语Darwin rename/replacement及固定目录枚举回归3/3，Linux枚举专测在Darwin跳过，见[`evidence/T18-dirfd-primitives-20261022.md`](evidence/T18-dirfd-primitives-20261022.md)。helper未接`data-backup.cjs`且Linux枚举仍 fail-closed；原型现有TOCTOU仍未修复，不能视为生产恢复。静态部署审计见[`evidence/T18-deployment-recovery-audit-20261020.md`](evidence/T18-deployment-recovery-audit-20261020.md)。 | 无目标环境干净安装、备份及真实业务记录/文件恢复、升级/回滚、密钥主密钥恢复、健康告警、发布版本/配置记录、Claude/新实例交付结论。 | 依赖 T01/T02/T03/T11/T15/T16；实际演练必须基于冻结候选构建与目标部署。 |

## AC01–AC24 验收状态

AC 的完整通过条件以任务包 v2.0 第 7 节及增补总验收矩阵为准。下表的 `blocked` 表示当前关键路径未达到可验收前置条件，不表示该场景一定已有失败实现；`untested` 表示缺少场景级证据。

| AC | 场景与关联任务 | 状态 | 缺少的关键证据 |
|---|---|---|---|
| AC01 | Google 首登/复登、BYOK、AUTO、首次问答（T02/T07） | blocked | 目标 Google/HTTPS 与真实浏览器全链路；新用户真实 AUTO 问答。 |
| AC02 | 两对话真实并行（T03/T04） | blocked | 两个真实 DSH session 时间重叠，A 执行媒体任务时 B 成功完成真实问答/文件任务。 |
| AC03 | 定向停止且上游运行说明准确（T03/T04） | blocked | 有 fake-child abort/drain、以及本地UI对 unknown/manual_check 上游返回明确警示23/23的局部证据；candidate-24 增加runner失败分类和错误码传递，但不能证明线上此次失败根因。仍缺真实上游继续运行证据、warning在刷新/replay后的可恢复性、SDK turn收敛和conversation lease/资源释放；warning单测不等于HTTP/DB全链路。 |
| AC04 | 刷新/断网/重启恢复且未知付费任务不重提（T03） | blocked | 本机shell/UI/browser harness在SSE断流后GET恢复同一Run，1/1；见[`evidence/T03-browser-disconnect-recovery-20261022.md`](evidence/T03-browser-disconnect-recovery-20261022.md)。sessionStorage仅保存conversationId+幂等键、重载后同key GET恢复且不POST的回归当前 **24/24 PASS**；见[`evidence/T03-AC04-idempotency-key-recovery-20261022.md`](evidence/T03-AC04-idempotency-key-recovery-20261022.md)。candidate-26增加sessionStorage写失败时零POST的fail-closed回归，UI run-resume **25/25 PASS**，见[`evidence/T03-AC04-storage-fail-closed-candidate26-20261022.md`](evidence/T03-AC04-storage-fail-closed-candidate26-20261022.md)；candidate-27另修复runner shutdown的durable `interrupted`终态。最新candidate-27尚未部署。仍缺托管浏览器、双实例/重启恢复、目标环境未知taskId人工核查及真实provider不重复付费证据。 |
| AC05 | 热会话切模型且日志一致（T07/T11） | untested | 下一轮真实请求实际使用新模型、历史/附件保留、日志与执行模型一致。 |
| AC06 | 模型目录新增/消失/恢复（T06） | blocked | 真实目录同步、失败同步不下架、权限与恢复生命周期/调度证据。 |
| AC07 | AUTO 混合任务与多个产物（T07/T08/T10） | untested | 图理解→海报→视频真实能力路由，多步骤状态和所有产物完整持久呈现。 |
| AC08 | 图片/图表理解及引用（T08） | untested | 真实图片集、正确答案、不可识别区域如实说明与引用可追溯。 |
| AC09 | 录音/视频问答与时间戳（T08） | untested | 真实音视频转录/视觉语义、时间戳回查及采样边界披露。 |
| AC10 | 办公文档与表格（T09） | untested | 本地已拒绝日期/单位/货币/百分比歧义格式；仍缺每个约定格式、跨文件引用和确定性计算标准答案的真实样本矩阵。 |
| AC11 | 多格式产物生成、重开和交付（T10） | untested | MD/HTML/PDF/CSV/XLSX 验证、预览/下载权限和重开持久性。 |
| AC12 | 多报告保存且 Agent 解释有据（T05/T10） | untested | 多份报告的 Run 归属/持久化、模型可见依据和前端展示实测。 |
| AC13 | 失败、去重计量和真实费用（T11） | blocked | 多请求调用记录、成功步骤保留、失败/中断补记、unknown 不当零、真实费用证据；局部 HTTP/PGlite fixture 证明受控 Run 下步骤状态保留，不覆盖 adapter call-only/no-result 帧或真实 SDK 取消/timeout terminal DB 行为。媒体外部操作仅存 task/status/query audit，没有PT费用/币种/usage；预算模块已有 `actualCost` 输入接口，但生产 runner 未接入成本证据来源。三次图片实际操作及费用需维护者回传Run/operation与PT账单记录，见[`evidence/T03-T11-media-timeout-and-truncated-reply-20261022.md`](evidence/T03-T11-media-timeout-and-truncated-reply-20261022.md)。 |
| AC14 | 长对话与个人记忆隔离（T12） | untested | 约束保持、跨会话召回、用户隔离、编辑删除立即生效。 |
| AC15 | 技能新版本与联网来源（T13/T14） | untested | profile 针对 seed 配置的 fail-closed 回归8/8通过；仍缺 PM 发布版本对新旧任务行为、来源回查、真实联网失败态及批准的插件/网络契约。 |
| AC16 | 跨用户越权、注入、恶意路径/链接（T02/T05/T10/T14） | blocked | 统一工具入口与真实身份上下文下的跨租户负向场景、附件/网页/技能注入、网络目标安全验证。 |
| AC17 | 干净部署、升级和旧数据（T01/T15） | blocked | 干净包安装、旧库升级及目标数据库分支实测；T01 仍缺真实 PG/生产打包证据。 |
| AC18 | 排队/连接/解析/生成阶段与时延（T03/T15） | blocked | 同条件可复现性能基线、阶段标记与真实浏览器/长任务状态；不能给无证据统一时延承诺。 |
| AC19 | 三层与前后端边界（T16） | blocked | 已有静态边界与选定allowlist文件/顶层HTML资产检查，并在fixture下通过本地真实server、页面assets和同源API smoke；仍缺完整依赖图/独立发布产物、真实浏览器与目标环境运行及完整 DSH 内核边界验收。 |
| AC20 | DSH/插件升级、生产 profile、回滚（T16/T18） | blocked | 仓库 source-generated profile candidate 已有并通过本机静态预检；仍缺目标机生产 profile/bundle 加载一致性、依赖闭包、升级影响回归、真实会话和回滚演练。 |
| AC21 | 扩展格式/ZIP 安全、部分失败、删除（T08/T09/T10） | untested | HTTP 已验证拒绝 PDF/XLSX/DOCX/PPTX/ZIP 上传且不落盘，CSV歧义值/拒绝边界23/23通过；仍缺全格式真实解析与引用、恶意/部分失败 ZIP、原文件及所有派生数据删除证明。 |
| AC22 | 用量日志与 UI（T11/T15） | untested | 预算事件已有零上限保存证据；仍缺字段到真实来源的映射、权限、真实计量和浏览器/移动基础交互。对话token汇总不含媒体PT账单费用/币种，不能用于反推图片调用次数或金额。 |
| AC23 | 外部依赖治理（T17） | untested | 已有缺失 baseURL provider 错误上下文与 key 脱敏局部回归；仍缺带来源/责任人/验证时间矩阵、生产错误配置可见、媒体实际输出域名加载。provider/profile设置入口和错误响应呈现契约需产品确认。 |
| AC24 | 生产恢复、回滚与独立交付（T15/T18） | blocked | 目标环境备份恢复、升级回滚、Claude 独立整体验收和全新 Claude Code 完整测试。 |

## 关键路径、并行工作与 10 月 21 日风险

用户记录的目标是 **2026-10-21 项目整体验收并上线**，范围仍为 T00–T18、AC01–AC24。截至2026-10-18撰写本历史风险快照时距目标三天；截至本文件10/20增量，距目标仅一天。当前 T07–T09、T11–T18 缺整包证据，T03 仍有未验证的真实恢复/预算/provider 工作，T15/T18 最终门禁未建立。因此依据截至10/20事实，**10月21日完整验收并上线的目标当前不具备 ready 证据；不能通过缩小场景、将partial改写为PASS或跳过独立验收来满足日期。** 是否能交付必须由冻结候选与目标环境实证决定。

执行顺序应沿真实依赖和不可逆外部副作用推进：

1. **冻结事实与候选范围。** 主 Agent 对当前工作树和所有实际 Northstar 分支做差异/状态盘点，标注工作区改动的 owner、提交状态和可复现命令；确定部署目标、候选版本、Google/数据库/DSH profile 环境及回滚窗口。不要把无 checkout/无证据的远端分支纳入状态。
2. **完成 T03 真实安全闭环（T00/T01/T05 接缝）。** 先在真实调用链完成 durable intent→provider 接受→taskId 持久化协议；unknown submission 不重提，已知 taskId 只做有界只读查询并能持久收敛；验证 lease fencing、queued recovery、取消和 SSE 跨实例/断线。预算只启用有正式来源的限额；真实模型/重试钩子和可核验成本证据缺失时如实列为未覆盖。
3. **并行推进可隔离的功能证据。** 在无文件冲突下分别做 T06/T07 文本路由、T08/T09 真实样本矩阵、T11 计量来源梳理、T13/T14 技能/联网来源与安全；T04 用受控模型/工具做同进程并发；T10 与 Run/store 接口协作验证持久产物。每条由未参与实现者复验，外部付费能力先做受控/免费样本和风险批准。
4. **T02/T01/T16/T17 部署事实收口。** 使用目标 HTTPS/Google OAuth、正式数据库版本与可回滚迁移、锁定 DSH profile/插件版本、外部域名和依赖来源矩阵；缺少部署凭据或环境时标 blocked，不用本地 mock 替代。
5. **保留最后完整交付门禁。** T15 按 AC01–24 逐条执行端到端矩阵，记录结果、环境、版本、日志/截图/数据库证据、失败与复验；T18 对同一候选执行干净安装、备份恢复、升级和回滚。所有 BLOCKED 项解除且独立验收完成后，才能出具验收/上线结论。

近期可并行：T08 与 T09 的样本/解析矩阵、T13/T14 的目录及来源审查、T17 的静态依赖来源盘点、T04 的受控 runtime probe、T15 的 AC 证据模板。必须串行集成：T03 durable provider 调用协议与 store、预算 admission 与真实入口、数据库迁移共享接缝、T16 候选产物/DSH profile、T18 对最终冻结构建的部署演练。并行提高产出速度，但不能消除独立验收所需时间或外部环境依赖。

## 可复核来源

- 范围/依赖/AC：[`北极星一期生产级重构完整任务包-v2.0.md`](../北极星一期生产级重构完整任务包-v2.0.md)，§4 T00–T18 与依赖图、§7 AC01–AC24、§9–§11 边界与增补矩阵。
- 过程状态与明确阻塞：[`WORKLOG.md`](WORKLOG.md)，当前状态表及 T03 条目。工作记录声明不是正式总文档；本矩阵重新按证据边界判状态。
- 子范围证据：[`evidence/`](evidence/) 中 T00–T06、T10 的对应 review/implementation 文件；文件内均须按其自身“范围与限制”理解。
- 本次现场盘点：`git worktree list --porcelain`、`git branch --list --all`、`git status --short`、`git rev-parse HEAD`。未做网络访问、付费请求、测试、部署或发布操作。

## 2026-10-22 candidate-17 qualification correction

独立审计发现服务端曾按静态模型ID合成 textChat=true、文本模态和chat endpoint override，可能覆盖PT可信字段标记的图片任务或显式textChat=false。已移除该override；PT五种 supported_endpoint_types 映射、localPolicy和adapter资格接线保留，新增五类映射与非隐式能力回归。candidate-16因此作废，candidate-17只在许可的模型任务事实与adapter映射都满足时放行。candidate-17归档SHA-256为480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964，unit SHA-256为a5abf2112af069331c621232ea50033c0b30e5ef08ff50280bf0b15dd0fb8869；独立审计确认318 USTAR members、0 PAX/GNU扩展、0 AppleDouble/禁用路径、19 migrations、server/app 2/2与源码一致。部署清单已修正维护者上传路径、两端自动checksum、原子新目录创建、归档禁用路径扫描、Node ≥20.6、旧服务健康基线、JSON `ok===true` 限时检查与失败即停预检；一次Run使用northstarNoChatRetry=1并将前置ACK不明归类unknown/manual_check。整套本地回归117/117 PASS。仅提升本地实现与包审计证据；线上部署和真实Run仍待维护者，T00–T18及AC01–AC24整包仍未通过。
