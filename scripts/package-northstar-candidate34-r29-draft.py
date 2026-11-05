#!/usr/bin/env python3
"""Freeze the isolated r28 bugfix candidate; never rewrite r28 artifacts."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('r28_builder',Path(__file__).with_name('package-northstar-candidate34-r28-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261105-candidate-34-r29-bugfix-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r29-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 outputs=previous_build()
 outputs[builder.UNIT]=outputs[builder.UNIT].replace(b'controlled-trial-20261103-candidate-34-r28-draft',b'controlled-trial-20261105-candidate-34-r29-bugfix-draft').replace(b'Candidate 34 r28',b'Candidate 34 r29 bugfix')
 plan=json.loads(outputs[builder.PLAN]);plan['revision']='r29-bugfix';plan['bugfixScope']={'codeCommit':'db94e425d3746db8c7ab138b462049f5f8a7c5f2','baseCommit':'bbd9997d1e19920dc1c850c31ec6c71dbc5994d1','htmlPreview':'DEGRADED_PREVIEW','geminiEightPackages':'not integrated','targetDeployment':'pending','independentQA':'pending'}
 outputs[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return outputs
builder.build=build
if __name__=='__main__':builder.main()
