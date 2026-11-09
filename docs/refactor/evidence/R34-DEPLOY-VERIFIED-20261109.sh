#!/usr/bin/env bash
# Exact R34 on agent-fat. Preserve all releases and data; no provider execution.
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo ROOT_REQUIRED; exit 1; }
exec 9>/run/lock/northstar-deploy.lock
flock -n 9 || { echo DEPLOYMENT_ALREADY_RUNNING; exit 1; }
exec 8>/run/lock/northstar-r30-deploy.lock
flock -n 8 || { echo LEGACY_DEPLOYMENT_ALREADY_RUNNING; exit 1; }
old=/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft
new=/opt/northstar/releases/controlled-trial-20261109-candidate-34-r34-auto08-m1-draft
stage=/tmp/pt-r34-validation-20261109-4782c3f
archive=$stage/northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft.tar.gz
plan=$stage/northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft.sources.json
baseline=$stage/northstar-controlled-trial-20261106-candidate-34-r33-questions-m1-draft.sources.json
unit=/etc/systemd/system/northstar-shell.service
runtime=/var/lib/northstar/runtime
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/var/backups/northstar/r34-$stamp
verify_db=northstar_r34_verify_$(date -u +%Y%m%d%H%M%S)
stopped=0
success=0
verify_sources() {
 python3 - "$1" "$2" <<'PY'
import sys,json,hashlib
from pathlib import Path
root=Path(sys.argv[2]);sources=json.loads(Path(sys.argv[1]).read_text())['sources']
assert len(sources)==(225 if 'r34-auto08' in root.name else 223), 'SOURCE_COUNT_MISMATCH'
for name,digest in sources.items():
    f=root/name
    for ancestor in [f,*f.parents]:
        if ancestor==root: break
        assert not ancestor.is_symlink(), 'SOURCE_SYMLINK_REJECTED'
    assert f.is_file() and hashlib.sha256(f.read_bytes()).hexdigest()==digest, 'SOURCE_BINDING_FAILED'
print('SOURCE_BINDING_PASS',root.name,len(sources))
PY
}
rollback() {
 code=$?
 trap - EXIT
 if [[ $success != 1 && $stopped == 1 ]]; then
  echo DEPLOYMENT_FAILED_RESTORING_R33
  systemctl stop northstar-shell || true
  if [[ -f $backup/unit.before ]]; then cp -a "$backup/unit.before" "$unit"; fi
  if [[ -f $backup/profile.before.tar ]]; then
   if [[ -e $runtime/dsh-home/profiles/run-persistent || -L $runtime/dsh-home/profiles/run-persistent ]]; then
    mv "$runtime/dsh-home/profiles/run-persistent" "$runtime/dsh-home/profiles/run-persistent.failed-r34-$stamp"
   fi
   tar -xpf "$backup/profile.before.tar" -C "$runtime/dsh-home/profiles"
  fi
  systemctl daemon-reload
  if systemctl start northstar-shell; then
   for i in $(seq 1 30); do
    if curl --max-time 5 -fsS http://127.0.0.1:8098/healthz -o "$backup/rollback-health.json" 2>/dev/null; then break; fi
    sleep 1
   done
   if systemctl is-active --quiet northstar-shell && [[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]] && curl --max-time 10 -fsS http://127.0.0.1:8098/assets/app.js -o "$backup/rollback-app.js" && cmp -s "$backup/rollback-app.js" "$old/shell/public/app.js"; then
    if python3 - "$backup/rollback-health.json" "$(systemctl show northstar-shell --property=MainPID --value)" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));assert r.get('ok') is True and r.get('pid')==int(sys.argv[2])
PY
    then echo R33_ROLLBACK_HEALTH_AND_SOURCE_PASS; else echo R33_ROLLBACK_HEALTH_FAILED_MANUAL_RECOVERY_REQUIRED; fi
   else echo R33_ROLLBACK_CHECK_FAILED_MANUAL_RECOVERY_REQUIRED; fi
  else echo R33_RESTART_FAILED_MANUAL_RECOVERY_REQUIRED; fi
 fi
 if [[ $code != 0 ]]; then echo "DEPLOYMENT_ABORTED_EXIT=$code BACKUP=$backup"; fi
 exit "$code"
}
trap rollback EXIT
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]] || { echo CURRENT_RELEASE_DRIFT; exit 1; }
systemctl is-active --quiet northstar-shell
systemctl is-active --quiet northstar-analytics
[[ ! -L $old && ! -L $new ]] || { echo RELEASE_SYMLINK_REJECTED; exit 1; }
printf '%s  %s\n' 70361b6ed893ae440650e3d7dce37058efa0633ea7f1b8f936b91026d359ee5d "$archive" 5c5bd832f120d8a9c85cdb04cd70ee191150b6ce7d6aa63c76a61ea513d1a005 "$plan" 3868bbcd04300a8a95f3c47b7748185ee665b635efab7067138613e55d60a72e "$baseline" | sha256sum -c -
verify_sources "$baseline" "$old"
required=$(du -sk /var/lib/northstar/runtime /var/lib/northstar/db /var/lib/northstar/secrets | awk '{s+=$1} END {print s*3+2097152}')
available=$(df -Pk /var/backups/northstar | awk 'NR==2 {print $4}')
(( available > required )) || { echo INSUFFICIENT_BACKUP_SPACE; exit 1; }
install -d -m 0700 "$backup"
# Verify the real, anonymous static-resource checks against R33 before a switch.
python3 - "$old/shell/public/index.html" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text();assert '/assets/app.js' in s and '/assets/styles.css' in s
PY
curl --max-time 10 -fsS http://127.0.0.1:8098/assets/app.js -o "$backup/app.before.js"
cmp "$backup/app.before.js" "$old/shell/public/app.js"
curl --max-time 20 -fsS https://agent-fat.adorado.top/assets/app.js -o "$backup/app.public.before.js"
cmp "$backup/app.public.before.js" "$old/shell/public/app.js"
curl --max-time 10 -fsS http://127.0.0.1:8098/assets/styles.css -o "$backup/styles.before.css"
cmp "$backup/styles.before.css" "$old/shell/public/styles.css"
echo R33_LOCAL_AND_PUBLIC_POSTCHECK_BASELINE_PASS
if [[ ! -e $new ]]; then
 mkdir -m 0755 "$new"
 tar -xzf "$archive" -C "$new"
 cp -a "$stage/app/shell/node_modules" "$new/shell/node_modules"
 chown -R root:root "$new"
else
 [[ -d $new && $(stat -c %U "$new") == root ]] || { echo EXISTING_RELEASE_OWNER_INVALID; exit 1; }
 echo EXISTING_RELEASE_REQUIRES_FULL_REVALIDATION
fi
verify_sources "$plan" "$new"
python3 - "$old" "$new" <<'PY'
import sys,ast
from pathlib import Path
old,new=map(Path,sys.argv[1:])
before={p.name:p.read_bytes() for p in (old/'shell/db-migrations').glob('*.sql')}
after={p.name:p.read_bytes() for p in (new/'shell/db-migrations').glob('*.sql')}
assert set(after)-set(before)=={'030_model_request_attempts.sql'} and all(after.get(k)==v for k,v in before.items()), 'MIGRATION_SCOPE_CHANGED'
assert (old/'shell/dsh-settings.yaml').read_bytes()==(new/'shell/dsh-settings.yaml').read_bytes(), 'SETTINGS_SCOPE_CHANGED'
for p in new.rglob('*.py'):
    if 'node_modules' not in p.parts: ast.parse(p.read_text(),filename=str(p))
print('ADDITIVE_MIGRATION_SETTINGS_AND_TARGET_PYTHON_PASS')
PY
(cd "$new/shell"; /usr/local/bin/node northstar-dependency-closure.cjs --check dependency-closure-manifest.json; /usr/local/bin/node --check server.cjs; /usr/local/bin/node --check public/app.js)
active=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT count(*) FROM agent_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')")
[[ $active == 0 ]] || { echo ACTIVE_RUNS_BLOCK_SWITCH; exit 1; }
cp -a "$unit" "$backup/unit.before"
stopped=1
systemctl stop northstar-shell
[[ $(systemctl is-active northstar-shell || true) == inactive ]] || { echo SERVICE_DID_NOT_STOP; exit 1; }
active=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT count(*) FROM agent_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')")
[[ $active == 0 ]] || { echo ACTIVE_RUNS_AFTER_DRAIN; exit 1; }
runuser -u postgres -- pg_dump -Fc northstar > "$backup/northstar.dump"
pg_restore --list "$backup/northstar.dump" > "$backup/dump.list"
tar --acls --xattrs -cpf "$backup/state.before.tar" -C / etc/northstar var/lib/northstar/runtime var/lib/northstar/db var/lib/northstar/secrets
if [[ -d $runtime/dsh-home/profiles/run-persistent ]]; then tar -cpf "$backup/profile.before.tar" -C "$runtime/dsh-home/profiles" run-persistent; fi
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $verify_db WITH TEMPLATE template0 CONNECTION LIMIT 0"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "REVOKE CONNECT ON DATABASE $verify_db FROM PUBLIC"
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges --dbname="$verify_db" < "$backup/northstar.dump" > "$backup/restore.private.log" 2>&1
source_counts=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT (SELECT count(*) FROM agent_runs)::text || ':' || (SELECT count(*) FROM schema_migrations)::text")
restored_counts=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d "$verify_db" -c "SELECT (SELECT count(*) FROM agent_runs)::text || ':' || (SELECT count(*) FROM schema_migrations)::text")
[[ $source_counts == "$restored_counts" ]] || { echo BACKUP_RESTORE_COUNTS_MISMATCH; exit 1; }
echo "BACKUP_RESTORE_PASS counts=$source_counts verify_db=$verify_db"
sha256sum "$backup/northstar.dump" "$backup/state.before.tar" "$backup/unit.before" > "$backup/backup.sha256"
runuser -u northstar -- /usr/local/bin/node --env-file=/etc/northstar/northstar.env - "$new" > "$backup/profile-rebuild.private.log" 2>&1 <<'NODE'
const path=require('node:path');
const root=process.argv[2],runtime=process.env.PT_RUNTIME_DIR;
if(runtime!=='/var/lib/northstar/runtime')throw Error('RUNTIME_SCOPE_MISMATCH');
const {rebuildProfile,makeProfile}=require(path.join(root,'shell/runtime/dsh-adapter.cjs'));
const home=path.join(runtime,'dsh-home'),template=path.join(root,'shell/dsh-settings.yaml'),runner=path.join(root,'shell/persistent-runner.mjs');
rebuildProfile(home,template,runner);makeProfile(home,template,runner);console.log('PROFILE_REBUILD_PASS');
NODE
echo PROFILE_REBUILD_PASS
run_migration() {
 local database=$1
 runuser -u postgres -- env PT_PG_HOST=/var/run/postgresql PT_PG_DATABASE="$database" PT_PG_USER=postgres /usr/local/bin/node - "$new" > "$backup/migration-$database.private.log" 2>&1 <<'NODE'
const root=process.argv[2],path=require('node:path'),m=require(path.join(root,'shell/db.cjs'));
(async()=>{const opened=await m.open({});try{await m.migrate(opened.db,path.join(root,'shell/db-migrations'));await m.migrate(opened.db,path.join(root,'shell/db-migrations'));}finally{await opened.close();}})().catch(()=>process.exit(1));
NODE
}
run_migration "$verify_db"
verified_counts=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d "$verify_db" -c "SELECT (SELECT count(*) FROM agent_runs)::text || ':' || (SELECT count(*) FROM schema_migrations)::text")
expected_counts="${source_counts%:*}:$(( ${source_counts##*:}+1 ))"
[[ $verified_counts == "$expected_counts" ]] || { echo ISOLATED_MIGRATION_COUNTS_MISMATCH; exit 1; }
runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d "$verify_db" -c "SELECT count(*) FROM agent_run_questions; SELECT count(*) FROM agent_question_scopes" > "$backup/question-tables.verify.txt"
echo "ISOLATED_MIGRATION_PASS counts=$verified_counts"
run_migration northstar
live_counts=$(runuser -u postgres -- psql -X -Atq -v ON_ERROR_STOP=1 -d northstar -c "SELECT (SELECT count(*) FROM agent_runs)::text || ':' || (SELECT count(*) FROM schema_migrations)::text")
[[ $live_counts == "$expected_counts" ]] || { echo LIVE_MIGRATION_COUNTS_MISMATCH; exit 1; }
echo "LIVE_ADDITIVE_MIGRATION_PASS counts=$live_counts"
python3 - "$backup/unit.before" "$unit" "$old" "$new" "$stamp" <<'PY'
from pathlib import Path
import sys,os,re
s=Path(sys.argv[1]).read_text();assert sys.argv[3] in s
s=s.replace(sys.argv[3],sys.argv[4]);s=re.sub(r'^Description=.*$', 'Description=Northstar Shell (R34 AUTO pre-dispatch M1 - 20261109, DEGRADED_PREVIEW)',s,flags=re.M)
p=Path(sys.argv[2]);tmp=p.with_suffix('.r34-'+sys.argv[5]);tmp.write_text(s);os.chmod(tmp,0o644);os.replace(tmp,p)
PY
systemd-analyze verify "$unit" > "$backup/unit-verify.private.log" 2>&1
systemctl daemon-reload
systemctl start northstar-shell
for i in $(seq 1 30); do
 if curl --max-time 5 -fsS http://127.0.0.1:8098/healthz -o "$backup/health.after.json" 2>/dev/null; then break; fi
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
curl --max-time 10 -fsS http://127.0.0.1:8098/assets/app.js -o "$backup/app.after.js"
cmp "$backup/app.after.js" "$new/shell/public/app.js"
curl --max-time 10 -fsS http://127.0.0.1:8098/assets/styles.css -o "$backup/styles.after.css"
cmp "$backup/styles.after.css" "$new/shell/public/styles.css"
curl --max-time 20 -fsS https://agent-fat.adorado.top/assets/app.js -o "$backup/app.public.after.js"
cmp "$backup/app.public.after.js" "$new/shell/public/app.js"
verify_sources "$plan" "$new"
success=1
printf 'DEPLOYED_FOR_QA\nRELEASE=%s\nBACKUP=%s\nVERIFY_DB=%s\nBUG12=DEGRADED_PREVIEW\n' "$new" "$backup" "$verify_db"
systemctl show northstar-shell --property=MainPID,WorkingDirectory,ActiveState,NRestarts --no-pager
