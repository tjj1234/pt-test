#!/usr/bin/env python3
"""Deterministic read-only operations kit; contains no application or credentials."""
import hashlib,io,sys,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'release-artifacts'
NAME='northstar-r16-config-preflight-20261030'
ZIP=OUT/(NAME+'.zip');SHA=OUT/(NAME+'.sha256')
INPUTS=[ROOT/'docs/refactor/OPS-R16-NEXT-ACTION-20261030.md',ROOT/'scripts/northstar-active-config-inspect.cjs',ROOT/'scripts/northstar-media-config-preflight.cjs']
def sha(data):return hashlib.sha256(data).hexdigest()
def build():
 files={}
 for p in INPUTS:
  if p.is_symlink() or not p.is_file():raise ValueError('INPUT_INVALID')
  files[p.name]=p.read_bytes()
 files['checksums.sha256']=''.join(sha(data)+'  '+name+'\n' for name,data in sorted(files.items())).encode()
 buf=io.BytesIO()
 with zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for name,data in sorted(files.items()):
   info=zipfile.ZipInfo(name,date_time=(2026,10,30,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
   z.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
 data=buf.getvalue();return {ZIP:data,SHA:(sha(data)+'  '+ZIP.name+'\n').encode()}
def main():
 if sys.argv[1:] not in (['--write'],['--check']):raise SystemExit('usage: --write|--check')
 outputs=build()
 if sys.argv[1]=='--write':
  if any(p.exists() or p.is_symlink() for p in outputs):raise ValueError('REFUSE_OVERWRITE')
  for p,v in outputs.items():
   with p.open('xb') as f:f.write(v)
 else:
  if any(p.is_symlink() or not p.is_file() or p.read_bytes()!=v for p,v in outputs.items()):raise ValueError('KIT_CHANGED')
 print('readOnlyPreflightKitSha256='+sha(outputs[ZIP]))
if __name__=='__main__':main()
