"use strict";
const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createPgCompatPool} = require('../../../analytics/lib/db.cjs');
const {createGaStore,readGaConnectionStatus} = require('./store');
const {createGoogleClient,SCOPE} = require('./client');
const {createGaConnector,gaQueryToolDefinition,validateArgs,connectorFromEnv} = require('./index');
const {buildUnifiedServer} = require('../../../analytics/backend/server');
const {renderReportHTML} = require('../../../shell/public/report-render');
const {validateOutput} = require('../../../analytics/backend/glue/validate');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const args={metrics:['activeUsers'],dimensions:['country'],dateRange:{startDate:'2026-09-01',endDate:'2026-09-30'},format:'table'};
let pool,store,app,dir,key,requests=[];
const mockFetch=async(url,options)=>{
 requests.push({url,options});
 if(url.includes('/token')) {
  const p=new URLSearchParams(options.body);
  return {ok:true,json:async()=>p.get('grant_type')==='authorization_code'?{access_token:'access',refresh_token:'refresh-secret',scope:SCOPE}:{access_token:'access'}};
 }
 return {ok:true,json:async()=>({dimensionHeaders:[{name:'country'}],metricHeaders:[{name:'activeUsers',type:'TYPE_INTEGER'}],rows:[{dimensionValues:[{value:'Japan<script>'}],metricValues:[{value:'42'}]}],rowCount:1,metadata:{timeZone:'Asia/Tokyo'}})};
};
before(async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'pt-ga-test-'));key=crypto.randomBytes(32);
 pool=await createPgCompatPool({dataDir:dir,migrationsDir:path.resolve(__dirname,'../../../analytics/backend/db')});
 store=createGaStore({pool,key});
 const connector=createGaConnector({store,google:createGoogleClient({clientId:'client',clientSecret:'secret',redirectUri:'http://localhost:3000/api/business/ga-connector/oauth/callback',fetchImpl:mockFetch})});
 app=buildUnifiedServer({pool,logger:false,gaConnector:connector,verifyAnalyticsToken:async token=>token==='A'?{tenant_id:A,scopes:['analytics:read']}:token==='B'?{tenant_id:B,scopes:['analytics:read']}:token==='expired'?{tenant_id:A,scopes:['analytics:read'],expires_at:0}:null});
 await app.ready();
});
after(async()=>{await app?.close();await pool?.end();fs.rmSync(dir,{recursive:true,force:true});});
const headers={authorization:'Bearer A',cookie:'pt_session=test-session'};
async function authorize() {
 const r=await app.inject({method:'GET',url:'/api/business/ga-connector/oauth/authorize?propertyId=12345',headers});assert.equal(r.statusCode,302);return new URL(r.headers.location);
}
test('real HTTP auth gate and input validation',async()=>{
 assert.equal((await app.inject({method:'GET',url:'/api/business/ga-connector/oauth/authorize'})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/api/business/ga-connector/oauth/authorize?propertyId=123',headers:{authorization:'Bearer expired'}})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/api/business/ga-connector/oauth/authorize?propertyId=bad',headers})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/business/ga-connector/query',headers,payload:args})).statusCode,409);
 assert.throws(()=>validateArgs({...args,tenantId:B}));
 assert.throws(()=>validateArgs({...args,dateRange:{startDate:'2026-02-30',endDate:'today'}}));
});
test('status uses real SQL without Google config, rejects unauthenticated requests and ignores tenant query input',async()=>{
 const url='/api/business/ga-connector/status';
 assert.equal((await app.inject({method:'GET',url})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url,headers:{authorization:'Bearer expired'}})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url,headers:{authorization:'Bearer invalid'}})).statusCode,403);
 const r=await app.inject({method:'GET',url:url+'?tenantId='+B,headers});
 assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');
 assert.deepEqual(r.json(),{ok:true,connected:false,propertyId:null,updatedAt:null});
 const f=require('../../../analytics/node_modules/fastify')();
 require('../../../analytics/backend/ga-connector/routes').registerGaConnectorRoutes(f,{pool,parseAuthorization:()=> 'test',verifyAnalyticsToken:async()=>({tenant_id:A,scopes:[]})});
 try {assert.equal((await f.inject({method:'GET',url,headers})).statusCode,403);} finally {await f.close();}
});
test('OAuth redirect, PKCE, tenant/session binding, single-use callback and encrypted SQL storage',async()=>{
 const u=await authorize(),state=u.searchParams.get('state');
 assert.equal(u.origin,'https://accounts.google.com');assert.equal(u.searchParams.get('scope'),SCOPE);assert.equal(u.searchParams.get('code_challenge_method'),'S256');
 const url=`/api/business/ga-connector/oauth/callback?state=${state}&code=google-code`;
 assert.equal((await app.inject({method:'GET',url,headers:{...headers,authorization:'Bearer B'}})).statusCode,400);
 assert.equal((await app.inject({method:'GET',url,headers:{...headers,cookie:'pt_session=other'}})).statusCode,400);
 const result=await app.inject({method:'GET',url,headers});assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{ok:true,propertyId:'12345'});
 assert.equal((await app.inject({method:'GET',url,headers})).statusCode,400);
 const c=await pool.connect();let rows;
 try {await c.query('BEGIN');await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);rows=(await c.query('SELECT * FROM ga_connections')).rows;await c.query('COMMIT');}finally{c.release();}
 assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('refresh-secret'));
 assert.equal((await store.get(A)).refreshToken,'refresh-secret');assert.equal(await store.get(B),null);
 const exchange=requests.find(x=>new URLSearchParams(x.options.body).get('grant_type')==='authorization_code');
 assert.equal(crypto.createHash('sha256').update(new URLSearchParams(exchange.options.body).get('code_verifier')).digest('base64url'),u.searchParams.get('code_challenge'));
});
test('status returns only tenant-owned metadata after callback; browser callback returns to settings',async()=>{
 const u=await authorize();
 const callback=await app.inject({method:'GET',url:`/api/business/ga-connector/oauth/callback?state=${u.searchParams.get('state')}&code=browser-code`,headers:{...headers,accept:'text/html'}});
 assert.equal(callback.statusCode,302);assert.equal(callback.headers.location,'/settings');
 const r=await app.inject({method:'GET',url:'/api/business/ga-connector/status?tenantId='+B,headers});
 assert.equal(r.statusCode,200);assert.deepEqual(Object.keys(r.json()).sort(),['connected','ok','propertyId','updatedAt']);
 assert.equal(r.json().connected,true);assert.equal(r.json().propertyId,'12345');assert.ok(Date.parse(r.json().updatedAt));
 assert.ok(!r.body.includes('refresh-secret'));assert.ok(!r.body.includes('ciphertext'));
 const other=await app.inject({method:'GET',url:'/api/business/ga-connector/status?tenantId='+A,headers:{authorization:'Bearer B'}});
 assert.deepEqual(other.json(),{ok:true,connected:false,propertyId:null,updatedAt:null});
 // Production status path must work without constructing the OAuth client or a decryption key.
 const f=require('../../../analytics/node_modules/fastify')();
 require('../../../analytics/backend/ga-connector/routes').registerGaConnectorRoutes(f,{pool,parseAuthorization:()=> 'test',verifyAnalyticsToken:async()=>({tenant_id:A,scopes:['analytics:read']})});
 try {assert.equal((await f.inject({method:'GET',url:'/api/business/ga-connector/status',headers})).json().propertyId,'12345');} finally {await f.close();}
});
test('GA4 runReport request and existing report renderer preserve exact Google values',async()=>{
 const r=await app.inject({method:'POST',url:'/api/business/ga-connector/query',headers,payload:args});assert.equal(r.statusCode,200);
 const report=r.json();assert.deepEqual(report.table.rows,[['Japan<script>','42']]);
 assert.deepEqual(validateOutput('report',report),{ok:true,issues:[]});
 const html=renderReportHTML(report);assert.ok(html.includes('Japan&lt;script&gt;'));assert.ok(html.includes('<td>42</td>'));
 const call=requests.find(x=>x.url.includes(':runReport'));assert.equal(call.url,'https://analyticsdata.googleapis.com/v1beta/properties/12345:runReport');assert.deepEqual(JSON.parse(call.options.body).dateRanges,[args.dateRange]);
 assert.equal((await app.inject({method:'POST',url:'/api/business/ga-connector/query',headers:{authorization:'Bearer B'},payload:args})).statusCode,409);
});
test('Google failures expose safe codes only',async()=>{
 const google=createGoogleClient({fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:'invalid_grant',error_description:'sensitive'})})});
 await assert.rejects(()=>google.refresh('secret'),e=>e.code==='GA_REAUTHORIZE_REQUIRED'&&!e.message.includes('sensitive'));
});
test('expired state, denied consent and missing refresh token never save connection',async()=>{
 const u=await authorize();assert.equal((await app.inject({method:'GET',url:`/api/business/ga-connector/oauth/callback?state=${u.searchParams.get('state')}&error=access_denied`,headers})).statusCode,400);
 const expired=createGaConnector({store,now:()=>0,google:createGoogleClient({clientId:'id',fetchImpl:mockFetch})});
 const exp=new URL(await expired.authorize(A,headers.cookie,'123'));await assert.rejects(()=>expired.callback(A,headers.cookie,{state:exp.searchParams.get('state'),code:'x'}),{code:'INVALID_OAUTH_STATE'});
 const missing=createGaConnector({store,google:{authorize:s=>`https://example.com/?state=${s}`,exchange:async()=>({access_token:'a',scope:SCOPE})}});
 const m=new URL(await missing.authorize(B,headers.cookie,'456'));await assert.rejects(()=>missing.callback(B,headers.cookie,{state:m.searchParams.get('state'),code:'x'}),{code:'GOOGLE_REFRESH_TOKEN_REQUIRED'});assert.equal(await store.get(B),null);
});
test('public tool definition matches registration contract',()=>{
 const d=gaQueryToolDefinition();assert.equal(d.name,'ga.query');assert.equal(d.outputType,'report');assert.deepEqual(d.requiredPermissions,['tool.use','attribution:read']);assert.ok(d.inputSchema.required.includes('metrics'));
});
test('summary, zero rows and truncation keep strict report shape without invented totals',async()=>{
 const connector=createGaConnector({store,google:{refresh:async()=>({access_token:'a'}),runReport:async()=>({dimensionHeaders:[{name:'country'}],metricHeaders:[{name:'activeUsers'}],rows:[],rowCount:0})}});
 const empty=await connector.query(A,args);assert.equal(empty.table,undefined);assert.ok(empty.stats.some(x=>x[1]==='无数据'));assert.equal(validateOutput('report',empty).ok,true);
 const google=createGoogleClient({fetchImpl:mockFetch});const summary=await createGaConnector({store,google}).query(A,{...args,format:'summary'});
 assert.equal(summary.table,undefined);assert.ok(summary.stats.some(x=>x[1]==='activeUsers: 42'));assert.equal(validateOutput('report',summary).ok,true);
 const truncated=await createGaConnector({store,google:{refresh:google.refresh,runReport:async()=>({dimensionHeaders:[{name:'country'}],metricHeaders:[{name:'activeUsers'}],rows:[{dimensionValues:[{value:'JP'}],metricValues:[{value:'1'}]}],rowCount:10001})}}).query(A,args);
 assert.ok(truncated.stats.some(x=>x[0]==='截断'&&x[1].startsWith('是')));
});
test('configuration fails closed without secrets or with mismatched callback',()=>{
 assert.throws(()=>connectorFromEnv(pool,{}),{code:'GA_NOT_CONFIGURED'});
 assert.throws(()=>connectorFromEnv(pool,{GA_CLIENT_ID:'x',GA_CLIENT_SECRET:'x',GA_TOKEN_ENCRYPTION_KEY:key.toString('base64'),GA_REDIRECT_URI:'https://example.com/wrong'}),{code:'GA_INVALID_REDIRECT_URI'});
});
test('ciphertext authentication rejects wrong encryption key',async()=>{
 await assert.rejects(()=>createGaStore({pool,key:crypto.randomBytes(32)}).get(A));
});
test('encrypted connection survives actual database close/reopen and RLS hides other tenant',async()=>{
 await pool.end();pool=await createPgCompatPool({dataDir:dir,migrationsDir:path.resolve(__dirname,'../../../analytics/backend/db')});
 const restored=createGaStore({pool,key});assert.equal((await restored.get(A)).refreshToken,'refresh-secret');
 assert.equal((await readGaConnectionStatus(pool,A)).propertyId,'12345');
 assert.equal((await readGaConnectionStatus(pool,B)).connected,false);
 const c=await pool.connect();try {await c.query('BEGIN');await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[B]);assert.equal((await c.query('SELECT * FROM ga_connections')).rows.length,0);await c.query('COMMIT');}finally{c.release();}
});
test('OAuth route logging does not leak callback code or state',async()=>{
 let logs='';const f=require('../../../analytics/node_modules/fastify')({logger:{stream:{write:s=>{logs+=s;}}}});
 require('../../../analytics/backend/ga-connector/routes').registerGaConnectorRoutes(f,{parseAuthorization:()=> 'A',verifyAnalyticsToken:async()=>({tenant_id:A,scopes:['analytics:read']}),gaConnector:{callback:async()=>({ok:true})}});
 try {
  await f.inject({method:'GET',url:'/api/business/ga-connector/oauth/callback?code=private-code&state=private-state',headers});
  assert.ok(!logs.includes('private-code'));assert.ok(!logs.includes('private-state'));
 } finally {await f.close();}
});
