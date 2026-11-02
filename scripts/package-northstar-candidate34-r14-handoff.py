#!/usr/bin/env python3
"""Create a deterministic, checksum-bound operations handoff ZIP."""
import hashlib
import io
import sys
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
NAME='northstar-controlled-trial-20261030-candidate-34-r14'
OUT=ROOT/'release-artifacts'
INPUTS=[OUT/(NAME+'.tar.gz'),OUT/'northstar-shell-candidate-34-r14.service',OUT/(NAME+'.json'),OUT/(NAME+'.sha256'),ROOT/'docs/refactor/OPS-CANDIDATE34-R14-TARGET-PREFLIGHT-20261030.md']
ZIP=OUT/(NAME+'-handoff.zip')
SHA=OUT/(NAME+'-handoff.sha256')
def build():
 buffer=io.BytesIO()
 with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for path in INPUTS:
   if not path.is_file() or path.is_symlink():raise ValueError('HANDOFF_INPUT_INVALID')
   info=zipfile.ZipInfo(path.name,date_time=(2026,10,30,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
   z.writestr(info,path.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
 data=buffer.getvalue();digest=hashlib.sha256(data).hexdigest()
 return {ZIP:data,SHA:(digest+'  '+ZIP.name+'\n').encode()},digest
def main():
 if sys.argv[1:] not in (['--write'],['--check']):raise SystemExit('usage: package-northstar-candidate34-r14-handoff.py --write|--check')
 outputs,digest=build()
 if sys.argv[1]=='--write':
  if any(p.exists() or p.is_symlink() for p in outputs):raise ValueError('REFUSE_OVERWRITE')
  for p,v in outputs.items():
   with p.open('xb') as f:f.write(v)
 else:
  if any(not p.is_file() or p.read_bytes()!=v for p,v in outputs.items()):raise ValueError('HANDOFF_CHANGED')
 print('handoffSha256='+digest)
if __name__=='__main__':main()
