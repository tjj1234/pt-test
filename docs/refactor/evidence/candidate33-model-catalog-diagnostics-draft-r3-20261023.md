# candidate-33 draft r3: catalog failure-stage diagnostics

基底为冻结 candidate-33 r2，归档 SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`。本草稿只叠加安全目录失败阶段诊断，target Linux/amd64、Node.js >=22.19；不含模型调用、数据库迁移或依赖变更。

| 文件 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r3.tar.gz` | `d6a065b678bd1321dadf75d37fc3e52290560537a1df526e7477bd7fb459bc77` |
| `release-artifacts/northstar-shell-candidate-33-draft-r3.service` | `5bce0f4371af7fa25665a188c4ea1455d4e6ae6af00150c6608c1761417463c9` |
| failure-stage patch | `8e2a1fa7e4483eef6b54fa19658657b7690e2ef39ce0770e00a978dc16687e8f` |

覆盖成员仅 `shell/server.cjs`、`shell/model-catalog.cjs`；其余 323 个归档成员逐字节继承 r2。新增接口字段 `failureStage` 限于九项固定枚举，internal error 的失败计数为 unknown。测试只使用本地 fixture，不发出 PT 模型请求。

本轮工作区回归：failure-stage 3/3、catalog diagnostics 3/3、HTTP/API脱敏与日志故障回退 1/1；合并执行为 7/7 PASS。T11 usage/UI 6/6 与 T03 lease recovery 10/10 是并行重构切片证据，未包含在本 r3 包内。HTTP fixture仅证明接口投影与安全日志边界；qualification真实故障注入仍未覆盖。线上 TypeError 根因尚未确定。

线上 r2 回传的 `MODEL_CATALOG_INTERNAL_TYPE_ERROR` 只说明异常未命中固定错误码、名称为 `TypeError`；r2 fallback 会固定返回 `failureCount:0`、`upstreamStatus:null`、`lastSuccessfulAt:null` 和 `syncedAt:0`，这些不是请求是否发出、历史成功/失败次数的证据。`models.length:24` 是本地 fallback 列表展示数，不代表远端目录数或可执行数。r3 把未测得的失败计数改为 `null`/`failureCountKnown:false`，并增加固定 `failureStage` 以供后续回传定位。

这是不可部署的本地草稿。candidate-33 r2 归档/unit和已交接 ZIP 保持冻结；r3 新鲜 Linux closure检查失败，也没有最终可执行 runbook、handoff ZIP 或独立发布门审计。当前仅有不可执行 runbook 审阅稿（SHA-256 `193bdf147294c9bb0cccb1eaa5899f0180483c4739adafb102132201e1773854`），目标机实际 r2 systemd unit、drop-in、EnvironmentFiles 尚无安全快照，必须以其精确快照作为以后回滚基线。不得用于部署。

追加发布阻断：新鲜 Linux/amd64 解包安装后，包内closure `--check` 实测 `MANIFEST_MISMATCH`。临时重建manifest仍有472包、30,091文件，差异仅在本地DSH tarball的`resolved`：冻结manifest记录原构建目录的绝对路径。r3运行包保持冻结且不得交付；需在后续候选修正可移植来源记录，重新生成并复验逐文件manifest。
