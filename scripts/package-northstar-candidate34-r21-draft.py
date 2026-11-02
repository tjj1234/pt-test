#!/usr/bin/env python3
"""Freeze native Context integration without changing r20."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r20',Path(__file__).with_name('package-northstar-candidate34-r20-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261102-candidate-34-r21-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r21-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS+=['shell/db-migrations/027_native_context_session.sql','shell/runtime/dsh-native-context-r4-candidate.mjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'candidate-34-r20-draft',b'candidate-34-r21-draft').replace(b'Candidate 34 r20',b'Candidate 34 r21')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r21';plan['scope']='native-Context-compaction-and-durable-recovery; '+plan['scope']
 plan['localClosedChains'].append('native automatic/manual compaction -> separate budget/intent/usage -> JSONL checkpoint -> whole-process restart recovery -> revocation invalidation')
 plan['remainingProductGates']=[gate for gate in plan['remainingProductGates'] if not gate.startswith('Context ')]
 plan['nativeContext']={'migration':'027','nativePlugins':['compaction-basic','token-meter','session-persistence-jsonl'],'automatic':'native 80 percent pressure and 16 percent recent-tail retention','manual':'owned conversation menu -> persistent Run -> compactNow','authority':'host-owned conversation plus credential SHA and current Run; client restore identity forbidden','budgets':'3 combined model calls: at most 2 ordinary plus 1 auxiliary; default retry 1, CSV/media retry 0; external media submission remains single-grant','usage':'native summary response retained; interrupted uncommitted auxiliary usage explicitly unknown','revocation':'source/memory cleanup clears persisted native mapping and closes warm state','evidence':'CONTEXT-PRODUCT-LOCAL-ACCEPTANCE-20261102.md; local fixture provider only'}
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
