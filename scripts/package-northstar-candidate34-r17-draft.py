#!/usr/bin/env python3
"""Immutable Office input and conversation Word export increment; preserves r16."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r16',Path(__file__).with_name('package-northstar-candidate34-r16-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261031-candidate-34-r17-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r17-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
parent.closure_path=builder.OUT/'northstar-r17-dependency-closure-20261031.json'
builder.ADDITIONS+=['shell/attachments/ooxml-structured-text.cjs','shell/exports/conversation-docx.cjs','shell/exports/document-export-worker.cjs','shell/exports/document-export-candidate.cjs','shell/exports/document-input-guard-candidate.cjs']
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261030-candidate-34-r16-draft',b'controlled-trial-20261031-candidate-34-r17-draft').replace(b'Candidate 34 r16',b'Candidate 34 r17')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r17';plan['deliveryTarget']='2026-11-02 Monday; full scope remains open'
 plan['scope']='XLSX-PPTX-upload-source-context-and-conversation-DOCX-download; '+plan['scope']
 plan['dependencyClosure']={'file':parent.closure_path.name,'sha256':builder.sha(parent.closure_path.read_bytes()),'evidence':'r17-office-linux-install-20261031-r2.log'}
 plan['structuredOfficeInput']={'formats':['docx','xlsx','pptx'],'boundaries':'20MiB input, 64MiB expanded ZIP, 512 entries, two 128MiB workers, 15s absolute per-context cap','locations':['DOCX extracted blocks','XLSX original sheet/cell raw value','PPTX original slide/paragraph'],'omissions':['formula evaluation','implicit spreadsheet date conversion','charts and embedded media interpretation','PDF/OCR','legacy Office binary formats']}
 plan['conversationWordExport']={'entry':'conversation menu -> export Word; owned GET /api/conversations/:id/export?fmt=docx','evidence':'worker round-trip and real HTTP owned/cross-user/anonymous/history tests','limits':'2MiB source text, 2000 messages, 8000 paragraphs; two 128MiB workers; 10s timeout; source/output SHA headers','omissions':['embedded attachment content','model-initiated structured-document tool','PDF Chinese export','XLSX export','unified Run artifact index']}
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
