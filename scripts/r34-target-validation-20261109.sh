#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
stage=/tmp/pt-r34-validation-20261109-4782c3f
old=/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft
archive=$stage/northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft.tar.gz
plan=$stage/northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft.sources.json
baseline=$stage/northstar-controlled-trial-20261106-candidate-34-r33-questions-m1-draft.sources.json
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]] || { echo CURRENT_RELEASE_DRIFT; exit 1; }
printf '%s  %s\n' 70361b6ed893ae440650e3d7dce37058efa0633ea7f1b8f936b91026d359ee5d "$archive" 5c5bd832f120d8a9c85cdb04cd70ee191150b6ce7d6aa63c76a61ea513d1a005 "$plan" 3868bbcd04300a8a95f3c47b7748185ee665b635efab7067138613e55d60a72e "$baseline" | sha256sum -c -
mkdir -m 0700 "$stage/app"
tar -xzf "$archive" -C "$stage/app"
python3 - "$plan" "$stage/app" "$baseline" "$old" <<'PY'
import sys,json,hashlib,ast
from pathlib import Path
for plan,root in ((sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4])):
    sources=json.loads(Path(plan).read_text())['sources']; assert len(sources)==(225 if root==sys.argv[2] else 223)
    root=Path(root)
    for name,digest in sources.items():
        f=root/name
        assert f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==digest, 'SOURCE_BINDING_FAILED'
    print('SOURCE_BINDING_PASS',root.name,len(sources))
new=Path(sys.argv[2]);old=Path(sys.argv[4])
before={p.name:p.read_bytes() for p in (old/'shell/db-migrations').glob('*.sql')}
after={p.name:p.read_bytes() for p in (new/'shell/db-migrations').glob('*.sql')}
assert set(after)-set(before)=={'030_model_request_attempts.sql'} and all(after.get(k)==v for k,v in before.items()), 'MIGRATION_SCOPE_CHANGED'
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
printf 'R34_TARGET_CLEAN_INSTALL_PASS\n'
node --version
python3 --version
