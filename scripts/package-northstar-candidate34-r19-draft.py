#!/usr/bin/env python3
"""Native tool gate also binds the current Run's native call record."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r18',Path(__file__).with_name('package-northstar-candidate34-r18-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261031-candidate-34-r19-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r19-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261031-candidate-34-r18-draft',b'controlled-trial-20261031-candidate-34-r19-draft').replace(b'Candidate 34 r18',b'Candidate 34 r19')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r19';plan['scope']='current-Run-native-tool-call-record-binding; '+plan['scope']
 plan['nativeToolAdmission']['seam']='native tools/execute waterfall: exact Agent object plus current-Run native tool/call record/name'
 plan['nativeToolAdmission']['denials']+=['previous Run call record','direct-call name mismatch']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
