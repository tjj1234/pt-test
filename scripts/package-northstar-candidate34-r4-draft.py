#!/usr/bin/env python3
"""Freeze explicit consent/reconciliation wiring without replacing older drafts."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r3',Path(__file__).with_name('package-northstar-candidate34-r3-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261028-candidate-34-r4-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r4-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS=builder.ADDITIONS+[
 'shell/db-migrations/023_controlled_media_reservation_release.sql',
 'shell/tasks/media-authorization.cjs',
 'shell/tasks/media-reservation-reconciliation-candidate.cjs',
 'shell/tasks/media-reservation-release-candidate.cjs',
]
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261028-candidate-34-r3-draft',b'controlled-trial-20261028-candidate-34-r4-draft')
 plan=json.loads(output[builder.PLAN])
 plan['revision']='r4'
 plan['scope']='owned-run-media-consent-and-durable-grant; explicit-reservation-reconciliation; authorization-default-off'
 plan['controlledMediaAuthorization']={'enabledByDefault':False,'enableEnvironment':'PT_CONTROLLED_MEDIA_AUTHORIZATION=1','maxExternalSubmissions':1,'maxRetries':0,'monetaryCapEnforced':False}
 plan['omissions']=['live-model-and-four-media-acceptance','media-price-and-credits-budget-confirmation','monetary-hard-cap','same-archive-clean-linux-and-python-verification','reservation-history-ui-integration','target-deployment-and-rollback']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
