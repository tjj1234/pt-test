#!/usr/bin/env python3
"""Promote the audited r13 archive bytes to a target-preflight release candidate."""
import hashlib
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'release-artifacts'
SOURCE='northstar-controlled-trial-20261030-candidate-34-r13-draft'
NAME='northstar-controlled-trial-20261030-candidate-34-r14'
OLD_UNIT='northstar-shell-candidate-34-r13-draft.service'
NEW_UNIT='northstar-shell-candidate-34-r14.service'
OLD_DIR='controlled-trial-20261030-candidate-34-r13-draft'
NEW_DIR='controlled-trial-20261030-candidate-34-r14'
ARCHIVE_SHA='f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993'
def sha(data):return hashlib.sha256(data).hexdigest()
def build():
 archive=(OUT/(SOURCE+'.tar.gz')).read_bytes()
 if sha(archive)!=ARCHIVE_SHA:raise ValueError('SOURCE_ARCHIVE_CHANGED')
 unit=(OUT/OLD_UNIT).read_bytes()
 if unit.count(OLD_DIR.encode())!=3 or unit.count(b'DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 34 r4')!=1:
  raise ValueError('SOURCE_UNIT_UNEXPECTED')
 unit=unit.replace(OLD_DIR.encode(),NEW_DIR.encode()).replace(
  b'DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 34 r4',b'Controlled Trial Candidate 34 r14')
 if b'DRAFT ONLY' in unit or OLD_DIR.encode() in unit:raise ValueError('UNIT_NOT_PROMOTED')
 plan={'schemaVersion':1,'status':'PENDING_TARGET_PREFLIGHT','archive':NAME+'.tar.gz',
  'archiveSha256':ARCHIVE_SHA,'sourceDraft':SOURCE,'sourcePlanSha256':sha((OUT/(SOURCE+'.sources.json')).read_bytes()),
  'sourceUnitSha256':sha((OUT/OLD_UNIT).read_bytes()),'unit':NEW_UNIT,'unitSha256':sha(unit),
  'targetReleaseDirectory':'/opt/northstar/releases/'+NEW_DIR,
  'gates':['target read-only baseline and rollback mapping','target clean install and closure','service switch','local and public health','same-version product acceptance']}
 outputs={OUT/(NAME+'.tar.gz'):archive,OUT/NEW_UNIT:unit,OUT/(NAME+'.json'):(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()}
 outputs[OUT/(NAME+'.sha256')]=''.join(sha(v)+'  '+p.name+'\n' for p,v in outputs.items()).encode()
 return outputs
def main():
 if sys.argv[1:] not in (['--write'],['--check']):raise SystemExit('usage: promote-northstar-candidate34-r14.py --write|--check')
 outputs=build()
 if sys.argv[1]=='--write':
  if any(p.exists() or p.is_symlink() for p in outputs):raise ValueError('REFUSE_OVERWRITE')
  for p,v in outputs.items():
   with p.open('xb') as f:f.write(v)
 else:
  if any(not p.is_file() or p.read_bytes()!=v for p,v in outputs.items()):raise ValueError('PROMOTION_OR_SOURCE_CHANGED')
 print(json.dumps({'status':'PENDING_TARGET_PREFLIGHT','archiveSha256':ARCHIVE_SHA,'unitSha256':sha(outputs[OUT/NEW_UNIT]),'reproducible':True}))
if __name__=='__main__':main()
