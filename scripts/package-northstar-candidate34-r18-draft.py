#!/usr/bin/env python3
"""Immutable live-Agent native tool Run gate; keeps public web tools disabled."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r17',Path(__file__).with_name('package-northstar-candidate34-r17-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261031-candidate-34-r18-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r18-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261031-candidate-34-r17-draft',b'controlled-trial-20261031-candidate-34-r18-draft').replace(b'Candidate 34 r17',b'Candidate 34 r18')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r18';plan['scope']='native-DSH-tools-live-Agent-Run-cancellation-budget-gate; '+plan['scope']
 plan['nativeToolAdmission']={'seam':'native tools/execute waterfall, exact Agent object identity','nativeNames':['ask_user_question','skill','web_search'],'policy':'explicit allowedTools plus current Run budget required; no implicit native admission','hostTools':'existing wrappers retain single admission; actual SDK count verified','denials':['foreign agent','cancelled/aborted','expired','unconfigured budget','out-of-scope native name','tool call limit'],'publicEnablement':'not enabled; web_fetch and OS tools remain denied; question/approval/Skill/provider product integration pending'}
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
