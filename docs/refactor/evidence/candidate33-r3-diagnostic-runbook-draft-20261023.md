# candidate-33 r3 诊断部署清单草稿（不可执行）

**状态：发布阻断，仅供审阅，禁止执行。** candidate-33 r3 在新鲜 Linux/amd64 安装后的逐文件 closure `--check` 返回 `MANIFEST_MISMATCH`：旧 manifest 含 DSH 本地 tarball 的构建目录绝对路径。本文不得据此上传、安装、切换或回滚服务。所有 `[TARGET: ...]` 必须由维护者在目标机只读采集并经独立审阅后填写；所有 `[FREEZE: ...]` 必须在发布闭包冻结后替换。当前未生成 ZIP，也未发送给同事；该 r3 草稿不会转为可执行清单。

## 候选输入与运行门槛

| 项目 | 当前可确认值 | 使用门槛 |
|---|---|---|
| 基底 | 冻结 candidate-33 r2，SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77` | 只从该不可变 archive 应用显式命名 overlay；禁止从 dirty worktree 打包 |
| r3 draft archive | `release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r3.tar.gz`，SHA-256 `d6a065b678bd1321dadf75d37fc3e52290560537a1df526e7477bd7fb459bc77` | 仅用于本地审阅；最终复核后必须再次确认 hash |
| r3 draft unit | `release-artifacts/northstar-shell-candidate-33-draft-r3.service`，SHA-256 `5bce0f4371af7fa25665a188c4ea1455d4e6ae6af00150c6608c1761417463c9` | 文件描述仍标记 `DRAFT ONLY - NOT FOR DEPLOYMENT`，不得安装；最终 unit 必须单独冻结并复核 |
| 代码 overlay | `shell/server.cjs`、`shell/model-catalog.cjs` | 其余成员应逐字节继承 r2；最终包审计须排除其他并行/dirty hunk |
| immutable release path | `/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r3` | 草稿路径；最终版须确认唯一、未存在且与冻结 unit 完全匹配 |
| 运行平台 | Linux/amd64（`uname -s=Linux`、`uname -m=x86_64`） | 任一不匹配即 STOP |
| Node.js | `>=22.19.0` | 目标机实际版本未复核；低于门槛即 STOP |
| 依赖闭包 | 锁定 Arborist `8.0.5`、semver `7.8.5`，逐文件 manifest | 当前闭包基线为 472 production packages / 30,091 files；r3 final 必须重新 `npm ci` 来源校验并对本候选执行 closure `--check`，输出和 manifest SHA 在冻结前填写 `[FREEZE: ...]` |
| 部署 unit / runbook / ZIP | `[FREEZE: unit SHA]` / `[FREEZE: runbook SHA]` / `[FREEZE: ZIP SHA]` | 最终包必须逐项校验；本草稿不生成、不替代交接 ZIP |

r3 草稿证据记录：本地 failure-stage 3/3、目录诊断 3/3、HTTP/API脱敏及日志故障回退 1/1；qualification 真实故障注入仍未覆盖。草稿不包含数据库迁移、依赖变更或模型调用。线上 TypeError 根因尚未确定；新增阶段诊断不能被描述为根因修复。

## 0. 目标机只读快照门

当前目标机虽被报告为运行 candidate-33 r2，但有效 systemd fragment、drop-ins、环境文件路径与覆盖关系尚无实测快照。执行授权到达后，先单独运行只读查询并逐字段回传；不可先假设仓库中的 r2 unit 就是目标机当前有效配置：

```bash
sudo systemctl show northstar-shell --no-pager \
  --property=FragmentPath --property=DropInPaths --property=ExecStart \
  --property=WorkingDirectory --property=EnvironmentFiles \
  --property=User --property=Group --property=LoadState --property=ActiveState
```

对返回的 `FragmentPath`、每个 `DropInPaths` 和 symlink target，只读取路径、`readlink -f`、`stat` 的 owner/group/mode 和 SHA-256；不打印 unit 文件内容。对 `EnvironmentFiles` 只检查确切路径存在且服务用户可读，不输出或备份其内容。不得查询 `Environment` 属性，不使用 `systemctl cat`，避免把 literal secret 写入回传。

目标机实测基线（待填；不得从候选文件推断）：

| 有效属性 | 目标机实测值 / SHA-256 |
|---|---|
| FragmentPath、resolved symlink、owner/group/mode | `[TARGET: 必须实测]` |
| 每个 DropInPath、resolved symlink、owner/group/mode | `[TARGET: 逐个实测；无 drop-in 时明确记录 none]` |
| WorkingDirectory、ExecStart | `[TARGET: 必须确认指向已运行 r2 immutable release]` |
| EnvironmentFiles | `[TARGET: 逐项列路径并检查可读，不输出内容]` |
| LoadState、ActiveState、Node 版本、平台 | `[TARGET: 必须实测]` |
| local 与 public `/healthz` JSON `ok===true` | `[TARGET: 必须实测]` |
| 当前已登录 `/api/models` 脱敏基线 | `[TARGET: 仅浏览器 GET；按第 4 节字段回传]` |

**立即 STOP 条件：** unit 未 loaded/active、WorkingDirectory/ExecStart/EnvironmentFiles 与已运行 r2 不符、路径缺失、Node/platform 不符、存在无法解释的 drop-in、FragmentPath 是 generator/transient 产物、symlink/权限关系未审阅、文件包含无法安全审阅的 inline secret、health 不通过，或任何值与目标机维护者确认的 r2 基线冲突。STOP 时不上传、不解包、不备份、不改 systemd。

## 1. 最终输入校验与安装准备（只有独立发布审计和部署授权后）

最终 runbook 必须填写并核验 archive、unit、manifest、closure helper、runbook 与 ZIP 的冻结 SHA；r3 当前草稿 hash 不能直接作为最终部署批准值。目标机依次校验文件 SHA、平台/Node、gzip 与 USTAR 成员/路径/迁移计数、候选 immutable path 不存在，再解包到经冻结的唯一 r3 path。按锁定依赖以 `northstar` 用户执行 `npm ci --no-audit --no-fund`，不得 root 执行、不得加 `--ignore-scripts`；验证 native helper 权限，运行候选内 closure helper `--check`。期望 package/file counts 与 manifest SHA 用 `[FREEZE: ...]` 固定，不得机械沿用旧候选数值。任一失败则 STOP；此阶段不得替换 unit 或重启。

## 2. 排他备份实际有效 unit 与 drop-ins

最终 runbook 必须把第 0 节目标机实测路径展开成逐项固定命令，禁止在执行时通过通用 glob 猜路径。备份目录使用唯一绝对路径 `[TARGET: /var/lib/northstar/rollback/<r2-to-r3-id>]`；以 `sudo mkdir -m 0700 <exact-backup-root>` 排他创建，若已存在立即 STOP，禁止覆盖。

对实测 FragmentPath 和每个 DropInPath 分别使用 `sudo cp -a -- <exact-source> <exact-backup-destination>`，记录源路径→备份路径映射。记录并比较备份前后 SHA-256、symlink target、owner/group/mode；所有项一致后才允许切换。没有 drop-ins 时记录 `DropInPaths=none`。不得复制 EnvironmentFiles、数据库、secret 或释放目录到 unit 备份区；不得删除 candidate-33 r2。

若实际 FragmentPath 不在最终切换命令明确支持的路径、为 generator/transient、是未审阅的 symlink，或 drop-in 会改变候选有效配置，必须 STOP 并先单独修订、审阅恢复映射；不能用 `cp`/`install` 试探。任何备份项缺失、hash 或 metadata 不一致均 STOP。

## 3. 切换与 restart 前的有效配置校验

最终版需将候选 unit 文件 hash、已核验的实际安装路径和 rollback 映射写死。切换块独立执行并回传；使用 `set -euo pipefail`，先以排他安全方式安装候选 unit，再 `daemon-reload`。**在 restart 前**运行下列有效属性查询，并对每个值作精确断言；预计值必须是 r3 immutable path，EnvironmentFiles 必须恰好符合冻结 unit：

```bash
sudo systemctl show northstar-shell --no-pager \
  --property=FragmentPath --property=DropInPaths --property=ExecStart \
  --property=WorkingDirectory --property=EnvironmentFiles \
  --property=User --property=Group --property=LoadState --property=ActiveState
```

```text
WorkingDirectory = [FREEZE: final immutable release path]/shell
ExecStart         = /usr/local/bin/node [FREEZE: final immutable release path]/shell/server.cjs
EnvironmentFiles = [FREEZE: exact external file + r3 limits file, paths only]
FragmentPath      = [FREEZE: exact target fragment path]
DropInPaths       = [FREEZE: exact paths or none]
```

以上有效值若缺失、含未知 drop-in override、仍指向 r2/其他路径，或无法精确判定，立即执行第 6 节回滚，不得 restart。只有断言全部通过，才 `restart northstar-shell` 并要求 `is-active` 成功。install、daemon-reload、有效配置断言、restart、is-active 任一失败，立即回滚；不继续 health 或 API 查询。

## 4. Health 后的单次诊断 GET

切换步骤成功并单独回传后，再单独检查 local 与 public `/healthz`；必须解析 JSON 并断言 `ok===true`，不能仅凭 HTTP 200。任一失败立即回滚。

两端 health 全通过后，只允许已登录浏览器对 `https://agent-fat.adorado.top/api/models` 发起 **GET**。不发 `/api/chat`、模型选择、工具调用或生成请求。仅回传 HTTP status、`catalogDiagnostics.state/errorCode/failureStage/failureCount/failureCountKnown/upstreamStatus/lastSuccessfulAt`、`syncedAt`、`syncError`、`models.length`；不得提供整个响应、Key、Cookie、Authorization、请求头或环境信息。

`failureStage` 只接受 `scope`、`qualification`、`cache_read`、`fetch_or_parse`、`merge`、`local_update`、`cache_write`、`projection`、`fallback_projection` 或 `null`。当 `state=internal_error`，必须同时满足 `failureCount=null`、`failureCountKnown=false`；若内部异常被捕获，stage 应是非 null 的固定枚举。字段缺失、未知 stage、类型不符或计数语义不一致，诊断验收失败并立即回滚。若本次目录同步成功且 stage 为 null，只能报告“本次未复现”；若 internal error 且 stage 有效，表示获得阶段诊断证据，不等于模型可调用，也不表示根因已修复。无论结果如何不调用模型。

## 5. 回滚与停止条件

最终版必须使用第 2 节已填充的精确路径映射；不得让操作者临时选择回滚目标。出现 install、daemon-reload、restart、is-active、restart 前有效属性校验、health 或诊断 schema 任一失败，立即执行回滚：逐项恢复预先备份的 FragmentPath 与所有 DropInPath（只触及列明的确切路径），校验 hash/symlink/owner/group/mode 与第 0 节快照相同，随后 `daemon-reload`、`restart northstar-shell`、`is-active`，再验证 local 与 public health 均 `ok===true`。恢复命令应由目标机快照具体化，不在本草稿中猜路径。

回滚中任一恢复、hash、systemd 或 health 命令失败，立即停止所有后续操作并报告；不得发诊断 GET、删除 candidate-33 r2、删除候选 r3 或备份，也不得尝试猜测式修复。回滚成功只说明 unit 和 health 恢复，不等于数据/secret 备份恢复或 T18 完整验收。

## 6. 交接前最终门

本文需经独立审阅，所有 `[TARGET: ...]` 由目标机安全回传填写，所有 `[FREEZE: ...]` 与最终归档/unit/manifest 一致，实际命令块通过静态检查，候选闭包和产物检查通过，最终 runbook 与 ZIP 重新冻结 SHA 后，才可提交给维护者另行决定是否授权。当前没有部署授权；不得发送旧 r2 ZIP 冒充 r3 清单。目标机未执行前不得宣称部署、诊断或回滚完成；此候选不会预先修复或确定线上 TypeError 根因。
