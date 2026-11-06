#!/usr/bin/env python3
"""Freeze ordinary-question M1 separately; never rewrite the deployed R31."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('r31_builder',Path(__file__).with_name('package-northstar-candidate34-r31-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.ADDITIONS=list(dict.fromkeys([*builder.ADDITIONS,'shell/questions/manager.cjs','shell/questions/store.cjs','shell/questions/service.cjs','shell/runtime/native-question-provider.mjs','shell/runtime/run-budget-questions.json','shell/db-migrations/029_user_questions.sql']))
builder.NAME='northstar-controlled-trial-20261106-candidate-34-r32-questions-m1-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r32-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build

def build():
    outputs=previous_build()
    outputs[builder.UNIT]=outputs[builder.UNIT].replace(b'controlled-trial-20261106-candidate-34-r31-batch5-draft',builder.NAME.removeprefix('northstar-').encode()).replace(b'Candidate 34 r31 batch5',b'Candidate 34 r32 questions M1')
    plan=json.loads(outputs[builder.PLAN]);plan['revision']='r32-questions-m1'
    plan['questionsM1Scope']={'codeCommit':'b714e69','baseCommit':'f02df3b','authorCommit':'d78d5c9cc745a3b22b752ff27d1c3d3b84dfefa7','included':['opt-in ordinary clarification','production SQL authority','native SDK and owned HTTP/UI'],'excluded':['approval','filesystem','scripts','other Gemini packages'],'targetDeployment':'not performed','independentQA':'pending','realProviderAcceptance':'not performed'}
    plan['bugfixScope']['geminiEightPackages']='ordinary clarification M1 only; eight packages not complete'
    outputs[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
    return outputs
builder.build=build
if __name__=='__main__':builder.main()
