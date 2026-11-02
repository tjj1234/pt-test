# r14 线上 PROFILE_STALE 修复

截图的 `Profile requires explicit rebuild` 对应受管 profile 与新包要求不一致，不能靠重复聊天修复。原部署清单遗漏了已有 profile 的离线升级步骤。下面使用**r14包内**已导出的维护API，不使用开发工作树或新图片功能代码，不删除DSH_HOME。AUTO无候选另需在profile修复后检查，不能从这张图断言Key失效。

## 1 只读确认实际版本和home

```bash
set -euo pipefail
test "$(systemctl show northstar-shell -p WorkingDirectory --value)" = /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
systemctl show northstar-shell -p ExecStart -p WorkingDirectory --no-pager
PT_PROFILE_HOME=$(sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'console.log(require("./tenant.cjs").DSH_HOME)')
printf 'PROFILE_HOME=%s\n' "$PT_PROFILE_HOME"
test "$PT_PROFILE_HOME" = /var/lib/northstar/runtime/dsh-home
sudo -u northstar test -f "$PT_PROFILE_HOME/profiles/run-persistent/northstar-profile-manifest.json"
```

路径不符就停止并回传路径和退出码，不改命令猜目录。不要回传env文件内容。

## 2 停服务、确认无同home运行进程、保留完整备份

以下在同一Bash会话接续执行。会短暂停止shell，确认已安排维护窗口且没有在途任务。

```bash
set -euo pipefail
sudo systemctl stop northstar-shell
if systemctl is-active --quiet northstar-shell; then exit 1; fi
if pgrep -u northstar -f -- 'persistent-runner|--profile run-persistent'; then
  printf 'STOP: DSH processes remain; do not rebuild.\n'
  exit 1
fi
sudo install -d -o root -g root -m 0700 /var/backups/northstar
PT_PROFILE_BACKUP="/var/backups/northstar/r14-dsh-home-before-rebuild-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sudo test ! -e "$PT_PROFILE_BACKUP"
sudo test ! -L "$PT_PROFILE_BACKUP"
sudo bash -c 'umask 077; tar -czf "$1" -C /var/lib/northstar/runtime dsh-home' -- "$PT_PROFILE_BACKUP"
sudo gzip -t "$PT_PROFILE_BACKUP"
sudo sha256sum "$PT_PROFILE_BACKUP"
sudo stat -c '%n %s bytes %a %U:%G' "$PT_PROFILE_BACKUP"
```

备份可能包含会话与私有配置，只保留在受限服务器目录，不上传/回传备份内容。进程检查发现PID、备份失败或已有中断恢复日志时停止，不强杀无关进程、不删除锁。

## 3 用r14维护API重建并校验

```bash
set -euo pipefail
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'const path=require("node:path");const api=require("./runtime/dsh-adapter.cjs");const home=require("./tenant.cjs").DSH_HOME;try{const result=api.rebuildProfile(home,path.resolve("dsh-settings.yaml"),path.resolve("persistent-runner.mjs"));console.log(JSON.stringify({ok:true,action:"rebuild",...result}));api.makeProfile(home,path.resolve("dsh-settings.yaml"),path.resolve("persistent-runner.mjs"));console.log("R14_PROFILE_VERIFY_PASS");}catch(e){console.error(JSON.stringify({ok:false,code:e.code||"PROFILE_REBUILD_FAILED"}));process.exitCode=1;}'
```

成功条件：exit0、返回`backupDir`、输出`R14_PROFILE_VERIFY_PASS`。维护器会验证旧profile自身完整性并保留旧目录及其未知文件。**若返回PROFILE_MANIFEST_INVALID/MISSING、PROFILE_RECOVERY_REQUIRED、PROFILE_LOCKED、SETTINGS相关错误等，保持停止、回传安全错误码；不要删除home/manifest/锁，不修改模板哈希，不直接用cp覆盖受管文件。** settings升级是另一条独立维护流程，不能盲目覆盖用户设置。


## 4 启动、健康与单次产品验证

```bash
set -euo pipefail
sudo systemctl start northstar-shell
sudo systemctl is-active northstar-shell
systemctl show northstar-shell -p ExecStart -p WorkingDirectory --no-pager
curl -fsS --max-time 15 http://127.0.0.1:8098/healthz
curl -fsS --max-time 15 https://agent-fat.adorado.top/healthz
```

要求active、仍是r14入口、两个health含ok:true。然后登录测试账号，**先手动选一个目录允许的文本模型**，发送一次短问答；保存该次Run终态、model_selection及text_chat_runtime_verified事件。首次手动Run成功可为同Key/版本建立AUTO资格，再切AUTO验证一次。AUTO仍无候选时回传模型资格原因和事件，不反复重发；profile错误发生在模型执行前，手动首调不能绕过profile重建。

若重建成功但服务启动失败，保留新旧profile及第2步备份并回传脱敏错误。原部署清单的unit回滚不会自动恢复profile，禁止只切旧unit就宣称回滚完成；需要回旧版时须同时恢复匹配的受管profile，另行按记录的备份路径处理，不能在运行中移动目录。

请回传：第1步版本/home，第2步备份路径/SHA/大小，第3步结果JSON（含backupDir），第4步health及单次手动Run结果。命令不修改数据库schema，也不需要重新执行020–023。
