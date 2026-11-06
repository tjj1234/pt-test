#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
stage=/tmp/pt-r33-validation-20261106-cf780db
old=/opt/northstar/releases/controlled-trial-20261106-candidate-34-r31-batch5-draft
archive=$stage/northstar-controlled-trial-20261106-candidate-34-r33-questions-m1-draft.tar.gz
plan=$stage/northstar-controlled-trial-20261106-candidate-34-r33-questions-m1-draft.sources.json
baseline=$stage/northstar-controlled-trial-20261106-candidate-34-r31-batch5-draft.sources.json
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]] || { echo CURRENT_RELEASE_DRIFT; exit 1; }
printf '%s  %s\n' 3f0cb945646b40580666f8537d578e6f19f9907d2d2c57cbd2aca2b750a5d263 "$archive" 3868bbcd04300a8a95f3c47b7748185ee665b635efab7067138613e55d60a72e "$plan" 7a82352da1eafda5455ae7baf61695632e49e197cacfb17f054eade7d30a560d "$baseline" | sha256sum -c -
mkdir -m 0700 "$stage/app"
tar -xzf "$archive" -C "$stage/app"
python3 - "$plan" "$stage/app" "$baseline" "$old" <<'PY'
import sys,json,hashlib,ast
from pathlib import Path
for plan,root in ((sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4])):
    sources=json.loads(Path(plan).read_text())['sources']; assert len(sources)==(223 if root==sys.argv[2] else 217)
    root=Path(root)
    for name,digest in sources.items():
        f=root/name
        assert f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==digest, 'SOURCE_BINDING_FAILED'
    print('SOURCE_BINDING_PASS',root.name,len(sources))
new=Path(sys.argv[2]);old=Path(sys.argv[4])
before={p.name:p.read_bytes() for p in (old/'shell/db-migrations').glob('*.sql')}
after={p.name:p.read_bytes() for p in (new/'shell/db-migrations').glob('*.sql')}
assert set(after)-set(before)=={'029_user_questions.sql'} and all(after.get(k)==v for k,v in before.items()), 'MIGRATION_SCOPE_CHANGED'
assert (new/'shell/dsh-settings.yaml').read_bytes()==(old/'shell/dsh-settings.yaml').read_bytes(), 'SETTINGS_SCOPE_CHANGED'
for p in new.rglob('*.py'): ast.parse(p.read_text(),filename=str(p))
print('ADDITIVE_MIGRATION_SETTINGS_AND_PYTHON_SYNTAX_PASS')
PY
export PATH=/usr/local/bin:$PATH
cd "$stage/app/shell"
npm ci --include=dev --no-audit --no-fund
node northstar-dependency-closure.cjs --check dependency-closure-manifest.json
node --check server.cjs
node --check public/app.js
printf 'R33_TARGET_CLEAN_INSTALL_PASS\n'
node --version
python3 --version
