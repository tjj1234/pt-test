# r28 线上部署记录
状态：TARGET_DEPLOYED_POSTCHECK_PASS；真实付费模型/媒体执行未进行。用户于本会话明确授权使用所提供SSH账号部署；认证口令未写入脚本、仓库、交付包或部署日志。

| 项目 | 证据 |
|---|---|
| 应用入口 | https://agent-fat.adorado.top |
| 精确应用归档SHA256 | e4aa5e2042b831267acc6ce7ad620b6d8ba36d8e4d5163542ba6260c78e0d501 |
| 交付ZIP SHA256 | b4ca44ebde755b08710b51632f8d0837d0a531254c33ff0fc63258f64a5771db |
| 源码提交 | 3deac76；交付提交062fe477372d54781a0b6ddfbd5375ff88cff43b |
| 旧版本/PID | controlled-trial-20261030-candidate-34-r14 / 223277 |
| 新版本/PID | controlled-trial-20261103-candidate-34-r28-draft / 302282 |
| 服务 | northstar-shell；active/running；NRestarts=0 |
| 切换健康时间 | 2026-11-03T07:10:49.273Z，即北京时间15:10:49 |
| Node/Python | v24.22.0 / 3.14.4 |
| 依赖 | 目标 npm ci、495包/31007文件生产闭包及PTY通过 |
| 源码 | 217绑定文件逐项SHA全部匹配 |
| 数据库 | 原24迁移→29；171历史Run保留；切换前有效租约0 |
| settings | current；5df264dce03602cc49b201f19e80ccf6b72e8d6d67ea29740240a79bd46fdce9 |
| profile manifest | f2abe3c5074c6319758cab1ce7ebb4c5f42e630b6a9539d78ac1d8eb6ab5fda1 |
| 媒体开关 | PT_MEDIA_GENERATION=standard3；PT_CONTROLLED_MEDIA_AUTHORIZATION=1 |
| 当前账号资格 | 7账号均fresh；Seedream T2I/I2I、Wan2.7 T2V手动标准路由通过；verificationRequired=true |
| 公网 | TLS/healthz200且PID一致；登录页已截图目视检查；app.js SHA与归档一致 |
| 认证边界 | 现有Google configured=true；未登录models/skills/memory/sources均401 |
| 浏览器已知小项 | favicon.ico请求401，非主页面加载失败 |

恢复点：`/var/backups/northstar/r28-20261103T070700Z`，root0700；PG自定义dump已实际隔离恢复；runtime/db/secrets/env归档可读取，连同旧unit校验全部OK。隔离库 `northstar_r28_verify_20261103070701` 的24→29迁移通过，保留171Run，PUBLIC CONNECT已撤销；保留供DBA检查，未下载其数据。目标配置升级事务 `.northstar-settings-upgrade-878ba53f49e8b52bc910f6f9f67de498`；旧profile备份 `.run-persistent.northstar-backup-d18eebc74563f7428fe997f93f2b7f7e`。

切换脚本包含失败时恢复旧unit和DSH home并启动旧服务的处理；本次未触发回滚，不能将“有回滚脚本”表述为“真实线上失败回滚演练已执行”。数据库不自动逆向迁移。脱敏原始日志为同目录 `northstar-r28-{stage,backup,migrate-verify,switch,catalog-audit,postcheck}.log`。公网app.js SHA256为23146dfb3657acb1a711631791605affe900371dbeaf0d2fc29bc7df31147970。

上线功能清单：[ONLINE-R28-FEATURES-20261103.md](../ONLINE-R28-FEATURES-20261103.md)。真实账号业务执行/付费生成需要与目录权限核验分开记录，未在本记录中声明完成。
