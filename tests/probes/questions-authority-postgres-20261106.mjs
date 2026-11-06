import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs'),{createTaskStore}=require('../../shell/tasks/store.cjs'),{createQuestionStore}=require('../../shell/questions/store.cjs'),{createQuestionManager}=require('../../shell/questions/manager.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('real PostgreSQL production store checks clock after waiting on a held Run lock',{timeout:30000},async()=>{
 assert.ok(process.env.PT_PG_DSN,'isolated PostgreSQL required');const temp=fs.mkdtempSync(path.join(os.tmpdir(),'question-pg-'));let a,b;
 try{
  a=await createStorage({masterKeyFile:path.join(temp,'key-a')});b=await createStorage({masterKeyFile:path.join(temp,'key-b')});
  const user=(await a.repositories.auth.register({username:'q-pg-'+randomUUID(),password:'FixturePass123'})).user;
  const identity={userId:user.id,tenantId:user.tenant_id},tasks=createTaskStore(a.adapter),conversation=await a.repositories.conversations.create(user.id),owner='owner-'+randomUUID();
  const run=(await tasks.createRun(identity,{conversationId:conversation.id,idempotencyKey:randomUUID(),request:{question:'fixture'}},{owner,ttlMs:120000})).run;
  await tasks.transition(identity,run.runId,'running',run.revision,owner);
  const scope={identity,runId:run.runId,callId:'native-call',leaseOwner:owner},storeA=createQuestionStore({db:a.adapter,...scope}),storeB=createQuestionStore({db:b.adapter,...scope});
  const manager=createQuestionManager({...identity,runId:run.runId,store:storeA});
  const waiting=manager.askQuestion('deadline',{question:'Deadline under lock',callId:scope.callId,timeoutMs:500});waiting.catch(()=>{});
  let record;while(!(record=await storeA.get('deadline')))await pause(2);
  let release,locked;const acquired=new Promise(r=>locked=r),gate=new Promise(r=>release=r);
  const hold=a.adapter.transaction(async tx=>{await tx.query('SELECT run_id FROM agent_runs WHERE run_id=$1 FOR UPDATE',[run.runId]);locked();await gate;});
  await acquired;
  const frozenNow=Date.now();assert.ok(frozenNow<record.deadline);
  const answer=storeB.updateStatusIfPending('deadline','answered',{answer:'yes',selectedOptions:['yes'],respondentUserId:identity.userId,respondentTenantId:identity.tenantId},{...identity,runId:run.runId,now:frozenNow});
  try{
   let lockWait=false;
   for(let n=0;n<50;n++){const rows=(await a.adapter.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM agent_runs%'",[])).rows;if(rows[0].count>0){lockWait=true;break;}await pause(5);}
   assert.equal(lockWait,true,'second production store must actually wait for row lock');
   await pause(Math.max(1,record.deadline-Date.now()+80));
  }finally{release();await hold;}
  const outcome=await answer;assert.equal(outcome.ok,false);assert.equal(outcome.code,'QUESTION_TIMEOUT');
  await assert.rejects(waiting,{code:'QUESTION_TIMEOUT'});assert.equal((await storeB.get('deadline')).status,'expired');
 }finally{await b?.close();await a?.close();fs.rmSync(temp,{recursive:true,force:true});}
});
