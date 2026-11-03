import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs'),{createSkillPublicationStore}=require('../../shell/skills/publication-store.cjs');
const release=version=>({skillId:'review-fixture',version,files:[{path:'SKILL.md',content:'---\nname: review-fixture\ndescription: Review owned fixture data\n---\nUse version '+version+' instructions.'},{path:'references/rules.md',content:'Read-only supporting fixture.'}]});
test('publication pins immutable versions, isolates owners and survives failed disable cleanup/reopen',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'skill-store-'));let storage;
 try{
  const options={dataDir:path.join(temp,'db'),masterKeyFile:path.join(temp,'key')};storage=await createStorage(options);
  const user=(await storage.repositories.auth.register({username:'publisher',password:'FixturePass123'})).user,other=(await storage.repositories.auth.register({username:'other-publisher',password:'FixturePass123'})).user;
  const identity={userId:user.id,tenantId:user.tenant_id},foreign={userId:other.id,tenantId:other.tenant_id};let rejectCleanup=false,cleanupWait;
  const make=()=>createSkillPublicationStore({db:storage.db,onInvalidate:async()=>{if(cleanupWait)await cleanupWait;if(rejectCleanup)throw Error('fixture');}});let skills=make();
  const v1=await skills.publish(identity,release('1.0.0'));const pin=await skills.pin(identity,[v1.releaseId]);
  const changed=release('1.0.0');changed.files[0].content+=' changed';await assert.rejects(skills.publish(identity,changed),{code:'SKILL_VERSION_IMMUTABLE'});
  await skills.publish(identity,release('2.0.0'));assert.match((await skills.readPinned(identity,JSON.parse(JSON.stringify(pin)),v1.releaseId)).body,/1.0.0/);
  const persisted=(await storage.db.query('SELECT $1::jsonb AS pin',[JSON.stringify(pin)])).rows[0].pin;assert.match((await skills.readPinned(identity,persisted,v1.releaseId)).body,/1.0.0/);
  await assert.rejects(skills.pin(foreign,[v1.releaseId]),{code:'SKILL_NOT_AVAILABLE'});await assert.rejects(skills.readPinned(foreign,pin,v1.releaseId),{code:'SKILL_NOT_AVAILABLE'});
  assert.equal((await skills.list(foreign)).length,0);
  const conversation=await storage.repositories.conversations.create(user.id);rejectCleanup=true;await assert.rejects(skills.disable(identity,'review-fixture'),{code:'SKILL_CLEANUP_PENDING'});
  await assert.rejects(skills.readPinned(identity,pin,v1.releaseId),{code:'SKILL_NOT_AVAILABLE'});
  assert.equal((await storage.db.query('SELECT skill_revocation_pending FROM conversations WHERE id=$1',[conversation.id])).rows[0].skill_revocation_pending,true);
  await storage.close();storage=await createStorage(options);skills=make();assert.equal((await skills.list(identity))[0].pending_cleanup,true);
  rejectCleanup=false;await skills.disable(identity,'review-fixture');assert.equal((await skills.list(identity))[0].pending_cleanup,false);
  assert.equal((await storage.db.query('SELECT skill_revocation_pending FROM conversations WHERE id=$1',[conversation.id])).rows[0].skill_revocation_pending,false);
  await skills.publish(identity,release('3.0.0'));let finishCleanup;cleanupWait=new Promise(resolve=>finishCleanup=resolve);const disabling=skills.disable(identity,'review-fixture');
  while(!(await skills.list(identity))[0].pending_cleanup)await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(skills.publish(identity,release('4.0.0')),{code:'SKILL_UPDATE_BUSY'});finishCleanup();await disabling;cleanupWait=null;assert.equal((await skills.list(identity))[0].enabled,false);
  const traversal=release('3.0.0');traversal.files.push({path:'../outside.md',content:'x'});await assert.rejects(skills.publish(identity,traversal),{code:'SKILL_RELEASE_INVALID'});
 }finally{await storage?.close();fs.rmSync(temp,{recursive:true,force:true});}
});
