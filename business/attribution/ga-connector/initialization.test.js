'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Writable}=require('node:stream');
const Fastify=require('../../../analytics/node_modules/fastify');
const {registerGaConnectorRoutes}=require('../../../analytics/backend/ga-connector/routes');
const tenant='11111111-1111-4111-8111-111111111111';
const envNames=['GA_CLIENT_ID','GA_CLIENT_SECRET','GA_REDIRECT_URI','GA_TOKEN_ENCRYPTION_KEY'];
const configured={GA_CLIENT_ID:'private-client',GA_CLIENT_SECRET:'private-secret',GA_REDIRECT_URI:'http://localhost/api/business/ga-connector/oauth/callback',GA_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};

test('initialization logs first failure and recovery, preserves retries/cache and excludes secrets',async()=>{
 const saved=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
 const logs=[];
 const stream=new Writable({write(chunk,encoding,done){logs.push(...chunk.toString().trim().split('\n').map(line=>JSON.parse(line)));done();}});
 const app=Fastify({logger:{stream}});
 let connections=0;
 // No tenant authorization: a configured connector must return the existing authorization error.
 const pool={connect:async()=>{connections++;return {query:async()=>({rows:[]}),release(){}};}};
 registerGaConnectorRoutes(app,{pool,parseAuthorization:value=>value||null,verifyAnalyticsToken:async()=>({tenant_id:tenant,scopes:['analytics:read']})});
 const query=()=>app.inject({method:'POST',url:'/api/business/ga-connector/query',headers:{authorization:'test'},payload:{metrics:['activeUsers'],dateRange:{startDate:'yesterday',endDate:'today'}}});
 const diagnostics=()=>logs.filter(log=>log.event==='ga_connector_initialization');
 try {
  for(const name of envNames) delete process.env[name];
  assert.equal((await app.inject({method:'POST',url:'/api/business/ga-connector/query',payload:{}})).statusCode,401);
  assert.equal(diagnostics().length,0);
  for(let i=0;i<2;i++) {
   const response=await query();
   assert.equal(response.statusCode,503);
   assert.equal(response.json().error.code,'GA_NOT_CONFIGURED');
  }
  assert.equal(diagnostics().length,1);
  const failure=diagnostics()[0];
  assert.equal(failure.outcome,'failure');assert.equal(failure.code,'GA_NOT_CONFIGURED');
  assert.deepEqual(failure.missing_env,envNames);assert.equal(failure.pid,process.pid);
  assert.ok(Number.isFinite(Date.parse(failure.timestamp)));
  assert.ok(Date.parse(failure.process_started_at)<=Date.parse(failure.timestamp));
  Object.assign(process.env,configured);
  const recovered=await query();
  assert.equal(recovered.statusCode,409);assert.equal(recovered.json().error.code,'GA_AUTHORIZATION_REQUIRED');
  assert.equal(diagnostics().length,2);assert.equal(diagnostics()[1].outcome,'success');assert.equal(diagnostics()[1].attempt,3);
  for(const name of envNames) delete process.env[name];
  assert.equal((await query()).json().error.code,'GA_AUTHORIZATION_REQUIRED');
  assert.equal(diagnostics().length,2);assert.equal(connections,2);
  for(const value of Object.values(configured)) assert.ok(!JSON.stringify(logs).includes(value));
 } finally {
  await app.close();
  for(const name of envNames) {if(saved[name]===undefined) delete process.env[name];else process.env[name]=saved[name];}
 }
});
