#!/usr/bin/env python3
"""Immutable DOCX/configuration repair draft with a fresh Linux dependency closure."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r15',Path(__file__).with_name('package-northstar-candidate34-r15-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261030-candidate-34-r16-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r16-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS+=['shell/attachments/office-zip-guard.cjs','shell/attachments/office-document-worker.cjs','shell/attachments/office-document-parser.cjs','shell/attachments/docx-evidence-index-candidate.cjs','shell/attachments/docx-evidence-index.cjs','shell/models/dsh-configured-catalog.cjs']
closure_path=builder.OUT/'northstar-r16-dependency-closure-20261030.json'
previous_inputs=builder.inputs
def inputs():
 members,data,unit=previous_inputs()
 data['shell/dependency-closure-manifest.json']=closure_path.read_bytes()
 return members,data,unit
builder.inputs=inputs
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261030-candidate-34-r15-draft',b'controlled-trial-20261030-candidate-34-r16-draft').replace(b'Candidate 34 r15',b'Candidate 34 r16')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r16'
 plan['scope']='r14-model-registry-consistency-safe-errors-and-bounded-DOCX-input; '+plan['scope']
 plan['dependencyClosure']={'file':closure_path.name,'sha256':builder.sha(closure_path.read_bytes()),'evidence':'r16-linux-install-20261030-r2.log; Linux/amd64 Node22.23.4, 495 packages, 31007 files'}
 plan['configurationRepair']={'activeSettings':'catalog reads actual DSH home settings; unregistered chat routes denied; discovery does not register models','manualAdditions':['deepseek-flash','deepseek-v4-1-flash-260910'],'upgrade':'offline settings review/upgrade and profile rebuild required; no startup overwrite','errors':['UNKNOWN_MODEL','NO_ADAPTER','INVALID_REQUEST'],'targetAcceptance':'pending operations'}
 plan['docxInput']={'limits':'20MiB input, 64MiB expanded ZIP, 512 entries, 2 workers; cancellation/timeout','index':'SHA/version checked against rebuilt derived fields; UTF16 offsets, no physical page claims','omissions':['cross-file retrieval','citation UI','persistent index']}
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
