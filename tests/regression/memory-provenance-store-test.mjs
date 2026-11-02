import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs'),{createMemoryProvenanceStore}=require('../../shell/memory/provenance-store.cjs'),{createSourceStore}=require('../../shell/attachments/source-store.cjs');
test('memory host confirmation scope source lifecycle and failed cleanup survive database reopen',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-provenance-'));let storage;
 try{
  const options={dataDir:path.join(temp,'db'),masterKeyFile:path.join(temp,'key')};storage=await createStorage(options);
  const user=(await storage.repositories.auth.register({username:'memory-owner',email:'memory@example.test',password:'FixturePass123'})).user;
  const other=(await storage.repositories.auth.register({username:'memory-other',email:'other@example.test',password:'FixturePass123'})).user;
  const identity={userId:user.id,tenantId:user.tenant_id},foreign={userId:other.id,tenantId:other.tenant_id};
  const c1=await storage.repositories.conversations.create(user.id),c2=await storage.repositories.conversations.create(user.id);
  await storage.repositories.conversations.saveMessages(user.id,c1.id,[{role:'user',text:'old context'},{role:'assistant',text:'old memory answer'}]);
  let failCleanup=false;const make=()=>createMemoryProvenanceStore({db:storage.db,onInvalidate:async()=>{if(failCleanup)throw Error('fixture');}});let memory=make();
  await assert.rejects(memory.set(identity,{key:'forged',value:'x',confirmed:true,provenance:'user-explicit-confirmation'}),{code:'MEMORY_INPUT_INVALID'});
  const proposal=await memory.set(identity,{key:'proposal',value:'inferred',mode:'proposal',scope:'conversation',conversationId:c1.id});
  assert.equal((await memory.recall(identity,{conversationId:c1.id})).lines.length,0);
  await assert.rejects(memory.confirm(foreign,proposal.id),{code:'MEMORY_NOT_FOUND'});
  await memory.confirm(identity,proposal.id);
  assert.deepEqual((await memory.recall(identity,{conversationId:c1.id})).lines,['proposal=inferred']);assert.equal((await memory.recall(identity,{conversationId:c2.id})).lines.length,0);
  const uploadsRoot=path.join(temp,'uploads'),bytes=Buffer.from('document memory'),name='b'.repeat(32)+'.txt',ref='/uploads/'+identity.tenantId+'/'+name;
  fs.mkdirSync(path.join(uploadsRoot,identity.tenantId),{recursive:true});fs.writeFileSync(path.join(uploadsRoot,identity.tenantId,name),bytes);
  const sources=createSourceStore({db:storage.db,uploadsRoot,onRevoke:async()=>{}});const source=await sources.register(identity,{ref,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,format:'txt',name});
  await memory.set(identity,{key:'document',value:'fact',sourceId:source.id});assert.equal((await memory.recall(identity,{conversationId:c2.id})).lines.length,1);
  await sources.revoke(identity,source.id);assert.equal((await memory.recall(identity,{conversationId:c2.id})).lines.length,0);
  assert.equal((await memory.list(identity)).find(row=>row.key==='document').sourceValid,false);
  failCleanup=true;await assert.rejects(memory.del(identity,{id:proposal.id}),{code:'MEMORY_CONTEXT_INVALIDATION_FAILED'});
  assert.equal((await storage.repositories.conversations.get(user.id,c1.id)).memory_revocation_pending,true);
  await storage.close();storage=await createStorage(options);memory=make();
  assert.equal((await storage.repositories.conversations.get(user.id,c1.id)).memory_revocation_pending,true);
  failCleanup=false;await memory.recover(identity);const recovered=await storage.repositories.conversations.get(user.id,c1.id);assert.equal(recovered.memory_revocation_pending,false);assert.equal(recovered.source_context_start,2);assert.equal(recovered.messages.length,2);
  assert.equal((await memory.list(foreign)).length,0);
 }finally{await storage?.close();fs.rmSync(temp,{recursive:true,force:true});}
});
