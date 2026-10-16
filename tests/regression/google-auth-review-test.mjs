import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {SignJWT,generateKeyPair,exportJWK}=await import(pathToFileURL(require.resolve('jose')));
const {createGoogleAuth,ISSUER,JWKS_URL,TOKEN_URL}=require('./auth-google.cjs');
const dbmod=require('./db.cjs');
const signing=await generateKeyPair('RS256'),untrusted=await generateKeyPair('RS256');
const jwk={...await exportJWK(signing.publicKey),kid:'independent-review',alg:'RS256',use:'sig'};
const config={GOOGLE_CLIENT_ID:'review-client',GOOGLE_CLIENT_SECRET:'synthetic-review-secret',GOOGLE_REDIRECT_URI:'http://127.0.0.1:8098/api/auth/google/callback'};
const browser=()=>crypto.randomBytes(32).toString('base64url');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'google-independent-'));let db=new PGlite(path.join(dir,'db'));await db.waitReady;
 await dbmod.migrate(db,fileURLToPath(new URL('../../shell/db-migrations',import.meta.url)));
 let claims={},wrongKey=false,exchangeThrows=false,calls=0;const now=Date.now();
 const fetchImpl=async(url,opts)=>{
  if(String(url)===JWKS_URL)return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
  assert.equal(String(url),TOKEN_URL);calls++;
  if(exchangeThrows)throw new Error('synthetic-review-secret code=must-not-leak');
  const verifier=opts.body.get('code_verifier');
  const nonce=nonceByVerifier.get(verifier);assert.ok(nonce,'PKCE verifier from persisted state');
  const payload={iss:ISSUER,sub:'independent-subject',aud:'review-client',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300,nonce,email:'independent@example.test',email_verified:true,...claims};
  const token=await new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(wrongKey?untrusted.privateKey:signing.privateKey);
  return new Response(JSON.stringify({id_token:token}),{headers:{'Content-Type':'application/json'}});
 };
 const nonceByVerifier=new Map();let auth=await createGoogleAuth({db,config,fetchImpl,now:()=>now});
 t.after(async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {get db(){return db;},get auth(){return auth;},setClaims:x=>{claims=x;},wrongKey:()=>{wrongKey=true;},failExchange:()=>{exchangeThrows=true;},calls:()=>calls,now,
  async begin(b=browser()){const x=await auth.begin({browserSessionId:b});const rows=await db.query('SELECT code_verifier,nonce FROM google_oauth_states');for(const r of rows.rows)nonceByVerifier.set(r.code_verifier,r.nonce);return {...x,browser:b};},
  callback:x=>auth.callback({state:x.state,code:'independent-code',browserSessionId:x.browser}),
  async reopen(){await db.close();db=new PGlite(path.join(dir,'db'));await db.waitReady;auth=await createGoogleAuth({db,config,fetchImpl,now:()=>now});},
 };
}
test('independent: genuinely wrong RSA signing key cannot mint session',async t=>{
 const f=await fixture(t);f.wrongKey();const r=await f.callback(await f.begin());assert.equal(r.ok,false);assert.equal((await f.db.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0);
});
test('independent: signed nonce/aud/azp/issuer/expiry negative cases create no accounts',async t=>{
 const f=await fixture(t);
 for(const patch of [{nonce:'wrong'},{aud:'other'},{azp:'other'},{aud:['review-client','other'],azp:'other'},{iss:'https://attacker.test'},{exp:Math.floor(f.now/1000)-31},{email_verified:'true'}]){
  f.setClaims(patch);const r=await f.callback(await f.begin());assert.equal(r.ok,false,JSON.stringify(patch));
 }
 assert.equal((await f.db.query('SELECT count(*)::int n FROM users')).rows[0].n,0);
});
test('independent: state remains browser-bound and exactly once after actual disk reopen',async t=>{
 const f=await fixture(t);const pending=await f.begin();await f.reopen();
 assert.equal((await f.auth.callback({state:pending.state,code:'x',browserSessionId:browser()})).code,'INVALID_OAUTH_STATE');assert.equal(f.calls(),0);
 const results=await Promise.all([f.callback(pending),f.callback(pending)]);
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.code==='INVALID_OAUTH_STATE').length,1);assert.equal(f.calls(),1);
});
test('independent: legacy email collision never auto-binds, trusted bind and legacy session API retain identity',async t=>{
 const f=await fixture(t);const tid=(await f.db.query("INSERT INTO tenants(name) VALUES ('old') RETURNING id")).rows[0].id;
 const uid=(await f.db.query("INSERT INTO users(tenant_id,username,email,password_hash,role) VALUES ($1,'old-independent','INDEPENDENT@EXAMPLE.TEST','disabled-password','viewer') RETURNING id",[tid])).rows[0].id;
 assert.equal((await f.callback(await f.begin())).code,'IDENTITY_BINDING_REQUIRED');assert.equal((await f.db.query('SELECT count(*)::int n FROM google_identities')).rows[0].n,0);
 await assert.rejects(f.auth.bindIdentity({issuer:ISSUER,subject:'independent-subject',userId:uid,email:'independent@example.test'}),{code:'INVALID_TRUSTED_BINDING'});
 await f.auth.bindIdentity({issuer:ISSUER,subject:'independent-subject',userId:uid,email:'independent@example.test',approvedBy:'trusted-review-migration'});
 const logged=await f.callback(await f.begin());assert.equal(logged.user.id,uid);assert.equal(logged.tenant.id,tid);assert.equal(logged.user.role,'viewer');
 const original=dbmod.open;let legacy;try{dbmod.open=async()=>({db:f.db,close:async()=>{}});legacy=await require('./auth.cjs').initAuth();}finally{dbmod.open=original;}
 assert.equal((await legacy.getSession(logged.token)).user.id,uid);await legacy.logout(logged.token);assert.equal(await legacy.getSession(logged.token),null);
});
test('independent: upstream secret-bearing errors are bounded and state cannot retry',async t=>{
 const f=await fixture(t);f.failExchange();const pending=await f.begin(),r=await f.callback(pending);
 assert.equal(r.ok,false);assert.equal(JSON.stringify(r).includes('synthetic-review-secret'),false);assert.equal((await f.callback(pending)).code,'INVALID_OAUTH_STATE');
});
