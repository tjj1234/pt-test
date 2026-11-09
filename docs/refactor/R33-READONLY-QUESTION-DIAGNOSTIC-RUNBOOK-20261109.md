# R33问答故障：只读正式核验准备（2026-11-09）
结论：SSH已恢复，主程已上传并校验脚本SHA，用户在终端交互sudo执行完毕；正式现场确认northstar_app对两张postgres-owned问答表缺SELECT/INSERT/UPDATE。正式数据未修改，修复未执行；见[R33现场核验及R34修复计划](R33-LIVE-ACL-FINDING-AND-R34-REPAIR-PLAN-20261109.md)。前次认证失败是历史准备状态。它不部署、不重启、不执行迁移/GRANT、不初始化storage/auth、不请求模型或PT API，也不写业务数据；不是R34部署脚本。

## 固定产物
脚本：`scripts/northstar-r33-readonly-diagnostic.cjs`，保存在integration/r34-final-all8-20261109代码分支；handoff分支仅同步本说明及证据。SHA256：`6f751bc18e7b5a46d29583a39b15c870a4070dc5b27d20d20d221dcaf06ade21`。仅适用于已记录的R33目录 `/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell`；版本漂移则停止，不能为方便运行直接改掉绑定。
脚本先检查systemd活动状态、目录及PID，绑定R33的db-pg、question service/store及029四文件SHA，再核对真实进程cwd。root仅在内存中读取该进程的PG配置；只将必要PG字段传给按服务实际uid/gid运行的子进程，无关API Key、NODE_OPTIONS等不转发。子进程使用只读事务、5秒statement timeout及1秒lock timeout，连接角色/数据库必须与配置一致。
输出限于服务状态、非敏感角色/数据库名、表owner/有效SELECT/INSERT/UPDATE/RLS、029迁移标记和已知两个失败Run的state/revision/问答条数。不读取或输出提示词、问答内容、用户表、完整环境、DSN、密码及原始异常。结尾再次核对PID和重启计数；变化则拒绝将结果当同一服务证据。stderr只返回有界错误码。
本诊断只查R33两张问答表及旧基线表，不要求R34的030表已存在。`aclSufficient=true`仅说明当前ACL条件，不是R34放行；runtimeSuperuser=true须另行审阅，不能声称普通运行账号权限已验。权限缺失能证明现场缺口，不能单凭这一点把原Run完整RPC/模型重试链说成已复现。

## SSH恢复及正式执行记录
此前SSH认证失败且旧socket不存在；用户恢复ControlMaster后，主程直接核验服务仍R33/PID367662/重启0。脚本已排他上传至 `/tmp/pt-r33-readonly-20261109-6f751bc18e7b.cjs`，远端SHA与本文件记录一致。
非交互sudo因需要终端认证而停止；用户随后在自己的SSH终端完成认证并执行同一脚本，回执时间2026-11-09T08:54:07.205Z。无需再次恢复SSH或重跑相同诊断。完整回执与证据分层见[R33现场记录](evidence/R33-LIVE-QUESTION-ACL-DIAGNOSTIC-20261109.json)。本次没有迁移、GRANT或部署；后续授权仅按整包发布门禁中的受控计划执行。

## 已完成验证与限制
- 隔离PostgreSQL16：5组通过，运行角色/迁移存在但问答缺权、最小授权后变化、错误身份/目标/重复配置拒绝、PG字段白名单、实际stdin子进程JSON输出和零问答写入。
- Linux amd64现有Node22.23.4镜像：3组通过，完整入口读取实际/proc/cwd和实际服务uid/gid65534，四源码SHA绑定，缺权/补权识别，源码与release漂移拒绝、零问答写入。systemctl元数据用夹具替换，非真实systemd/正式Node24验收。正式入口与服务/四源/ACL现场已执行，未再次单独采集Node版本，不冒称完整生产Node24回归。
- 首次Linux依赖挂载目录名不是node_modules，Node找不到传递依赖pg-types；修正为/locked/node_modules。第二次Docker默认无跨uid的/proc读取能力；测试夹具增加SYS_PTRACE后通过（只影响隔离容器，未变更宿主或生产权限）。早期失败日志保留，不能归责应用。脚本对进程信息读取失败已提供明确R33_DIAG_PROCESS_READ_FAILED。
- macOS直接启动按预期拒绝R33_DIAG_LINUX_ROOT_REQUIRED。测试容器均清理，未留下本轮后台任务。
证据：`evidence/R33-READONLY-DIAGNOSTIC-PG-20261109.txt`、`evidence/R33-READONLY-DIAGNOSTIC-LINUX-20261109.txt`及FIRST/SECOND环境日志；指纹见`evidence/R34-MAIN-CONTINUATION-INPUTS-20261109.json`。
