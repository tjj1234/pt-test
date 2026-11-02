#!/usr/bin/env python3
"""Freeze the four reviewed local product chains; preserve prior archives."""
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_r19',Path(__file__).with_name('package-northstar-candidate34-r19-draft.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
builder=parent.builder
builder.NAME='northstar-controlled-trial-20261102-candidate-34-r20-draft'
builder.PLAN=builder.OUT/(builder.NAME+'.sources.json')
builder.ARCHIVE=builder.OUT/(builder.NAME+'.tar.gz')
builder.UNIT=builder.OUT/'northstar-shell-candidate-34-r20-draft.service'
builder.CHECKSUM=builder.OUT/(builder.NAME+'.sha256')
builder.ADDITIONS += [
 'shell/db-migrations/024_conversation_reasoning_preference.sql',
 'shell/db-migrations/025_document_sources.sql',
 'shell/db-migrations/026_memory_provenance.sql',
 'shell/attachments/source-retrieval-candidate.cjs',
 'shell/attachments/source-search-worker.cjs',
 'shell/attachments/source-store.cjs',
 'shell/attachments/text-decode.cjs',
 'shell/memory/provenance-store.cjs',
 'shell/exports/portable-xlsx-candidate.cjs',
]
previous_build=builder.build
def build():
 output=previous_build()
 output[builder.UNIT]=output[builder.UNIT].replace(b'controlled-trial-20261031-candidate-34-r19-draft',b'controlled-trial-20261102-candidate-34-r20-draft').replace(b'Candidate 34 r19',b'Candidate 34 r20')
 plan=json.loads(output[builder.PLAN]);plan['revision']='r20'
 plan['scope']='four-local-product-chains; '+plan['scope']
 plan['localClosedChains']=['reasoning preference -> durable Run -> native SDK -> visible result -> reload','CSV analysis -> portable XLSX -> owned download -> history','source search -> SHA-bound citation -> Run -> deletion invalidation and cancellation','memory proposal -> host confirmation -> scoped recall -> source/delete invalidation and cold replay boundary']
 plan['deliveryDecision']='NOT_FINAL; NOT_DEPLOYABLE'
 plan['remainingProductGates']=['Context native automatic/manual compaction and cold checkpoint recovery','Skill publish/disable/version pin and native loader/tool wiring','audio/video understanding and timestamp provenance','PDF/OCR/legacy Office/ZIP and Chinese PDF','trusted web research, questions/approval/isolation','actual billing reconciliation and multimodal AUTO','same-archive Linux runtime and target configuration/acceptance/rollback']
 plan['reasoningPreference']={'migration':'024','authority':'conversation preference and durable Run snapshot; client chat override rejected'}
 plan['sourceRetrieval']={'migrations':['025'],'formats':['txt','md','csv','docx','xlsx','pptx'],'limits':'8 selected sources, 20MiB total, 5000 blocks per document, explicit coverage; bounded worker','deletion':'tombstone, cancel affected Runs, close warm sessions, advance cold replay boundary, physical file cleanup; durable failed-cleanup retry'}
 plan['memoryProvenance']={'migration':'026','authorization':'authenticated host confirmation only; unconfirmed model inference excluded','scope':['user','conversation'],'limits':'100 stored entries, 20 recalled entries and 4000 characters','legacy':'visible but unconfirmed; old model replay boundary advanced','deletion':'active cancellation, warm close, cold replay epoch; pending flag survives restart'}
 plan['docxInput']['omissions']=['PDF/OCR','legacy Office binary formats','original physical page locators']
 plan['conversationWordExport']['omissions']=['embedded attachment content','model-initiated structured-document tool','PDF Chinese export','unified Run artifact version index']
 output[builder.PLAN]=(json.dumps(plan,ensure_ascii=False,indent=2)+'\n').encode()
 return output
builder.build=build
if __name__=='__main__':builder.main()
