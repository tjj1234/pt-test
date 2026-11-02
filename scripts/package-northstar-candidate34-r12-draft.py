#!/usr/bin/env python3
"""Immutable draft revision: AUTO verification and durable image2video asset upload."""
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('candidate34_r11',Path(__file__).with_name('package-northstar-candidate34-r11-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r12-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r12-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+[
 'shell/media/pt-asset-upload-bridge-r2-candidate.cjs',
 'shell/media/pt-asset-upload-worker-r2-candidate.py',
 'shell/media/vendor/powertokens_video/pt_video_product.py',
 'shell/tasks/media-input-asset.cjs',
]
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r11-draft',b'controlled-trial-20261029-candidate-34-r12-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r12'
 plan['scope']='real-AUTO-qualification-after-manual-Run; durable-PT-asset-upload-before-image2video; '+plan['scope']
 plan['controlledMediaAuthorization']['liveAutoEvidence']='F1-live-agent-20261029-auto-r2.json; same-version manual qualification then AUTO PASS'
 plan['controlledMediaAuthorization']['image2videoAssetUpload']='PT fixed-origin upload, separate Run external operation, asset ID persisted before generation; offline integration only'
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
