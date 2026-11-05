#!/usr/bin/env bash
# Authorized agent-fat bounded bugfix deployment. No provider calls or secret output.
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo ROOT_REQUIRED; exit 1; }
exec 9>/run/lock/northstar-r30-deploy.lock
flock -n 9 || { echo DEPLOYMENT_ALREADY_RUNNING; exit 1; }
old=/opt/northstar/releases/controlled-trial-20261103-candidate-34-r28-draft
new=/opt/northstar/releases/controlled-trial-20261105-candidate-34-r30-bugfix-draft
stage=/tmp/pt-r30-validation-20261105
archive=$stage/northstar-controlled-trial-20261105-candidate-34-r30-bugfix-draft.tar.gz
plan=$stage/northstar-controlled-trial-20261105-candidate-34-r30-bugfix-draft.sources.json
unit=/etc/systemd/system/northstar-shell.service
runtime=/var/lib/northstar/runtime
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/var/backups/northstar/r30-$stamp
verify_db=northstar_r30_verify_$(date -u +%Y%m%d%H%M%S)
stopped=0
switched=0
success=0
rollback() {
 code=$?
 trap - EXIT
 if [[ $success != 1 && $stopped == 1 ]]; then
  echo DEPLOYMENT_FAILED_RESTORING_OLD_SERVICE
  systemctl stop northstar-shell || true
  if [[ -f $backup/unit.before ]]; then cp -a "$backup/unit.before" "$unit"; fi
  if [[ -f $backup/profile.before.tar ]]; then
   if [[ -e $runtime/dsh-home/profiles/run-persistent || -L $runtime/dsh-home/profiles/run-persistent ]]; then
    mv "$runtime/dsh-home/profiles/run-persistent" "$runtime/dsh-home/profiles/run-persistent.failed-$stamp"
   fi
   tar -xpf "$backup/profile.before.tar" -C "$runtime/dsh-home/profiles"
  fi
  systemctl daemon-reload
  if systemctl start northstar-shell; then echo OLD_SERVICE_RESTARTED; else echo OLD_SERVICE_RESTART_FAILED_MANUAL_RECOVERY_REQUIRED; fi
 fi
 if [[ $code != 0 ]]; then echo "DEPLOYMENT_ABORTED_EXIT=$code BACKUP=$backup"; fi
 exit "$code"
}
trap rollback EXIT
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]] || { echo CURRENT_RELEASE_DRIFT; exit 1; }
systemctl is-active --quiet northstar-shell
[[ ! -L $new ]] || { echo RELEASE_SYMLINK_REJECTED; exit 1; }
echo "493ad02a9d6a2b32aea2913604a4f74032c35143c479360dcda4875fd2ba2199  $archive" | sha256sum -c -
# Compare affected baseline sources before any service change.
(cd "$old"; sha256sum -c - <<'HASHES'
7268273f49892a667e0d206cae0708de696b7e09ae4513f1381fa6857028ea45  shell/server.cjs
23146dfb3657acb1a711631791605affe900371dbeaf0d2fc29bc7df31147970  shell/public/app.js
ee22cd736a6e95294dbfc0bec48a0def339d58cbc96f20bba5de80e46d9c0626  shell/persistent-runner.mjs
6b9d330e1d1ebbfea377092f0abd64cdc0b8de48b89be906140b5c8da3bfccca  shell/tasks/store.cjs
8e060cd8f0a3ce79183c37e2b79b9b3493a3fa352f718ba26b125160314b476b  shell/agent-persona.md
HASHES
)
# Check available space against a conservative three-copy data estimate.
required=$(du -sk /var/lib/northstar/runtime /var/lib/northstar/db /var/lib/northstar/secrets | awk '{s+=$1} END {print s*3+2097152}')
available=$(df -Pk /var/backups/northstar | awk 'NR==2 {print $4}')
(( available > required )) || { echo INSUFFICIENT_BACKUP_SPACE; exit 1; }
# Install into a new root-owned release; no configuration values copied into it.
if [[ ! -e $new ]]; then
 mkdir -m 0755 "$new"
 tar -xzf "$archive" -C "$new"
 cp -a "$stage/app/shell/node_modules" "$new/shell/node_modules"
 chown -R root:root "$new"
else
 [[ -d $new && $(stat -c %U "$new") == root ]] || { echo EXISTING_RELEASE_OWNER_INVALID; exit 1; }
 echo EXISTING_RELEASE_REQUIRES_FULL_REVALIDATION
fi
python3 - "$plan" "$new" "$old" <<'PY'
import sys,json,hashlib
from pathlib import Path
plan=json.loads(Path(sys.argv[1]).read_text());new=Path(sys.argv[2]);old=Path(sys.argv[3])
for p,h in plan['sources'].items():
 f=new/p
 assert f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==h, 'SOURCE_BINDING_FAILED'
assert {p.name:p.read_bytes() for p in (new/'shell/db-migrations').glob('*.sql')}=={p.name:p.read_bytes() for p in (old/'shell/db-migrations').glob('*.sql')}, 'MIGRATION_SCOPE_CHANGED'
assert (new/'shell/dsh-settings.yaml').read_bytes()==(old/'shell/dsh-settings.yaml').read_bytes(), 'SETTINGS_SCOPE_CHANGED'
print('SOURCE_BINDING_AND_UNCHANGED_MIGRATIONS_PASS')
PY
(cd "$new/shell"; /usr/local/bin/node northstar-dependency-closure.cjs --check dependency-closure-manifest.json; /usr/local/bin/node --check server.cjs; /usr/local/bin/node --check public/app.js)
active=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT count(*) FROM agent_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')")
[[ $active == 0 ]] || { echo ACTIVE_RUNS_BLOCK_SWITCH; exit 1; }
install -d -m 0700 "$backup"
cp -a "$unit" "$backup/unit.before"
# Stop only Shell; analytics stays running. Recheck after graceful drain.
stopped=1
systemctl stop northstar-shell
[[ $(systemctl is-active northstar-shell || true) == inactive ]] || { echo SERVICE_DID_NOT_STOP; exit 1; }
active=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT count(*) FROM agent_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')")
[[ $active == 0 ]] || { echo ACTIVE_RUNS_AFTER_DRAIN; exit 1; }
# Private backups remain server-side. No database restore over the live DB.
runuser -u postgres -- pg_dump -Fc northstar > "$backup/northstar.dump"
pg_restore --list "$backup/northstar.dump" > "$backup/dump.list"
tar --acls --xattrs -cpf "$backup/state.before.tar" -C / etc/northstar var/lib/northstar/runtime var/lib/northstar/db var/lib/northstar/secrets
if [[ -d $runtime/dsh-home/profiles/run-persistent ]]; then
 tar -cpf "$backup/profile.before.tar" -C "$runtime/dsh-home/profiles" run-persistent
fi
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $verify_db WITH TEMPLATE template0 CONNECTION LIMIT 0"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "REVOKE CONNECT ON DATABASE $verify_db FROM PUBLIC"
# PostgreSQL superuser may connect at limit 0; ordinary accounts cannot.
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges --dbname="$verify_db" < "$backup/northstar.dump" > "$backup/restore.private.log" 2>&1
source_counts=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT (SELECT count(*) FROM agent_runs)::text || ':' || (SELECT count(*) FROM schema_migrations)::text")
restored_counts=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d "$verify_db" -c "SELECT (SELECT count(*) FROM agent_runs)::text || ':' || (SELECT count(*) FROM schema_migrations)::text")
[[ $source_counts == "$restored_counts" ]] || { echo BACKUP_RESTORE_COUNTS_MISMATCH; exit 1; }
echo "BACKUP_RESTORE_PASS counts=$source_counts verify_db=$verify_db"
# Retain the isolated restored DB (limit 0, PUBLIC revoked) for audit; no user data exported.
sha256sum "$backup/northstar.dump" "$backup/state.before.tar" "$backup/unit.before" > "$backup/backup.sha256"
runuser -u northstar -- /usr/local/bin/node --env-file=/etc/northstar/northstar.env - "$new" <<'NODE'
const path=require('node:path');
const root=process.argv[2],runtime=process.env.PT_RUNTIME_DIR;
if(runtime!=='/var/lib/northstar/runtime')throw Error('RUNTIME_SCOPE_MISMATCH');
const {rebuildProfile,makeProfile}=require(path.join(root,'shell/runtime/dsh-adapter.cjs'));
const home=path.join(runtime,'dsh-home'),template=path.join(root,'shell/dsh-settings.yaml'),runner=path.join(root,'shell/persistent-runner.mjs');
rebuildProfile(home,template,runner);makeProfile(home,template,runner);console.log('PROFILE_REBUILD_PASS');
NODE
python3 - "$backup/unit.before" "$unit" "$old" "$new" <<'PY'
from pathlib import Path
import sys,os
s=Path(sys.argv[1]).read_text();assert sys.argv[3] in s
s=s.replace(sys.argv[3],sys.argv[4]).replace("Scoped release r28 - 20261103","Bugfix r30 - 20261105, DEGRADED_PREVIEW");p=Path(sys.argv[2]);tmp=p.with_suffix('.r30-new');tmp.write_text(s);os.chmod(tmp,0o644);os.replace(tmp,p)
PY
systemd-analyze verify "$unit" > "$backup/unit-verify.private.log" 2>&1
systemctl daemon-reload
switched=1
systemctl start northstar-shell
for i in $(seq 1 30); do
 if curl -fsS http://127.0.0.1:8098/healthz > "$backup/health.after.json" 2>/dev/null; then break; fi
 sleep 1
done
systemctl is-active --quiet northstar-shell
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$new/shell" ]]
python3 - "$backup/health.after.json" "$(systemctl show northstar-shell --property=MainPID --value)" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));assert r.get('ok') is True and r.get('pid')==int(sys.argv[2])
PY
sleep 3
systemctl is-active --quiet northstar-shell
systemctl is-active --quiet northstar-analytics
cmp <(curl -fsS http://127.0.0.1:8098/assets/app.js) "$new/shell/public/app.js"
success=1
printf 'DEPLOYED_FOR_QA\nRELEASE=%s\nBACKUP=%s\nVERIFY_DB=%s\nBUG12=DEGRADED_PREVIEW\n' "$new" "$backup" "$verify_db"
systemctl show northstar-shell --property=MainPID,WorkingDirectory,ActiveState --no-pager
# No paid request has been made. Product/independent QA remains pending.
