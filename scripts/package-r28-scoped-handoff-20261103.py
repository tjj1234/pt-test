#!/usr/bin/env python3
"""Write-once scoped release handoff, bound to local acceptance evidence."""
from pathlib import Path
from hashlib import sha256
from zipfile import ZipFile,ZipInfo,ZIP_DEFLATED
import io,json,sys
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'release-artifacts';NAME='northstar-r28-scoped-release-20261103'
ARCHIVE='northstar-controlled-trial-20261103-candidate-34-r28-draft'
CHAINS=['reasoning','context','xlsx','retrieval','memory','skill']
def build():
 files=['release-artifacts/'+ARCHIVE+ext for ext in ['.tar.gz','.sha256','.sources.json']]+[
 'release-artifacts/northstar-shell-candidate-34-r28-draft.service','release-artifacts/northstar-shell-r28-scoped.service',
 'docs/refactor/OPS-R28-SCOPED-RELEASE-20261103.md','scripts/northstar-r26-settings-transition.cjs',
 'scripts/northstar-active-config-inspect.cjs','scripts/northstar-r28-exact-linux-20261103.sh',
 'docs/refactor/evidence/r28-full-regression-20261103.txt','docs/refactor/evidence/r28-exact-archive-linux-20261103.txt',
 'docs/refactor/evidence/r28-standard-media-local-20261103.txt'] + ['docs/refactor/evidence/'+c+'-browser-20261102.png' for c in ['reasoning','context','xlsx','source','memory','skill']]
 for chain in CHAINS:
  name='docs/refactor/evidence/'+chain+'-r28-final-20261103.json';report=json.loads((ROOT/name).read_text())
  if report['status']!='MECHANICAL_PASS' or report['sourceDrift']:raise ValueError('chain not accepted: '+chain)
  for source,digest in report['sources'].items():
   if sha256((ROOT/source).read_bytes()).hexdigest()!=digest:raise ValueError('source drift: '+source)
  files.append(name)
  for check in report['checks']:
   if check['exitCode']!=0 or check['timedOut'] or sha256((ROOT/check['log']).read_bytes()).hexdigest()!=check['logSha256']:raise ValueError('check/log drift')
   files.append(check['log'])
 full=(ROOT/'docs/refactor/evidence/r28-full-regression-20261103.txt').read_text()
 if '共 263 个套件，通过 263，失败 0' not in full:raise ValueError('full regression missing')
 linux=(ROOT/'docs/refactor/evidence/r28-exact-archive-linux-20261103.txt').read_text()
 if 'R28_EXACT_ARCHIVE_LINUX_PASS' not in linux:raise ValueError('Linux pass missing')
 local=(ROOT/'docs/refactor/evidence/r28-standard-media-local-20261103.txt').read_text()
 if 'fail 0' not in local:raise ValueError('standard media pass missing')
 files=list(dict.fromkeys(files));data={Path(p).name:(ROOT/p).read_bytes() for p in files}
 if len(data)!=len(files):raise ValueError('duplicate names')
 archiveHash=sha256(data[ARCHIVE+'.tar.gz']).hexdigest()
 if archiveHash!='e4aa5e2042b831267acc6ce7ad620b6d8ba36d8e4d5163542ba6260c78e0d501':raise ValueError('archive drift')
 status={'status':'SCOPED_RELEASE_LOCAL_ACCEPTED_TARGET_PENDING','date':'2026-11-03','revision':'r28','archiveSha256':archiveHash,'boundSources':217,'archiveMembers':419,'regressionSuites':263,'localBrowserChains':CHAINS,'mediaTasks':['text2image','image2image','text2video'],'excludedModels':'all Seedance family','mediaModels':['seedream-5-0-260128','wan2.7-t2v'],'providerAcceptance':'not performed; local controlled PT responses','targetAcceptance':'operations deployment, backup, runtime and per-account permission checks required','urlPermanence':'PT standard API assumption; not duration-tested','scopeDocument':'OPS-R28-SCOPED-RELEASE-20261103.md'}
 data['RELEASE-STATUS.json']=(json.dumps(status,ensure_ascii=False,indent=2)+'\n').encode()
 data['START-HERE.txt']='先校验 handoff-checksums.sha256，再阅读 OPS-R28-SCOPED-RELEASE-20261103.md。r28 替代 r24 review ZIP。使用 northstar-shell-r28-scoped.service；不要误装同包保留的 draft 审计 unit。目标部署验收待运维执行；不含凭据或 node_modules。\n'.encode()
 data['handoff-checksums.sha256']=''.join(sha256(data[n]).hexdigest()+'  '+n+'\n' for n in sorted(data)).encode()
 out=io.BytesIO()
 with ZipFile(out,'w') as z:
  for n in sorted(data):
   info=ZipInfo(n,(2026,11,3,0,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data[n])
 return out.getvalue(),data
if __name__=='__main__':
 if sys.argv[1:] not in [['--write'],['--check']]:raise SystemExit('usage: --write|--check')
 payload,members=build();output=OUT/(NAME+'.zip');checksum=OUT/(NAME+'.sha256');line=sha256(payload).hexdigest()+'  '+output.name+'\n'
 if sys.argv[1]=='--write':
  for p,b in [(output,payload),(checksum,line.encode())]:
   if p.exists():raise SystemExit('Refusing overwrite: '+str(p))
   p.write_bytes(b)
 elif output.read_bytes()!=payload or checksum.read_text()!=line:raise SystemExit('HANDOFF_DRIFT')
 with ZipFile(io.BytesIO(payload)) as z:
  if z.testzip() or z.namelist()!=sorted(members) or any(z.read(n)!=members[n] for n in members):raise SystemExit('ZIP_AUDIT_FAILED')
 print(json.dumps({'status':'SCOPED_RELEASE_LOCAL_ACCEPTED_TARGET_PENDING','sha256':sha256(payload).hexdigest(),'members':len(members),'archive':output.name}))
