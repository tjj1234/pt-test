#!/usr/bin/env python3
"""Freeze managed media output and bounded generation consent; no deployment approval."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r5',Path(__file__).with_name('package-northstar-candidate34-r5-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261029-candidate-34-r6-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r6-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+['shell/media/pinned-asset-fetch.cjs','shell/media/managed-result-publisher.cjs','shell/media/managed-media-read.cjs','shell/runtime/managed-media-writer-candidate.cjs','shell/tasks/controlled-media-parameters.cjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r5-draft',b'controlled-trial-20261029-candidate-34-r6-draft')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r6'
 plan['scope']='managed-media-output-and-owned-range-read; bounded-generation-consent; explicit-reservation-reconciliation; authorization-default-off'
 plan['controlledMediaAuthorization']['assetHostsEnvironment']='PT_MEDIA_ASSET_HOSTS'
 plan['controlledMediaAuthorization']['assetHostsRequiredWhenEnabled']=True
 plan['controlledMediaAuthorization']['parameterPolicy']='controlled-media-single-v1'
 plan['controlledMediaAuthorization']['imageParameters']={'imageCount':1,'size':'2048x2048','seedream5SequentialImages':False}
 plan['controlledMediaAuthorization']['videoParameters']={'durationSeconds':5,'resolution':'720P','ratio':'16:9'}
 plan['omissions']=plan['omissions']+['python-video-input-upload-bridge','real-external-asset-tls-and-cdn-verification']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
