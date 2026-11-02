#!/usr/bin/env python3
"""Immutable draft revision: GET-only recovery for a known image2video asset task."""
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('candidate34_r12',Path(__file__).with_name('package-northstar-candidate34-r12-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261030-candidate-34-r13-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r13-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r12-draft',b'controlled-trial-20261030-candidate-34-r13-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r13'
 plan['scope']='GET-only known-task asset upload recovery before image2video; '+plan['scope']
 plan['controlledMediaAuthorization']['image2videoAssetRecovery']='Known task ID: bounded anonymous GET, no upload resubmission; generation remains gated on durable asset ID'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
