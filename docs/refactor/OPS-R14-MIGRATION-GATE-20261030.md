# r14 第4步迁移差异处理

**检查点澄清：隔离库迁移成功后，正式业务库再次查询仍为APPLIED=20、缺020–023是正常的。** 前面的命令没有迁移正式库；正式库24迁移是第5步启动r14后的检查结果，不能作为第5步启动前的条件。备份成功、隔离恢复及020–023验证均通过（隔离库24、missing_semantics=0、历史行数不变），且其余预检已通过，即可继续原执行清单第5步。不要为了使第4步变24而手工修改正式库。

运维回传：EXPECTED=24、APPLIED=20，缺020–023，EXTRA=none。这是新包新增迁移尚未应用，不是多出未知迁移；仍需在数据库备份门禁完成后切换。

| 迁移 | 实际影响 |
|---|---|
| 020 | chat_usage 新增 total_semantics，回填 legacy_unclassified，设置默认值/非空/约束；不修改历史 token 数值，但会更新既有行并可能持锁 |
| 021 | 新建价格版本表与索引 |
| 022 | 新建媒体授权及预留表 |
| 023 | 调整022新表的约束，增加释放字段、部分唯一索引、函数与触发器 |

下一步由运维/DBA执行：确认无在途任务，安排维护窗口；按目标 PostgreSQL 已有原生备份流程备份实际业务库，记录备份时间、对象范围、大小、校验和与恢复点，并验证备份可读取。优先在隔离库恢复备份、用确切r14迁移链验证020–023成功及数据保留。不得使用PGlite备份脚本替代PG备份，不回传数据库凭据或备份内容。

## 本机 PostgreSQL 备份命令

下面适用于目标PG就在该服务器、标准本机 postgres 管理账号可通过 Unix socket 登录的情况。命令先从应用同一配置读取主机/库名/端口，拒绝非本机PG，不输出密码。若拒绝、找不到客户端或peer认证失败，停止并由DBA使用实际数据库原生备份入口，不改认证配置、不把密码粘到命令行。各命令块在同一 Bash 会话执行；不要开启 `set -x`。

```bash
set -euo pipefail
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'const c=require("./db-pg.cjs").buildConfig();let h=c.host,p=c.port,d=c.database;if(c.connectionString){const u=new URL(c.connectionString);h=u.hostname;p=u.port||5432;d=decodeURIComponent(u.pathname.slice(1));if(u.searchParams.has("host")||u.searchParams.has("port")||u.searchParams.has("dbname"))throw Error("DBA_REVIEW_CONNECTION_OPTIONS");}if(!["127.0.0.1","localhost","::1","[::1]"].includes(h)||!Number.isInteger(Number(p))||Number(p)<1||Number(p)>65535||!d||!/^[A-Za-z0-9_-]+$/.test(d))throw Error("DBA_REVIEW_NONLOCAL_OR_UNUSUAL_TARGET");console.log(d+" "+p)' > /tmp/northstar-r14-backup-target.txt
read -r PT_BACKUP_DB PT_BACKUP_PORT < /tmp/northstar-r14-backup-target.txt
test -n "$PT_BACKUP_DB"
test -n "$PT_BACKUP_PORT"
sudo -u postgres pg_dump --version
sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d "$PT_BACKUP_DB" -v ON_ERROR_STOP=1 -Atc 'SELECT current_database(),current_setting('\''server_version'\'');'
PT_BACKUP_DIR="/var/backups/northstar/r14-$(date -u +%Y%m%dT%H%M%SZ)"
sudo test ! -e "$PT_BACKUP_DIR"
sudo test ! -L "$PT_BACKUP_DIR"
sudo install -d -o postgres -g postgres -m 0700 "$PT_BACKUP_DIR"
sudo -u postgres pg_dump -p "$PT_BACKUP_PORT" --dbname="$PT_BACKUP_DB" --format=custom --file="$PT_BACKUP_DIR/database.dump"
sudo -u postgres pg_restore --list "$PT_BACKUP_DIR/database.dump" > /tmp/northstar-r14-backup-list.txt
sudo test -s "$PT_BACKUP_DIR/database.dump"
sudo sha256sum "$PT_BACKUP_DIR/database.dump"
sudo stat -c '%n %s bytes %a %U:%G %y' "$PT_BACKUP_DIR/database.dump"
printf 'BACKUP_DIR=%s\n' "$PT_BACKUP_DIR"
```

`pg_dump`客户端主版本须不低于服务器主版本。备份运行时旧服务仍可运行，PG提供一致性快照；切换前须另确认无在途任务。此备份只含业务库，不含集群角色、master key和托管文件；DBA还需确认原角色及外部secrets/runtime保留，不能把单库dump称为完整灾备。

## 隔离恢复验证（不会覆盖业务库）

沿用上一块变量，在同一服务器建立唯一临时库；保留供检查，不执行删除。备份可能含敏感资料，临时库禁止对应用/外部用户开放。若业务角色为超级用户或拥有跨库能力，先由DBA选择独立验证实例，不能在共享实例运行应用。

```bash
set -euo pipefail
PT_VERIFY_DB="northstar_r14_verify_$(date -u +%Y%m%d%H%M%S)"
sudo -u postgres createdb -p "$PT_BACKUP_PORT" --template=template0 "$PT_VERIFY_DB"
sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d postgres -v ON_ERROR_STOP=1 -c "REVOKE CONNECT ON DATABASE \"$PT_VERIFY_DB\" FROM PUBLIC;"
sudo -u postgres pg_restore -p "$PT_BACKUP_PORT" --dbname="$PT_VERIFY_DB" --exit-on-error --single-transaction "$PT_BACKUP_DIR/database.dump"
sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d "$PT_VERIFY_DB" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS applied_migrations FROM schema_migrations;'
printf 'VERIFY_DATABASE=%s\n' "$PT_VERIFY_DB"
```

预期隔离库恢复成功、迁移数仍为20。不要把新server指向隔离库启动，以免触发旧Run恢复/真实外部查询。下面只在刚创建的隔离库执行迁移；再次检查库名固定前缀，绝不对业务库手工运行。

```bash
set -euo pipefail
case "$PT_VERIFY_DB" in northstar_r14_verify_[0-9]*) ;; *) exit 1 ;; esac
test "$PT_VERIFY_DB" != "$PT_BACKUP_DB"
PT_VERIFY_ROWS_BEFORE=$(sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d "$PT_VERIFY_DB" -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM chat_usage;')
for PT_VERIFY_FILE in 020_chat_usage_total_semantics.sql 021_text_price_catalogs.sql 022_controlled_media_grants.sql 023_controlled_media_reservation_release.sql; do
  sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d "$PT_VERIFY_DB" -v ON_ERROR_STOP=1 --single-transaction -f "/opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell/db-migrations/$PT_VERIFY_FILE" -c "INSERT INTO schema_migrations(name) VALUES ('$PT_VERIFY_FILE');"
done
PT_VERIFY_ROWS_AFTER=$(sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d "$PT_VERIFY_DB" -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM chat_usage;')
test "$PT_VERIFY_ROWS_BEFORE" = "$PT_VERIFY_ROWS_AFTER"
sudo -u postgres psql -X -p "$PT_BACKUP_PORT" -d "$PT_VERIFY_DB" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS applied_migrations FROM schema_migrations;' -c 'SELECT count(*) AS missing_semantics FROM chat_usage WHERE total_semantics IS NULL;'
printf 'ISOLATED_MIGRATION_PASS rows_before=%s rows_after=%s\n' "$PT_VERIFY_ROWS_BEFORE" "$PT_VERIFY_ROWS_AFTER"
```

预期24迁移、missing_semantics=0、历史用量行数不变。回传退出码、备份路径/大小/SHA、服务器/客户端版本、隔离库名和上述计数；不要回传dump、目录清单全文或用户数据。隔离迁移通过仍不代表旧版回滚业务兼容已验证；保留备份与旧release，发布负责人核对回传后再继续原清单第5步。

回传备份和隔离验证结果后再进入原执行清单第5步。当前不要手工粘贴SQL、修改schema_migrations或反复重启服务。应用启动会按文件顺序自动迁移，每个文件及其schema_migrations标记在同一事务；四个文件不是一个整体事务，失败时前面已成功的文件会保留，下一次按标记跳过。

迁移后重复原第4步查询，要求EXPECTED=24 APPLIED=24、MISSING=none、EXTRA=none，并核对r14入口与本机/公网health。若启动失败，先恢复旧unit；这只回滚代码，不回滚数据库。020有既有行更新，旧版对新增schema的兼容尚未由目标备份恢复试验确认，不能承诺只换unit即可恢复全部业务；需要恢复数据库时由DBA按确认恢复点操作，禁止自动DROP新表/列。
