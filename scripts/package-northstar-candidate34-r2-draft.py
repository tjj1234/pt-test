#!/usr/bin/env python3
"""New immutable revision; reuses candidate34 builder, never overwrites r1."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_builder',Path(__file__).with_name('package-northstar-candidate34-draft.py'))
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
builder.NAME='northstar-controlled-trial-20261028-candidate-34-r2-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r2-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+['shell/db-migrations/022_controlled_media_grants.sql','shell/tasks/media-grant-store-candidate.cjs','shell/runtime/run-budget-media.json']
original_build=builder.build
def build():
 output=original_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261028-candidate-34-draft',b'controlled-trial-20261028-candidate-34-r2-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r2';plan['scope']='controlled-host-admission-and-media-profile; server-not-enabled'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
