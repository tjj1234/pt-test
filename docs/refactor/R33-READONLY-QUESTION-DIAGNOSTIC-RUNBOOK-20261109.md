# R33问答故障：只读正式核验准备（2026-11-09）
结论：诊断脚本已完成隔离PG及Linux入口验证，尚未在正式环境执行。现有SSH认证失败、旧ControlMaster socket不存在，需要用户恢复登录后才能继续。它不部署、不重启、不执行迁移/GRANT、不初始化storage/auth、不请求模型或PT API，也不写业务数据；不是R34部署脚本。

## 固定产物
脚本：`scripts/northstar-r33-readonly-diagnostic.cjs`，保存在integration/r34-final-all8-20261109代码分支；handoff分支仅同步本说明及证据。SHA256：`6f751bc18e7b5a46d29583a39b15c870a4070dc5b27d20d20d221dcaf06ade21`。仅适用于已记录的R33目录 `/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell`；版本漂移则停止，不能为方便运行直接改掉绑定。
脚本先检查systemd活动状态、目录及PID，绑定R33的db-pg、question service/store及029四文件SHA，再核对真实进程cwd。root仅在内存中读取该进程的PG配置；只将必要PG字段传给按服务实际uid/gid运行的子进程，无关API Key、NODE_OPTIONS等不转发。子进程使用只读事务、5秒statement timeout及1秒lock timeout，连接角色/数据库必须与配置一致。
输出限于服务状态、非敏感角色/数据库名、表owner/有效SELECT/INSERT/UPDATE/RLS、029迁移标记和已知两个失败Run的state/revision/问答条数。不读取或输出提示词、问答内容、用户表、完整环境、DSN、密码及原始异常。结尾再次核对PID和重启计数；变化则拒绝将结果当同一服务证据。stderr只返回有界错误码。
本诊断只查R33两张问答表及旧基线表，不要求R34的030表已存在。`aclSufficient=true`仅说明当前ACL条件，不是R34放行；runtimeSuperuser=true须另行审阅，不能声称普通运行账号权限已验。权限缺失能证明现场缺口，不能单凭这一点把原Run完整RPC/模型重试链说成已复现。

## 运行准备与用户协助
当前只读SSH尝试在完成网络授权后返回Permission denied (publickey,password)，未执行任何远端命令；旧socket已不存在。用户可在本机终端恢复复用连接：
```sh
ssh -M -S /private/tmp/pt-ops-20261105.sock -o ControlPersist=30m tongjiawan@47.237.22.191
```
在用户自己的终端完成登录，保持窗口开启后通知主程；不要发送密码、Token或环境文件。该步骤只恢复访问，不执行部署。
恢复后由主程先重新只读核对服务，再将本脚本放入独立临时路径并比对上述SHA。若需要交互sudo，主程在远端文件已就绪、SHA已复核后再给出精确命令，用户批准的是这一份只读脚本；本轮未上传，当前不要执行任何旧部署脚本。诊断结果再决定是否确有权限问题；本轮脚本本身不会自动修复。

## 已完成验证与限制
- 隔离PostgreSQL16：5组通过，运行角色/迁移存在但问答缺权、最小授权后变化、错误身份/目标/重复配置拒绝、PG字段白名单、实际stdin子进程JSON输出和零问答写入。
- Linux amd64现有Node22.23.4镜像：3组通过，完整入口读取实际/proc/cwd和实际服务uid/gid65534，四源码SHA绑定，缺权/补权识别，源码与release漂移拒绝、零问答写入。systemctl元数据用夹具替换，非真实systemd/正式Node24验收。生产Node版本和服务现场仍待实际执行。
- 首次Linux依赖挂载目录名不是node_modules，Node找不到传递依赖pg-types；修正为/locked/node_modules。第二次Docker默认无跨uid的/proc读取能力；测试夹具增加SYS_PTRACE后通过（只影响隔离容器，未变更宿主或生产权限）。早期失败日志保留，不能归责应用。脚本对进程信息读取失败已提供明确R33_DIAG_PROCESS_READ_FAILED。
- macOS直接启动按预期拒绝R33_DIAG_LINUX_ROOT_REQUIRED。测试容器均清理，未留下本轮后台任务。
证据：`evidence/R33-READONLY-DIAGNOSTIC-PG-20261109.txt`、`evidence/R33-READONLY-DIAGNOSTIC-LINUX-20261109.txt`及FIRST/SECOND环境日志；指纹见`evidence/R34-MAIN-CONTINUATION-INPUTS-20261109.json`。
