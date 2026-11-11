#!/usr/bin/env python3
"""Task-scoped R34 transport/readonly validation; no production deployment."""
import hashlib,shlex,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
STAGE='/home/tongjiawan/pt-r34-stage-37930c7'
NAME='northstar-controlled-trial-20261110-r34-all8-a3f39f5'
SSH=['ssh','-S','/private/tmp/pt-ops-20261105.sock','-o','BatchMode=yes','-o','ConnectTimeout=8','tongjiawan@47.237.22.191']
def remote(code,timeout=60):return subprocess.run(SSH+[code],check=True,timeout=timeout)
mode=sys.argv[1] if len(sys.argv)==2 else ''
if mode in ('seed','transfer','preflight','fingerprints'):raise SystemExit('SUPERSEDED_CANDIDATE_ACTION_DISABLED')
if mode=='seed':
 old=STAGE+'/northstar-controlled-trial-20261110-r34-all8-37930c7.tar.gz';new=STAGE+'/'+NAME+'.tar.gz'
 remote('set -eu; printf "%s  %s\\n" 831c689b87d09af2fe848a5cd5fc93cea9d2e544b2ca42687473afce9061bd6a '+shlex.quote(old)+' | sha256sum -c -; if test ! -e '+shlex.quote(new)+'; then cp -p '+shlex.quote(old)+' '+shlex.quote(new)+'; fi')
elif mode=='transfer':
 files=[ROOT/'release-artifacts'/NAME/(NAME+suffix) for suffix in ['.tar.gz','.sources.json','.sha256']]
 files += [ROOT/p for p in ['scripts/r34-target-preflight-20261111.sh','scripts/r34-runtime-maintenance-20261111.cjs','docs/refactor/evidence/R34-DEPLOY-VERIFIED-20261111.sh']]
 subprocess.run(['rsync','-rt','--partial','-e','ssh -S /private/tmp/pt-ops-20261105.sock -o BatchMode=yes',*map(str,files),'tongjiawan@47.237.22.191:'+STAGE+'/'],check=True,timeout=240)
elif mode=='disable-stale-deploy':
 digest=hashlib.sha256((ROOT/'docs/refactor/evidence/R34-DEPLOY-VERIFIED-20261111.sh').read_bytes()).hexdigest()
 remote('set -eu; cd '+STAGE+'; printf "%s  %s\\n" '+digest+' R34-DEPLOY-VERIFIED-20261111.sh | sha256sum -c -; test ! -e R34-DEPLOY-BEFORE-LEGACY-ZIP.disabled; mv R34-DEPLOY-VERIFIED-20261111.sh R34-DEPLOY-BEFORE-LEGACY-ZIP.disabled; printf "#!/bin/sh\\necho R34_SCOPE_PENDING_LEGACY_ZIP_DO_NOT_DEPLOY\\nexit 1\\n" > R34-DEPLOY-VERIFIED-20261111.sh')
elif mode=='final-prepare':
 folder=STAGE+'/assembled-1586f76'
 files=[ROOT/'docs/refactor/evidence/R34-DEPLOY-FINAL-VERIFIED-20261111.sh',ROOT/'scripts/r34-target-final-preflight-20261111.sh',ROOT/'scripts/r34-runtime-maintenance-20261111.cjs']
 subprocess.run(['scp','-o','ControlPath=/private/tmp/pt-ops-20261105.sock',*map(str,files),'tongjiawan@47.237.22.191:'+folder+'/'],check=True,timeout=30)
 remote('set -eu; for file in r34-target-linux-node-modules-20261111.tar.gz northstar-controlled-trial-20261106-candidate-34-r33-questions-m1-draft.sources.json jfk.wav ocr-proof.png; do test ! -e '+folder+'/$file; cp -p '+STAGE+'/$file '+folder+'/; done; bash '+folder+'/r34-target-final-preflight-20261111.sh',timeout=150)
elif mode=='final-script-upload':
 subprocess.run(['scp','-o','ControlPath=/private/tmp/pt-ops-20261105.sock',str(ROOT/'docs/refactor/evidence/R34-DEPLOY-FINAL-VERIFIED-20261111.sh'),'tongjiawan@47.237.22.191:'+STAGE+'/assembled-1586f76/'],check=True,timeout=30)
elif mode=='profile-upgrade-fixture':
 remote("set -eu; umask 077; node - <<'NODE'\nconst fs=require('node:fs'),path=require('node:path');const base='/home/tongjiawan/pt-r34-stage-37930c7';const home=fs.mkdtempSync(base+'/profile-upgrade-fixture-');const old='/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft',next='/opt/northstar/releases/controlled-trial-20261111-r34-all8-1586f76-target';try{require(old+'/shell/runtime/dsh-adapter.cjs').makeProfile(home,old+'/shell/dsh-settings.yaml',old+'/shell/persistent-runner.mjs');const adapter=require(next+'/shell/runtime/dsh-adapter.cjs');adapter.rebuildProfile(home,next+'/shell/dsh-settings.yaml',next+'/shell/persistent-runner.mjs');adapter.makeProfile(home,next+'/shell/dsh-settings.yaml',next+'/shell/persistent-runner.mjs');console.log('R33_TO_R34_PROFILE_FIXTURE_PASS');}catch(e){console.log('PROFILE_FIXTURE_FAILED',e.code||e.name,String(e.message).slice(0,300));process.exitCode=1;}\nNODE",timeout=25)
elif mode=='final-fingerprints':
 remote('sha256sum '+STAGE+'/assembled-1586f76/R34-DEPLOY-FINAL-VERIFIED-20261111.sh '+STAGE+'/assembled-1586f76/r34-runtime-maintenance-20261111.cjs; systemctl show northstar-shell --property=ActiveState,MainPID,NRestarts,WorkingDirectory --no-pager')
elif mode=='assemble-upload':
 plan=ROOT/'release-artifacts/northstar-controlled-trial-20261110-r34-all8-1586f76/northstar-controlled-trial-20261110-r34-all8-1586f76.sources.json'
 files=[plan,ROOT/'.release-inputs/r34-final-overlay-1586f76.tar.gz',ROOT/'scripts/assemble-r34-target-20261111.py']
 subprocess.run(['scp','-o','ControlPath=/private/tmp/pt-ops-20261105.sock',*map(str,files),'tongjiawan@47.237.22.191:'+STAGE+'/'],check=True,timeout=90)
elif mode=='assemble':
 plan=ROOT/'release-artifacts/northstar-controlled-trial-20261110-r34-all8-1586f76/northstar-controlled-trial-20261110-r34-all8-1586f76.sources.json';overlay=ROOT/'.release-inputs/r34-final-overlay-1586f76.tar.gz'
 sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
 remote('python3 '+STAGE+'/assemble-r34-target-20261111.py '+plan.name+' '+overlay.name+' '+sha(plan)+' '+sha(overlay),timeout=150)
elif mode=='download-final-plan':
 name='northstar-controlled-trial-20261111-r34-all8-1586f76-target'
 subprocess.run(['scp','-o','ControlPath=/private/tmp/pt-ops-20261105.sock','tongjiawan@47.237.22.191:'+STAGE+'/assembled-1586f76/'+name+'.sources.json',str(ROOT/'.release-inputs'/('FINAL-'+name+'.sources.json'))],check=True,timeout=30)
elif mode=='legacy-upload':
 subprocess.run(['scp','-o','ControlPath=/private/tmp/pt-ops-20261105.sock',str(ROOT/'.release-inputs/r34-legacy-proof-inputs.tar.gz'),'tongjiawan@47.237.22.191:'+STAGE+'/'],check=True,timeout=180)
elif mode=='legacy-http-upload':
 files=[ROOT/'tests/regression'/name for name in ['office-http-sdk-integration-test.mjs','office-document-parser-test.mjs','pdf-document-lifecycle-test.mjs']]
 files.append(ROOT/'tests/helpers/office-structured-fixtures.cjs')
 subprocess.run(['scp','-o','ControlPath=/private/tmp/pt-ops-20261105.sock',*map(str,files),'tongjiawan@47.237.22.191:'+STAGE+'/'],check=True,timeout=90)
elif mode=='stop-own-http-fixture':
 remote('python3 -c '+shlex.quote("import os,pathlib,signal,select\nroot='/home/tongjiawan/pt-r34-stage-37930c7';found=[]\nfor p in pathlib.Path('/proc').iterdir():\n if not p.name.isdigit():continue\n try:\n  if p.stat().st_uid!=os.getuid():continue\n  args=(p/'cmdline').read_bytes().split(b'\\0');exe=pathlib.Path(args[0].decode()).name\n  match=exe=='node' and (any(x.endswith(b'/tests/regression/office-http-sdk-integration-test.mjs') or x==b'tests/regression/office-http-sdk-integration-test.mjs' for x in args) or any(x.startswith((root+'/legacy-proof-tmp/office-http-sdk-').encode()) for x in args))\n  if match:\n   fd=os.pidfd_open(int(p.name));signal.pidfd_send_signal(fd,signal.SIGTERM);found.append((int(p.name),fd))\n except (FileNotFoundError,PermissionError,ProcessLookupError):pass\nfor pid,fd in found:\n poll=select.poll();poll.register(fd,select.POLLIN)\n if not poll.poll(1500):signal.pidfd_send_signal(fd,signal.SIGKILL)\n os.close(fd)\nprint('OWN_FIXTURE_PROCESSES_STOPPED',len(found))\n"),timeout=15)
elif mode=='legacy-http-only':
 remote('set -eu; umask 077; cd '+STAGE+'; cp office-http-sdk-integration-test.mjs legacy-proof-app/tests/regression/; mkdir -p legacy-proof-app/tests/helpers; cp office-structured-fixtures.cjs legacy-proof-app/tests/helpers/; cd legacy-proof-app; TMPDIR='+STAGE+'/legacy-proof-tmp PT_MEDIA_PROCESSING_DIR='+STAGE+'/legacy-proof-tmp PT_NATIVE_MEDIA_RUNTIME='+STAGE+'/legacy-proof-app/shell/media/vendor-runtime R34_FIXTURE_TRACE=1 R34_LEGACY_PROOF_ROOT='+STAGE+'/legacy-proof-app/tests/fixtures/legacy-r34 node --expose-gc --test --test-concurrency=1 --test-reporter=tap tests/regression/office-http-sdk-integration-test.mjs',timeout=120)
elif mode=='legacy-http':
 remote('set -eu; umask 077; cd '+STAGE+'; cp office-http-sdk-integration-test.mjs office-document-parser-test.mjs pdf-document-lifecycle-test.mjs legacy-proof-app/tests/regression/; mkdir -p legacy-media-proof/whisper.cpp-1.7.6/samples; cp jfk.wav legacy-media-proof/whisper.cpp-1.7.6/samples/; cp ocr-proof.png legacy-media-proof/; cd legacy-proof-app; TMPDIR='+STAGE+'/legacy-proof-tmp PT_MEDIA_PROCESSING_DIR='+STAGE+'/legacy-proof-tmp PT_NATIVE_MEDIA_RUNTIME='+STAGE+'/legacy-proof-app/shell/media/vendor-runtime R34_MEDIA_PROOF_ROOT='+STAGE+'/legacy-media-proof R34_LEGACY_PROOF_ROOT='+STAGE+'/legacy-proof-app/tests/fixtures/legacy-r34 node --test --test-concurrency=1 --test-reporter=tap tests/regression/office-http-sdk-integration-test.mjs tests/regression/document-bundle-test.mjs tests/regression/office-document-parser-test.mjs tests/regression/pdf-document-lifecycle-test.mjs',timeout=150)
elif mode=='legacy-proof':
 remote('set -eu; cd '+STAGE+'; test ! -e legacy-proof-app; mkdir legacy-proof-app; cp -a verified-app/. legacy-proof-app/; tar -xzf r34-legacy-proof-inputs.tar.gz -C legacy-proof-app; mkdir -p legacy-proof-tmp; chmod 700 legacy-proof-tmp; cd legacy-proof-app; TMPDIR='+STAGE+'/legacy-proof-tmp PT_MEDIA_PROCESSING_DIR='+STAGE+'/legacy-proof-tmp node tests/probes/r34-legacy-native-20261111.cjs',timeout=150)
elif mode=='preflight':remote('bash '+STAGE+'/r34-target-preflight-20261111.sh',timeout=180)
elif mode=='preserve-own-tmp':
 remote('python3 -c '+shlex.quote("import os,pathlib,subprocess,shutil\npaths=[pathlib.Path('/tmp/pt-r29-validation-20261105'),pathlib.Path('/tmp/pt-r30-validation-20261105'),pathlib.Path('/tmp/pt-r31-validation-20261106-97a3e5a'),pathlib.Path('/tmp/pt-r33-validation-20261106-cf780db'),pathlib.Path('/tmp/northstar-controlled-trial-20261110-r34-all8-8429e8d.tar.gz')]\nassert subprocess.check_output(['systemctl','show','northstar-shell','--property=WorkingDirectory','--value'],text=True).strip()=='/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell'\nuid=os.getuid();dest=pathlib.Path('/home/tongjiawan/pt-r34-preserved-tmp-20261111');dest.mkdir(mode=0o700,exist_ok=True)\nfor source in paths:\n if not source.exists():continue\n target=dest/source.name\n assert not target.exists() and not source.is_symlink()\n entries=[source,*source.rglob('*')] if source.is_dir() else [source]\n assert all(x.lstat().st_uid==uid for x in entries),'NON_OWNED_CONTENT'\n for proc in pathlib.Path('/proc').iterdir():\n  if not proc.name.isdigit() or int(proc.name) in (os.getpid(),os.getppid()):continue\n  try:command=(proc/'cmdline').read_bytes()\n  except (PermissionError,FileNotFoundError,ProcessLookupError):continue\n  assert bytes(str(source),'utf8') not in command,'ACTIVE_REFERENCE'\n shutil.move(str(source),str(target));print('PRESERVED_OWN_TEMP',str(source),str(target))\nsubprocess.run(['free','-m'],check=True)\n"),timeout=120)
elif mode=='project-tmp-sizes':
 remote(r'find /tmp -maxdepth 1 -user tongjiawan \( -name "pt-r*-validation*" -o -name "northstar-*" \) -exec du -sk {} \; | sort -nr | head -12; systemctl show northstar-shell --property=ActiveState,MainPID,NRestarts --no-pager')
elif mode=='tmp-inventory':
 remote('for p in /tmp/pt-r34-validation-20261109-4782c3f /tmp/pt-r33-validation-20261106-cf780db /tmp/northstar-controlled-trial-20261110-r34-all8-8429e8d.tar.gz; do if test -e "$p"; then stat -c "%U %a %n" "$p"; du -sk "$p"; fi; done; free -m')
elif mode=='status':remote('ls -lh '+STAGE+'/*tar.gz; systemctl show northstar-shell --property=WorkingDirectory,ActiveState,NRestarts,MainPID --no-pager; df -h '+STAGE+'; free -m')
elif mode=='fingerprints':remote('sha256sum '+STAGE+'/R34-DEPLOY-VERIFIED-20261111.sh '+STAGE+'/r34-runtime-maintenance-20261111.cjs '+STAGE+'/'+NAME+'.sources.json')
elif mode=='postcheck':
 remote('systemctl show northstar-shell --property=WorkingDirectory,ActiveState,NRestarts,MainPID --no-pager; curl --max-time 10 -fsS http://127.0.0.1:8098/healthz; curl --max-time 20 -fsS https://agent-fat.adorado.top/assets/app.js | sha256sum; sha256sum /opt/northstar/releases/'+'controlled-trial-20261111-r34-all8-1586f76-target'+'/shell/public/app.js')
else:raise SystemExit('Allowed actions: seed,transfer,preflight,status,fingerprints,postcheck')
