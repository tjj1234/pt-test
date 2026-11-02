# 北极星 shell systemd 环境回滚探测

`psql` 与直接运行 r4 的 `db-pg.cjs` 均成功执行首个迁移并回滚。直接探测通过 Node `--env-file` 加载配置；正式服务由 systemd 的 `EnvironmentFile=` 加载。下面由临时 systemd unit 用同一环境文件、用户、工作目录和只读沙箱设置重复事务探测，以核对 systemd 环境解析。临时 unit 只运行探测脚本，不启动 shell 监听；事务会主动回滚。正式 `northstar-shell` 保持停止。

在服务器 SSH 终端逐条执行第 8–10 行：

```bash
sudo systemctl show northstar-shell -p User -p Group -p WorkingDirectory -p ExecStart -p EnvironmentFiles -p Restart
sudo systemd-run --wait --pipe --collect --unit=northstar-pg-rollback-probe-20261021 -p User=northstar -p Group=northstar -p WorkingDirectory=/opt/northstar/releases/controlled-trial-20261021-r4/shell -p EnvironmentFile=/etc/northstar/northstar.env -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes /usr/local/bin/node -e 'const {openPg}=require("./db-pg.cjs");(async()=>{let x;try{x=await openPg();await x.db.transaction(async t=>{await t.exec(require("node:fs").readFileSync("db-migrations/001_auth.sql","utf8"));await t.query("INSERT INTO schema_migrations(name) VALUES($1)",["001_auth.sql"]);throw Error("ROLLBACK_PROBE");});}catch(e){console.log(e.message==="ROLLBACK_PROBE"?"SYSTEMD_ENV_PROBE_OK":"SYSTEMD_ENV_PROBE_FAILED code="+(e.code||"none")+" message="+(e.message||""));}finally{if(x)await x.close();}})();'
sudo -u postgres psql -d northstar -c 'SELECT name, applied_at FROM schema_migrations ORDER BY name;'
```

第二条预期输出 `SYSTEMD_ENV_PROBE_OK`；第三条应仍为 `(0 rows)`。如果第二条报错，回传完整错误；若内容中出现任何 DSN、密码或密钥，先遮住。临时 unit 执行完即自动清理；不要启动正式 shell 服务。
