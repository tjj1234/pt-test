# T16 打包链静态审计：Runtime / DSH / Profile

**结论：T16 仍不能通过生产打包与 DSH 升级门禁，但本机隔离 profile 的真实 CLI 启动及 packaged DSH 入口完整性已有受控证据。** Node `v24.14.0`、DSH `0.1.1-rc.2` 下，`tests/regression/dsh-cli-profile-ready-test.mjs` 使用临时 DSH_HOME 启动仓库实际 CLI，收到含协议版本与 runner capabilities 的 `ready` 帧，并在空闲观察期保持存活；没有发起模型或工具请求。该证据验证当前本机依赖/profile 的 boot 路径，不证明生产机器依赖图、OS 隔离或升级兼容。2026-10-19 入口校验已取消全局回退并绑定完整 DSH 包文件、vendor 与 lockfile；bundle/实际依赖闭包仍没有生产级锁定验收。下方历史审计对应项以末尾入口补录为准。

## 审计范围与证据等级

审计检查了 T16（任务包 v2.0）、架构/部署说明、shell/package.json / package-lock.json / vendor tarball、shell/runtime/dsh-adapter.cjs、shell/persistent-runner.mjs、shell/tenant.cjs、shell/dsh-settings.yaml、docs/dsh-profile-snapshot/ 和当前 checkout 的 runtime/；另运行了隔离 temp profile 的真实 CLI boot probe。为修复真实 CLI boot 暴露的 peer 缺包，项目精确锁入 `@deepseek-ai/cordis-plugin-group@1.0.1`，满足 `@deepseek-ai/dsh-app-boot@0.1.1-rc.2` 的 `^1.0.1` peer 要求。未访问付费模型/工具；未验证生产 DSH_HOME 的安装图、生产实际 DSH_JS、生产 OS 配置或供应商模型行为。

## 主要发现（历史审计快照；profile 修复状态以下方 2026-10-19 记录为准）

| 严重度 | 位置与静态事实 | 影响 / 最小修复 |
|---|---|---|
| **阻断：运行版本未被强制固定** | [dsh-adapter.cjs](../../shell/runtime/dsh-adapter.cjs) 的 findDshEntry()（约 123–169 行）接受 DSH_JS 路径后直接返回，也会按 Node 路径、cwd 和全局 npm root 自动搜索；它只检查文件存在，不读取包版本或完整性。createDshRuntime() 将发现结果直接传给 spawn()（约 340–347、556–570 行）。 | 部署环境可在不改产品 lockfile 的情况下运行不同 DSH。发布前须把唯一允许的实际入口与 @deepseek-ai/dsh 版本/hash绑定，启动时核验并 fail-closed；禁用未声明的全局回退，或将它作为明确、带版本校验的部署输入。记录实机解析路径和版本。 |
| **阻断：生产 profile 不可从仓库完整复现** | [makeProfile()](../../shell/runtime/dsh-adapter.cjs) 每次生成 runtime/dsh-home/profiles/run-persistent/package.json，只声明 @deepseek-ai/dsh-base bundle，dependencies: {}；没有 profile 专属 npm lockfile，bundle 名称也不含版本，故不能证明 DSH profile 安装使用了 shell/package-lock.json 中同一依赖闭包。profile 源文件现有 manifest/hash 校验，缺失或不匹配会阻断启动。 | 把生产 run-persistent profile 的 bundle、插件精确版本、patch、包管理器配置及依赖 lock 纳入仓库发布输入；用干净 DSH_HOME 验证可重建。不要拿 docs/dsh-profile-snapshot/ 的 web profile 当生产配置。 |
| **已验证但限于本机受控环境** | `tests/regression/dsh-cli-profile-ready-test.mjs` 用 Node `v24.14.0`、DSH `0.1.1-rc.2`、临时 profile 与真实 CLI 验证 runner ready 以及空闲存活；profile manifest 覆盖生成文件，所需 runner companion 缺失会阻断生成。 | 此 probe 不等同于生产依赖锁定、OS sandbox 或真实模型验收。仍需干净发布环境重建、核对 profile 实际依赖版本与安装来源。 |
| **HMR 兼容边界** | 此版 app-boot 会无条件调用 `hmr.registerConfig()` 监听 user patch；锁定的 `cordis-plugin-hmr@1.0.19` 未提供该方法。profile 保持 HMR disabled，并注册 manifest 覆盖的 no-op 兼容服务，避免打开宽范围文件监听。 | profile/config 修改在进程重启后生效；当前没有热重载承诺。应在文档与运维流程中保留此限制，不能把兼容服务视为 HMR 支持。 |
| **阻断：生产配置存在陈旧配置窗口** | ensureDshHomeConfig() 仅当 DSH_HOME 下 settings.yaml 不存在时从 [dsh-settings.yaml](../../shell/dsh-settings.yaml) 复制（约 191–202 行）；已有目标不会与新模板比较/升级。profile 源变化时现逻辑会报告 `PROFILE_STALE` 并 fail-closed，但没有显式 rebuild/升级入口。仓库没有 runtime/dsh-home/profiles/run-persistent 产物；当前 runtime/只有 workspaces，不能检查生产 profile 状态。 | 给生产 settings/profile 配置加显式版本/哈希与迁移策略：新安装可种子化，已安装环境要报告旧版本并执行经验证的升级或阻断；保留用户可改项与模板分层，避免静默覆盖。发布包需要包含脱敏、可复建的生产 profile 快照。 |
| **待实施：profile 生成需要事务边界与显式升级入口** | 当前 `makeProfile()` 在正式 `profiles/run-persistent` 目录逐个写文件，manifest 最后写入。中途失败可能留下无 manifest 的部分目录；下次启动会以 `PROFILE_MANIFEST_MISSING` 拒绝。现有带 manifest profile 遇到源变化会以 `PROFILE_STALE` 拒绝，但没有受控 rebuild/升级入口。`ensureDshHomeConfig()` 对 settings 模板复制失败只报 stderr 并继续。 | 按下方“Profile 所有权、原子更新与恢复方案”实现；任何情况下都不递归删除整个 DSH_HOME、settings.yaml 或未识别的用户文件。 |
| **高：握手有协议与能力，但未声明实际 DSH 包版本** | Adapter 校验 runner ready 帧中的 `protocolVersion`、runner 名称和 capabilities，并设置握手超时；当前握手不报告实际 DSH 包版本/hash，也没有覆盖跨版本兼容矩阵的生产验收。 | 保留协议版本与能力校验，补充实际 DSH 来源/版本/hash 的可核验记录，并在升级验收中验证兼容与拒绝行为。 |
| **高：profile 文件复制仍需发布级完整性校验** | makeProfile() 将 runner 及 companion 文件复制到 profile，并生成 SHA-256 manifest；启动前检查现存 manifest 与预期文件，拒绝不匹配或无 manifest 的非空 profile。 | 当前 manifest 校验的是生成文件内容，不是完整 npm 依赖闭包或生产安装来源；仍需将 profile bundle、依赖版本和 lock 纳入可复现发布证据。 |
| **高：开发 profile 快照与生产 profile 混淆风险** | [docs/dsh-profile-snapshot/README.md](../dsh-profile-snapshot/README.md) 明确它是历史全局 web profile 快照，插件 dsh-better-sidebar@0.17.1 与机器相关 browser 路径也在其中；生产运行 profile 实际由 makeProfile() 写为 run-persistent 且只挂 dsh-base。 | 文件名和部署文档继续清楚标记 web/开发快照；增加单独的生产 profile 快照及来源/生成命令，禁止发布流程把 web profile 整目录拷进产品 DSH_HOME。 |
| **中：独立前端发布准备没有可执行入口** | shell/package.json 仅声明 start；UI 静态文件在 shell/public/，没有独立 UI manifest、校验/产物清单或发布命令。任务包已说明当前 UI 无编译步骤，因此不要求引入打包器；但 AC19 要求前端产物与后端 API 分别可检查后同源运行。 | 添加轻量静态产物检查/清单与版本标识，分别验证 UI 目录、后端 API 契约，再由同源代理组合；不需要强制更换前端框架或拆成跨源部署。 |

## 已能静态确认的有利边界

- shell/package.json 将 @deepseek-ai/dsh 固定为 file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz；lockfile 也固定为 0.1.1-rc.2 并带 npm integrity。当前读取的 vendor SHA-256 为 47ec05f45ada5ab87779ae18a90456b5ebff5421dc0ff5c179677d65e1c16057；shell/package-lock.json SHA-256 为 a8a18183d2467b656d3a2d94cc5284dc9f15ae4386e525d6e10af71c8f3eb5d4。这证明仓库里该 tarball 与 lockfile 的固定值，不证明生产安装副本同 hash。
- `@deepseek-ai/cordis-plugin-group@1.0.1` 已作为直接精确依赖加入 shell package/lock；锁定 registry tarball integrity 为 `sha512-E1NThkFB3jn3TCqa6Oc++1zQHqLejF3W2wDwv2BlL3UEmgtBXL1K1j1koc+j676RuiOXtJkUJlPcOntRGKLWBQ==`。`npm ls` 显示 DSH app-boot peer 复用该版本。此修复消除当前 CLI 的缺包阻断，不等于生产 profile lock 闭环。
- lockfile 中 dsh-base、dsh-agent、dsh-llm、dsh-session、dsh-tools 均解析为 0.1.1-rc.2 并有 integrity；Cordis 锁定 4.0.4，loader 锁定 1.0.5。这些值由项目根 shell lockfile 固定，不能自动证明 profile 自己的包管理器会复用这些已锁定副本。
- persistent-runner.mjs 导入 @deepseek-ai/dsh-agent、dsh-llm、dsh-session、dsh-tools 的包根路径；当前安装包的 exports 均提供 "." 入口，未见 @deepseek-ai/dsh-*/lib/... 私有深路径。此证据支持“使用包声明的导出入口”，但不能证明这些底层包被 DSH 官方承诺为稳定 SDK。persistent-runner.mjs 由产品通过 Cordis patch 插入，是自有插件/Adapter 接线，不是对 DSH tarball 的改写。
- tenant.cjs 指向产品专用 runtime/dsh-home，spawn cwd 为每租户 workspace，环境变量通过白名单生成；DSH 本身由子进程启动。当前源码没有对 vendor 或 node_modules 执行写入/patch 的逻辑。POSIX UID/GID 降权是可选配置，Windows 不支持 spawn uid/gid；白名单环境与 workspace cwd 不是 OS 沙箱，必须对照部署系统的文件/命令/网络隔离另验。
- 源码检查没有找到 shell/public/ 对 DSH 包的导入；UI 调产品 HTTP API。产品服务在 server 中经业务模块导出调用媒体工具；runner 自有工具通过 host RPC 请求父进程执行，边界方向符合 T16 目标。静态导入检查不证明权限/身份在真实多租户运行中正确隔离。

## 上线阻断与最小修复次序

1. **固定部署输入**：指定支持的 Node/OS、DSH 实际入口、DSH 与 Cordis/插件版本；验证启动所用包版本与 lock/integrity 对齐，移除静默全局 fallback。
2. **固化生产 profile**：提交生产 profile 模板及精确 dependency/lock 信息、patch/bundle 顺序、settings 版本与重建方式；与历史 web profile 分开。保留已有生成文件的 hash 校验，并实施文档所述原子切换与显式 rebuild。
3. **补齐部署版本证据**：ready 已校验 runner 协议版本与 capabilities；继续补实际 DSH package version/hash 的来源记录，并对未知协议 fail-closed。
4. **建立可复现打包验收**：干净检出后使用锁文件安装，在空产品 DSH_HOME 中创建 profile，核对 profile 文件/依赖完整性；分开校验静态 UI 与后端 API，再通过同源代理运行。
5. **独立真实 DSH 验收与回滚**：隔离候选版本运行契约测试、真实多轮、工具/Skill、模型切换、并发取消、附件/产物/用量及进程异常恢复；执行预发布升级/回滚演练，记录完整 hash、Node/OS、入口、profile hash、命令与结果。

在 1–4 完成前，生产升级/新环境交付属于 **阻断**；隔离本机 CLI ready 只关闭当前 boot 缺包/启动故障，不证明升级兼容或 AC19/AC20 通过。OS sandbox 与生产发布证据仍未闭环；在 5 取得真实 DSH/预发布证据前，不得声称生产验收完成。

## 2026-10-19 Profile 路径、升级与恢复实现

本节覆盖上表历史快照中的 profile 首次生成、路径与恢复状态；DSH 实际入口/依赖版本锁定、settings 模板版本迁移、干净发布重建和 OS 隔离门禁仍未关闭。

`profile-paths.cjs` 在任何 profile 写入前逐级核验 POSIX 祖先目录类型、owner 和写权限；拒绝用户 symlink、非 root/本 uid 祖先、非 sticky 的 group/world writable 祖先。home/profiles 必须由当前 uid 持有且不可被 group/world 写。macOS root 所有的 `/tmp`、`/var`、`/etc` 系统别名仅在 realpath 与 `/private/...` 一致时允许。Windows 未实现等价 ACL 策略，明确阻断，不能按 POSIX mode 假装通过。已有 settings 必须是当前 uid 所有且无 group/world 写权限的普通文件；首次 seed 使用同目录临时文件加 exclusive hard link 发布，不覆盖已有配置，模板不可读或发布失败阻断启动。

`profile-lifecycle.cjs` 把 managed profile 的目录、manifest、受管文件也纳入 owner/mode/type/hash 核验。正常启动只验证当前源版本或首次创建，遇到旧版本、未知目录、锁或未完成 journal 时拒绝自动接管。首次创建使用 sibling staging 回读验证后 rename。显式 rebuild 只接管自校验有效的旧 manifest：新 staging 校验后记录 journal，旧 profile 整体移入随机 backup，再发布新版本；未知用户文件随旧 backup 保存，不静默复制或删除。切换失败尝试回滚；回滚再次失败保留 journal/全部目录并返回 `PROFILE_RECOVERY_REQUIRED`。

维护前须停止使用该 DSH_HOME 的全部 Northstar/DSH 进程。`--offline` 是操作者声明，命令不自动检测或停止服务；lifecycle 锁只串行化管理操作，不覆盖 runtime 整个存活期。命令不启动 DSH、不安装依赖、不删除 backup。

```sh
node scripts/northstar-profile.cjs rebuild --home /absolute/dsh-home --offline
node scripts/northstar-profile.cjs restore-backup --home /absolute/dsh-home --offline
# 发布后已有 current：显式将其整体保留到 preserved，再恢复旧 backup
node scripts/northstar-profile.cjs restore-backup --home /absolute/dsh-home --offline --preserve-current
# journal已写但尚未移走旧profile：核验旧manifest后保留current并结束事务
node scripts/northstar-profile.cjs keep-current --home /absolute/dsh-home --offline
```

`restore-backup` 只接受 journal 内直属、受限名称和 oldManifest 绑定的 backup，不能传任意恢复路径。存在 current 时缺少 `--preserve-current` 拒绝。崩溃遗留 owner 锁时，显式加 `--lock-token <owner.json内token>`，仍须验证原 owner pid 已不存在；有效 owner 不允许抢锁。仅有空锁、尚未来得及写 owner 的崩溃点不能通过 token 恢复，需运维确认停机与锁确实为空后人工处理；不提供递归强制删除。staging、backup、preserved 的回收是独立维护操作，本命令不执行清理。

保证边界：目录检查和 rename 不抵御同 uid 非协作写入者，不能保证任意目标的 rename-no-replace；无 fsync，不构成断电持久性保证。当前验证针对进程级故障与保留证据的恢复路径，不等同 OS 沙箱或生产升级演练。

验证：路径+生命周期独立交叉复核 **15/15 PASS**；离线 CLI 重建及旧用户文件保留 **1/1 PASS**；宿主 RPC/Adapter **10 个断言 PASS**；隔离真实 DSH CLI ready **1/1 PASS**（未发模型/工具请求）。证据日期 2026-10-19，Node v24.14.0，本机 POSIX 临时目录，所有测试临时目录已由夹具清理，无生产 profile 改动。

追加集成：profile/env/identity 校验现先于日志FD打开，避免profile拒绝后的描述符泄漏；连续三次失败且无日志创建反例独立 **1/1 PASS**。本轮所有选定聚焦回归联合 **33/33 PASS**，不扩大为T16整包验收。

## 2026-10-19 断线恢复：packaged DSH 入口核验

本节覆盖历史表中“入口只有存在性检查/全局回退”的描述。`dsh-installation.cjs` 仅接受 packaged `@deepseek-ai/dsh@0.1.1-rc.2/lib/bin.js`，显式路径及环境覆盖均须匹配，任一非法覆盖拒绝启动。release manifest 绑定 vendor SHA-256、npm integrity、完整安装文件集逐文件 SHA-256 和精确 shell lockfile hash；多余/缺失文件、包元数据变化、不可信权限和 symlink 拒绝。Adapter 在 spawn、profile 写入与日志打开前复核，并输出标记为 `host_release_verification` 的安装证据；这不是 child 握手独立声明实际包版本。

本次入口/manifest 专项 **30/30 PASS**（installation 9、runtime release 2、manifest 19），另真实 CLI/profile 五文件 **18/18 PASS**；和 CSV/router/snapshot 联合的首组为 **52/52 PASS**。没有修改 vendor/node_modules，没有模型或工具请求。manifest 不验证已安装依赖包闭包；profile 精确 bundle/插件安装、settings 迁移、干净重建、OS 隔离及生产升级回滚仍为开放门禁。上文历史 lockfile hash 不再代表当前文件，以当前 manifest 及运行核验结果为准。

## 2026-10-19 Profile 发布输入与 settings 基线

生成的 profile `package.json` 现从 shell lockfile 提取精确 bundle 版本；`northstar-profile-dependencies.json` 记录 bundle version/resolved/integrity 和 lockfile、`.npmrc` 原始字节 SHA-256，参与 profile manifest。改变发布输入会触发现有 `PROFILE_STALE`，需显式离线 rebuild。版本与 SRI 校验包含有效 SemVer、算法对应摘要长度和规范 Base64。`pnpm-workspace.yaml` 本身已受 manifest 覆盖。此快照记录发布输入，不是独立 npm lockfile，也不验证已安装依赖闭包；不得在 profile 内另跑无锁安装并宣称可复现。

真实 CLI 夹具已移除人工创建的 profile `node_modules` 软链，使用空临时 home 和 DSH 自己的 `healProfilesModuleFallback`；ready 明确断言协议版本1及 task/tool-rpc/abort 三项能力。DSH 将当前安装的依赖目录映射至 home 的共享 profiles/node_modules；因此证明当前 shell 安装图可用，仍非干净 npm ci 验收。

settings 维护入口只检查和登记已审阅基线，不修改 YAML、不推断配置兼容、不接运行时启动门禁。检查返回 `untracked`（无基线）、`template-drift`（模板变化，优先于配置变化）、`operator-edited` 或 `current`，只输出状态/摘要/基线元数据。先人工核对现有配置与发布模板，再把检查结果的三个 hash 明确传给登记命令；不能用即时自动读取代替审阅。

```sh
node scripts/northstar-profile.cjs inspect-settings --home /absolute/dsh-home --offline
node scripts/northstar-profile.cjs adopt-settings --home /absolute/dsh-home --offline --reviewed --settings-hash <sha256> --template-hash <sha256> --baseline-hash <sha256-or-none>
```

`--baseline-hash none` 仅用于首次登记。旧摘要或缺少审阅参数拒绝；已有基线保留随机 backup，发布失败保留原基线，当前 YAML 不变。锁只串行化遵循协议的维护者，崩溃残留锁须停机核验后人工处理；无 fsync，不保证断电持久性，也不防同 uid 非协作修改（包括原地修改 hardlink 备份）。这些命令不能替代实际 settings 迁移、生产依赖闭包校验或干净发布重建。

本切片最终9文件联合 **36/36 PASS**；parent RPC另10断言PASS。独立审查关闭SemVer/SRI、未知基线字段/null、日期注释和hash数组类型反例后复验通过；settings模块/CLI独立9/9 PASS。无宿主依赖安装、无模型/工具调用，测试临时目录已清理，未改真实DSH_HOME；未提交、推送或部署。

## 2026-10-19 实际 settings 升级与干净 CLI 重建

新增受限升级：仅已登记且原配置与旧模板字节一致、登记后无修改的配置允许整模板替换；已登记定制配置也必须人工合并，不能因adopt就抹去自定义值。显式reviewed/offline/三hash，旧YAML与baseline复制到私有事务目录，journal发布后再切换两文件。中途失败保留journal和old/new四文件；恢复只做显式rollback，校验journal hash、受限路径及全部内容hash，未知当前配置拒绝覆盖。进程退出残留owner锁需匹配token且原PID已死；无fsync断电保证、无同uid绕锁保证。

```sh
node scripts/northstar-profile.cjs upgrade-settings --home /absolute/dsh-home --offline --reviewed --settings-hash <sha256> --template-hash <sha256> --baseline-hash <sha256>
node scripts/northstar-profile.cjs inspect-settings-recovery --home /absolute/dsh-home --offline
node scripts/northstar-profile.cjs rollback-settings --home /absolute/dsh-home --offline --reviewed --journal-hash <sha256>
# 仅原锁owner PID已死时额外传 --lock-token <owner-token>
```

pending journal阻断inspect/adopt及冷runtime启动。冷spawn另拒绝home/workspace的`.env`、home patch和home/profile局部node_modules，保留原文件。DSH共享fallback与祖先Node解析路径仍未全量核验，该门禁不是OS沙箱；运行中实例不支持在线维护。

12文件联合55/55 PASS，升级/恢复/冷启动独立审查通过。选择性CLI发布probe在空临时发布根执行在线`npm ci --ignore-scripts --no-audit --no-fund`、主包20文件核验、空home真实ready/idle通过；无模型或工具请求，隔离文件清理。最终probe含signalCode断言已由主Agent再次在线完整运行PASS；offline仍因cache缺项ENOTCACHED。在线复用宿主npm cache可新增缓存，项目node_modules未修改。未验证完整HTTP服务与独立静态UI发布、安装脚本、依赖闭包逐文件完整性或目标生产升级/回滚；AC19/20仍blocked。
