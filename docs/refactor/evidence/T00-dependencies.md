# T00／T17 依赖与部署预检证据

日期：2026-10-16；2026-10-20 补充。代码基线：`a2adbee64c326653dbf5bfed3f918dd09f96589d`。本证据含离线预检与 source-generated `run-persistent` 候选快照。当前预检只证明仓库锁定输入和候选 profile 文件自洽；没有读取真实数据库、生产 DSH home、`.env`，没有启动生产服务或发起网络／付费调用。结论：**候选快照与离线元数据检查通过；部署机实际 profile、一致性和真实服务/网络验证仍未证明，不能宣称 T00 或一期验收完成。**

## 核查结果

| 项 | 当前实物／结论 |
|---|---|
| DSH 顶层依赖 | `shell/package.json` 使用 `file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz`，锁文件版本 `0.1.1-rc.2` |
| vendor 校验 | 当前 tgz 与锁文件 SHA-512 integrity 匹配；预检重新计算字节哈希，不只检查文件名 |
| 实际入口 | 本机仓库内已安装入口存在，关联包版本 `0.1.1-rc.2` 与锁文件一致；未执行入口，也未遍历全局安装 |
| DSH 传递依赖 | 锁文件有 182 个 `@deepseek-ai/*` 包条目，其中 170 个版本为 `0.1.1-rc.2`，181 个 resolved 指向 npm registry；不能声称离线安装完整 |
| Node | 本次预检执行版本 `24.14.0`；package 声明 >=18，现有 CI 为 Node 20/22，不据此宣称所有平台／版本兼容 |
| Google 登录 | 初始 T00 检查时还没有已实现契约；T02 已实现 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI` 与 Google 路由，当前离线预检按源码静态识别，不探测外部服务 |
| 数据迁移 | `shell/db-migrations` 到 010，`shell/storage/migrations` 仅 001–006；内容与集合未统一，预检阻断 |
| profile | 历史 `web` 快照仍仅作历史记录；新增 `run-persistent` source-generated 候选快照，内容可由当前 profile builder / lock / npmrc 复现；部署机实际 profile 一致性未证明 |
| 测试／生产模式 | 本次运行环境未启用 `PT_MOCK_DSH=1` 或 `PT_CHAT_DRYRUN=1`；只表示开关关闭，不代表已走真实 DSH |
| HTTPS／PG | 本次环境 Secure Cookie 未开启、PG 配置不存在；这是开发环境事实，不直接推断生产环境配置 |

锁文件公开完整性值：`sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==`。该值是依赖完整性摘要，不是密钥。脚本仅输出校验布尔值，避免输出配置或文件正文。

## 交付与验证

`node scripts/northstar-preflight.mjs` 只读取 package/lock、vendor 字节、安装入口关联包元数据、迁移文件哈希和 profile 元数据。输出 Node／DSH 版本与配置布尔状态，不输出路径、Key、连接串、secret、异常原文或文件正文；不自动加载 `.env`。主程序未满足全部离线检查时返回 exit 1，当前确实因迁移与 profile 缺口返回 1。`ready` 仅代表这些离线检查，不代表可发布，输出的 scope 与 limitations 明确这一点。

`inspectPreflight({root, env})` 支持隔离夹具注入，不修改真实环境。`node --test tests/regression/northstar-preflight-test.mjs`：**7/7 通过**，覆盖正常夹具、vendor 篡改、mock 开启、迁移内容差异、显式入口版本不符、web profile 不符、缺文件及恶意版本／凭据不泄漏。无真实服务执行。未运行全量项目回归；预检代码本身不修改产品行为。

Google 的两个布尔字段明确表示此基线未实现／未验证，未来登录实现时必须同步更新预检，不能让静态常量成为永久状态。profile 元数据存在也不能替代实际 profile、bundle、patch、版本及启动验证。

## 外部能力与部署依赖交接

| 能力 | 已有入口／依赖 | 后续真实验证与边界 |
|---|---|---|
| 模型与媒体 | PT BYOK、现有 model-catalog／business media | 有余额测试 Key、实际模型与端点能力、生成产物 URL／CSP、错误语义；本批未联网 |
| Google 登录 | 待实现 | 注册应用、准确回调、secret 受控注入、OIDC 验证与真实浏览器登录；未定配置名不写成已生效 |
| 文档／表格／ZIP | 当前上传及附件路径 | 扩展格式解析器、旧 Office 转换、OCR、受控解压、资源限额与原生依赖均需单独选型并真实验证，不能仅靠后缀 |
| 数据与密钥 | PGlite／PG、平台差异的主密钥保护 | 统一迁移、最小权限、持久卷、密钥保管及跨机恢复演练；未加载真实库 |
| DSH 运行环境 | vendor、传递依赖、公开 SDK、runner/profile | 隔离 home/workspace、子进程权限与网络边界、生产配置快照、真实契约＋冒烟；本批未启动 |
| 部署与运维 | 同源 API/SSE、HTTPS 代理 | 证书域名、SSE 长连接、持久文件、告警触发与备份恢复命令需补交付；不能引用旧文档中当前仓库不存在的脚本 |

下一步按任务包解决迁移及 profile 缺口，再做 DSH 并发／模型注入等真实技术验证；Google、解析器及上线凭据等依赖各按所属任务交付。本预检不替代 Claude 独立验收、预发布／部署验证和全新 Claude Code 完整测试。

## T01 后预检更新

默认迁移入口已经统一为 `shell/db-migrations`；旧 `shell/storage/migrations` 保留为历史快照，内容不同不再作为阻断。预检改为检查 auth／storage 中约定的字面默认入口及权威目录存在且非空，字段为 `migrationDefaultMetadataAligned`；旧目录比对降为 `observations.legacyMigrationSnapshotMatches`。这是有限静态元数据检查，不执行模块，不证明控制流或数据库已迁移；真实升级证据另见 T01 独立审查。

新增正常旧快照差异、入口漂移反例，预检测试 **7/7 PASS**。本机实际预检 `migrationDefaultMetadataAligned=true`、旧快照匹配=false；本段的 exit 1 是候选 profile 快照添加前的历史结果，现由末节取代。DSH vendor、锁文件和安装入口版本匹配保持通过。此次未操作数据库或网络。先前「迁移双源阻断」是修改前的历史结果，已由本段取代。

## T02 后的预检字段校正

Google 登录实施后，原 `googleConfigurationContractImplemented:false` 已变成错误的永久否定值。预检升级为 schema v2，改为静态字段 `googleConfigurationContractPresent`（只检查源码内固定配置名及路由）与 `googleLoginIntegrationEvidencePresent`（只检查接线／测试文件存在），另保留 `googleExternalOAuthVerified:false` 明确表示没有真实 Google 配置、token交换或回调注册证据。此段记载 profile 候选快照添加前的历史状态；最新结果见末节。这些布尔值是静态存在性判断，不替代 T02 实测或 Google 服务验证。

## 2026-10-20：`run-persistent` source-generated candidate

仓库当前不存在 `runtime/dsh-home/profiles/run-persistent`，因此没有从安全本地实物导出部署 profile；未访问开发者 `~/.dsh` 或生产 home。依据 `shell/runtime/dsh-adapter.cjs` 的 profile builder，在隔离临时 DSH home 中调用 `makeProfile` 生成 `docs/dsh-profile-snapshot/run-persistent/`。输入仅为仓库 runner/business source、`shell/package-lock.json` 与 `.npmrc`；临时 settings 使用空合成模板，未复制进快照。候选目录含 11 个 manifest 管理文件与 manifest，共 12 个文件；manifest SHA-256：`935c4a38f6b81094adebbb0cd8432db5a46228d6977b73cdd80ed996121e3f12`。用 `node scripts/northstar-profile-snapshot.mjs check` 验证与当前生成器一致；`write` 是显式更新仓库候选快照的模式。

`node --test tests/regression/northstar-preflight-test.mjs` **8/8 PASS**；`node scripts/northstar-preflight.mjs` **exit 0，ready=true**。旧字段 `productionProfileSnapshotMetadataPresent` 已更名为 `runPersistentSourceSnapshotComplete`：preflight 检查必需文件集合、manifest SHA-256、profile identity、dependency contract 与当前 lock/npmrc 字节哈希。`ready` 仍限定为 `offline-static-only`，不是部署 ready，也不证明生产已加载这些 bundle/patch。

部署一致性仍需部署方提供最小脱敏资料：产品专用 profile 标识、DSH 精确版本、实际 profile managed files 的内容/哈希、DSH 启动生成的 `cordis.yml`（仅保留 bundle/patch ID 与加载顺序）和已安装 bundle 名称/版本/加载状态，以及采集时间。不要提供 settings、API Key/token、连接串、绝对 home 路径、workspace 或用户文件。当前 source candidate 只声明 `@deepseek-ai/dsh-base`，不能据此宣称搜索/浏览器能力已生产加载。
