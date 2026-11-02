# 给运维：FAT旧版模型目录故障只读取证清单

目的：定位既有版本的MODEL_CATALOG_INTERNAL_TYPE_ERROR，并确认准确部署基线。线上尚未更新为主Agent当前开发代码；本次不是新版验收或部署申请。请先提供第1、2项，已有资料可直接复用。无需重启、更新、清缓存、改Key、补造权限或执行模型请求。

## 1. 当前运行版本和路径（必需）

服务默认名为northstar-shell；若实际名称不同请替换。仅查询指定属性，不回传整个unit或Environment内容：

```bash
sudo systemctl show northstar-shell --property=MainPID --property=WorkingDirectory --property=FragmentPath --property=ActiveState
sudo systemctl is-active northstar-shell
```

请另给实际启动的server.cjs绝对路径、所用Node二进制路径和版本、候选/发布编号及原包SHA256（若有）。若目录里有Git元数据，提供commit；没有则写“无Git元数据”，无需补建仓库。不要直接回传可能含token参数的完整命令行或ExecStart。

在实际release根目录执行以下源码指纹；若文件不存在，回传缺失项，不从其他版本复制补齐：

```bash
sha256sum shell/server.cjs shell/model-catalog.cjs shell/models/catalog-cache.cjs shell/models/capabilities.cjs
```

补充当前runtime目录绝对路径、日志目录绝对路径、是否使用PGlite或PostgreSQL（仅类型，不提供连接串）、反向代理是否指向此实例。路径用于核对服务/缓存是否来自同一候选，不要求修改配置。

## 2. 同一次目录故障的已有日志（必需）

浏览器于2026-10-27 08:04 UTC前后读取GET /api/models，结果为MODEL_CATALOG_INTERNAL_TYPE_ERROR。请取下列UTC窗口的已有日志；若journal无应用日志，从实际应用日志目录查询同一窗口。以下命令仅打印相关事件行：

```bash
sudo journalctl -u northstar-shell --utc --since '2026-10-27 07:55:00' --until '2026-10-27 08:10:00' --no-pager -o cat | grep -E 'model_catalog_internal_failed|model_catalog_status|MODEL_CATALOG_INTERNAL_TYPE_ERROR'
```

需要保留ts/event/errorCode/errorClass，以及实际存在的failureStage、requestId/traceId、错误message和stack中的源码文件/行号。若异常堆栈另起多行，请补对应事件紧邻的堆栈，不提供整份日志。若旧版仅记录errorClass=TypeError、没有message/stack/failureStage，请原样说明“旧版未记录”，不要临时改生产代码加日志或推测阶段；主Agent据此决定最小诊断候选。

该日志窗口已过；无需为了取证发送聊天或生成请求。若确需重新触发目录读取，只在已登录页面打开模型列表/GET /api/models，并记录精确UTC时间，不点击发送、生成或强制同步。

## 3. 目录缓存的结构摘要（已有可复用）

用户此前提供：files=6、unreadable=0、invalidEnvelope=0、nullRecords=0、legacyDisplayRecords=0、richRecords=480。若仍是同一部署/runtime且缓存未变化，确认采集时间及“未变化”即可，不必重复跑。

如缓存已变化，提供当前统计与每文件字节数/mtime/文件SHA256；不回传用户/租户标识或完整缓存正文。需要查看记录形状时，仅提供字段名、字段类型、数组长度及null/缺失情况；尤其是models、tasks、endpoints、inputModalities、outputModalities、localPolicy、adaptations、verifications。没有这些字段也请写明。不要删除或自动迁移原缓存。

## 4. 返回接口摘要（便于关联）

当前已由主Agent实际浏览器观察，无需运维重复证明登录：
- GET /api/models：顶层ok=true，但availability.status=unknown、modelIds=[]；catalogDiagnostics.state=internal_error、errorCode=MODEL_CATALOG_INTERNAL_TYPE_ERROR、upstreamStatus=null、lastSuccessfulAt=null、failureCount=0、retryAt=null、modelCount=24。未见failureStage。
- 24项模型为静态projection-only、目录状态未确认，不能当作24个可执行模型。
- GET /healthz：ok=true、version=1.0.0、pid=123507、uptimeSec=358907、ts=2026-10-27T08:04:16.764Z。通用version不足以识别源码。

如运维发现此域名经多实例/负载均衡，请提供实例数量、上述PID对应实例及代理映射摘要，避免用A实例源码解释B实例错误。

## 回传模板与脱敏边界

```text
服务名/实例：
发布编号/实际server.cjs路径：
Node路径/版本：
MainPID/WorkingDirectory：
原发布包SHA256或Git commit（无则说明）：
四个源码文件SHA256（缺失则列出）：
runtime/日志目录；数据库类型：
故障UTC时间及对应事件：
message/stack/failureStage：有则提供脱敏片段；没有则写旧版未记录
缓存是否仍为此前6文件/480 rich records：
是否多实例、代理是否指向该实例：
```

不要提供.env全文、API Key、Authorization、Cookie、OAuth code/state、Google client secret、数据库密码/连接串、私钥、用户输入或完整请求/响应体。源码stack保留文件名和行号即可，删去可能包含凭据/数据的错误值。取证不包含重启、部署、迁移或真实付费调用授权。

## 运维回传后的补充（2026-10-27）

MainPID=123507，WorkingDirectory=/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell，服务active。四个源码SHA256与本地冻结r2归档全部精确匹配：server 64ad1cdc9cc1f7fed1f90ef918f39e8c260eee294d15730715ac766fe9eafe54；catalog 934719b4f542c57d34a4121fdb91639a0e393013a7b49d999b4088d71f35e73d；cache 05266578ab4f3489dfa0a467c60de8f2e1f984b59be8295699cc1e6c81eacc4a；capabilities b569a61b7e09da7bd41e901f5da4a16c70cebc926baa8fd0306a2d6bec72b593。

旧版logging.cjs默认落release根logs/app-YYYY-MM-DD.log，PT_LOG_DIR可覆盖；故journal查询空不能代表没有应用日志。冻结server.cjs:136只记录errorCode/errorClass，不记录message/stack/failureStage，这些字段无法从现有日志补出。无需继续反复查journal或要求不存在的堆栈。

先查询实际路径（只输出两个路径变量，不输出其余进程环境）：
```bash
sudo python3 - <<'PYOPS'
from pathlib import Path
entries = Path('/proc/123507/environ').read_bytes().split(b'\0')
values = dict(item.split(b'=', 1) for item in entries if b'=' in item)
for key in [b'PT_LOG_DIR', b'PT_RUNTIME_DIR']:
    print(key.decode() + '=' + values.get(key, b'(not set)').decode(errors='replace'))
PYOPS
```
未设置PT_LOG_DIR时查询：
```bash
sudo grep -hE '"event":"model_catalog_(internal_failed|status)"' /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/logs/app-2026-10-27.log | tail -30
```
如设置了PT_LOG_DIR，替换成该目录；若相对路径则按服务WorkingDirectory解析。文件名按服务主机本地日期切割，记录ts为UTC；无对应日期文件时仅列目录文件名/mtime，不回传其他内容。此步骤只需确认最近事件与路径；重复相同TypeError事件不能进一步定位根因。根因仍需主Agent对精确冻结代码作复现，必要时准备最小诊断候选再走受控流程，不能直接编辑线上文件。
