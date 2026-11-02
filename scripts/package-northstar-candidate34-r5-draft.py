#!/usr/bin/env python3
"""Freeze reviewed reservation display and explicit history actions as a new draft."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r4',Path(__file__).with_name('package-northstar-candidate34-r4-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r5-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r5-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+['shell/public/media-reservation-view-candidate.cjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261028-candidate-34-r4-draft',b'controlled-trial-20261029-candidate-34-r5-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r5'
 plan['scope']='owned-run-media-consent-and-durable-grant; explicit-reservation-reconciliation-with-reviewed-history-view; authorization-default-off'
 plan['omissions']=[entry for entry in plan['omissions'] if entry!='reservation-history-ui-integration']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
