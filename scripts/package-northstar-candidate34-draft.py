#!/usr/bin/env python3
"""Freeze a complete current-source draft; NOT a deployment approval.
Reuses the reviewed r4 archive skeleton and portable npm closure. Source plan
and outputs are write-once; --check rejects later workspace drift.
"""
import copy,gzip,hashlib,io,json,pathlib,re,sys,tarfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'release-artifacts'
BASE=OUT/'northstar-controlled-trial-20261023-candidate-33-draft-r4.tar.gz'
BASE_SHA='665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c'
BASE_UNIT=OUT/'northstar-shell-candidate-33-draft-r4.service'
UNIT_SHA='ee7f9118190278ea0c7289eb70d94c754191a30f58152bf33e10841f1a8fe772'
NAME='northstar-controlled-trial-20261028-candidate-34-draft'
PLAN=OUT/(NAME+'.sources.json')
ARCHIVE=OUT/(NAME+'.tar.gz')
UNIT=OUT/'northstar-shell-candidate-34-draft.service'
CHECKSUM=OUT/(NAME+'.sha256')
ADDITIONS='''shell/attachments/csv-column-profile.cjs
shell/attachments/csv-column-selection-candidate.cjs
shell/attachments/csv-run-source.cjs
shell/db-migrations/020_chat_usage_total_semantics.sql
shell/db-migrations/021_text_price_catalogs.sql
shell/exports/csv-analysis-result-candidate.cjs
shell/exports/csv.cjs
shell/media/asset-ingest-candidate.cjs
shell/media/ptvideo-bridge.cjs
shell/media/ptvideo-executor.cjs
shell/media/ptvideo-result-guard-candidate.cjs
shell/media/ptvideo-worker.py
shell/media/vendor/powertokens_video/LICENSE
shell/media/vendor/powertokens_video/README.md
shell/media/vendor/powertokens_video/UPSTREAM.json
shell/media/vendor/powertokens_video/pt_video.py
shell/models/media-route-admission.cjs
shell/models/media-task-router.cjs
shell/models/reviewed-media-apply.cjs
shell/models/reviewed-media-qualification.cjs
shell/runtime/backup-fs.cjs
shell/runtime/csv-run-artifact.cjs
shell/runtime/data-backup.cjs
shell/runtime/run-budget-csv.json
shell/tasks/controlled-media-admission.cjs
shell/tasks/csv-analysis-adapter.cjs
shell/tasks/csv-run-handler.cjs
shell/tasks/csv-tool-definition.cjs
shell/tasks/lease-recovery-sweep.cjs
shell/usage/bound-text-estimate.cjs
shell/usage/model-intent-handler.cjs
shell/usage/price-catalog-store.cjs
shell/usage/price-snapshot-selection-candidate.cjs
shell/usage/run-usage-csv.cjs
shell/usage/text-cost-estimate.cjs'''.splitlines()
def sha(data):return hashlib.sha256(data).hexdigest()
def safe_name(name):
 p=pathlib.PurePosixPath(name)
 if p.is_absolute() or any(x in ('','.','..') or x.startswith('.env') or x in ('node_modules','__pycache__','.git','wb copy') or x.startswith('._') for x in name.split('/')) or '\\' in name or any(ord(c)<32 for c in name):raise ValueError('PROHIBITED_PATH')
def source(name):
 safe_name(name)
 path=ROOT/name
 for p in [path,*path.parents]:
  if p==ROOT:break
  if p.is_symlink():raise ValueError('SOURCE_SYMLINK')
 if not path.is_file():raise ValueError('SOURCE_MISSING')
 return path.read_bytes()
def inputs():
 raw=BASE.read_bytes();unit=BASE_UNIT.read_bytes()
 if sha(raw)!=BASE_SHA or sha(unit)!=UNIT_SHA:raise ValueError('BASE_CHANGED')
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as t:
  members=t.getmembers();data={}
  if len({m.name for m in members})!=len(members):raise ValueError('DUPLICATE_BASE')
  for m in members:
   safe_name(m.name)
   if not(m.isfile() or m.isdir()) or m.pax_headers:raise ValueError('BASE_TYPE')
   if m.isfile():data[m.name]=t.extractfile(m).read()
 return members,data,unit
def build():
 members,data,unit=inputs();bound={};changed=[]
 # Preserve unrelated analytics/business snapshots. Only current shell and the
 # explicitly changed media executor are in this delivery source scope.
 for name in sorted(data):
  if name.startswith('shell/') and name not in ('shell/northstar-dependency-closure.cjs','shell/dependency-closure-manifest.json') or name=='business/media/powertokens.cjs':
   current=source(name);bound[name]=sha(current)
   if current!=data[name]:changed.append(name)
   data[name]=current
 for name in ADDITIONS:
  if name in data:raise ValueError('ADDITION_ALREADY_PRESENT')
  data[name]=source(name);bound[name]=sha(data[name])
 plan={'schemaVersion':1,'status':'DRAFT_NOT_FOR_DEPLOYMENT','baseSha256':BASE_SHA,'sources':bound,'changedBaseFiles':changed,'addedFiles':ADDITIONS,'omissions':['live-model-and-media-acceptance','media-budget-qualification','clean-linux-install','target-python-validation','target-deployment-rollback']}
 tar=io.BytesIO();old={m.name:m for m in members}
 names=set(old)|set(ADDITIONS)
 for name in list(names):
  parent=pathlib.PurePosixPath(name).parent
  while str(parent)!='.':names.add(str(parent));parent=parent.parent
 with tarfile.open(fileobj=tar,mode='w',format=tarfile.USTAR_FORMAT) as t:
  for name in sorted(names):
   safe_name(name);info=tarfile.TarInfo(name);info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
   body=data.get(name)
   info.type=tarfile.REGTYPE if body is not None else tarfile.DIRTYPE
   info.mode=0o644 if body is not None else 0o755
   if name in old and body is not None:info.mode=old[name].mode & 0o755
   info.size=len(body) if body is not None else 0;t.addfile(info,io.BytesIO(body) if body is not None else None)
 gz=io.BytesIO()
 with gzip.GzipFile(fileobj=gz,mode='wb',mtime=0,filename='') as f:f.write(tar.getvalue())
 unit=unit.replace(b'controlled-trial-20261023-candidate-33-draft-r4',b'controlled-trial-20261028-candidate-34-draft').replace(b'Candidate 33',b'Candidate 34')
 return {PLAN:(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode(),ARCHIVE:gz.getvalue(),UNIT:unit}
def main():
 if sys.argv[1:] not in (['--write'],['--check']):raise SystemExit('usage: package-northstar-candidate34-draft.py --write|--check')
 outputs=build();outputs[CHECKSUM]=''.join(sha(value)+'  '+path.name+'\n' for path,value in outputs.items()).encode()
 if sys.argv[1]=='--check':
  if any(not p.is_file() or p.read_bytes()!=v for p,v in outputs.items()):raise ValueError('DRAFT_OR_SOURCE_CHANGED')
 else:
  if any(p.exists() or p.is_symlink() for p in outputs):raise ValueError('REFUSE_OVERWRITE')
  for p,v in outputs.items():
   with p.open('xb') as f:f.write(v)
 print(json.dumps({'status':'DRAFT_NOT_FOR_DEPLOYMENT','reproducible':True,'archiveSha256':sha(outputs[ARCHIVE]),'sourceFiles':len(json.loads(outputs[PLAN])['sources'])}))
if __name__=='__main__':main()
