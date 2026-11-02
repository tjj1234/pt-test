# 北极星 shell node-postgres 回滚复现

`psql` 已在事务中成功执行并回滚 `001_auth.sql`；当前 `pg` 为 8.23.1。下一步用 r4 自带的 `db-pg.cjs`、相同首个 SQL 和迁移记录 INSERT，显式抛出探测标记触发 ROLLBACK。该命令不会提交迁移；`--env-file` 只在进程内读取环境配置，不打印配置值。Shell 服务保持停止。

在服务器 SSH 终端执行第 8–10 行：

```bash
cd /opt/northstar/releases/controlled-trial-20261021-r4/shell && sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'const fs=require("node:fs");const {openPg}=require("./db-pg.cjs");(async()=>{if(!process.env.PT_PG_DSN)throw new Error("PT_PG_DSN_MISSING");const x=await openPg();try{await x.db.transaction(async tx=>{await tx.exec(fs.readFileSync("db-migrations/001_auth.sql","utf8"));await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)",["001_auth.sql"]);throw new Error("ROLLBACK_PROBE");});}catch(e){if(e.message==="ROLLBACK_PROBE")console.log("DRIVER_PROBE_OK: migration SQL and marker INSERT succeeded; transaction rolled back");else{console.error("DRIVER_PROBE_FAILED:",e.code||"no-code",e.message);process.exitCode=1;}}finally{await x.close();}})();'
sudo -u postgres psql -d northstar -c 'SELECT name, applied_at FROM schema_migrations ORDER BY name;'
sudo -u postgres psql -d northstar -c '\dt'
```

预期第 8 行输出 `DRIVER_PROBE_OK`；最后查询应仍为空迁移记录，且只有 `schema_migrations` 表。若第 8 行报错，保留错误码和文本，但检查并遮住任何可能出现的 DSN/密码。逐条执行并回传结果；不要重启 shell。
