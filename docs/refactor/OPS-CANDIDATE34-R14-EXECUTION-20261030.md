# Northstar candidate34-r14 运维逐步执行清单

**发布对象仅为测试机上的 `northstar-shell.service`，状态为受控发布候选，尚未上线。** 应用归档 SHA-256 `f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993`；unit SHA-256 `ef51137bcd05ce82a5cbce366a6fc6596538d3d1378401927e43b8f9202a25d3`。每一编号单独执行、记录退出码与原始输出，满足成功条件才进入下一步。不要回传 `.env`、Key、cookie、私钥、数据库内容。失败时保持旧服务运行；切换后失败则执行第 7 步。不要删除旧 release、备份 unit 或新 release。

**0. 文件交接（运维电脑）。** 下载[执行交接 ZIP](../../release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14-handoff-r3.zip)及[外层 SHA 清单](../../release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14-handoff-r3.sha256)，放在一个空目录。先核对外层 ZIP，再解压并核对内层文件。不要从工作树重新打包。此前 `handoff-r2` 的 Linux `spawn-helper` 路径检查有误，已作废，不要执行。

```bash
set -euo pipefail
shasum -a 256 -c northstar-controlled-trial-20261030-candidate-34-r14-handoff-r3.sha256
unzip -t northstar-controlled-trial-20261030-candidate-34-r14-handoff-r3.zip
unzip -n northstar-controlled-trial-20261030-candidate-34-r14-handoff-r3.zip
shasum -a 256 -c northstar-controlled-trial-20261030-candidate-34-r14.sha256
```

成功条件：外层、内层校验全为 `OK`，且 ZIP 中只有归档、unit、JSON、内层 SHA、只读预检和本执行文档六项。若 SHA 不符，停止。

**1. 目标机只读基线。** 在目标机执行[预检清单](OPS-CANDIDATE34-R14-TARGET-PREFLIGHT-20261030.md)的全部只读命令，并补执行 `/usr/local/bin/node --version`、`sudo -u northstar -H node --version`、`sudo -u northstar -H npm --version`，回传结果。必须确认当前服务 `active`、本机与公网 health 均为 `ok:true`，当前 unit/WorkingDirectory/ExecStart 指向一个仍存在的旧 release、`/etc/northstar/northstar.env` 可读，新目录既不存在也不是悬空 symlink，架构为 `x86_64`，服务及安装使用的 Node 均至少 22.19。记录旧 unit 的 SHA 和旧 release 绝对路径，供回滚复核。Python 版本若不是已验证目标的 3.14.4，先停止并安排该解释器的包内导入验证。任一项不符，停止；不要传包或切换。

**2. 传包并复核目标字节。** 使用运维已批准的 SSH/传包入口；以下 `scp` 仅在该入口有权限时执行。服务端目标文件名固定，不覆盖既有同名文件；如果目标文件已存在，停止并核对来源。

```bash
ssh tongjiawan@47.237.22.191 'test ! -e /tmp/northstar-controlled-trial-20261030-candidate-34-r14.tar.gz && test ! -L /tmp/northstar-controlled-trial-20261030-candidate-34-r14.tar.gz && test ! -e /tmp/northstar-shell-candidate-34-r14.service && test ! -L /tmp/northstar-shell-candidate-34-r14.service'
scp northstar-controlled-trial-20261030-candidate-34-r14.tar.gz northstar-shell-candidate-34-r14.service northstar-controlled-trial-20261030-candidate-34-r14.json northstar-controlled-trial-20261030-candidate-34-r14.sha256 tongjiawan@47.237.22.191:/tmp/
```

目标机执行：

```bash
set -euo pipefail
cd /tmp
sha256sum -c northstar-controlled-trial-20261030-candidate-34-r14.sha256
gzip -t northstar-controlled-trial-20261030-candidate-34-r14.tar.gz
test "$(tar -tzf northstar-controlled-trial-20261030-candidate-34-r14.tar.gz | wc -l)" -eq 385
test "$(tar -tzf northstar-controlled-trial-20261030-candidate-34-r14.tar.gz | grep -Ec '^shell/db-migrations/[0-9].*\.sql$')" -eq 24
```

成功条件：三项 SHA 均 `OK`，385 个归档成员、24 个 shell SQL migration。归档已在本地独立审计 USTAR 路径/相对导入/禁用文件；目标 SHA 不符时不解包。

**3. 安装到新目录，旧服务保持运行。** 只切换 shell；归档中的 analytics/attribution 为快照，不执行其安装或修改其服务。`npm ci` 会运行锁定依赖的安装脚本，必须由 `northstar` 低权限用户执行；安装成功后校验生产闭包，并在 Linux 上实际启动一次无害 PTY 测试。

```bash
set -euo pipefail
sudo test ! -e /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14
sudo test ! -L /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14
sudo mkdir -m 0755 /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14
sudo tar -xzf /tmp/northstar-controlled-trial-20261030-candidate-34-r14.tar.gz -C /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14
sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14
sudo chown northstar:northstar /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar -H npm ci --no-audit --no-fund
sudo -u northstar /usr/local/bin/node northstar-dependency-closure.cjs --check dependency-closure-manifest.json
sudo -u northstar /usr/local/bin/node -e 'const p=require("node-pty");let got=false;const x=p.spawn("/bin/sh",["-c","printf PTY_OK"],{cols:80,rows:24});x.onData(d=>{if(d.includes("PTY_OK"))got=true});x.onExit(e=>{if(e.exitCode===0&&got)console.log("PTY_RUNTIME_PASS");else process.exitCode=1});setTimeout(()=>{if(!got)process.exit(1)},5000).unref()'
sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo /usr/local/bin/node --check /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell/server.cjs
sudo systemd-analyze verify /tmp/northstar-shell-candidate-34-r14.service
```

成功条件：安装 exit 0；闭包 472 生产包、30,091 文件；PTY 输出 `PTY_RUNTIME_PASS`；server 语法和 unit 校验通过。该 PTY 检查和闭包已在 Linux/amd64 Node v22.23.4 的确切归档上通过。若安装失败，保持旧服务，不改用 `npm install` 或覆盖 lockfile；回传脱敏错误。

**4. 数据库迁移与备份门禁。** 新归档有 24 个 shell migration，旧服务可能少于 24。运维/DBA 须先从当前配置读取目标 PostgreSQL 的 `schema_migrations` 名称并与新目录 `shell/db-migrations/*.sql` 比较，仅回传 `EXPECTED`、`APPLIED`、`MISSING`、`EXTRA`。可在新目录、以 `northstar` 用户运行以下只读查询（`openPg` 只连接并执行 `SELECT`）：

```bash
set -euo pipefail
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'const fs=require("node:fs");const {openPg}=require("./db-pg.cjs");(async()=>{let x;try{x=await openPg();const expected=fs.readdirSync("./db-migrations").filter(n=>!n.startsWith("._")&&n.endsWith(".sql")).sort();const rows=await x.db.query("SELECT name FROM schema_migrations ORDER BY name");const applied=rows.rows.map(r=>r.name).sort();const missing=expected.filter(n=>!applied.includes(n));const extra=applied.filter(n=>!expected.includes(n));console.log("EXPECTED="+expected.length+" APPLIED="+applied.length);console.log("MISSING="+(missing.join(",")||"none"));console.log("EXTRA="+(extra.join(",")||"none"));if(expected.length!==24||extra.length)process.exitCode=1;}catch(e){console.error("MIGRATION_PREFLIGHT_FAILED code="+(e.code||"unknown"));process.exitCode=1;}finally{if(x)await x.close();}})()'
```

若 `MISSING` 非 `none`，**暂停切换并回传**：这表示首次启动会写入 PostgreSQL schema。必须先由 DBA 按目标机现有 PostgreSQL 原生流程完成一致性备份、验证备份可读取并记录恢复点；发布负责人审核缺失迁移和旧版回滚兼容性后，才可继续第 5 步。`scripts/northstar-data-backup.cjs` 只支持离线 PGlite，不能用作 PostgreSQL 备份。若 `EXTRA` 非 `none` 或查询失败，停止并调查，不切换。若 `MISSING=none`，仍需记录当前数据库备份/恢复点；服务切换回滚不自动撤销已经应用的 schema 迁移。

**5. 备份旧 unit 后切换。** 仅在前四步通过、迁移门禁已处理、旧 release 完整存在时执行。备份路径必须不存在且不覆盖；记录备份 SHA，并与第 1 步的旧 unit SHA 比对。

```bash
set -euo pipefail
sudo test ! -e /etc/systemd/system/northstar-shell.service.candidate-34-r14-backup
sudo test ! -L /etc/systemd/system/northstar-shell.service.candidate-34-r14-backup
sudo cp -a /etc/systemd/system/northstar-shell.service /etc/systemd/system/northstar-shell.service.candidate-34-r14-backup
sudo sha256sum /etc/systemd/system/northstar-shell.service.candidate-34-r14-backup
sudo install -o root -g root -m 0644 /tmp/northstar-shell-candidate-34-r14.service /etc/systemd/system/northstar-shell.service
sudo systemctl daemon-reload
sudo systemctl restart northstar-shell
sudo systemctl is-active northstar-shell
sudo systemctl show northstar-shell -p ExecStart -p WorkingDirectory -p FragmentPath --no-pager
curl -fsS --max-time 15 http://127.0.0.1:8098/healthz
curl -fsS --max-time 15 https://agent-fat.adorado.top/healthz
```

成功条件：备份 SHA 与旧 unit 一致；新 `ExecStart`/`WorkingDirectory` 精确指向 r14；服务 `active`；两个 health 均返回 `ok:true`。任何失败立即执行第 7 步，且不要发起真实模型/媒体请求。公网 health 与版本号本身不足以证明 r14 生效，必须核对 systemd 实际入口。

**6. 发布后验收与回传。** 运维回传第 0–5 步每步成功/失败、命令退出码和脱敏原始输出，以及新 unit SHA、旧 unit 备份 SHA、数据库迁移前后数量、DB 备份/恢复点标识、服务启动时间、当前 `ExecStart`、本机/公网 health。发布负责人随后在**同一线上版本**核验登录态普通聊天、模型切换、四媒体路由（按已授权次数与 Key 余额）、托管下载与历史重开；未取得这些证据前只称“服务已切换且健康”，不称一期或 F1/F2/F3 完成。

**7. 回滚（第 5 步之后任一健康检查失败时立即执行）。** 只恢复旧 unit；旧 release 必须保留。数据库若已应用新 migration，不得自动执行逆向 SQL 或恢复 PG 备份，须由 DBA 根据恢复点另行处理。回滚后核对旧 `ExecStart` 与第 1 步相同，两个 health 均为 `ok:true`；任一失败视为未恢复，回传脱敏错误并继续运维排查。

```bash
set -euo pipefail
sudo test -s /etc/systemd/system/northstar-shell.service.candidate-34-r14-backup
sudo cp -a /etc/systemd/system/northstar-shell.service.candidate-34-r14-backup /etc/systemd/system/northstar-shell.service
sudo systemctl daemon-reload
sudo systemctl restart northstar-shell
sudo systemctl is-active northstar-shell
sudo systemctl show northstar-shell -p ExecStart -p WorkingDirectory -p FragmentPath --no-pager
curl -fsS --max-time 15 http://127.0.0.1:8098/healthz
curl -fsS --max-time 15 https://agent-fat.adorado.top/healthz
```
