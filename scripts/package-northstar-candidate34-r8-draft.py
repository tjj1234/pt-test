#!/usr/bin/env python3
"""Immutable revision: durable model intents observe final model selection."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r7',Path(__file__).with_name('package-northstar-candidate34-r7-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r8-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r8-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r7-draft',b'controlled-trial-20261029-candidate-34-r8-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r8'
 plan['scope']='final-model-before-durable-intent; '+plan['scope']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
