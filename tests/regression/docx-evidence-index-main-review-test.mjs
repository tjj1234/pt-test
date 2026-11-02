import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildDocxEvidenceIndex,verifyDocxEvidenceIndex}=require('../../shell/attachments/docx-evidence-index.cjs');
test('persisted DOCX evidence requires current source and version and rejects derived-field tampering',()=>{
 const target={tenantId:'tenant-a',documentId:'doc',sourceSha256:'a'.repeat(64),version:1};
 const index=buildDocxEvidenceIndex({...target,blocks:[{index:1,text:'中文00123🙂'}]});
 assert.equal(verifyDocxEvidenceIndex(index,target),true);
 assert.equal(verifyDocxEvidenceIndex(index,{tenantId:'tenant-a',documentId:'doc'}),false);
 for(const mutate of [x=>{x.blocks[0].text='tampered';},x=>{x.blocks[0].charEnd++;},x=>{x.summary.coverageHash='b'.repeat(64);}]){
  const changed=structuredClone(index);mutate(changed);assert.equal(verifyDocxEvidenceIndex(changed,target),false);
 }
 assert.equal(verifyDocxEvidenceIndex(index,{...target,tenantId:'tenant-b'}),false);
 assert.equal(verifyDocxEvidenceIndex(index,{...target,version:2}),false);
});
