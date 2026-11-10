import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createDocumentExportHandler}=require('../../shell/tasks/document-export-handler.cjs');
test('document export publishes no file or event after cancellation or lease loss',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'document-export-authority-'));
 try{for(const mode of ['cancelled','lease']){
  const controller=new AbortController();let checked=0,emitted=0;
  const handler=createDocumentExportHandler({workspaceRoot:root,identity:{userId:randomUUID(),tenantId:randomUUID()},runId:randomUUID(),assertLive:async()=>{checked++;if(mode==='lease'&&checked===2)throw Object.assign(Error('lease lost'),{code:'LEASE_LOST'});},emit:async()=>emitted++});
  if(mode==='cancelled')controller.abort();
  await assert.rejects(handler.handle({args:{format:'docx',document:{title:'bounded export',sections:[{paragraphs:['fixture']}] }},signal:controller.signal}),e=>e.code===(mode==='cancelled'?'DOCUMENT_EXPORT_CANCELLED':'LEASE_LOST'));
  assert.equal(emitted,0);assert.deepEqual(fs.readdirSync(root),[]);
 }}finally{fs.rmSync(root,{recursive:true,force:true});}
});
