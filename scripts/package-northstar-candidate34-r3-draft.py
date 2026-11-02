#!/usr/bin/env python3
"""Freeze the reviewed per-turn token-cap fix as a new immutable draft."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r2',Path(__file__).with_name('package-northstar-candidate34-r2-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261028-candidate-34-r3-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r3-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261028-candidate-34-r2-draft',b'controlled-trial-20261028-candidate-34-r3-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r3';plan['scope']='controlled-host-admission-and-profile; per-turn-token-cap; server-not-enabled'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
