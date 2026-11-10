'use strict';
// Operator-only maintenance, never imported by the application. No migrations,
// revokes, ownership changes, PUBLIC grants or role elevation are performed.
const {openPg}=require('../shell/db-pg.cjs');
const {pgConfigured}=require('../shell/db.cjs');
const TABLES=Object.freeze([
 {name:'agent_question_scopes',migration:'029_user_questions.sql',privileges:['SELECT','INSERT','UPDATE']},
 {name:'agent_run_questions',migration:'029_user_questions.sql',privileges:['SELECT','INSERT','UPDATE']},
 {name:'model_request_attempts',migration:'030_model_request_attempts.sql',privileges:['SELECT','INSERT']},
 {name:'agent_web_calls',migration:'032_web_source_evidence.sql',privileges:['SELECT','INSERT','UPDATE']},
 {name:'pt_billing_credentials',migration:'033_billing_login_credentials.sql',privileges:['SELECT','INSERT','UPDATE','DELETE']},
]);
const fail=code=>Object.assign(new Error(code),{code});
async function repairRuntimeAcl(db,{expectedDatabase,runtimeRole,apply=false}={}){
 if(typeof expectedDatabase!=='string'||!expectedDatabase||typeof runtimeRole!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)||runtimeRole==='public'||typeof apply!=='boolean')throw fail('R34_ACL_INPUT_INVALID');
 return db.transaction(async tx=>{
  if(!apply)await tx.query('SET TRANSACTION READ ONLY');
  await tx.query("SET LOCAL lock_timeout='2s'");await tx.query("SET LOCAL statement_timeout='5s'");
  const {rows:[identity]}=await tx.query('SELECT current_user AS administrator, current_database() AS database');
  if(identity.database!==expectedDatabase)throw fail('R34_ACL_DATABASE_MISMATCH');
  const {rows:[role]}=await tx.query(`SELECT rolname,rolsuper,rolcanlogin,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1`,[runtimeRole]);
  if(!role||!role.rolcanlogin||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolbypassrls)throw fail('R34_ACL_RUNTIME_ROLE_REJECTED');
  const {rows:[schema]}=await tx.query("SELECT has_schema_privilege($1,'public','USAGE') AS allowed",[runtimeRole]);
  if(!schema.allowed)throw fail('R34_ACL_SCHEMA_USAGE_REQUIRED');
  if(apply){
   const {rows:[lock]}=await tx.query("SELECT pg_try_advisory_xact_lock(734030,3401) AS acquired");
   if(!lock.acquired)throw fail('R34_ACL_MAINTENANCE_BUSY');
   // Prevent concurrent table replacement or ACL changes while observing/granting.
   await tx.query('LOCK TABLE public.agent_question_scopes,public.agent_run_questions,public.model_request_attempts,public.agent_web_calls,public.pt_billing_credentials IN SHARE ROW EXCLUSIVE MODE');
  }
  const tables=[];
  for(const table of TABLES){
   const marker=await tx.query('SELECT 1 FROM public.schema_migrations WHERE name=$1',[table.migration]);
   if(marker.rows.length!==1)throw fail('R34_ACL_MIGRATION_REQUIRED');
   const {rows:[relation]}=await tx.query(`SELECT c.oid,c.relkind,c.relrowsecurity AS rls,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass($1)`,['public.'+table.name]);
   if(!relation||relation.relkind!=='r'||relation.rls)throw fail('R34_ACL_TABLE_POLICY_REJECTED');
   const before={},missing=[];
   for(const privilege of table.privileges){
    const {rows:[row]}=await tx.query('SELECT has_table_privilege($1,$2::oid,$3) AS allowed',[runtimeRole,relation.oid,privilege]);
    before[privilege]=row.allowed===true;if(!row.allowed)missing.push(privilege);
   }
   tables.push({table:'public.'+table.name,owner:relation.owner,oid:relation.oid,aclBefore:relation.acl,before,added:apply?missing:[],planned:missing});
  }
  // Validate the whole plan first, so a later table cannot leave a partial grant.
  if(apply)for(const table of tables){if(table.planned.length)await tx.query(`GRANT ${table.planned.join(',')} ON TABLE ${table.table} TO "${runtimeRole}"`);}
  if(apply)for(const table of tables){
   for(const privilege of Object.keys(table.before)){
    const {rows:[row]}=await tx.query('SELECT has_table_privilege($1,$2::oid,$3) AS allowed',[runtimeRole,table.oid,privilege]);
    if(row.allowed!==true)throw fail('R34_ACL_EFFECTIVE_GRANT_FAILED');
   }
  }
  return {scope:'R34_MINIMAL_RUNTIME_ACL',mode:apply?'APPLY':'READONLY_PLAN',database:identity.database,administrator:identity.administrator,runtimeRole,
   runtimeLoginVerification:'REQUIRED_SEPARATELY',tables};
 });
}
async function main(args=process.argv.slice(2)){
 const flags=new Map();for(let i=0;i<args.length;i+=2){if(!['--expect-database','--runtime-role','--mode'].includes(args[i])||flags.has(args[i])||!args[i+1])throw fail('R34_ACL_USAGE');flags.set(args[i],args[i+1]);}
 if(!['plan','apply'].includes(flags.get('--mode'))||!pgConfigured())throw fail('R34_ACL_USAGE');
 const connection=await openPg();try{
  const result=await repairRuntimeAcl(connection.db,{expectedDatabase:flags.get('--expect-database'),runtimeRole:flags.get('--runtime-role'),apply:flags.get('--mode')==='apply'});
  process.stdout.write(JSON.stringify(result)+'\n');return result;
 }finally{await connection.close();}
}
if(require.main===module)main().catch(error=>{const code=/^R34_ACL_[A-Z_]+$/.test(error.code||'')?error.code:'R34_ACL_OPERATION_FAILED';process.stderr.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;});
module.exports={repairRuntimeAcl,main};
