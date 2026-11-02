/** Independent HTTP-adapter review: actual Google auth module + real isolated PGlite/JWT.
 * No socket/listener, browser, real Google or paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'shell/package.json'));
const {PGlite}=require('@electric-sql/pglite');
const {SignJWT,generateKeyPair,exportJWK}=await import(pathToFileURL(require.resolve('jose')));
const {createGoogleAuthRoutes}=require('./auth-google-routes.cjs');
const {TOKEN_URL,JWKS_URL,ISSUER}=require('./auth-google.cjs');
const cfg={GOOGLE_CLIENT_ID:'review-client',GOOGLE_CLIENT_SECRET:'REVIEW_SYNTHETIC_SECRET',GOOGLE_REDIRECT_URI:'https://northstar.example/api/auth/google/callback'};
const pair=await generateKeyPair('RS256');
const jwk={...await exportJWK(pair.publicKey),kid:'review',alg:'RS256',use:'sig'};
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function fixture(extra={}){
 const db=new PGlite();await db.waitReady;
 for(const filename of ['001_auth.sql','012_google_identities.sql','019_account_disable.sql'])await db.exec(fs.readFileSync(path.join(root,'shell/db-migrations',filename),'utf8'));
 let exchanges=0;
 const fetchImpl=async(url,opts)=>{
  if(String(url)===JWKS_URL)return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
  assert.equal(String(url),TOKEN_URL);exchanges++;
  // The exchanged verifier must have belonged to the consumed authorization.
  const verifier=opts.body.get('code_verifier'),nonce=nonces.get(sha(verifier));assert.ok(nonce);
  assert.equal(opts.body.get('client_id'),cfg.GOOGLE_CLIENT_ID);assert.equal(opts.body.get('redirect_uri'),cfg.GOOGLE_REDIRECT_URI);assert.equal(opts.redirect,'error');
  const token=await new SignJWT({sub:'route-subject',email:'route-review@example.com',email_verified:true,nonce}).setProtectedHeader({alg:'RS256',kid:'review'}).setIssuedAt().setExpirationTime('5m').setAudience(cfg.GOOGLE_CLIENT_ID).setIssuer(ISSUER).sign(pair.privateKey);
  return new Response(JSON.stringify({id_token:token}),{headers:{'Content-Type':'application/json'}});
 };
 const nonces=new Map(),responses=[];
 const routes=await createGoogleAuthRoutes({db,config:cfg,fetchImpl,rateLimit:100,...extra});
 async function request(url,headers={},method='GET'){
  const response={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(body=''){this.body=body;}};
  responses.push(response);
  const handled=await routes.handle({url,method,headers,socket:{remoteAddress:'127.0.0.1'}},response);return {handled,...response};
 }
 async function start(cookie){
  const r=await request('/api/auth/google/start?returnTo=https://evil.example&role=owner&userId=injected',cookie?{cookie}:{});assert.equal(r.statusCode,303);
  const authorization=new URL(r.headers.location);
  const state=authorization.searchParams.get('state');
  const rows=await db.query('SELECT code_verifier,nonce FROM google_oauth_states WHERE state_hash=$1',[sha(state)]);assert.equal(rows.rows.length,1);
  nonces.set(sha(rows.rows[0].code_verifier),rows.rows[0].nonce);
  return {response:r,state,cookie:r.headers['set-cookie'].split(';')[0]};
 }
 return {db,routes,request,start,responses,exchanges:()=>exchanges};
}
async function use(extra,fn){const f=await fixture(extra);try{await fn(f);}finally{await f.db.close();}}

test('adapter actual auth path issues database-backed session without request identity escalation',()=>use({},async f=>{
 const begun=await f.start();assert.match(begun.cookie,/^__Host-pt_google_binding=/);
 const r=await f.request('/api/auth/google/callback?state='+begun.state+'&code=controlled-code&userId=injected&tenantId=injected&role=owner&returnTo=https://evil.example',{cookie:begun.cookie,origin:'https://accounts.google.com','sec-fetch-site':'cross-site'});
 assert.equal(r.statusCode,303);assert.equal(r.headers.location,'/');assert.equal(r.body,'');
 const cookie=r.headers['set-cookie'];assert.match(cookie,/^pt_session=/);assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);
 const token=cookie.split(';')[0].slice('pt_session='.length);const sessions=await f.db.query('SELECT s.user_id,u.role,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1',[sha(token)]);
 assert.equal(sessions.rows.length,1);assert.equal(sessions.rows[0].email,'route-review@example.com');assert.equal(sessions.rows[0].role,'admin');assert.notEqual(sessions.rows[0].user_id,'injected');
 assert.equal(f.exchanges(),1);assert.ok(!JSON.stringify(r).includes('REVIEW_SYNTHETIC_SECRET'));
}));

test('stolen callback with another browser binding cannot exchange; correct binding remains usable once',()=>use({},async f=>{
 const a=await f.start(),b=await f.start();assert.notEqual(a.cookie,b.cookie);
 const url='/api/auth/google/callback?state='+a.state+'&code=controlled';
 const wrong=await f.request(url,{cookie:b.cookie});assert.equal(wrong.headers.location,'/login?error=google_auth');assert.equal(f.exchanges(),0);
 const results=await Promise.all([f.request(url,{cookie:a.cookie}),f.request(url,{cookie:a.cookie})]);
 assert.equal(results.filter(r=>r.headers.location==='/').length,1);assert.equal(f.exchanges(),1);assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions')).rows[0].n,1);
}));

test('encoded duplicate query and cookie pollution fail before authenticating',()=>use({},async f=>{
 const a=await f.start();
 for(const query of ['state='+a.state+'&state=other&code=c','state='+a.state+'&code=c&co%64e=other','state='+a.state+'&code=c&error=e&%65rror=other']){
  const r=await f.request('/api/auth/google/callback?'+query,{cookie:a.cookie});assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(r.headers['set-cookie'],undefined);
 }
 const duplicate=await f.request('/api/auth/google/callback?state='+a.state+'&code=c',{cookie:a.cookie+'; '+a.cookie});assert.equal(duplicate.headers.location,'/login?error=google_auth');assert.equal(f.exchanges(),0);
 assert.equal((await f.request('/api/auth/google/callback?state='+a.state+'&code=c',{cookie:a.cookie})).headers.location,'/');
}));

test('provider denial consumes state, leaks no details and does not overwrite existing session',()=>use({},async f=>{
 const a=await f.start();
 const r=await f.request('/api/auth/google/callback?state='+a.state+'&error=access_denied&error_description=REVIEW_SYNTHETIC_SECRET',{cookie:a.cookie+'; pt_session='+'x'.repeat(43)});
 assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(r.headers['set-cookie'],undefined);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');assert.ok(!JSON.stringify(r).includes('REVIEW_SYNTHETIC_SECRET'));
 assert.equal(f.exchanges(),0);assert.equal((await f.request('/api/auth/google/callback?state='+a.state+'&code=c',{cookie:a.cookie})).headers.location,'/login?error=google_auth');
}));

test('forged Host and forwarding headers cannot change OAuth destination or cookie security',()=>use({},async f=>{
 const r=await f.request('/api/auth/google/start',{host:'evil.example','x-forwarded-host':'evil.example','x-forwarded-proto':'http','x-real-ip':'fake',origin:'https://northstar.example'});
 const u=new URL(r.headers.location);assert.equal(u.origin,'https://accounts.google.com');assert.equal(u.searchParams.get('redirect_uri'),cfg.GOOGLE_REDIRECT_URI);assert.match(r.headers['set-cookie'],/; Secure$/);
}));


test('workspace hook receives verified principal and completes before issuing login cookie',{timeout:5000},async()=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let principal;
 await use({onAuthenticated:async result=>{principal=result;entered();await gate;}},async f=>{
  const a=await f.start();const pending=f.request('/api/auth/google/callback?state='+a.state+'&code=c&userId=untrusted',{cookie:a.cookie});
  await started;assert.equal(principal.ok,true);assert.equal(principal.user.email,'route-review@example.com');assert.notEqual(principal.user.id,'untrusted');assert.equal(f.responses.at(-1).headers['set-cookie'],undefined);assert.equal(f.responses.at(-1).body,undefined);
  release();const result=await pending;assert.equal(result.headers.location,'/');assert.match(result.headers['set-cookie'],/^pt_session=/);
 });
});

test('workspace initialization failure cannot issue cookie or expose failure detail',()=>use({onAuthenticated:async()=>{throw new Error('PRIVATE_WORKSPACE_PATH_OR_SECRET');}},async f=>{
 const a=await f.start();const r=await f.request('/api/auth/google/callback?state='+a.state+'&code=c',{cookie:a.cookie});
 assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(r.headers['set-cookie'],undefined);assert.ok(!JSON.stringify(r).includes('PRIVATE_WORKSPACE_PATH_OR_SECRET'));
}));

test('status exposes only configuration readiness and supports no mutation',async()=>{
 for(const config of [cfg,{}])await use({config},async f=>{
  const r=await f.request('/api/auth/google/status');assert.equal(r.statusCode,200);assert.deepEqual(JSON.parse(r.body),{ok:true,configured:config===cfg});assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['set-cookie'],undefined);assert.equal(f.exchanges(),0);
  const post=await f.request('/api/auth/google/status',{},'POST');assert.equal(post.statusCode,405);assert.equal(post.headers.allow,'GET');assert.ok(!JSON.stringify(r).includes('REVIEW_SYNTHETIC_SECRET'));
 });
});

test('unprefixed binding cookie cannot replace secure host-only binding',()=>use({},async f=>{
 const a=await f.start();const r=await f.request('/api/auth/google/callback?state='+a.state+'&code=c',{cookie:a.cookie.replace('__Host-','')});
 assert.equal(r.headers.location,'/login?error=google_auth');assert.equal(f.exchanges(),0);
}));
