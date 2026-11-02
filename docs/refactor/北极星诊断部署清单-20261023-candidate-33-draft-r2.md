# 北极星模型目录故障诊断清单（candidate-33 draft r2）

**本轮已获授权按此清单执行。** 目标是在 candidate-32 的内部目录异常处记录安全错误类别，并通过已登录 `/api/models` 读取该诊断码。此清单不执行 `/api/chat`、不选模型、不发起生成请求；由维护者逐步执行，每步单独回传输出，只在成功条件满足后进入下一步。授权范围仅限本清单中的诊断部署与回滚。

## 固定输入与门槛

| 文件 | SHA-256 |
|---|---|
| [`northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz`](../../release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz) | `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77` |
| [`northstar-shell-candidate-33-draft-r2.service`](../../release-artifacts/northstar-shell-candidate-33-draft-r2.service) | `eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105` |

候选从冻结 candidate-32 生成，325 个 USTAR 成员：5 个源文件覆盖、2 个 T16 closure 文件新增；无数据库 migration 改动。目标必须为 Linux/amd64、Node.js >=22.19.0。候选版本目录固定为 `/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2`。

## 执行门

只有在维护者确认当前 `/etc/systemd/system/northstar-shell.service`、旧版本目录和回滚 unit 均可读取后才能继续。任一 checksum、平台、Node、依赖闭包、现有 health 或 unit 路径检查失败，停止且不切换。不得覆盖已有的候选版本目录或备份文件。部署前保存当前 unit 到 `/etc/systemd/system/northstar-shell.service.candidate-32-backup`；若该路径已存在，停止并报告，不覆盖。

## 1. 本地校验并上传

在维护者电脑把两个文件放入 `~/Downloads/northstar-candidate-33-r2/` 后执行：

```bash
set -euo pipefail
cd "$HOME/Downloads/northstar-candidate-33-r2"
printf 'bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77  northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz\needa8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105  northstar-shell-candidate-33-draft-r2.service\n' | shasum -a 256 -c -
scp -P 22 northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz tongjiawan@47.237.22.191:/tmp/northstar-release-candidate-33-draft-r2.tar.gz
scp -P 22 northstar-shell-candidate-33-draft-r2.service tongjiawan@47.237.22.191:/tmp/northstar-shell-candidate-33-draft-r2.service
```

## 2. 目标机预检与暂存

SSH 登录测试机后，确认平台、Node、归档与当前服务基线。任一输出不符即停止：

```bash
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
/usr/local/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19)){console.error("NODE_VERSION_UNSUPPORTED");process.exit(1)}console.log("NODE="+process.version)'
printf 'bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77  /tmp/northstar-release-candidate-33-draft-r2.tar.gz\needa8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105  /tmp/northstar-shell-candidate-33-draft-r2.service\n' | sha256sum -c -
gzip -t /tmp/northstar-release-candidate-33-draft-r2.tar.gz
tar -tzf /tmp/northstar-release-candidate-33-draft-r2.tar.gz > /tmp/northstar-candidate-33-draft-r2-files.txt
awk '{members++} /(^|\/)(\.env($|\.)|secrets\/|node_modules\/|\.git\/)/ {forbidden++} /(^|\/)\._/ || /(^|\/)__MACOSX(\/|$)/ {apple++} /^shell\/db-migrations\/[0-9][0-9][0-9][^[:space:]]*\.sql$/ {migrations++} END {printf "MEMBERS=%d MIGRATIONS=%d FORBIDDEN=%d APPLEDOUBLE=%d\n",members,migrations,forbidden,apple; if(members!=325||migrations!=20||forbidden!=0||apple!=0) exit 1}' /tmp/northstar-candidate-33-draft-r2-files.txt
test ! -e /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2
sudo systemctl is-active --quiet northstar-shell
sudo test -r /etc/systemd/system/northstar-shell.service
sudo test -r /etc/northstar/northstar.env
sudo systemctl show northstar-shell --property=FragmentPath --property=ExecStart --property=EnvironmentFiles
sudo systemctl cat northstar-shell | grep -F '/opt/northstar/releases/controlled-trial-20261022-candidate-32/shell/server.cjs'
sudo test -f /opt/northstar/releases/controlled-trial-20261022-candidate-32/shell/server.cjs
curl --connect-timeout 5 --max-time 15 -fsS http://127.0.0.1:8098/healthz
curl --connect-timeout 5 --max-time 15 -fsS https://agent-fat.adorado.top/healthz
```

确认当前 unit 仍指向 candidate-32，两个 health 都含 `"ok":true` 后，解压并安装锁定依赖。不要以 root 执行 `npm ci`，不要加 `--ignore-scripts`：

```bash
set -euo pipefail
sudo install -d -o root -g root -m 0755 /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2
sudo tar -xzf /tmp/northstar-release-candidate-33-draft-r2.tar.gz -C /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2
sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2
cd /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell
sudo chown northstar:northstar /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell
sudo -u northstar -H npm ci --no-audit --no-fund
sudo test -n "$(sudo -u northstar find /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell/node_modules -type f -name spawn-helper -perm -u+x -print -quit)"
sudo -u northstar -H /usr/local/bin/node northstar-dependency-closure.cjs --check dependency-closure-manifest.json
sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell
printf 'eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105  /tmp/northstar-shell-candidate-33-draft-r2.service\n' | sha256sum -c -
sudo systemd-analyze verify /tmp/northstar-shell-candidate-33-draft-r2.service
grep -Fx 'WorkingDirectory=/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell' /tmp/northstar-shell-candidate-33-draft-r2.service
grep -Fx 'EnvironmentFile=/etc/northstar/northstar.env' /tmp/northstar-shell-candidate-33-draft-r2.service
grep -Fx 'EnvironmentFile=/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell/northstar-limits.conf' /tmp/northstar-shell-candidate-33-draft-r2.service
grep -Fx 'ExecStart=/usr/local/bin/node /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell/server.cjs' /tmp/northstar-shell-candidate-33-draft-r2.service
sudo test ! -e /etc/systemd/system/northstar-shell.service.candidate-32-backup
sudo cp -a /etc/systemd/system/northstar-shell.service /etc/systemd/system/northstar-shell.service.candidate-32-backup
```

若依赖安装、spawn-helper 权限或 closure 检查失败，在停止后将 shell 目录所有权恢复为 `root:root`，回传脱敏错误；不替换 service、不重启。

closure 输出必须为 `result=PASS`、`target.platform=linux`、`target.arch=x64`、`packageCount=472`、`fileCount=30091`，并与包内 lock SHA 绑定。然后对 unit 执行 `sha256sum -c` 和 `sudo systemd-analyze verify`，逐项核对 `WorkingDirectory`、`ExecStart`、候选 `northstar-limits.conf` 与外部 `/etc/northstar/northstar.env` 四条路径。确认备份路径不存在且标准 unit/environment 可读后，备份当前 unit；不得复制或打印环境文件内容。

## 3. 切换、诊断与回滚

只有前述步骤全部通过且 unit 备份成功后才切换。切换命令必须作为一个独立步骤运行并单独回传输出；其中 `install`、`daemon-reload`、`restart` 或 `is-active` 任一失败，都要立即执行下方回滚块并回传结果，不得继续 health 或诊断步骤。若回滚块任一命令失败，停止并报告，不得尝试 `/api/models`。

```bash
set -euo pipefail
sudo install -o root -g root -m 0644 /tmp/northstar-shell-candidate-33-draft-r2.service /etc/systemd/system/northstar-shell.service
sudo systemctl daemon-reload
sudo systemctl restart northstar-shell
sudo systemctl is-active northstar-shell
```

切换块成功并回传后，再单独执行以下 health 检查。任一 health 不通过时立即执行下方回滚块并回传结果：

```bash
set -euo pipefail
check_health() { curl --connect-timeout 5 --max-time 15 -fsS "$1" | /usr/local/bin/node -e 'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>d+=x);process.stdin.on("end",()=>{try{if(JSON.parse(d).ok!==true)throw new Error();console.log("HEALTH_OK=true")}catch{console.error("HEALTH_NOT_OK");process.exit(1)}})' ; }
check_health http://127.0.0.1:8098/healthz
check_health https://agent-fat.adorado.top/healthz
```

任一 health 不通过时立即执行下方回滚块并回传结果：

```bash
set -euo pipefail
sudo cp -a /etc/systemd/system/northstar-shell.service.candidate-32-backup /etc/systemd/system/northstar-shell.service
sudo systemctl daemon-reload
sudo systemctl restart northstar-shell
sudo systemctl is-active northstar-shell
check_health() { curl --connect-timeout 5 --max-time 15 -fsS "$1" | /usr/local/bin/node -e 'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>d+=x);process.stdin.on("end",()=>{try{if(JSON.parse(d).ok!==true)throw new Error();console.log("HEALTH_OK=true")}catch{console.error("HEALTH_NOT_OK");process.exit(1)}})' ; }
check_health http://127.0.0.1:8098/healthz
check_health https://agent-fat.adorado.top/healthz
```

回滚后仍不 active 或 health 不通过时，停止操作并报告；不要发聊天请求，也不要删除 candidate-32 目录或 unit 备份。

health 通过后，只在已登录浏览器 GET `https://agent-fat.adorado.top/api/models`。回传 HTTP 状态、`catalogDiagnostics.state`、`catalogDiagnostics.errorCode`、`syncedAt`、`syncError`、`models.length`。不得回传 Key、Cookie、请求头或整个响应。错误码可区分常见内部异常类型/系统错误类别；若为 `MODEL_CATALOG_INTERNAL_ERROR`，仅能说明异常类型不在安全映射表内，需维护者按该固定事件码结合目标运行状态继续排查。无论诊断结果如何，本步骤都不调用模型。
