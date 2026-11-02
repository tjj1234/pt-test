#!/usr/bin/env python3
"""New immutable revision for host-bound current-upload references."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r6',Path(__file__).with_name('package-northstar-candidate34-r6-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r7-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r7-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r6-draft',b'controlled-trial-20261029-candidate-34-r7-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r7'
 plan['scope']='host-bound-current-upload; managed-media-output-and-owned-range-read; bounded-generation-consent; explicit-reconciliation; authorization-default-off'
 plan['controlledMediaAuthorization']['referenceBinding']='verified-current-upload; tool-supplied references replaced'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
