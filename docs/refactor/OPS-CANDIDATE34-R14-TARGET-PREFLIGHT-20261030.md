# candidate34-r14：目标机只读预检与发布交接（2026-10-30）

**状态：`PENDING_TARGET_PREFLIGHT`。** r14 应用归档与已在 Linux/amd64 验证的 r13 归档逐字节相同；仅修正 systemd unit 的候选名、发布路径和误留的草案说明。归档 SHA-256 `f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993`，unit SHA-256 `ef51137bcd05ce82a5cbce366a6fc6596538d3d1378401927e43b8f9202a25d3`，清单 JSON SHA-256 `4d13cf8eca08fa5af6a96aa13e9b59324db578ce17c6f2c1d5e761d0bff13336`。本地 promotion builder `--check`、r13 builder/audit、逐字节 `cmp`、`git diff --check` PASS；真实图生视频与确切归档 Linux 证据见 [r13 门禁](evidence/F1-candidate34-r13-20261030-release-gate.md)。**尚未在目标机安装、切换或验证回滚。**

| 文件 | 位置 |
|---|---|
| 应用归档 | `release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14.tar.gz` |
| systemd unit | `release-artifacts/northstar-shell-candidate-34-r14.service` |
| 绑定清单 | `release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14.json` |
| 哈希清单 | `release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14.sha256` |

请运维**仅执行下面只读采集**并回传命令、原始输出、退出码（不要回传环境变量值、Key、cookie、数据库数据）：

```bash
date -Is
uname -m
node --version
python3 --version
systemctl is-active northstar-shell
systemctl show northstar-shell -p FragmentPath -p ExecStart -p WorkingDirectory -p EnvironmentFiles -p User -p Group --no-pager
systemctl cat northstar-shell
sudo stat -c '%n %F %a %U:%G' /etc/systemd/system/northstar-shell.service /etc/northstar/northstar.env /var/lib/northstar/runtime /var/lib/northstar/db /var/lib/northstar/secrets
sudo sha256sum /etc/systemd/system/northstar-shell.service
test ! -e /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14; echo "r14_path_absent=$?"
test ! -L /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14; echo "r14_symlink_absent=$?"
curl -fsS --max-time 5 http://127.0.0.1:8098/healthz
curl -fsS --max-time 10 https://agent-fat.adorado.top/healthz
```

回传时另注明：当前可回滚 release 的绝对路径、其应用归档/源码来源、node_modules 是否驻留在该 release 内、最近一次可用数据库备份的位置与创建时间、运维使用的受控 SSH/传包入口。`systemctl cat` 若暴露敏感环境值，应只回传 unit 文件中 EnvironmentFile 的**路径**与相关配置行，不回传值。此阶段不执行 `scp`、解包、`npm ci`、迁移、`daemon-reload` 或服务重启。

收到预检后再锁定目标机 clean install、unit 安装、旧 unit 和 release 备份、切换、健康与回滚的逐条命令；任何路径/版本/依赖不符，停止切换。公网健康检查只说明当前旧版服务存活，不能替代部署后同版 Agent 的聊天、模型切换、媒体执行、托管下载与历史重开验收。
