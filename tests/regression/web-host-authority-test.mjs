import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs'),{createTaskStore}=require('../../shell/tasks/store.cjs'),{createWebHostService}=require('../../shell/web/host-service.cjs');
test('trusted web host persists exact calls and fences identity, changed inputs, cancellation and lease',{timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'web-authority-'));let storage;
 try{
  storage=await createStorage({dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key')});const user=(await storage.repositories.auth.register({username:'web-authority',password:'FixturePass123'})).user,identity={userId:user.id,tenantId:user.tenant_id},tasks=createTaskStore(storage.adapter);let revision='fixture-v1',calls=0,blocked;
  const service=createWebHostService({db:storage.adapter,getPolicy:()=>({trustedDomains:['safe.example','duckduckgo.com'],maxBytes:131072,timeoutMs:1000,revision}),transportFactory:()=>async url=>{calls++;await blocked;return {statusCode:200,url,byteLength:7,content:url.includes('duckduckgo.com')?'<a class="result__a" href="https://safe.example/page">Verified source</a>':'content'};}});
  async function fixture(){const conversation=await storage.repositories.conversations.create(user.id),owner='owner-'+randomUUID();let {run}=await tasks.createRun(identity,{conversationId:conversation.id,idempotencyKey:randomUUID(),request:{question:'fixture'}},{owner,ttlMs:120000});await tasks.transition(identity,run.runId,'running',run.revision,owner);return {identity,runId:run.runId,leaseOwner:owner,args:{kind:'fetch',callId:'native-call',ordinal:0,args:{url:'https://safe.example/page'}}};}
  await t.test('same completed operation replays without new transport; changed input and foreign user denied',async()=>{
   const scope=await fixture(),before=calls;assert.equal((await service.execute(scope)).body.content,'content');assert.equal((await service.execute(scope)).body.content,'content');assert.equal(calls,before+1);
   await assert.rejects(service.execute({...scope,args:{...scope.args,args:{url:'https://safe.example/other'}}}),{code:'WEB_CALL_CONFLICT'});
   await assert.rejects(service.list({...identity,userId:randomUUID()},scope.runId),{code:'NOT_FOUND'});assert.equal((await service.list(identity,scope.runId)).sources[0].evidenceType,'page_content');
  });
  await t.test('search saves snippet evidence without pretending it is fetched page content',async()=>{
   const scope=await fixture();await service.execute({...scope,args:{kind:'search',callId:'search',ordinal:0,args:{query:'official',maxResults:5}}});const sources=(await service.list(identity,scope.runId)).sources;assert.equal(sources.length,1);assert.equal(sources[0].evidenceType,'search_snippet');
  });
  for(const mode of ['abort','lease','policy'])await t.test('in-flight '+mode+' blocks result publication and replay',async()=>{
   const scope=await fixture(),controller=new AbortController();let release;blocked=new Promise(r=>release=r);const before=calls,pending=service.execute({...scope,signal:controller.signal});pending.catch(()=>{});while(calls===before)await new Promise(r=>setTimeout(r,1));
   if(mode==='abort')controller.abort();if(mode==='lease')await storage.db.query("UPDATE agent_runs SET lease_owner='new-owner' WHERE run_id=$1",[scope.runId]);if(mode==='policy')revision='fixture-v2';release();await assert.rejects(pending);blocked=undefined;
   assert.equal((await service.list(identity,scope.runId)).sources.length,0);if(mode!=='lease')await assert.rejects(service.execute(scope));revision='fixture-v1';
  });
 }finally{await storage?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
