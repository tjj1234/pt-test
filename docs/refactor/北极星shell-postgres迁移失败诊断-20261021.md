# 北极星 shell PostgreSQL 迁移失败诊断

r4 已越过模块加载，失败点在 `db.cjs` 执行第一段身份数据库迁移时，node-postgres 返回 `invalid message format`。目前还不能区分连接参数/协议和 SQL 执行问题；先停止失败 unit，读取 PostgreSQL 服务端日志与迁移状态，并复核应用账号的 TCP 登录。所有查询均为只读，不改数据库。

在服务器 SSH 终端逐条执行第 8–13 行，每条等待提示符回来：

```bash
sudo systemctl stop northstar-shell
sudo systemctl is-active northstar-shell
sudo tail -n 80 /var/log/postgresql/postgresql-16-main.log
sudo -u postgres psql -d northstar -c '\dt'
sudo -u postgres psql -d northstar -c 'SELECT name, applied_at FROM schema_migrations ORDER BY name;'
psql -h 127.0.0.1 -U northstar_app -d northstar -W -c 'SELECT current_database(), current_user;'
```

第二条应为 `inactive`；最后一条输入数据库密码时终端不会回显，不要把密码发到聊天。请贴出每条结果；若数据库日志或输出包含 DSN、密码或密钥，请先遮住。不要重启 shell、修改环境文件或手工运行迁移，等根据 PostgreSQL 服务端错误定位后再决定下一步。
