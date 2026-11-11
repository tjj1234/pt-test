#!/usr/bin/env python3
"""Assemble exact frozen members locally on target, reusing an audited base."""
import gzip,hashlib,io,json,re,sys,tarfile,zlib
from pathlib import Path
sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
def safe(name):
 assert name and not name.startswith('/') and all(x not in ('','..','.git','node_modules') and not x.startswith('.env') and not x.startswith('._') for x in name.split('/'))
def main():
 stage=Path('/home/tongjiawan/pt-r34-stage-37930c7')
 frozen_file=stage/sys.argv[1];overlay_file=stage/sys.argv[2]
 assert frozen_file.parent==stage and overlay_file.parent==stage
 assert sha(frozen_file)==sys.argv[3] and sha(overlay_file)==sys.argv[4]
 plan=json.loads(frozen_file.read_text());assert re.fullmatch('[a-f0-9]{40}',plan['commit'])
 expected=plan['members'];modes=plan['memberModes'];assert 1000<len(expected)<1400
 base=stage/'northstar-controlled-trial-20261110-r34-all8-a3f39f5.tar.gz'
 assert sha(base)=='57c5bc357f3de3e61a150513302c3098b07b75dfd6b4360f0e527c4dc407d45d'
 name='northstar-controlled-trial-20261111-r34-all8-'+plan['commit'][:7]+'-target'
 out=stage/('assembled-'+plan['commit'][:7]);out.mkdir(mode=0o700)
 output=out/(name+'.tar.gz')
 class Checked:
  def __init__(self,file):self.file=file;self.hash=hashlib.sha256()
  def read(self,size=-1):b=self.file.read(size);self.hash.update(b);return b
 with tarfile.open(base) as original,tarfile.open(overlay_file) as overlay:
  bmap={m.name:m for m in original};omap={m.name:m for m in overlay}
  assert len(omap)==len(overlay.getmembers()) and not(set(omap)-set(expected))
  with output.open('xb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as gz,tarfile.open(fileobj=gz,mode='w|',format=tarfile.USTAR_FORMAT) as target:
   for member,digest in sorted(expected.items()):
    safe(member);source=overlay if member in omap else original;info=(omap if member in omap else bmap)[member]
    assert info.isfile() and info.size<=128*1024*1024
    stream=Checked(source.extractfile(info));header=tarfile.TarInfo(member);header.size=info.size;header.mode=modes[member];assert header.mode&0o7022==0
    target.addfile(header,stream);assert stream.hash.hexdigest()==digest,'FROZEN_MEMBER_CHANGED'
  plan['assembly']={'baseSha256':sha(base),'overlaySha256':sha(overlay_file),'frozenMemberPlanSha256':sha(frozen_file),'zlib':zlib.ZLIB_RUNTIME_VERSION}
  plan['archive']=output.name;plan['archiveSha256']=sha(output);plan['status']='FROZEN_TARGET_CANDIDATE_NOT_DEPLOYED'
  manifest=out/(name+'.sources.json');manifest.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
  (out/(name+'.sha256')).write_text(plan['archiveSha256']+'  '+output.name+'\n'+sha(manifest)+'  '+manifest.name+'\n')
  print(json.dumps({'directory':str(out),'name':name,'commit':plan['commit'],'archiveSha256':sha(output),'planSha256':sha(manifest),'members':len(expected),'sources':len(plan['sources'])}))
if __name__=='__main__':main()
