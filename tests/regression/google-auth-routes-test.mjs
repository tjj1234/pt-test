import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createGoogleAuthRoutes}=require('../../shell/auth-google-routes.cjs');
const config={GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'SYNTHETIC_SECRET',GOOGLE_REDIRECT_URI:'https://northstar.example/api/auth/google/callback'};
const binding='b'.repeat(43),token='t'.repeat(43);
async function fixture(overrides={}){
 const calls=[];
 const authFactory=async()=>({begin:async x=>{calls.push(['begin',x]);return {authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture&nonce=fixture'};},callback:async x=>{calls.push(['callback',x]);return {ok:true,token,expiresAt:'2026-10-17T00:00:00.000Z'};}});
 const routes=await createGoogleAuthRoutes({config,authFactory,now:()=>Date.parse('2026-10-16T00:00:00.000Z'),...overrides});
 async function request(url,options={}){
  const req={url,method:'GET',headers:{},socket:{remoteAddress:'127.0.0.1'},...options};
  const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(body=''){this.body=body;}};
  const handled=await routes.handle(req,res);return {handled,...res};
 }
 return {routes,calls,request};
}
test('Google route begin sets server-generated secure binding and no-store fixed Google destination',async()=>{
 const f=await fixture();const r=await f.request('/api/auth/google/start?returnTo=https://attacker.test');
 assert.equal(r.statusCode,303);assert.equal(new URL(r.headers.location).origin,'https://accounts.google.com');
 assert.match(r.headers['set-cookie'],/^__Host-pt_google_binding=[A-Za-z0-9_-]{43}; Max-Age=600; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
 assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET'),false);
});
test('Google callback accepts only cookie binding and emits compatible secure session with fixed redirect',async()=>{
 const f=await fixture();const r=await f.request('/api/auth/google/callback?state=s&code=c&userId=attacker&role=owner&returnTo=https://attacker.test',{headers:{cookie:'__Host-pt_google_binding='+binding,'sec-fetch-site':'cross-site'}});
 assert.equal(r.statusCode,303);assert.equal(r.headers.location,'/');assert.match(r.headers['set-cookie'],/^pt_session=t+; Expires=.*; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
 assert.deepEqual(f.calls[0],['callback',{state:'s',code:'c',error:null,browserSessionId:binding}]);assert.equal(r.body,'');
});
test('missing malformed or duplicate cookies and repeated query parameters never reach callback',async()=>{
 const f=await fixture();
 for(const cookie of [undefined,'__Host-pt_google_binding=%E0%A4%A','__Host-pt_google_binding='+binding+'; __Host-pt_google_binding='+binding]){
  const r=await f.request('/api/auth/google/callback?state=s&code=c',{headers:{cookie}});assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(r.headers['set-cookie'],undefined);
 }
 const r=await f.request('/api/auth/google/callback?state=a&state=b&code=c',{headers:{cookie:'__Host-pt_google_binding='+binding}});assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(f.calls.length,0);
});
test('begin reuses valid binding for parallel tabs; cross-origin start is rejected',async()=>{
 const f=await fixture();let r=await f.request('/api/auth/google/start',{headers:{cookie:'__Host-pt_google_binding='+binding,origin:'https://northstar.example'}});assert.equal(r.statusCode,303);assert.equal(f.calls[0][1].browserSessionId,binding);
 for(const headers of [{origin:'https://attacker.test'},{'sec-fetch-site':'cross-site'}]){r=await f.request('/api/auth/google/start',{headers});assert.equal(r.statusCode,403);}
 assert.equal(f.calls.length,1);
});
test('unconfigured or wrong callback configuration fails explicitly and never exposes secret',async()=>{
 for(const cfg of [{},{...config,GOOGLE_REDIRECT_URI:'https://northstar.example/wrong'},{...config,GOOGLE_REDIRECT_URI:'https://northstar.example/api/auth/google/callback?x=1'}]){
  const f=await fixture({config:cfg});assert.equal(f.routes.configured,false);const r=await f.request('/api/auth/google/start');assert.equal(r.statusCode,503);assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET'),false);assert.equal(f.calls.length,0);
 }
});
test('callback failures and thrown provider details never appear in redirect or body',async()=>{
 for(const callback of [async()=>({ok:false,code:'secret-code',error:'SYNTHETIC_SECRET'}),async()=>{throw new Error('SYNTHETIC_SECRET');},async()=>({ok:true,token:'bad\r\nCookie: injected',expiresAt:'2026-10-17T00:00:00Z'})]){
  const f=await fixture({authFactory:async()=>({callback})});const r=await f.request('/api/auth/google/callback?state=s&code=SYNTHETIC_SECRET',{headers:{cookie:'__Host-pt_google_binding='+binding}});
  assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(r.headers['set-cookie'],undefined);assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET'),false);
 }
});
test('GET-only routes, unknown paths and rate limits are explicit',async()=>{
 const f=await fixture({rateLimit:1});assert.equal((await f.request('/api/auth/google/start',{method:'POST'})).statusCode,405);
 assert.equal((await f.request('/other')).handled,false);assert.equal((await f.request('//attacker.test/api/auth/google/start')).handled,false);
 assert.equal((await f.request('/api/auth/google/start')).statusCode,303);const blocked=await f.request('/api/auth/google/start');assert.equal(blocked.statusCode,429);assert.equal(blocked.headers['retry-after'],'60');
});
test('loopback HTTP uses non-Secure local cookie; non-loopback HTTP is unavailable',async()=>{
 const local=await fixture({config:{...config,GOOGLE_REDIRECT_URI:'http://127.0.0.1:8098/api/auth/google/callback'}});const r=await local.request('/api/auth/google/start');assert.match(r.headers['set-cookie'],/^pt_google_binding=/);assert.equal(r.headers['set-cookie'].includes('; Secure'),false);
 const remote=await fixture({config:{...config,GOOGLE_REDIRECT_URI:'http://northstar.example/api/auth/google/callback'}});assert.equal(remote.routes.configured,false);
});
test('expired session response or invalid authorization redirect fails closed',async()=>{
 const f=await fixture({authFactory:async()=>({begin:async()=>({authorizationUrl:'https://attacker.test/steal?secret=SYNTHETIC_SECRET'}),callback:async()=>({ok:true,token,expiresAt:'2020-01-01T00:00:00Z'})})});
 const start=await f.request('/api/auth/google/start');assert.equal(start.statusCode,503);assert.equal(start.headers.location,undefined);
 const result=await f.request('/api/auth/google/callback?state=s&code=c',{headers:{cookie:'__Host-pt_google_binding='+binding}});assert.equal(result.headers.location,'/login?error=google_auth');assert.equal(result.headers['set-cookie'],undefined);
});
test('status exposes only readiness; authenticated provision finishes before session cookie',async()=>{
 const order=[];
 const f=await fixture({onAuthenticated:async(result)=>{assert.equal(result.ok,true);order.push('provision');}});
 const status=await f.request('/api/auth/google/status');assert.deepEqual(JSON.parse(status.body),{ok:true,configured:true});
 assert.equal(status.headers['cache-control'],'no-store');assert.equal(status.headers['set-cookie'],undefined);
 const result=await f.request('/api/auth/google/callback?state=s&code=c',{headers:{cookie:'__Host-pt_google_binding='+binding}});
 assert.equal(result.statusCode,303);assert.equal(order[0],'provision');assert.ok(result.headers['set-cookie'].startsWith('pt_session='));
 const failing=await fixture({onAuthenticated:async()=>{throw new Error('workspace failure');}});
 const rejected=await failing.request('/api/auth/google/callback?state=s&code=c',{headers:{cookie:'__Host-pt_google_binding='+binding}});
 assert.equal(rejected.headers.location,'/login?error=google_auth');assert.equal(rejected.headers['set-cookie'],undefined);
});
