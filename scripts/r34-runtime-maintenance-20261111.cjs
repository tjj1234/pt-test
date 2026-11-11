'use strict';
// Explicit operator step. Environment is supplied by the existing service file.
const path=require('node:path');
async function main(){
 const [root,database,mode]=process.argv.slice(2);
 if(!path.isAbsolute(root)||!/^northstar(?:_r34_verify_[0-9]+)?$/.test(database)||!['verify','import'].includes(mode))throw Error('R34_MAINTENANCE_SCOPE');
 if(process.env.PT_PG_DSN){const uri=new URL(process.env.PT_PG_DSN);if(decodeURIComponent(uri.pathname.slice(1))!=='northstar'||uri.searchParams.has('database')||uri.searchParams.has('dbname')||uri.searchParams.has('user'))throw Error('R34_MAINTENANCE_DSN_SCOPE');uri.pathname='/'+database;process.env.PT_PG_DSN=uri.href;}
 else if((process.env.PT_PG_DATABASE||process.env.PT_PG_DB||'northstar')!=='northstar')throw Error('R34_MAINTENANCE_DATABASE_SCOPE');
 process.env.PT_PG_DATABASE=database;process.env.PT_PG_DB=database;
 const {openPg}=require(path.join(root,'shell/db-pg.cjs'));const connection=await openPg();
 try{
  const gate=await require(path.join(root,'scripts/northstar-runtime-db-gate.cjs')).inspectRuntimeDatabase(connection.db,{expectedRole:'northstar_app',expectedDatabase:database});
  if(!gate.ok)throw Error('R34_RUNTIME_ACL_FAILED');console.log(JSON.stringify(gate));
  if(mode==='import'){
   const input=require(path.join(root,'shell/usage/reviewed-text-prices-20261110.json'));
   const now=Date.now();for(const model of ['deepseek-v4-pro','glm-4.7'])if(!input.snapshots.some(s=>s.model===model&&Date.parse(s.effectiveFrom)<=now&&(s.effectiveUntil===null||now<Date.parse(s.effectiveUntil))))throw Error('R34_REVIEWED_PRICE_EXPIRED');
   const result=await connection.db.transaction(async tx=>{await tx.query("SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s'");await tx.query("SELECT pg_advisory_xact_lock(hashtext('northstar-reviewed-price-import'))");return require(path.join(root,'shell/usage/price-catalog-store.cjs')).createTextPriceCatalogStore(tx).importCatalog({...input,reviewed:true});});
   for(const model of ['deepseek-v4-pro','glm-4.7']){const selected=await require(path.join(root,'shell/usage/price-catalog-store.cjs')).createTextPriceCatalogStore(connection.db).selectNow(model);if(!selected.snapshot)throw Error('R34_PRICE_SELECTION_FAILED');}
   console.log(JSON.stringify({scope:'REVIEWED_PRICE_IMPORT',...result}));
  }
 }finally{await connection.close();}
}
main().catch(error=>{console.error(/^R34_[A-Z_]+$/.test(error.message)?error.message:'R34_RUNTIME_MAINTENANCE_FAILED');process.exitCode=1;});
