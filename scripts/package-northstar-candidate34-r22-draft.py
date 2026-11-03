#!/usr/bin/env python3
"""Freeze recovered native Skill integration and PT contract compatibility; preserve r21."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r21',Path(__file__).with_name('package-northstar-candidate34-r21-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261103-candidate-34-r22-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r22-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS += ['shell/db-migrations/028_skill_publication.sql','shell/skills/publication-store.cjs','shell/runtime/published-skill-provider.mjs','shell/runtime/run-budget-skill.json','shell/runtime/run-budget-skill-csv.json','shell/runtime/run-budget-skill-media.json']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'20261102-candidate-34-r21-draft',b'20261103-candidate-34-r22-draft').replace(b'Candidate 34 r21',b'Candidate 34 r22')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r22';plan['scope']='owned immutable Skill publication and native loading; PT 401/402 compatibility; '+plan['scope']
 plan['localClosedChains'].append('owned Skill publication -> fixed release Run pin -> native registry/loader -> bounded supporting text -> result/history -> disable/revocation')
 plan['remainingProductGates']=[gate for gate in plan['remainingProductGates'] if not gate.startswith('Skill ')]
 plan['publishedSkills']={'migration':'028','scope':'owner tenant; one selected release per Run','content':'SKILL.md plus up to15 supporting text files,256KiB total; no script execution or capability grants','versions':'immutable content; new Runs select active release; existing Run retains prior pin','revocation':'disable blocks new/queued access, cancels active owner Runs, closes warm sessions and clears native checkpoints; durable failed cleanup retry','evidence':'skill-chain-checks-20261103.json; local controlled native SDK/browser only'}
 plan['ptContractCompatibility']={'A04':'401 invalid Key;402 insufficient balance;legacy403 compatibility until PT confirms rollout','A11':'duration safe integer internally;existing /v1/videos wire seconds string; exact duration alias requires PT confirmation','productionRollout':'unconfirmed; no paid acceptance'}
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
