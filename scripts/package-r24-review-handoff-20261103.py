#!/usr/bin/env python3
"""Reproducible review handoff; never claims deployment approval."""
from pathlib import Path
from hashlib import sha256
from zipfile import ZipFile,ZipInfo,ZIP_DEFLATED
import io,json,sys
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'release-artifacts'
NAME='northstar-r24-review-handoff-20261103'
FILES=[
 'release-artifacts/northstar-controlled-trial-20261103-candidate-34-r24-draft.tar.gz',
 'release-artifacts/northstar-controlled-trial-20261103-candidate-34-r24-draft.sha256',
 'release-artifacts/northstar-controlled-trial-20261103-candidate-34-r24-draft.sources.json',
 'release-artifacts/northstar-shell-candidate-34-r24-draft.service',
 'docs/refactor/OPS-R24-URGENT-PREFLIGHT-20261103.md',
 'docs/refactor/evidence/R24-CANDIDATE-20261103.md',
 'scripts/northstar-media-config-preflight.cjs',
]
def build():
 data={Path(p).name:(ROOT/p).read_bytes() for p in FILES}
 if len(data)!=len(FILES):raise ValueError('duplicate member name')
 name='northstar-controlled-trial-20261103-candidate-34-r24-draft.tar.gz'
 if sha256(data[name]).hexdigest()!='1aa947848010156e183cea351febf5f6b0c4ea7ceede0ed17c2830448eb08153':raise ValueError('archive digest mismatch')
 data['REVIEW_STATUS.txt']=('REVIEW ONLY - NOT FOR DEPLOYMENT\nFull agreed scope and target approval/acceptance remain open.\nRead OPS-R24-URGENT-PREFLIGHT-20261103.md and R24-CANDIDATE-20261103.md.\n').encode()
 data['handoff-checksums.sha256']=''.join(sha256(data[n]).hexdigest()+'  '+n+'\n' for n in sorted(data)).encode()
 out=io.BytesIO()
 with ZipFile(out,'w') as z:
  for name in sorted(data):
   info=ZipInfo(name,(2026,11,3,0,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data[name])
 return out.getvalue(),data
if __name__=='__main__':
 if sys.argv[1:] not in (['--write'],['--check']):raise SystemExit('usage: --write|--check')
 payload,members=build();zipfile=OUT/(NAME+'.zip');checksum=OUT/(NAME+'.sha256');line=sha256(payload).hexdigest()+'  '+zipfile.name+'\n'
 if sys.argv[1]=='--write':
  for p,b in [(zipfile,payload),(checksum,line.encode())]:
   if p.exists():raise SystemExit('Refusing to overwrite '+str(p))
   p.write_bytes(b)
 else:
  if zipfile.read_bytes()!=payload or checksum.read_text()!=line:raise SystemExit('HANDOFF_DRIFT')
 with ZipFile(io.BytesIO(payload)) as z:
  if z.testzip() is not None or z.namelist()!=sorted(members) or any(z.read(n)!=members[n] for n in members):raise SystemExit('HANDOFF_AUDIT_FAILED')
 print(json.dumps({'status':'REVIEW_ONLY_NOT_DEPLOYMENT_APPROVAL','sha256':sha256(payload).hexdigest(),'members':len(members),'archive':zipfile.name}))
