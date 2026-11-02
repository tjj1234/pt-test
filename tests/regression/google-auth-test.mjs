import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'shell/package.json'));
const {PGlite}=require('@electric-sql/pglite');
const {SignJWT,generateKeyPair,exportJWK}=await import(pathToFileURL(require.resolve('jose')));
const {createGoogleAuth,TOKEN_URL,JWKS_URL,ISSUER}=require('./auth-google.cjs');
const keys=await generateKeyPair('RS256');
const jwk={...await exportJWK(keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const browser=crypto.randomBytes(32).toString('base64url');
const cfg={GOOGLE_CLIENT_ID:'client-test',GOOGLE_CLIENT_SECRET:'test-only-not-real',GOOGLE_REDIRECT_URI:'http://127.0.0.1:8090/api/auth/google/callback'};
async function fixture() {
 const db=new PGlite();await db.waitReady;
 for(const f of ['001_auth.sql','012_google_identities.sql','019_account_disable.sql'])await db.exec(fs.readFileSync(path.join(root,'shell/db-migrations',f),'utf8'));
 let activeNonce='',claims={},exchangeFail=false,tamper=false,seenBody,tokenCalls=0;let clock=Date.now();
 const fetchImpl=async(url,opts)=>{
  if(String(url)===JWKS_URL)return new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'Content-Type':'application/json'}});
  assert.equal(String(url),TOKEN_URL);tokenCalls++;seenBody=opts.body;
  if(exchangeFail)throw new Error('secret-auth-code-and-key-must-not-leak');
  let token=await new SignJWT({sub:'subject-one',email:'employee@example.com',email_verified:true,nonce:activeNonce,...claims}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuedAt(Math.floor(clock/1000)).setIssuer(claims.iss||ISSUER).setAudience(claims.aud||'client-test').setExpirationTime(claims.exp??Math.floor(clock/1000)+300).sign(keys.privateKey);
  if(tamper){const parts=token.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);token=parts.join('.');}
  return new Response(JSON.stringify({id_token:token,access_token:'ignored-token'}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const auth=await createGoogleAuth({db,config:cfg,fetchImpl,now:()=>clock});
 async function begin(){const b=await auth.begin({browserSessionId:browser});activeNonce=new URL(b.authorizationUrl).searchParams.get('nonce');return b;}
 const callback=b=>auth.callback({state:b.state,code:'controlled-code',browserSessionId:browser});
 return {db,auth,begin,callback,setClaims:c=>{claims=c;},advance:ms=>{clock+=ms;},failExchange:()=>{exchangeFail=true;},tamperSignature:()=>{tamper=true;},body:()=>seenBody,tokenCalls:()=>tokenCalls};
}
async function withFixture(fn){const f=await fixture();try{await fn(f);}finally{await f.db.close();}}

test('Google first login uses PKCE and persisted sessions; repeat retains user/tenant',()=>withFixture(async f=>{
 const b=await f.begin(),url=new URL(b.authorizationUrl);
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'openid email profile');
 const first=await f.callback(b);assert.equal(first.ok,true);assert.equal(first.user.role,'admin');
 assert.equal(crypto.createHash('sha256').update(f.body().get('code_verifier')).digest('base64url'),url.searchParams.get('code_challenge'));
 const stored=await f.db.query('SELECT user_id,token_hash FROM sessions');assert.equal(stored.rows[0].user_id,first.user.id);assert.notEqual(stored.rows[0].token_hash,first.token);
 const second=await f.callback(await f.begin());assert.equal(second.user.id,first.user.id);assert.equal(second.tenant.id,first.tenant.id);
 const counts=await f.db.query('SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM tenants)::int tenants');assert.deepEqual(counts.rows[0],{users:1,tenants:1});
 // Exercise the existing auth.getSession method over the exact same real PGlite DB.
 const dbmod=require('./db.cjs'),original=dbmod.open;let legacy;
 try{dbmod.open=async()=>({db:f.db,close:async()=>{}});legacy=await require('./auth.cjs').initAuth({migrationsDir:path.join(root,'tests/probes/nonexistent-migrations')});}finally{dbmod.open=original;}
 assert.equal((await legacy.getSession(first.token)).user.id,first.user.id);
 await legacy.logout(first.token);assert.equal(await legacy.getSession(first.token),null);
}));

test('state is browser-bound, one-use, and expires before exchange',()=>withFixture(async f=>{
 const b=await f.begin();assert.equal((await f.auth.callback({state:b.state,code:'x',browserSessionId:crypto.randomBytes(32).toString('base64url')})).code,'INVALID_OAUTH_STATE');
 assert.equal((await f.callback(b)).ok,true);assert.equal((await f.callback(b)).code,'INVALID_OAUTH_STATE');
 const expired=await f.begin();f.advance(300001);assert.equal((await f.callback(expired)).code,'INVALID_OAUTH_STATE');assert.equal(f.tokenCalls(),1);
}));

test('denied callback consumes valid state and does not exchange',()=>withFixture(async f=>{
 const b=await f.begin();assert.equal((await f.auth.callback({state:b.state,error:'access_denied',browserSessionId:browser})).code,'GOOGLE_AUTH_DENIED');assert.equal(f.tokenCalls(),0);assert.equal((await f.callback(b)).code,'INVALID_OAUTH_STATE');
}));

for(const [name,claims] of Object.entries({issuer:{iss:'https://evil.example'},audience:{aud:'other-client'},authorizedParty:{azp:'other-client'},multiAudience:{aud:['client-test','other-client']},nonce:{nonce:'wrong'},unverifiedEmail:{email_verified:false},expired:{exp:1}})) {
 test('rejects invalid '+name,()=>withFixture(async f=>{f.setClaims(claims);const r=await f.callback(await f.begin());assert.equal(r.ok,false);assert.equal((await f.db.query('SELECT count(*)::int n FROM users')).rows[0].n,0);}));
}

test('email collision never merges; trusted binding preserves old IDs and assets and revokes legacy sessions',()=>withFixture(async f=>{
 const tenant=(await f.db.query("INSERT INTO tenants(name) VALUES ('old') RETURNING id")).rows[0];
 const user=(await f.db.query("INSERT INTO users(tenant_id,username,email,password_hash,role) VALUES ($1,'old','Employee@Example.com','invalid','admin') RETURNING id",[tenant.id])).rows[0];
 await f.db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,'legacy-hash',NOW()+INTERVAL '1 day')",[user.id]);
 assert.equal((await f.callback(await f.begin())).code,'IDENTITY_BINDING_REQUIRED');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM tenants')).rows[0].n,1);
 await assert.rejects(f.auth.bindIdentity({issuer:ISSUER,subject:'subject-one',userId:user.id,email:'employee@example.com'}),{code:'INVALID_TRUSTED_BINDING'});
 await f.auth.bindIdentity({issuer:ISSUER,subject:'subject-one',userId:user.id,email:'employee@example.com',approvedBy:'trusted-migration-operator'});
 assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[user.id])).rows[0].n,0);
 const r=await f.callback(await f.begin());assert.equal(r.user.id,user.id);assert.equal(r.tenant.id,tenant.id);
}));

test('concurrent callbacks for one subject create only one tenant and user',()=>withFixture(async f=>{
 const a=await f.begin(),b=await f.begin();
 // Both states have distinct nonces; issue a token bound to its exact verifier/state.
 const rows=await f.db.query('SELECT nonce,code_verifier FROM google_oauth_states');
 const nonceByVerifier=new Map(rows.rows.map(r=>[r.code_verifier,r.nonce]));
 const concurrent=await createGoogleAuth({db:f.db,config:cfg,fetchImpl:async(url,opts)=>{
  if(String(url)===JWKS_URL)return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
  assert.equal(String(url),TOKEN_URL);
  const token=await new SignJWT({sub:'concurrent-sub',email:'parallel@example.com',email_verified:true,nonce:nonceByVerifier.get(opts.body.get('code_verifier'))}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuedAt().setIssuer(ISSUER).setAudience('client-test').setExpirationTime('5m').sign(keys.privateKey);
  return new Response(JSON.stringify({id_token:token}),{headers:{'Content-Type':'application/json'}});
 }});
 const result=await Promise.all([a,b].map(x=>concurrent.callback({state:x.state,code:'code',browserSessionId:browser})));
 assert.equal(result.every(x=>x.ok),true);assert.equal(result[0].user.id,result[1].user.id);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM tenants')).rows[0].n,1);
}));

test('token exchange failures expose no upstream secrets and consume state',()=>withFixture(async f=>{
 f.failExchange();const b=await f.begin(),result=await f.callback(b);assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('secret-auth-code'));assert.equal((await f.callback(b)).code,'INVALID_OAUTH_STATE');
}));

test('trusted account disable revokes sessions and blocks later Google sign-in; re-enable restores access',()=>withFixture(async f=>{
 const signedIn=await f.callback(await f.begin());assert.equal(signedIn.ok,true);
 const dbmod=require('./db.cjs'),original=dbmod.open;let legacy;
 try{dbmod.open=async()=>({db:f.db,close:async()=>{}});legacy=await require('./auth.cjs').initAuth({migrationsDir:path.join(root,'tests/probes/nonexistent-migrations')});}finally{dbmod.open=original;}
 assert.equal((await legacy.getSession(signedIn.token)).user.id,signedIn.user.id);
 assert.deepEqual(await legacy.setAccountDisabled(signedIn.user.id,true),{ok:true,disabled:true});
 assert.equal(await legacy.getSession(signedIn.token),null,'existing cookie must stop authenticating immediately');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[signedIn.user.id])).rows[0].n,0,'disable revokes persisted sessions');
 assert.equal((await f.callback(await f.begin())).code,'ACCOUNT_DISABLED','Google callback cannot mint another session');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[signedIn.user.id])).rows[0].n,0);
 assert.deepEqual(await legacy.setAccountDisabled(signedIn.user.id,false),{ok:true,disabled:false});
 assert.equal((await f.callback(await f.begin())).ok,true,'trusted re-enable permits a new Google session');
 assert.equal((await legacy.setAccountDisabled('not-a-uuid',true)).code,'INVALID_USER_ID');
}));

test('password session issuance serializes with account disable and cannot reappear after re-enable',()=>withFixture(async f=>{
 const dbmod=require('./db.cjs'),originalOpen=dbmod.open;let legacy;
 try{dbmod.open=async()=>({db:f.db,close:async()=>{}});legacy=await require('./auth.cjs').initAuth({migrationsDir:path.join(root,'tests/probes/nonexistent-migrations')});}finally{dbmod.open=originalOpen;}
 const tenant=(await f.db.query("INSERT INTO tenants(name) VALUES ('disable-race') RETURNING id")).rows[0];
 const {hashPassword}=require('./auth.cjs');
 const user=(await f.db.query("INSERT INTO users(tenant_id,username,email,password_hash,role) VALUES ($1,'disable-race','disable-race@example.test',$2,'admin') RETURNING id",[tenant.id,hashPassword('RaceTest123')])).rows[0];
 let entered,release;
 const locked=new Promise(resolve=>{entered=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 const txOriginal=f.db.transaction.bind(f.db);
 f.db.transaction=(callback,...args)=>txOriginal(tx=>callback({
  ...tx,
  query:async(sql,params)=>{
   const result=await tx.query(sql,params);
   if(/SELECT .*password_hash.*FOR UPDATE/s.test(sql)){entered();await gate;}
   return result;
  },
 }),...args);
 try {
  const loginPromise=legacy.login({username:'disable-race',password:'RaceTest123'});
  await locked;
  const disablePromise=legacy.setAccountDisabled(user.id,true);
  release();
  const [login,disabled]=await Promise.all([loginPromise,disablePromise]);
  assert.equal(login.ok,true,'login that acquired the account lock may finish before disable');
  assert.deepEqual(disabled,{ok:true,disabled:true});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[user.id])).rows[0].n,0,'disable deletes a session issued immediately before it');
  assert.deepEqual(await legacy.setAccountDisabled(user.id,false),{ok:true,disabled:false});
  assert.equal(await legacy.getSession(login.token),null,'re-enable cannot resurrect the pre-disable cookie');
 } finally {f.db.transaction=txOriginal;}
}));

test('disable-first lock wait makes password login reject without inserting a session',()=>withFixture(async f=>{
 const dbmod=require('./db.cjs'),originalOpen=dbmod.open;let legacy;
 try{dbmod.open=async()=>({db:f.db,close:async()=>{}});legacy=await require('./auth.cjs').initAuth({migrationsDir:path.join(root,'tests/probes/nonexistent-migrations')});}finally{dbmod.open=originalOpen;}
 const tenant=(await f.db.query("INSERT INTO tenants(name) VALUES ('disable-first') RETURNING id")).rows[0];
 const {hashPassword}=require('./auth.cjs');
 const user=(await f.db.query("INSERT INTO users(tenant_id,username,email,password_hash,role) VALUES ($1,'disable-first','disable-first@example.test',$2,'admin') RETURNING id",[tenant.id,hashPassword('RaceTest123')])).rows[0];
 let announceDisable,releaseDisable,announceLoginWait,disableComplete;
 const disableStarted=new Promise(resolve=>{announceDisable=resolve;});
 const disableGate=new Promise(resolve=>{releaseDisable=resolve;});
 const loginWaiting=new Promise(resolve=>{announceLoginWait=resolve;});
 const disabledCommitted=new Promise(resolve=>{disableComplete=resolve;});
 const query=f.db.query.bind(f.db);
 const txOriginal=f.db.transaction.bind(f.db);
 // PGlite deliberately serializes its transactions, so model the row-lock
 // wait at the transaction adapter seam while executing each SQL statement
 // against the real fixture database after the preceding transaction commits.
 f.db.transaction=async callback=>{
  let isDisable=false;
  try {
   return await callback({
    query:async(sql,params)=>{
     if(/^\s*UPDATE users SET disabled_at/i.test(sql)) {
      isDisable=true;
      announceDisable();
      await disableGate;
     }
     if(/SELECT .*password_hash.*FOR UPDATE/s.test(sql)) {
      announceLoginWait();
      await disabledCommitted;
     }
     return query(sql,params);
    },
    exec:async sql=>f.db.exec(sql),
   });
  } finally { if(isDisable)disableComplete(); }
 };
 try {
  const disablePromise=legacy.setAccountDisabled(user.id,true);
  await disableStarted;
  const loginPromise=legacy.login({username:'disable-first',password:'RaceTest123'});
  await loginWaiting;
  releaseDisable();
  const [disabled,login]=await Promise.all([disablePromise,loginPromise]);
  assert.deepEqual(disabled,{ok:true,disabled:true});
  assert.equal(login.ok,false,'login resumes after the disable transaction and sees the locked row state');
  assert.equal((await query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[user.id])).rows[0].n,0,'disable-first path creates no session');
 } finally {f.db.transaction=txOriginal;}
}));

test('fixed configuration rejects arbitrary redirect protocol',async()=>{
 const db={transaction(){}};await assert.rejects(createGoogleAuth({db,config:{...cfg,GOOGLE_REDIRECT_URI:'javascript:alert(1)'}}),{code:'GOOGLE_NOT_CONFIGURED'});
});

test('rejects cryptographically invalid signature from controlled JWKS',()=>withFixture(async f=>{f.tamperSignature();assert.equal((await f.callback(await f.begin())).ok,false);assert.equal((await f.db.query('SELECT count(*)::int n FROM users')).rows[0].n,0);}));

test('accepted issuer spelling is canonicalized and multi-audience requires matching azp',()=>withFixture(async f=>{f.setClaims({iss:'accounts.google.com',aud:['client-test','other-client'],azp:'client-test'});assert.equal((await f.callback(await f.begin())).ok,true);assert.equal((await f.db.query('SELECT issuer FROM google_identities')).rows[0].issuer,ISSUER);}));
