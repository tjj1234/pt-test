#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
stage=/tmp/pt-r31-validation-20261106-97a3e5a
old=/opt/northstar/releases/controlled-trial-20261105-candidate-34-r30-bugfix-draft
archive=$stage/northstar-controlled-trial-20261106-candidate-34-r31-batch5-draft.tar.gz
plan=$stage/northstar-controlled-trial-20261106-candidate-34-r31-batch5-draft.sources.json
baseline=$stage/northstar-controlled-trial-20261105-candidate-34-r30-bugfix-draft.sources.json
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]] || { echo CURRENT_RELEASE_DRIFT; exit 1; }
printf '%s  %s\n' 6addd5e342b9696f4d37ddc30bc60412b6f8ab5b735161b2e07fe38df4818955 "$archive" 7a82352da1eafda5455ae7baf61695632e49e197cacfb17f054eade7d30a560d "$plan" 3af4318fc935f72fd336103ae9c3b3619bdcb6f6b08778e45e2b6e2a32603684 "$baseline" | sha256sum -c -
mkdir -m 0700 "$stage/app"
tar -xzf "$archive" -C "$stage/app"
python3 - "$plan" "$stage/app" "$baseline" "$old" <<'PY'
import sys,json,hashlib,ast
from pathlib import Path
for plan,root in ((sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4])):
    sources=json.loads(Path(plan).read_text())['sources']; assert len(sources)==217
    root=Path(root)
    for name,digest in sources.items():
        f=root/name
        assert f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==digest, 'SOURCE_BINDING_FAILED'
    print('SOURCE_BINDING_PASS',root.name,len(sources))
new=Path(sys.argv[2]);old=Path(sys.argv[4])
assert {p.name:p.read_bytes() for p in (new/'shell/db-migrations').glob('*.sql')}=={p.name:p.read_bytes() for p in (old/'shell/db-migrations').glob('*.sql')}, 'MIGRATION_SCOPE_CHANGED'
assert (new/'shell/dsh-settings.yaml').read_bytes()==(old/'shell/dsh-settings.yaml').read_bytes(), 'SETTINGS_SCOPE_CHANGED'
for p in new.rglob('*.py'): ast.parse(p.read_text(),filename=str(p))
print('UNCHANGED_MIGRATIONS_SETTINGS_AND_PYTHON_SYNTAX_PASS')
PY
export PATH=/usr/local/bin:$PATH
cd "$stage/app/shell"
npm ci --include=dev --no-audit --no-fund
node northstar-dependency-closure.cjs --check dependency-closure-manifest.json
node --check server.cjs
node --check public/app.js
printf 'R31_TARGET_CLEAN_INSTALL_PASS\n'
node --version
python3 --version
