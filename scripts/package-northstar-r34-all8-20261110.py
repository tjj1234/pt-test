#!/usr/bin/env python3
"""Freeze an immutable source/native-runtime candidate; never deploy or overwrite."""
import gzip,hashlib,io,json,os,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
COMMIT=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
NAME='northstar-controlled-trial-20261110-r34-all8-'+COMMIT[:7]
OUT=ROOT/'release-artifacts'/NAME
sha=lambda b:hashlib.sha256(b).hexdigest()
def safe(name):
 p=Path(name)
 if p.is_absolute() or any(x in ('','..','.git','node_modules','__pycache__') or x.startswith('.env') or x.startswith('._') for x in p.parts):raise ValueError('UNSAFE_MEMBER')
def main():
 if OUT.exists():raise ValueError('REFUSE_OVERWRITE')
 tracked=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0')
 dirty=subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=ROOT,text=True)
 if dirty:raise ValueError('TRACKED_SOURCE_DIRTY')
 base=ROOT/'release-artifacts/northstar-controlled-trial-20261106-candidate-34-r33-questions-m1-draft.tar.gz'
 baseline=json.loads((base.with_suffix('').with_suffix('.sources.json')).read_text())
 files={};modes={};bound={}
 with tarfile.open(base) as archive:
  for member in archive:
   if member.isfile():
    safe(member.name);files[member.name]=archive.extractfile(member).read();modes[member.name]=member.mode&0o755
 for name in tracked:
  if not name:continue
  if not(name.startswith('shell/') or name in ('business/attribution/import/workspace-meta.js','business/media/powertokens.cjs') or name in ('scripts/northstar-r34-runtime-acl.cjs','scripts/northstar-runtime-db-gate.cjs','scripts/northstar-price-catalog.cjs','scripts/northstar-profile-maintenance.cjs')):continue
  safe(name);file=ROOT/name
  if file.is_symlink() or not file.is_file():raise ValueError('SOURCE_TYPE')
  body=file.read_bytes();files[name]=body;modes[name]=0o644;bound[name]=sha(body)
 for name,file in [('shell/northstar-dependency-closure.cjs',ROOT/'scripts/northstar-dependency-closure.cjs'),('shell/dependency-closure-manifest.json',ROOT/'.release-inputs/r34-linux-dependency-closure.json'),('shell/isolation/vendor/offline-analysis',ROOT/'.release-inputs/isolation/offline-analysis')]:
  files[name]=file.read_bytes();bound[name]=sha(files[name]);modes[name]=0o755 if name.endswith('/offline-analysis') else 0o644
 if bound['shell/isolation/vendor/offline-analysis']!='1641b251b3dcac6baf18816b3dd2dc57ace858f9bd4c740ffea2af0b30ed0835':raise ValueError('ISOLATION_BINARY_CHANGED')
 runtime=ROOT/'.release-inputs/whisper/runtime-linux-x64'
 manifest=json.loads((runtime/'manifest.json').read_text())
 for rel,entry in manifest['files'].items():
  file=runtime/rel
  if file.is_symlink() or not file.is_file():raise ValueError('MEDIA_RUNTIME_TYPE')
  body=file.read_bytes()
  if sha(body)!=entry['sha256'] or len(body)!=entry['size']:raise ValueError('MEDIA_RUNTIME_CHANGED')
 for file in sorted(runtime.rglob('*')):
  if file.is_symlink():raise ValueError('MEDIA_RUNTIME_SYMLINK')
  if not file.is_file():continue
  rel=file.relative_to(runtime).as_posix()
  if rel!='manifest.json' and rel not in manifest['files']:raise ValueError('UNBOUND_MEDIA_FILE')
  name='shell/media/vendor-runtime/'+rel;safe(name);files[name]=file.read_bytes();bound[name]=sha(files[name]);modes[name]=0o755 if file.stat().st_mode&0o111 else 0o644
 # No deleted/changed historical migration may be hidden by the base archive.
 for name,digest in baseline['sources'].items():
  if name.startswith('shell/db-migrations/') and sha(files[name])!=digest:raise ValueError('HISTORICAL_MIGRATION_CHANGED')
 OUT.mkdir()
 archive=OUT/(NAME+'.tar.gz')
 with archive.open('xb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as gz,tarfile.open(fileobj=gz,mode='w|',format=tarfile.USTAR_FORMAT) as tar:
  for name,body in sorted(files.items()):
   info=tarfile.TarInfo(name);info.size=len(body);info.mode=modes[name];info.uid=info.gid=info.mtime=0;tar.addfile(info,io.BytesIO(body))
 archive_sha=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
 plan={'schemaVersion':2,'status':'FROZEN_CANDIDATE_NOT_DEPLOYED','revision':'r34-all8','commit':COMMIT,'archive':archive.name,'archiveSha256':archive_sha,'sources':bound,'members':{n:sha(b) for n,b in sorted(files.items())},'migrationAdditions':['030_model_request_attempts.sql','031_pdf_document_sources.sql','032_web_source_evidence.sql','033_billing_login_credentials.sql','034_run_operation_approvals.sql'],'bug12':'DEGRADED_PREVIEW','acceptance':'same-version independent QA and real provider acceptance pending','billing':'Official credits and local USD estimates are independent; reviewed base tariffs and bounded weekday periods cover two models until superseded; other dimensions/models remain unknown.','auto08':'Pre-dispatch qualification and ordering; uncertain submitted requests never automatically repost or switch model.'}
 planfile=OUT/(NAME+'.sources.json');planfile.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
 (OUT/(NAME+'.sha256')).write_text(archive_sha+'  '+archive.name+'\n'+sha(planfile.read_bytes())+'  '+planfile.name+'\n')
 print(json.dumps({'directory':str(OUT),'archiveSha256':archive_sha,'sourceFiles':len(bound),'members':len(files)}))
if __name__=='__main__':main()
