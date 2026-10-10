'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createPgCompatPool}=require('../../../analytics/lib/db.cjs');
const {createGaStore}=require('./store');
const {createGaConnector}=require('./index');
const {buildUnifiedServer}=require('../../../analytics/backend/server');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const url='/api/business/ga-connector/connection',status='/api/business/ga-connector/status';
const disconnected={ok:true,connected:false,propertyId:null,updatedAt:null};
let pool,store,app,dir,googleCalls=0;
const headers={authorization:'Bearer A'};
before(async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'pt-ga-disconnect-'));
 pool=await createPgCompatPool({dataDir:dir,migrationsDir:path.resolve(__dirname,'../../../analytics/backend/db')});
 store=createGaStore({pool,key:crypto.randomBytes(32)});
 const auth={A:{tenant_id:A,scopes:['analytics:read']},B:{tenant_id:B,scopes:['analytics:read']},expired:{tenant_id:A,scopes:['analytics:read'],expires_at:0},readonlyMissing:{tenant_id:A,scopes:[]},badTenant:{tenant_id:'invalid',scopes:['analytics:read']}};
 app=buildUnifiedServer({pool,logger:false,verifyAnalyticsToken:async token=>auth[token]||null});
 await app.ready();
});
beforeEach(async()=>{await store.save(A,'12345','secret-A');await store.save(B,'67890','secret-B');});
after(async()=>{await app?.close();await pool?.end();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
async function rows(tenantId){
 const c=await pool.connect();
 try {
  await c.query('BEGIN');await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenantId]);
  const result=(await c.query('SELECT tenant_id,property_id FROM ga_connections WHERE tenant_id=$1::uuid',[tenantId])).rows;
  await c.query('COMMIT');return result;
 } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
}
test('disconnect physically deletes own connection, status becomes disconnected and repeat is idempotent without Google config',async()=>{
 assert.equal((await app.inject({method:'GET',url:status,headers})).json().connected,true);
 assert.equal((await rows(A))[0].property_id,'12345');
 const r=await app.inject({method:'DELETE',url,headers});
 assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');assert.deepEqual(r.json(),disconnected);
 assert.deepEqual(await rows(A),[]);assert.equal(await store.get(A),null);
 assert.deepEqual((await app.inject({method:'GET',url:status,headers})).json(),disconnected);
 const repeat=await app.inject({method:'DELETE',url,headers});assert.equal(repeat.statusCode,200);assert.deepEqual(repeat.json(),disconnected);
 const connector=createGaConnector({store,google:{refresh:async()=>{googleCalls++;throw new Error('must not reach Google');}}});
 await assert.rejects(()=>connector.query(A,{metrics:['activeUsers'],dateRange:{startDate:'yesterday',endDate:'today'}}),{code:'GA_AUTHORIZATION_REQUIRED'});
 assert.equal(googleCalls,0);
});
test('disconnect ignores injected tenant/property identifiers and RLS prevents deleting another tenant',async()=>{
 const c=await pool.connect();
 try {
  await c.query('BEGIN');await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
  assert.equal((await c.query('DELETE FROM ga_connections WHERE tenant_id=$1::uuid',[B])).rowCount,0);
  await c.query('COMMIT');
 } finally {c.release();}
 const r=await app.inject({method:'DELETE',url:url+'?tenantId='+B+'&propertyId=67890',headers,payload:{tenantId:B,propertyId:'67890'}});
 assert.equal(r.statusCode,200);assert.deepEqual(await rows(A),[]);
 assert.equal((await rows(B))[0].property_id,'67890');assert.equal((await store.get(B)).refreshToken,'secret-B');
 const other=(await app.inject({method:'GET',url:status,headers:{authorization:'Bearer B'}})).json();
 assert.equal(other.connected,true);assert.equal(other.propertyId,'67890');
});
test('disconnect auth failures never delete either tenant connection',async()=>{
 const cases=[[undefined,401],['expired',401],['unknown',403],['readonlyMissing',403],['badTenant',403]];
 for(const [token,code] of cases){
  const r=await app.inject({method:'DELETE',url,headers:token?{authorization:'Bearer '+token}:{}});
  assert.equal(r.statusCode,code);
 }
 assert.equal((await rows(A))[0].property_id,'12345');assert.equal((await rows(B))[0].property_id,'67890');
});
