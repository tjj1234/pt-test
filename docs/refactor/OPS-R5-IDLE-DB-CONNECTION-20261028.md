# r5 空闲检查：复用服务配置连接 PostgreSQL

不需要寻找或手填数据库密码，也不要cat环境文件。把northstar-r5-idle-check.cjs传至/tmp；该脚本只加载当前release的db-pg.cjs连接模块，不加载server/storage初始化器，不迁移数据库，不读取用户内容。使用一连接、只读事务、5秒SQL超时，仅返回任务状态聚合与idle布尔值。

脚本SHA256：7c14f49b09d661046031b5d1643c9a4fc64cf49260441297e8bd0911018aef2f

```bash
sha256sum /tmp/northstar-r5-idle-check.cjs
cd /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell
sudo env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --env-file=/etc/northstar/northstar.env --env-file=./northstar-limits.conf /tmp/northstar-r5-idle-check.cjs
```

env -i避免运维终端已有PT_PG变量覆盖服务环境文件。两个env-file与已确认服务unit相同，凭据只在进程内使用，不显示。脚本检测显式PG配置；未配置则PG_NOT_CONFIGURED_STOP，不偷偷连接默认库或打开PGlite目录。PG配置支持PT_PG_DSN或PT_PG_HOST/PORT/USER/PASSWORD/DATABASE等，沿用现有TLS设置，不弱化证书校验。

输出 {"backend":"postgresql","idle":true,"counts":[]} 表示此次查询没有检查范围内的活动任务，可在保持无新请求的窗口继续已获批activate。idle=false则等任务完成后重查，不取消/重提交付费任务。若输出PG_NOT_CONFIGURED_STOP、PG_CONNECTION_FAILED、IDLE_CHECK_FAILED或其他错误码，原样回传，不改数据库配置/密码或以空结果代替失败。连接失败不意味着需要重启数据库。检查只是即时快照，不能保证后续无人提交任务。

本地已核对冻结r2的openPg/pgConfigured导出及两env-file；脚本语法通过。SQL在隔离PGlite PostgreSQL引擎中验证空闲/忙碌计数及只读写入被拒，不冒称实际目标PG已连接。此新文件不修改此前5项激活校验清单，单独按上方SHA核对即可。
