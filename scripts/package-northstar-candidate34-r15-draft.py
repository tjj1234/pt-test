#!/usr/bin/env python3
"""Immutable native DSH image-understanding draft; leaves r14 untouched."""
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('candidate34_r13',Path(__file__).with_name('package-northstar-candidate34-r13-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261030-candidate-34-r15-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r15-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+['shell/runtime/native-image-message.mjs','shell/models/native-image-qualification.cjs','shell/models/reviewed-image-facts.cjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261030-candidate-34-r13-draft',b'controlled-trial-20261030-candidate-34-r15-draft').replace(b'Candidate 34 r4',b'Candidate 34 r15')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r15'
 plan['scope']='native-DSH-image-understanding-manual-AUTO-cold-replay; '+plan['scope']
 plan['nativeImageUnderstanding']={'implementation':'DSH attachment admission/store, ImageBlock and pi-ai projection; host ACL, bounds and Run qualification',
  'reviewedModel':'qwen3.8-flash','source':'https://powertokens.ai/models/qwen3.8-flash',
  'liveEvidence':'F1-live-agent-20261029-vision-shapes-r1.json: count/color manual-AUTO-cold PASS',
  'limitation':'OCR fixture misread R7K2 as RTK2; vision-r1 INCOMPLETE retained; no audio/video understanding acceptance',
  'coldReplay':'latest 3 historical user images plus current, total 10MiB; history references reverified by tenant and SHA'}
 plan['runtimeProfileUpgrade']='Existing profile requires offline rebuild from exact release source, backup retained; unit rollback alone does not restore profile'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
