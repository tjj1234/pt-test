'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openPg}=require('../../shell/db-pg.cjs'),{createStorage}=require('../../shell/storage/index.cjs');
const {createTaskStore}=require('../../shell/tasks/store.cjs'),{createQuestionService}=require('../../shell/questions/service.cjs');
const {repairRuntimeAcl}=require('../../scripts/northstar-r34-runtime-acl.cjs'),{inspectRuntimeDatabase}=require('../../scripts/northstar-runtime-db-gate.cjs');
(async()=>{
 const env={...process.env},database='r34_acl_repair_fixture',role='r34_acl_runtime';
 assert.equal(env.PT_PG_DATABASE,database);assert.equal(env.PT_PG_HOST,'127.0.0.1');assert.equal(env.PT_PG_PORT,'65014');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'r34-acl-repair-')),admin=await openPg(),options={expectedDatabase:database,runtimeRole:role};let storage,runtime;
 try{
  await admin.db.exec('CREATE ROLE r34_acl_runtime LOGIN; GRANT USAGE,CREATE ON SCHEMA public TO r34_acl_runtime');
  const baseline=path.join(temp,'baseline');fs.mkdirSync(baseline);
  for(const file of fs.readdirSync(path.join(__dirname,'../../shell/db-migrations')).filter(f=>f.endsWith('.sql')&&!['029_user_questions.sql','030_model_request_attempts.sql','032_web_source_evidence.sql','033_billing_login_credentials.sql'].includes(f)))fs.copyFileSync(path.join(__dirname,'../../shell/db-migrations',file),path.join(baseline,file));
  process.env.PT_PG_USER=role;
  storage=await createStorage({migrationsDir:baseline,masterKeyFile:path.join(temp,'key')});
  const user=(await storage.repositories.auth.register({username:'r34-acl-test',password:'FixturePass123'})).user;
  const identity={userId:user.id,tenantId:user.tenant_id},conversation=await storage.repositories.conversations.create(user.id),tasks=createTaskStore(storage.adapter);
  let {run}=await tasks.createRun(identity,{conversationId:conversation.id,idempotencyKey:'acl-test',request:{question:'fixture'}},{owner:'acl-worker',ttlMs:120000});
  run=await tasks.transition(identity,run.runId,'running',run.revision,'acl-worker');
  const {migrate}=require('../../shell/db.cjs');await migrate(admin.db,path.join(__dirname,'../../shell/db-migrations'));
  runtime=await openPg({...env,PT_PG_USER:role});
  const audit=()=>inspectRuntimeDatabase(runtime.db,{expectedRole:role,expectedDatabase:database});
  assert.equal((await audit()).ok,false);
  const service=createQuestionService({db:runtime.db}),args={callId:'native-qa',questions:[{id:'scope',question:'Choose scope',options:['current','user']}]};
  await assert.rejects(service.ask({identity,runId:run.runId,leaseOwner:'acl-worker',args}),{code:'STORE_UNAVAILABLE'});
  console.log('PASS real runtime-owned baseline + administrator new migrations reproduces STORE_UNAVAILABLE');
  const plan=await repairRuntimeAcl(admin.db,options);assert.equal(plan.mode,'READONLY_PLAN');assert.ok(plan.tables.every(t=>t.planned.length>0));assert.equal((await audit()).ok,false);
  await assert.rejects(repairRuntimeAcl(admin.db,{...options,expectedDatabase:'other',apply:true}),{code:'R34_ACL_DATABASE_MISMATCH'});
  await assert.rejects(repairRuntimeAcl(admin.db,{...options,runtimeRole:'postgres',apply:true}),{code:'R34_ACL_RUNTIME_ROLE_REJECTED'});
  console.log('PASS readonly plan leaves ACL unchanged; wrong database and privileged runtime role rejected');
  const fault={transaction:callback=>admin.db.transaction(tx=>callback({...tx,query:async(sql,params)=>{
   if(sql.startsWith('GRANT')&&sql.includes('model_request_attempts'))throw Error('injected final grant failure');return tx.query(sql,params);
  }}))};
  await assert.rejects(repairRuntimeAcl(fault,{...options,apply:true}));
  assert.ok((await audit()).tables.every(t=>Object.values(t.privileges).every(v=>!v)));
  console.log('PASS late grant failure rolls back earlier grants in real PostgreSQL transaction');
  const applied=await repairRuntimeAcl(admin.db,{...options,apply:true});assert.deepEqual(applied.tables.map(t=>t.added),[['SELECT','INSERT','UPDATE'],['SELECT','INSERT','UPDATE'],['SELECT','INSERT'],['SELECT','INSERT','UPDATE'],['SELECT','INSERT','UPDATE','DELETE']]);
  assert.equal((await audit()).ok,true);
  for(const table of applied.tables){const {rows:[row]}=await admin.db.query("SELECT has_table_privilege($1,$2,'DELETE') AS allowed",[role,table.table]);assert.equal(row.allowed,table.table==='public.pt_billing_credentials');}
  assert.ok((await repairRuntimeAcl(admin.db,{...options,apply:true})).tables.every(t=>t.added.length===0));
  console.log('PASS minimal grants pass actual runtime login; DELETE only on dedicated billing credential table; reapply idempotent');
  const pending=service.ask({identity,runId:run.runId,leaseOwner:'acl-worker',args});pending.catch(()=>{});
  let listed;for(let n=0;n<100;n++){listed=await service.list(identity,run.runId);if(listed.questions.length)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(listed.questions[0].status,'pending');await service.answer(identity,run.runId,'scope',{callId:'native-qa',answer:{selected:['current']}});
  assert.deepEqual((await pending).answers,[{id:'scope',selected:['current']}]);
  await runtime.close();runtime=await openPg({...env,PT_PG_USER:role});
  assert.equal((await createQuestionService({db:runtime.db}).list(identity,run.runId)).questions[0].status,'answered');
  console.log('PASS actual question pending/answer/durable terminal survives runtime connection reopen');
 }finally{
  process.env.PT_PG_USER=env.PT_PG_USER;await runtime?.close();await storage?.close();await admin.close();fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
