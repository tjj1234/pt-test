import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs'),{createSourceStore}=require('../../shell/attachments/source-store.cjs');
test('source revocation remains fail-closed across cleanup failure, retry and database reopen',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'source-store-'));let storage;
 try{
  const options={dataDir:path.join(temp,'db'),masterKeyFile:path.join(temp,'key')};storage=await createStorage(options);
  const user=(await storage.repositories.auth.register({username:'source-owner',email:'source-owner@example.test',password:'FixturePass123'})).user;
  const identity={userId:user.id,tenantId:user.tenant_id},uploadsRoot=path.join(temp,'uploads'),name='a'.repeat(32)+'.txt',ref='/uploads/'+identity.tenantId+'/'+name,bytes=Buffer.from('revoked source needle');
  fs.mkdirSync(path.join(uploadsRoot,identity.tenantId),{recursive:true});fs.writeFileSync(path.join(uploadsRoot,identity.tenantId,name),bytes);
  let rejectCleanup=true;const make=()=>createSourceStore({db:storage.db,uploadsRoot,onRevoke:async()=>{if(rejectCleanup)throw Error('fixture failure');}});let sources=make();
  const source=await sources.register(identity,{ref,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,format:'txt',name:'plain.txt'});
  const conversation=await storage.repositories.conversations.create(user.id);await storage.repositories.conversations.saveMessages(user.id,conversation.id,[{role:'user',text:'read',documents:[ref]},{role:'assistant',text:'derived source summary'}]);
  const result=await sources.search(identity,{sourceIds:[source.id],query:'needle'});assert.equal(result.returnedCount,1);
  await assert.rejects(sources.revoke(identity,source.id),{code:'SOURCE_REVOCATION_PENDING'});
  assert.equal((await storage.repositories.conversations.get(user.id,conversation.id)).source_revocation_pending,true);
  await assert.rejects(sources.search(identity,{sourceIds:[source.id],query:'needle'}),{code:'SOURCE_NOT_FOUND'});
  await assert.rejects(sources.assertLive(identity,[ref]),{code:'SOURCE_DELETED'});
  await storage.close();storage=await createStorage(options);sources=make();
  assert.equal((await sources.list(identity))[0].pendingCleanup,true);
  rejectCleanup=false;assert.equal((await sources.revoke(identity,source.id)).deleted,true);
  const current=await storage.repositories.conversations.get(user.id,conversation.id);assert.equal(current.source_revocation_pending,false);assert.equal(current.source_context_start,2);assert.equal(current.messages.length,2);
  assert.equal(fs.existsSync(path.join(uploadsRoot,identity.tenantId,name)),false);assert.equal((await sources.list(identity)).length,0);
  assert.equal((await sources.revoke(identity,source.id)).alreadyDeleted,true);
 }finally{await storage?.close();fs.rmSync(temp,{recursive:true,force:true});}
});
