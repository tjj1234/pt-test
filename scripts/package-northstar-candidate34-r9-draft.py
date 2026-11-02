#!/usr/bin/env python3
"""Immutable revision for host-reviewed media scope projection."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r8',Path(__file__).with_name('package-northstar-candidate34-r8-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r9-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r9-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+['shell/models/reviewed-media-catalog-view.cjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r8-draft',b'controlled-trial-20261029-candidate-34-r9-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r9'
 plan['scope']='exact-default-endpoint-scope; ephemeral-host-reviewed-media; '+plan['scope']
 plan['controlledMediaAuthorization']['reviewFileEnvironment']='PT_MEDIA_REVIEW_FILE'
 plan['controlledMediaAuthorization']['reviewMode']='exact-current-scope-and-base-revision; max24h; manual-only; no-base-cache-mutation'
 plan['omissions']=[item for item in plan['omissions'] if item!='media-price-and-credits-budget-confirmation']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
