#!/usr/bin/env python3
"""Freeze recovered native Skill integration and PT contract compatibility; preserve r21."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r24',Path(__file__).with_name('package-northstar-candidate34-r24-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261103-candidate-34-r25-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r25-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')

previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'candidate-34-r24-draft',b'candidate-34-r25-draft').replace(b'Candidate 34 r24',b'Candidate 34 r25')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r25';plan['ptContractCompatibility']['javascript']='Media POST and polling GET classify 401/402, preserve ambiguous 403, redact upstream error body and never resubmit unknown outcomes.'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
