#!/usr/bin/env python3
"""Immutable revision: media Runs require owned, successful local output."""
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('candidate34_r10',Path(__file__).with_name('package-northstar-candidate34-r10-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r11-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r11-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+['shell/tasks/media-result-acceptance.cjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r10-draft',b'controlled-trial-20261029-candidate-34-r11-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r11'
 plan['scope']='media-run-owned-output-completion-gate; '+plan['scope']
 plan['controlledMediaAuthorization']['liveText2VideoEvidence']='F1-live-agent-20261029-t2v-r1.json; remote succeeded, local media absent, Run false success in r10; r11 completion gate fixes the false success offline'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
