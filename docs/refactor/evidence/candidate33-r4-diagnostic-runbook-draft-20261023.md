# candidate-33 r4 目录诊断部署清单草稿（不可执行）

**仅供审阅；未获部署授权；禁止直接运行、上传或交给目标机执行。** candidate-33 r4 本地 draft archive、unit、portable manifest 已生成，且本地 Linux/amd64 closure 验证通过；这些仍不是最终部署冻结或目标机验收。本稿保留目标机 systemd 快照及回滚映射 `[TARGET: ...]`，候选身份仍待 `[FREEZE: ...]`。所有占位符未由维护者和发布审计共同确认前，本稿都不是操作清单。未生成 ZIP、未发送同事、未操作目标机。

## 1. 发布身份与不可沿用项

| 项目 | 必须冻结的值 / 当前状态 |
|---|---|
| 唯一候选 ID 与 immutable release path | `[FREEZE: candidate-33 r4 ID]` / `/opt/northstar/releases/[FREEZE: unique-r4-release-id]/shell` |
| 冻结构建基底 | candidate-33 r2 archive SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77` |
| 当前 r4 draft archive / unit SHA-256 | `665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c` / `ee7f9118190278ea0c7289eb70d94c754191a30f58152bf33e10841f1a8fe772`；unit Description 仍含 `DRAFT ONLY - NOT FOR DEPLOYMENT`，不得安装；最终发布审计需复核 |
| 归档内 T16 portable manifest / helper SHA-256 | `shell/dependency-closure-manifest.json`: `88203b2c8606c790aa901366225fc1b029727e62b2e18d4f9c4a45ef878f2eaa`；`shell/northstar-dependency-closure.cjs`: `9f5ffe4bf45c0174474ac3c4d1b86f5e7d1253af8d01c7fac6fb6f92b9889ad8`。此行只绑定 r4 归档成员，不沿用工作区旧 manifest。 |
| runbook / handoff ZIP SHA-256 | 冻结 runbook 字节后，在**包外发布校验表**记录 runbook SHA；组装 ZIP 后再在同一包外校验表记录 ZIP SHA。runbook/ZIP 不包含自己的 SHA，避免循环引用。 |
| 运行门槛 | Linux/amd64（`linux`/`x64`）；Node.js `>=22.19.0`；Arborist `8.0.5`、semver `7.8.5`（当前 r4 锁定版本） |
| 当前 T16 manifest 计数 | 472 production packages / 30,091 files；最终交付前仍须与归档内 manifest 和 clean install 输出逐项复核 |

r3 draft archive/unit/manifest 不得作为 r4 基底或交付输入。r3 的 `@deepseek-ai/dsh` manifest `resolved` 曾包含 `/tmp/northstar-t16/shell/vendor/...` 构建机绝对路径；这不能代表目标 release path，目标机 closure 检查可能失败。r3 archive、unit、runbook 草稿和旧 hash 必须保持原样，不得覆盖或混入 r4。

## 2. r4 输入绑定与最小 overlay

r4 必须从上表冻结的 candidate-33 r2 archive 构建，仅准许以下四个已审阅成员变化：

| 成员 | r4 处理 | 输入 SHA-256 |
|---|---|---|
| `shell/server.cjs` | failure-stage 诊断 overlay；先筛掉无关 dirty hunk | 当前 r4 归档成员 `ee7c595018873d48527bbeda411a3247bde36eeb25873319c9c1b8429a8549f6` |
| `shell/model-catalog.cjs` | failure-stage 诊断 overlay | 当前 r4 归档成员 `620f18c683b348aeecb6c9cc50ef74652f572b713bd3b75eb9422041bffa5a13` |
| `shell/northstar-dependency-closure.cjs` | portable `file:` resolved 规范化及 fail-closed 检查 | 当前 r4 归档成员 `9f5ffe4bf45c0174474ac3c4d1b86f5e7d1253af8d01c7fac6fb6f92b9889ad8` |
| `shell/dependency-closure-manifest.json` | 两目录验证后生成的 portable manifest | 当前 r4 归档成员 `88203b2c8606c790aa901366225fc1b029727e62b2e18d4f9c4a45ef878f2eaa` |

同时必须显式 pin 下列虽预期不变、但影响安装闭包的输入，并逐字节比对 r2 基底及 r4 archive：`shell/package.json`、`shell/package-lock.json`、`shell/.npmrc`、`shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz`。锁文件中的 DSH local tarball `resolved` 与 integrity 必须与真实 tarball 一致；任何 lock、npmrc、vendor tarball 或额外成员变化都会使四 overlay allowlist 失败并 STOP。构建器不得遍历 dirty worktree 打包。

候选产物、发布证据必须绑定：base archive；上述四个 overlay 源文件；四个 unchanged install inputs；Arborist/semver 锁版本与 helper；portable manifest；unit、archive、runbook、ZIP；成员清单、路径及 SHA-256。发布构建器、闭包审计工具、双目录负向回归脚本的 SHA 作为构建证据冻结，不作为 runtime 包成员，除非 manifest/overlay 明确要求。

## 3. Portable closure Linux 证据与交付门

已经通过的 fresh Linux/amd64 验证如下；详细命令、版本、lock SHA 和限制见 [portable closure 证据](candidate33-r4-portable-closure-20261023.md)：

| 安装根与输入 | 环境 / 安装 | closure `--check` |
|---|---|---|
| `/work-a`：冻结 r2 + portable helper/manifest | Node v22.23.4 linux/x64；clean `npm ci` 安装 621 packages | PASS，472 production packages / 30,091 files |
| `/different/work-b`：冻结 r2 + 同一 helper/manifest，独立 clean install | Node v22.23.4 linux/x64；clean `npm ci` 安装 621 packages | PASS，472 production packages / 30,091 files |
| r4 archive 解包至其模拟 immutable release path | 新鲜 Linux/amd64 install；使用 archive 内 helper/manifest | PASS，472 production packages / 30,091 files；另见 [r4 draft 证据](candidate33-model-catalog-diagnostics-draft-r4-20261023.md) |

前两项证明不同绝对根的 portable 来源解析一致；第三项验证了 r4 当前归档自身的 package closure。三项均为本地容器证据，不代表目标机安装或应用运行验收。最终 handoff 前仍须对最终冻结 r4 archive/hash 重复 package closure `--check`，不得仅引用当前 draft hash。比较规范化 manifest 时，除明确允许的 generator/checker Node 版本字段外，不得忽略 package identity、resolved、integrity、file metadata 或任何文件 hash。

必须满足：

1. 两个安装根生成的 manifest 字节或规范化内容完全一致；DSH 的 `resolved` 使用从 lock/vendor 输入可稳定重建的相对 `file:` 形式，不含构建机、容器或目标机的绝对安装根。
2. 只规范化 DSH local tarball 安装根；不全局忽略 `resolved` 或 integrity。DSH tarball 的 SHA-256 / lock integrity、包版本与 location、installed package 每个文件的类型、mode、size、SHA-256 仍逐项验证。
3. 加入回归：改变绝对安装根而不改变 lock/tarball/package 字节时 manifest 不变；改变 DSH tarball、manifest 输入或 installed package 任一字节时必须 fail closed。
4. 从最终 r4 archive 在最终 immutable release path 重新解包并 clean install，再对该候选的 manifest 执行 `--check`；结果必须 `PASS`，并与冻结 platform、packageCount、fileCount、package-lock、package.json、`.npmrc` hash 一致。
5. 候选 archive 仍以冻结 r2 为基底且差异恰为上述四成员；USTAR、成员数、路径白名单、无禁用文件和 unit 路径检查全部通过。r4 archive、unit hash 生成后不得改字节；runbook/ZIP 必须随后按最终内容重新 freeze。

任一条件失败、出现绝对根残留、计数变化未解释或额外成员，r4 不得出 handoff；不修补已生成 archive，须更新命名输入、重新构建并重审。

## 4. 授权前目标机只读基线

部署授权前若维护者允许只读 SSH 观测，可安全采集系统元信息和 systemd 非秘密属性；不得修改 unit、创建备份、上传/解包候选或发起 `/api/models` 请求。`/api/models` 虽为 GET，可能触发目录同步、缓存读写及 PT 目录请求，须留到明确授权的诊断步骤。

```bash
uname -s
uname -m
/usr/local/bin/node --version
sudo systemctl show northstar-shell --no-pager \
  --property=LoadState --property=ActiveState --property=FragmentPath \
  --property=DropInPaths --property=ExecStart --property=WorkingDirectory \
  --property=EnvironmentFiles --property=User --property=Group
```

对实测 FragmentPath 和每一个 DropInPath，只采路径、`readlink -f`、`stat` owner/group/mode、SHA-256；EnvironmentFiles 只记录路径并测试服务用户可读。不读文件内容，不用 `systemctl cat`、`Environment`、完整 `systemctl status` 或 journal 输出。基线记录：

| 有效属性 | 目标机安全实测值 |
|---|---|
| FragmentPath、symlink target、owner/group/mode、SHA-256 | `[TARGET: 必须实测]` |
| 每个 DropInPath 的同类信息；无 drop-in 时明确记录 `none` | `[TARGET: 必须实测]` |
| WorkingDirectory、ExecStart、EnvironmentFiles（仅路径） | `[TARGET: 必须验证为当前运行 r2 配置]` |
| User、Group、LoadState、ActiveState | `[TARGET: 必须实测]` |
| 当前 r2 release 路径存在、local/public `/healthz` JSON `ok===true` | `[TARGET: 只读检查]` |
| 唯一备份路径与候选 r4 路径冲突检查 | `[TARGET: 路径冻结后仅 test existence，不创建]` |

第一轮由用户转述的目标机结果：Linux/x86_64、Node v24.22.0、服务 active；FragmentPath 为 `/etc/systemd/system/northstar-shell.service`，DropInPaths 为 none；WorkingDirectory 为 `/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell`，ExecStart 的 server 路径同该目录，EnvironmentFiles 为 `/etc/northstar/northstar.env` 与 r2 release 内 `shell/northstar-limits.conf`，User/Group 为 northstar/northstar。此摘要尚无 unit symlink/owner/mode/SHA、新路径存在性、两端health及逐项原始退出码，所以上表仍不视为最终冻结。第二轮只读采集见[清单](../北极星r4目标机只读文件与健康采集-20261023.md)。

如果当前 unit 未 loaded/active、实际路径不是已运行 r2、存在不明 drop-in、FragmentPath 为 generator/transient、symlink/权限关系不明、环境文件路径不符、Node/platform 不符或 health 失败，STOP；不继续安装准备。当前清单内的 candidate r2 service 文件不能代替目标机有效配置快照。

## 5. 授权后的备份、切换与 restart 前校验

本节是最终 runbook 需填充的门禁，不是当前可执行命令。仅获得明确 r4 部署授权、r4 T16 与发布审计通过、目标机快照已审阅后才可填具体路径和命令。

备份目录 `[TARGET: 全新唯一绝对路径]` 必须用排他 `mkdir` 创建；路径存在即 STOP，禁止覆盖。按已审阅快照逐一 `cp -a` FragmentPath 和全部 DropInPaths，写明源→备份映射；记录原件和备份 SHA-256、symlink target、owner/group/mode并确认相同。环境文件、secret、数据库或 r2 release 不进入 unit 备份。若快照发现无法安全恢复的 unit 位置或 drop-in，禁止切换。

仅将最终冻结的 r4 unit 安装到明确审阅的 fragment 目标，随后 daemon-reload；**restart 前**运行：

```bash
sudo systemctl show northstar-shell --no-pager \
  --property=LoadState --property=ActiveState --property=FragmentPath \
  --property=DropInPaths --property=ExecStart --property=WorkingDirectory \
  --property=EnvironmentFiles --property=User --property=Group
```

必须把查询结果逐字段与冻结 r4 unit 比较：WorkingDirectory、ExecStart、全部 EnvironmentFiles、FragmentPath、DropInPaths、User、Group 必须完全符合；不匹配、缺失或无法确定即按第 7 节回滚，不 restart。仅当有效配置门通过才 restart，并要求 `is-active`。

## 6. Health 后的单次目录诊断

切换块成功并单独回传后，local 与 public `/healthz` 必须分别返回 JSON `ok===true`。任一不通过即回滚，禁止继续 API 查询。

双端 health 通过后，只允许使用已登录浏览器向 `https://agent-fat.adorado.top/api/models` 发送一次 GET；不使用 `/api/chat`、模型选择、工具或生成请求。只回传 HTTP status、`catalogDiagnostics.state`、`errorCode`、`failureStage`、`failureCount`、`failureCountKnown`、`upstreamStatus`、`lastSuccessfulAt`、`syncedAt`、`syncError`、`models.length`。不回传整个响应、Key、Cookie、Authorization、headers 或环境信息。

`failureStage` 必须是 `scope`、`qualification`、`cache_read`、`fetch_or_parse`、`merge`、`local_update`、`cache_write`、`projection`、`fallback_projection` 之一或 `null`。若 `state=internal_error`，要求 `failureCount=null` 且 `failureCountKnown=false`；已捕获内部异常的 stage 应为固定枚举中的非 null 值。字段缺失、未知 stage、计数语义矛盾或响应不符即诊断验收失败并回滚。若目录成功且 stage null，只能记录“本次未复现”；有效 stage 只是安全定位证据，不证明模型可调用或根因已修复。无论诊断结果如何均不调用模型。

## 7. 严格回滚与停止

最终版必须把回滚命令绑定至第 4、5 节实测并备份的 FragmentPath、每个 DropInPath、symlink 和 metadata；禁止操作者现场猜路径。install、daemon-reload、restart 前有效属性检查、restart、is-active、health 或诊断 schema 任一失败，立即逐项恢复原 fragment/drop-ins，校验 hash/symlink/owner/group/mode 后执行 daemon-reload、restart、is-active，再验证 local/public health 均 `ok===true`。

回滚任一恢复、hash、systemd 或 health 步骤失败时立即停止并报告；不得继续 GET、删除 r2/r4 release、删备份或猜测式修复。保留 r2、r4 和备份待维护者判断。回滚成功仅证明 systemd 配置与 health 恢复，不等于数据库/secret 备份恢复或完整 T18 验收。

## 8. 交付前最终门

所有 `[FREEZE: ...]` 与最终 r4 archive、unit、manifest 逐字节一致；所有 `[TARGET: ...]` 由目标机安全采集且独立审阅。先冻结 runbook，再构建 ZIP，最后在不放入 ZIP 的包外发布校验表记录并复核二者 SHA-256；双安装根 portable closure、最终 immutable path `--check`、四成员 overlay、unit/systemd 有效路径、runbook 逐步门槛及回滚映射均须通过独立审计，才可把最终材料交维护者另行确认是否授权。当前未获部署授权；本稿不生成 ZIP、不发给同事、不操作目标机，也不宣称线上 TypeError 根因已确定或修复。
