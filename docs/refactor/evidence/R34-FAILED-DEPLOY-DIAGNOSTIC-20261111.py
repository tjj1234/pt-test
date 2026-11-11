#!/usr/bin/env python3
"""Read-only, bounded diagnostic. Never prints log bodies or secret values."""
import os,re,json,subprocess
from pathlib import Path
assert os.geteuid()==0, 'ROOT_REQUIRED'
b=Path('/var/backups/northstar/r34-20261111T051705Z')
p=b/'profile-rebuild.private.log'
s=p.read_text(errors='replace')[:65536] if p.exists() else ''
codes=sorted(set(re.findall(r'\b(?:PROFILE_[A-Z_]+|RUNTIME_SCOPE_MISMATCH|ENOENT|EACCES|EPERM|MODULE_NOT_FOUND|ERR_[A-Z_]+)\b',s)))
print(json.dumps({'scope':'R34_FAILED_DEPLOY_READONLY','profileLogExists':p.exists(),'profileErrorCodes':codes,'errorTypes':sorted(set(re.findall(r'\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b',s)))}))
for line in s.splitlines():
 if 'at ' in line and re.search(r'(dsh-adapter|profile-paths|profile-lifecycle|profile-dependencies)\.cjs:\d+',line):
  print('FRAME',re.search(r'(?:dsh-adapter|profile-paths|profile-lifecycle|profile-dependencies)\.cjs:\d+(?::\d+)?',line).group())
for name in ['runtime','runtime/dsh-home','runtime/dsh-home/profiles','runtime/dsh-home/profiles/run-persistent']:
 p=Path('/var/lib/northstar')/name
 st=p.lstat();print('PATH_METADATA',name,st.st_uid,oct(st.st_mode&0o7777),p.is_symlink())
result=subprocess.run(['runuser','-u','northstar','--','/usr/local/bin/node','--env-file=/etc/northstar/northstar.env','-e',"console.log(JSON.stringify({runtimeMatches:process.env.PT_RUNTIME_DIR==='/var/lib/northstar/runtime',runtimeDefined:!!process.env.PT_RUNTIME_DIR}))"],capture_output=True,text=True)
print('RUNTIME_ENV_CHECK',result.returncode,result.stdout.strip() if result.returncode==0 else 'FAILED')
subprocess.run(['systemctl','show','northstar-shell','--property=ActiveState,MainPID,NRestarts,WorkingDirectory','--no-pager'],check=True)

# Reproduce module loading only; no profile changes, DB opens, or service changes.
module='/opt/northstar/releases/controlled-trial-20261111-r34-all8-1586f76-target/shell/runtime/dsh-adapter.cjs'
for cwd in ['/home/tongjiawan/pt-r34-stage-37930c7/assembled-1586f76','/']:
 r=subprocess.run(['runuser','-u','northstar','--','/usr/local/bin/node','--env-file=/etc/northstar/northstar.env','-'],input="require("+json.dumps(module)+");console.log('MODULE_LOAD_PASS');",capture_output=True,text=True,cwd=cwd)
 print(json.dumps({'scope':'MODULE_CWD_REPRO','cwd':cwd,'exit':r.returncode,'pass':r.stdout.strip()=='MODULE_LOAD_PASS','codes':sorted(set(re.findall(r'\b(?:ERR_[A-Z_]+|EACCES|EPERM|ENOENT)\b',r.stderr)))}))
# Print only a package path, never arbitrary exception text.
for v in re.findall(r'Invalid package config ([^\n]+)',s):
 v=v.strip().rstrip('.')
 if v.startswith('/') and re.fullmatch(r'[a-zA-Z0-9_./-]+',v):print('INVALID_PACKAGE_PATH',v)
