#!/usr/bin/env python3
"""Freeze local pre-dispatch AUTO M1 separately from deployed R33."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('r33_builder',Path(__file__).with_name('package-northstar-candidate34-r33-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.ADDITIONS=list(dict.fromkeys([*builder.ADDITIONS,'shell/models/auto-route-policy.cjs','shell/db-migrations/030_model_request_attempts.sql']))
builder.NAME='northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json');builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz');builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r34-draft.service';builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
previous_build=builder.build

def build():
 out=previous_build()
 out[builder.UNIT]=out[builder.UNIT].replace(b'Candidate 34 r33 questions M1',b'Candidate 34 r34 AUTO pre-dispatch M1')
 p=json.loads(out[builder.PLAN]);p['revision']='r34-auto08-pre-dispatch-m1'
 p['auto08Scope']={'codeCommit':'f5fa39a','baseCommit':'88d6535','included':['trusted host candidate ordering via existing routeChatTask','durable per-Run logical model request submission fence','scope and capability revision check before permit'],'excluded':['post-submission fallback','zero-charge guarantee','04 web integration','batch3 bug candidate'],'configuration':'optional host PT_AUTO08_ROUTE_CONFIG_FILE; unset preserves existing candidate order','recovery':'a prior worker reservation blocks automatic continuation of the same Run; requires explicit reconciliation','deployment':'not performed','independentQA':'pending','realProviderAcceptance':'not performed'}
 p['bugfixScope']['geminiEightPackages']='ordinary clarification and local AUTO pre-dispatch M1 only; eight packages not complete'
 out[builder.PLAN]=(json.dumps(p,ensure_ascii=False,indent=2)+'\n').encode();return out
builder.build=build
if __name__=='__main__':builder.main()
