# 需要用户决策的事项（先读）

> 2026-10-29费用授权更新：用户已重新提供测试Key，并明确“现有余额均可用于测试，不足再申请”，补充余额约20美元。此前“缺总/单次credits因此不发付费请求”的等待已解除；按最小用例串行真实验收，未知不重提、不足再申请。金额为用户约数，不是API读取或实际账单；Key只留测试进程内存，不写本文/证据/代码。真实执行见evidence/F1-live-session-20261029.json，不以此授权代替同Key资格、Run或发布门禁。

> 2026-10-29 r7恢复入口：Gemini托管写入经主审修正并接通；真实锁定SDK经HTTP四媒体离线链、当前上传绑定、文件读取/历史/隔离及暖会话预算恢复通过，模型和provider仍为替身。活动草案candidate34-r7，SHA be3f447800f23983aff5babfe3dc13bdb9ec2dcdcde1260507c57df666d94007，DRAFT_NOT_FOR_DEPLOYMENT；完整回归210套件204通过/6历史绑定失败，确切归档Linux15/15与依赖闭包通过。Python引擎/worker相对r6哈希未变，沿用r6的19项证据，不冒充r7重跑。媒体授权默认关闭；真实同Key资格、额度、Python参考图上传桥、真实业务验收及发布门禁仍未关闭。资产上传候选patch/tests已出现，但交付报告尚未出现，先只读审查，不擅自改写Gemini独占文件。

> 2026-10-29最新接续：授权等待/签发及历史显式核对已接线，默认不开媒体授权；Gemini展示经主审修正后联合63项通过。最新冻结为candidate34-r5草案（非线上catalog-cache-r5），SHA cc8c799f77d5348c0e97cad08e545e199f93229486204292e03334e0bf49313b；活动门禁见candidates/current-draft.json。WORKLOG末尾及evidence/MEDIA-reservation-view-main-review-20261029.md覆盖本文旧快照中“入口未接”的状态。真实付费额度/同版验收与发布批准仍未关闭，F1未交付。持续执行约定：除必要用户协助外继续推进，阶段汇报不作为停点。

> 2026-10-28 接续增量：server 已接持久授权读取/固定ID/原子消费与media profile选择；下文“server未接线”是此前快照，现以 `docs/refactor/evidence/F1-server-controlled-grant-read-20261028.md` 及 WORKLOG 最后一节为准。产品签发时序与显式核对入口仍未完成，未发布、未付费，F1未交付。

1. **真实测试经费额度**：用户已提供测试 Key，并明确授权其用于真实扣费测试；本轮仍缺「总预算 credits」和「单次最高 credits」两个数值，已询问、未收到数值回复。后续“继续”仅用于继续开发，不能当作额度答复。Key 已完成一次只读目录验证，不需要无故重复索要；**本文和任何交接/记忆/日志均不得保存 Key**。
2. **新完整包部署批准**：r5 的切换/重启/失败回滚已获授权并执行；该授权不自动覆盖尚未完成的新完整候选。先完成具体候选、SHA、操作单、目标预检与验收，再就该具体包取得部署批准，不要现在反复询问空泛许可。

其他主线实现与可逆离线验证已获继续授权，不等用户逐模块确认。10/30 是交付目标，完整范围仍高风险；不能为了日期把草案称为可上线包，也不能把完整一期或“所有对话”提前标为完成。

# 北极星项目交接（2026-10-28）

本文件供用户手动 `/new` 后恢复。**本轮只核对现场、创建交接文档，没有修改业务代码、重跑全仓审计/测试、提交、推送或部署。完成交接即停止，等待用户 `/new`。** 历史记录保留在 `docs/refactor/WORKLOG.md` 和各任务包/证据报告中；本文件不替代正式总文档。

## 1. 项目目标、架构及技术决策

目标：交付同一版本中可运行、可恢复、可观察的 Agent，而非候选模块合集。当前关键包为 F1 正常问答/切模型/四类媒体，F2 CSV 分析导出，F3 Run 用量与请求模型价格估算。用户原 deadline 为10/21，已延期；当前目标10/30（周五），未承诺全部一期任务按期完成。

| 模块 | 当前实现与职责 |
|---|---|
| Web/身份/租户 | `shell/server.cjs`、Google OAuth、tenant、public UI；Google 登录、BYOK、对话/附件/历史、HTTP/SSE |
| 持久 Run | `shell/tasks/{store,execution,chat-request,external-operations-store}.cjs`；租约、事件、幂等、取消与外部任务恢复。数据库支持 PostgreSQL/PGlite，迁移在 `shell/db-migrations/` |
| DSH 运行时 | 固定 `@deepseek-ai/dsh@0.1.1-rc.2`；`runtime/contract.cjs` 四方法/五事件，`dsh-adapter.cjs` 翻译层，`persistent-runner.mjs` 受管进程/profile。不得随意升级版本 |
| 模型资格 | `model-catalog.cjs`、`models/{capabilities,catalog-cache,task-router,media-task-router,media-route-admission,reviewed-media-*}.cjs`；按同用户/Key/baseURL scope、任务、权限、adapter、revision及运行证据准入，目录可见不等于可调用 |
| 媒体执行 | `business/media/powertokens.cjs` 现有 JS 执行器；`shell/media/ptvideo-{executor,bridge}.cjs`、worker Python及固定上游引擎。图片/图生图保留 JS；Python视频/Seedance使用新 adapter 身份，不借用 JS 验证证据 |
| 媒体授权/核对 | `controlled-media-admission` + `media-grant-store-candidate` + 022迁移：单授权一次提交、零重试、跨Run slot、同tx意图/事件；`media-reservation-reconciliation-candidate` + release候选/023：依据持久事实显式核对释放，保留已消费授权和审计。**产品入口尚未启用** |
| CSV | `attachments/csv-*`、`tasks/csv-*`、`runtime/csv-run-artifact`、`exports/csv*`；明确列选择/类型证据、计算、托管下载、历史、隔离；有独立CSV预算 |
| 用量/估算 | `shell/usage/*`、020/021迁移；调用前持久绑定请求模型/价格快照，调用后记录usage；估算金额明确非PT官方账单，实际上游身份无证据则unknown |
| 发布 | `scripts/package-northstar-*`、独立audit、portable Linux依赖闭包、profile快照、systemd操作单、stage/activate/rollback。新包必须冻结，不能部署脏工作区 |

**使命**：优先复用 DSH。先查锁定版本/插件/Adapter，能启用就启用，能接线就只做必要接线，确实缺失才研发。搜索、Skill registry、压缩、reasoningEffort底层不重写；这四项产品接入按用户决定放下一期。若确需升级DSH，执行正式总文档§4.8b：隔离分支→26契约测试+真实对话冒烟→全过再合并；当前无升级需求。

**财务/外部任务边界**：请求次数限制不是金额硬上限；目前 `maxCost` 虽有算法，但runner缺完整可信 estimated/actual cost链，不能只改JSON额度就宣称受控。结果未知保持manual_check/占位，不自动重提、fallback、释放或把金额填0。PT暂未开放按Key账单/消费查询是用户提供的背景，F3本期不等待该API；未来API用于对账增强。403不直接判断Key失效；内容拒绝与资产库问题不能靠模糊错误文字猜测。

## 2. 交付进度：本地完成不等于产品交付

| 功能/包 | 已验证事实 | 未完成/交付判断 |
|---|---|---|
| r5目录缓存热修复 | 冻结旧r2只替换cache模块；目标激活、备份、重启后health/目录已通过 | **本轮唯一实际切换并验证的新增恢复能力**；不是F1/F2/F3完整新版 |
| F1问答/切模型 | 既有产品、模型目录/偏好/运行时机制存在，26契约等局部证据通过 | 新完整候选的真实问答、同会话A→B/AUTO及身份/响应证据未完成；F1未交付 |
| F1四类媒体 | SDK/runner/host/DB/执行器替身链通过；Python桥、结果门禁、持久授权与显式核对已离线/PG验证 | server/UI未启用持久授权/profile/核对入口；同Key真实四任务、结果托管/展示/刷新/历史及失败取消验收未完成 |
| F2 CSV分析导出 | 真实SDK+HTTP+tenant+managed profile+host+artifact下载/历史的替身链通过；明确选择及保守类型判定模块通过 | 目标环境真实PT/用户流程同版验收未完成；不算已上线功能 |
| F3 Run用量/估算 | 本地调用时快照绑定、用量事件、HTTP/UI/CSV/重开链已有证据 | 可信当前价格正式录入、目标真实调用与台账同版验收未完成；不是PT官方账单 |
| Word/PDF/Excel扩展 | Gemini文档导出/输入门禁及主审修正候选存在 | 未产品接线；PDF中文/字体/排版、同步生成超时、相关依赖闭包仍有缺口；未算入已交付功能 |
| DSH四项下一期接入 | 原生能力复用审计已做 | Skill发布、思考深度、压缩、联网搜索的下一期产品接入未开始/未交付；不得误写成从零研发 |
| candidate34/r2/r3 | 新完整源码草案、哈希、重建/审计与部分独立环境验证存在 | **均为DRAFT_NOT_FOR_DEPLOYMENT**，无新增已上线业务功能；r3不含023/release增量 |

每次交付边界：旧r2是既有受控基线，本轮未重验其全部业务；r5新增“旧目录cache不合当前schema时备份原字节并恢复目录”这一受控恢复能力；candidate34系列只新增本地冻结/验证材料，不算用户可用功能交付。没有完整F1/F2/F3验收可据此计百分比。

## 3. 当前Git与工作现场

- 工作区：`/Users/mmdn/Downloads/pt项目`。
- 分支：`feature/northstar-phase1-refactor-20261016`。
- HEAD完整hash：`b09b1e13720cd16cd7538999d4c63386920b367c`。
- HEAD日期/主题：2026-10-17 07:20:54 +0900，`feat(agent): coordinate durable runs with worker leases`。
- 交接快照时间：2026-10-28T18:23:29+09:00。Git共590条：已跟踪修改67、暂存0、未跟踪条目523（含目录分组）。
- **大量历史未提交工作，共享工作区，不是干净main；没有执行本轮commit/push/merge。** Git明细见 [交接时Git快照](docs/refactor/evidence/HANDOFF-git-status-20261028.txt)。快照为`git status --short`条目，未跟踪目录可能分组，不能当实际文件总数。
- 保留 `wb copy/`、所有历史candidate/任务包/证据和用户改动；禁止 reset/clean、覆盖旧包或把工作区整体递归打包。不要把业务/归因的历史脏改动顺手并入本次发布。
- 最近增量主要在下表；更早全部变动以Git快照及WORKLOG为准，不重复全仓审计。

| 最近文件组 | 状态/作用 |
|---|---|
| `shell/tasks/media-run-handler.cjs`、`external-operations-store.cjs`、`models/media-route-admission.cjs` | 可信grant注入、manual首调选择、非fetch提交阶段；抽取同tx createIntent复用，不重复意图SQL |
| `media-grant-store-candidate.cjs`、022迁移、grant回归/PG probe | 原子grant消费+slot+external intent+Run事件，身份/租约/跨Run竞争及重开验证 |
| `media-reservation-{reconciliation,release}-candidate.cjs`、023迁移、回归/PG probe | 主审后的纯决策、显式释放、部分唯一slot、历史审计与旧数据升级；未产品启用 |
| `persistent-runner.mjs`、`runtime/dsh-adapter.cjs`、`runtime/contract.cjs`、`run-budget-media.json` | `budgetProfile=media:<task>`；180s/2model/1tool/0retry/512token；每次实际请求更新maxTokens，warm恢复128已测 |
| `scripts/northstar-{preflight,profile-snapshot}.mjs`、`docs/dsh-profile-snapshot/run-persistent/` | 15文件profile清单；更新前历史副本曾保存tmp，正式快照仍在仓库 |
| `shell/media/ptvideo-*`、`vendor/powertokens_video/*` | reviewed上游+主Agent overlay、MIT/license/hash、可信JSONL worker/Node桥/host胶水；Key仅stdin |
| `scripts/package/audit-northstar-candidate34*`、`release-artifacts/*candidate-34*` | 只增新修订，不覆盖旧归档；r3为已验证草案，不含最新release模块 |
| `scripts/northstar-release-archive-preflight-candidate.py`及测试 | Gemini原35项后主审补至41，gzip尾部/限额/FIFO/路径等反例修复；只读结构预检 |
| 新F3消费归一候选 | `shell/usage/pt-consume-record-candidate.cjs`已出现；本次核对测试/报告尚不存在，可能外部Gemini仍在写，勿碰其独占文件 |

**当前业务代码位置确认**：`server.cjs:955`仍只按CSV选择`budgetProfile:"csv"`；未注入`loadControlledGrant`/`reserveControlledAttempt`。profile/候选测试通过不能被说成server已开放媒体。`media-run-handler`本身已具备这些可信依赖接口。

## 4. 目标环境：最后实际运行版本与部署结果

以下是运维/用户回执和当时独立浏览器/HTTP证据，**本次文档交接未重新连接目标机**。

| 项 | 最后已证实状态 |
|---|---|
| 目标URL | `https://agent-fat.adorado.top/`；本案为FAT受控实例，不等于完整生产放量 |
| systemd | `northstar-shell.service`，FragmentPath `/etc/systemd/system/northstar-shell.service`，ActiveState=active |
| 最近MainPID | **192553**（激活最初191830，随后获批重启为192553） |
| WorkingDirectory | `/opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5/shell` |
| 目标Node | 运维预检v24.22.0；未在交接时重查 |
| 目标Python | `/usr/bin/python3`，**3.14.4**；northstar用户minimumVersionOk/stdlibOk=true |
| Runtime | `/var/lib/northstar/runtime`；northstar可写 |
| 最近切换 | r2→r5激活成功，stage325成员，活动Run/提交查询计数为空，health ok，返回ACTIVATED_R5_CATALOG_VERIFICATION_PENDING |
| 回滚情况 | 激活成功及后续cwd始终r5，**未触发激活脚本自动回滚**；没有收到另行回滚执行记录。不能把“有回滚脚本”当实际做过回滚演练 |
| 重启502 | 首次立即curl502；随后独立公网200/ok=true/PID192553，登录态目录成功；运维确认是尚未启动完成，故障已关闭 |
| 旧cache备份 | 已触及scope两份原件SHA匹配、文件名hash匹配、0600；未触及scope不要求一次生成六份 |

根因已落证：旧r2 cache合法外壳内480记录缺`ptEndpointTasks`，旧reader未校验嵌套shape，merge重算时TypeError。r5是冻结r2的**单模块backport**，不是当前主线。其他324成员保持基底，不包含F2/F3/Python最新代码。历史材料在 `交付-目录缓存修复-r5-20261027/` 和 [r5目标证据](docs/refactor/evidence/F1-r5-catalog-activation-browser-20261028.md)。旧缓存不清除，不恢复原坏字节覆盖新cache。

## 5. 候选包与来源绑定

当前最新已冻结草案：
- `release-artifacts/northstar-controlled-trial-20261028-candidate-34-r3-draft.tar.gz`。
- 本次直接计算SHA确认：`44b1757736ddd425a4157917984f7138f36959ef6c9d5804e3b965cf6940bce4`。
- sources.json SHA：`0d7bcf7b16dde83511867951191843fb0019047f4d9b43eee93cb6faf634c664`；service SHA：`50af847dc7220dc701af814d7b9a44c8ab21dbaca293c4c8222af4b5d136cfad`。
- 369成员/313文件/168绑定源码；scope为受控host授权/profile与per-turn token cap，**server-not-enabled**。
- r3含022/grant/profile，不含023/release及其纯决策模块；最新工作区不能直接等同这个包。
- r3 sources.json的omissions为冻结时列表，部分Linux/Python门禁后来已有补证；以带版本/环境的证据报告为准，不篡改冻结清单来假装重建。
- `package-northstar-candidate34-r3-draft.py --check`与独立audit曾通过；复用r4骨架及portable npm closure，包/lock/.npmrc/vendor保持精确绑定。后续源码改变时旧source-check报漂移属预期，不覆盖旧包迎合当前代码。

## 6. 测试与验收：已有结果及边界

**本次交接只读证据，不重新跑业务/全仓测试。以下为先前实际执行结果；文件存在性与部分日志尾部已在本次核对。不要把历史套件总数当当前全仓重新执行结果。**

| 检查 | 实际结果 | 证据/边界 |
|---|---|---|
| 最近一次完整默认回归 | 当时191套件：186通过、5失败 | [candidate34证据](docs/refactor/evidence/F1-candidate34-draft-20261028.md)。此后多处代码/测试增加，**未全仓重跑**；不能报当前CI全绿 |
| 5项旧失败 | candidate28/30/31/32源码绑定与candidate17 lock provenance | 后续r1/r2草案source-check也会因新源码漂移；须区分历史归档完整性与当前候选门禁，不删断言掩盖 |
| 最新已执行JS语法 | 475文件，0失败 | 发生在release后续增量之前，不是交接时重新跑全部文件 |
| Runtime/父子RPC | 原26项契约通过；RPC11项通过 | 四方法/五事件不变，scope profile只传对应task；固定DSH版本，不等于真实PT冒烟 |
| DSH/profile | DSH20文件0.1.1-rc.2通过；profile15文件check通过 | profile manifest `15ccd479fe16dae36a1bebb2c39797d003f90acc6989e74c0d6adfe8c70814c3`，非现网profile证明 |
| r3 Linux实际包 | 干净Linux/amd64 Node22.23.4 npm ci(ignore-scripts)→closure472包/30091文件PASS；预算/四任务5/5 | `/private/tmp/northstar-candidate34-r3-linux.log`本次仍存在；[r3报告](docs/refactor/evidence/F1-controlled-media-profile-r3-20261028.md)。替身模型/provider，0真实PT |
| Python引擎 | 原R3 67项+主审15项本地通过；实际旧草案包Python3.14.4/Linux worker4+主审15通过 | [引擎主审](docs/refactor/evidence/F1-ptvideo-main-bridge-review-20261028.md)、[包内Python记录](docs/refactor/evidence/F1-candidate34-draft-20261028.md)。不可外推新冻结包重新验收 |
| 结果门禁/桥 | 门禁52项；真实Python worker桥/宿主15项通过 | 原Gemini候选有缺陷，主审修后结果；API传输仍替身 |
| 受控授权 | PGlite隔离/消费/回滚/重开及host联合21项通过；真实PG双backend/Lock竞争仅一方成功 | [持久授权证据](docs/refactor/evidence/F1-controlled-media-durable-admission-20261028.md)；PG JSON日志本次仍存在，无provider调用 |
| 核对/释放/授权 | 纯函数53+release/grant12，共65/65；真实PG release commit→新slot竞争/rollback/reopen通过 | [释放证据](docs/refactor/evidence/F1-media-reservation-release-review-20261028.md)；`northstar-release-all-reviewed.log`/PG日志本次仍存在；候选未启用 |
| 旧PG四门禁 | 旧草案阶段4/4 | 当时修了过时锁顺序测试夹具，未改生产锁逻辑；不是最新023全套PG回归 |
| 归档预检 | 原Gemini35项，主审后41；Node包装器2项 | 仅结构/资源扫描；同FD防路径替换不防同inode可写并发修改；不是部署许可 |
| F2/F3 | F2 HTTP/SDK/下载/历史替身链通过；F3八文件定向33项等证据通过 | [F3快照绑定证据](docs/refactor/evidence/F3-price-catalog-and-call-binding-20261027.md)、对应F2 HTTP测试；无目标同版真实业务验收 |
| 测试Key只读 | 2026-10-28T08:24:26.755Z GET /v1/models HTTP200/82模型 | [脱敏JSON](docs/refactor/evidence/F1-live-catalog-readonly-20261028.json)；**0付费POST**，目录无价格字段，非模型运行/扣费证据 |

关键已修反例：暖会话media512→default128时实际provider maxTokens曾继承512，已每请求应用当前cap且断言真实options；纯核对曾用错taskType/可变Set/顺延日期/Proxy等，主审后修正；同事务now()可早于clock_timestamp()，未决只keep不伪造时间；host observedAt可比DB updatedAt领先1ms，不强加跨clock先后，但两者不得早于reservedAt。显式释放UPDATE RETURNING须恰好一行。

部分tmp历史日志本次已不存在（如早期整仓/旧Python日志），不要引用它们为当前可读取原始日志；保留的仓库证据与脚本可以后续定向复验。交接过程没有为补日志重复跑全套。

## 7. 子Agent、Gemini与未合并工作

| 执行者 | 本次live状态 | 成果/风险 |
|---|---|---|
| `/root/ptvideo_guard_review` | completed，无后台执行 | 结果门禁/预算审阅，grant/release候选与PG专项；最终报告只说probe静态通过，**主Agent随后实际PG执行并修正，最终以证据文档/日志为准** |
| `/root/friday_release_audit` | completed，无后台执行 | 发布复用/预检/纯核对/释放只读审查；其最终report仍记录初次时钟兼容失败，后续主Agent已修并实际65项/PG通过，勿把旧report误当最新终态 |
| 旧CSV三子agent | 未在本次live树列出，非当前运行任务 | 不宣称它们后台继续或擅重开；相关F2成果以文件/测试为准 |
| Gemini（外部用户转交）旧包 | 用户均报完成，原报告保留 | R3引擎、结果门禁、CSV/文档/价格候选、归档预检、预留核对均经过不同程度主审；原“PASS”不替代主审修正证据 |
| Gemini新F3包 | **状态待确认，可能仍在写** | [新任务包](docs/refactor/GEMINI-F3-PT-CONSUME-NORMALIZER-PACKAGE-20261028.md)。本次只发现`pt-consume-record-candidate.cjs`；指定测试、报告缺失。不要覆盖、重派或宣称完成，先等用户/Gemini交付确认 |

内部子Agent均已结束，没有需要终止的任务，未擅自终止任何Agent。所有成果在共享脏工作区，**尚未提交/合并main**，不是独立分支已合并；业务修正、候选和报告都需按当前Git状态保留。外部Gemini进程不受本Agent管理，若继续写入，Git快照可能随后变化；这是新会话首要交接风险。

## 8. 下一步：优先级、依赖及验收标准

| 优先级 | 可直接执行的工作 | 依赖与完成标准 |
|---|---|---|
| P0 | 新会话读本文件→Git HEAD/branch/status→WORKLOG末尾→最新证据；只查差异，不全审计 | 确认无用户/Gemini新改动冲突；F3三文件未齐不接线。不自动commit/reset/升级依赖 |
| P1 | 收口产品授权签发/读取与profile选择、显式核对入口 | 复用既有auth/tenant、grant/release、Run和SDK，不新增引擎；客户端/tool args不能伪造授权、scope、model、费用或force；默认/CSV不受污染；HTTP→Run→授权→意图→provider替身→结果/历史有完整证据 |
| P1并行 | 核实同Key model×task与当前价格，准备最小真实验收矩阵 | 使用已有fresh目录/任务/权限/adapter/revision准入；Python新adapter不能借JS证据。无完整视频报价不猜费率；未知提交不再POST |
| P1外部依赖 | 在预算额度明确后执行真实文本A→B/媒体/CSV/F3 | 用户已给测试Key，但总/单次额度未答。每次精确模型/参数、请求/任务ID、用量与价格版本、结果、RunId留证；估算不当官方账单，缺实际模型身份保持unknown |
| P2 | 接显式核对释放；只根据同tx重读事实释放已确认slot | 复用纯函数与023/release；未知/本地取消/费用未知不当远端未提交。旧grant永远consumed，新授权才能新提交；重复释放幂等、audit保留；不默认自动释放/重试 |
| P2并行 | Gemini新F3归一候选完成后主审 | 只接PT已有四类消费记录，不联网、不DB、不换汇、不猜usage0，不用归一记录替代Run成功或物理上游身份。独立任务不挡主线 |
| P3 | 收口后冻结新完整修订，包含023及真正接线的新文件 | 复用已有builder/audit/portable closure；显式源清单、禁止凭据/pycache/运行状态、包内模块闭包/SQL/profile/许可；不覆盖r3。当前候选门禁与历史源绑定检查分别解释，不掩盖失败 |
| P3 | 同包回归/干净Linux/目标预检、部署/回滚 | 26契约+专项+真实冒烟；必要PG及包内Python；受控scope/费用证据；source SHA/unit/deps/迁移、空闲、备份、health/cwd/PID、回滚路径可验证。具体可审包获批后运维执行 |
| P4 | 已延期DSH四项产品接入及完整一期收尾 | 下一期另排，优先复用原生能力；不是当前F1验收新增项。Office中文PDF/排版等不以候选模块算产品完成 |

目标顺序见 [10/30就绪清单](docs/refactor/RELEASE-20261030-READINESS.md) 和 [交付重排](docs/refactor/FUNCTION-DELIVERY-REPLAN-20261024.md)。10/28–29接线、10/29真实验收、10/29–30冻结、10/30部署都是目标而非已完成承诺；若关键门禁未过，明确报告延期与具体缺口。

## 9. 必须保持的约束

- **最多3个子Agent并行**（连主Agent共4槽）；独立任务优先 `fork_turns:"none"`，短背景、精确目标、独占文件、验证与禁令。不能方便就复制全部历史；不因有空槽就无关并发。
- **保持Default服务档位**；不擅换模型/优先档位，协作模式保持Default；不为缩短工期降低安全、测试或验收。
- 默认自主完成已授权可逆工作；只有真实用户/运维依赖才停。不要每完成模块索要确认；也不要声称回复结束后仍在后台工作。
- Gemini通过用户转交，一次一个自包含包、仅指定新文件、不碰主线/其他Agent文件；先看任务状态，**不要重复派已完成包**。本次新F3包已写，源文件开始出现，是否已完整交付待确认。
- 保存全部历史包/报告/决策及脏改动；不commit/push/merge/deploy、不覆盖未授权工作。r5获批操作≠新完整包部署授权。
- Key此前已提供且明确测试用途：不回显、不落盘、不写handoff/记忆/argv/env/报告；本次只读探针通过关闭回显stdin、固定官方API、禁止重定向。进程已结束，Key未保存在安全凭据文件；新会话优先使用用户已保存/安全提供的凭据，只有确实无法取得才解释后请求，不能假称用户没给过。
- 总/单次测试credits待答，不因“继续”自行填额度；scope/任务资格未知、费用无证据不填0。保留manual_check，不自动重提或用fallback撞第二次付费POST。
- UI如需配合，先重查当前登录与目标页面，只使用已授权业务页面；不读取用户其他Chrome标签页/凭据。此轮没有新Google OAuth往返验收。
- 本次handoff之后停止，等待用户手动 `/new`；不再继续业务开发、派新任务、运行测试或部署。

## 10. 交接安全结论

已知内部任务和测试均结束；临时PG容器已按执行回执停止并自动移除，无需新会话擅停Docker Desktop/其他容器。当前无已知内部后台任务或未结付费POST。可以安全开启新会话，**前提是保持当前工作区不清理、不覆盖外部Gemini独占文件，并首先核对其是否仍在写入**。本文件、Git快照是恢复入口，不代表Git工作已提交或整个项目已完成。
