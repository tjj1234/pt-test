/** Independent T01 policy review: legacy disk DB -> real OIDC callback -> disk reopen.
 * No HTTP listener, browser, live Google or PT; no password API after upgrade. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'shell/package.json'));
const {createStorage}=require('./storage/index.cjs');
const {createGoogleAuth,TOKEN_URL,JWKS_URL,ISSUER}=require('./auth-google.cjs');
const {SignJWT,generateKeyPair,exportJWK}=await import(pathToFileURL(require.resolve('jose')));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const cfg={GOOGLE_CLIENT_ID:'storage-review-client',GOOGLE_CLIENT_SECRET:'SYNTHETIC_NOT_A_GOOGLE_KEY',GOOGLE_REDIRECT_URI:'https://northstar.example/api/auth/google/callback'};

async function assets(storage,uid){
 const out={};
 for(const [table,column,order]of [['users','id','id'],['conversations','user_id','id'],['user_memory','user_id','key'],['api_keys','user_id','id']])out[table]=(await storage.adapter.query(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY ${order}`,[uid])).rows;
 return out;
}

test('independent Google-only policy: old password session revoked, actual OIDC-issued session and old assets survive reopen',{timeout:30000},async()=>{
 assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&process.env[k]),false,'explicit PG environment forbidden for this disk PGlite fixture');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-storage-google-review-'));
 const opts={dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'master.key')};
 let storage;
 try{
  storage=await createStorage({...opts,migrationsDir:path.join(root,'shell/storage/migrations')});
  const old=await storage.repositories.auth.register({username:'old-policy-user',email:'storage-review@example.test',password:'SyntheticReview123'});assert.equal(old.ok,true);
  // Password login exists only to reconstruct a real pre-upgrade fixture.
  const legacy=await storage.repositories.auth.login({username:'old-policy-user',password:'SyntheticReview123'});assert.equal(legacy.ok,true);
  const conv=await storage.repositories.conversations.create(old.user.id);
  await storage.repositories.conversations.saveMessages(old.user.id,conv.id,[{role:'user',text:'Preserve this exact old asset',ts:'2026-10-16T00:00:00Z'}]);
  await storage.repositories.conversations.setArchived(old.user.id,conv.id,true);
  await storage.repositories.memory.set(old.user.id,'fixture','keep-old-memory');
  const syntheticKey='pt_synthetic_storage_review_not_live_12345';
  assert.equal((await storage.repositories.keys.encryptApiKey(old.user.id,syntheticKey)).ok,true);
  const before=await assets(storage,old.user.id);await storage.close();storage=null;

  storage=await createStorage(opts);
  assert.equal(await storage.repositories.auth.getSession(legacy.token),null);
  assert.equal((await storage.adapter.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0);
  assert.deepEqual(await assets(storage,old.user.id),before);
  const pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'storage-review',alg:'RS256',use:'sig'};
  let nonce,exchanges=0;
  const fetchImpl=async(url,options)=>{
   if(String(url)===JWKS_URL)return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
   assert.equal(String(url),TOKEN_URL);exchanges++;
   assert.equal(options.body.get('grant_type'),'authorization_code');assert.equal(options.body.get('redirect_uri'),cfg.GOOGLE_REDIRECT_URI);
   const token=await new SignJWT({sub:'storage-verified-subject',email:'storage-review@example.test',email_verified:true,nonce}).setProtectedHeader({alg:'RS256',kid:'storage-review'}).setIssuedAt().setIssuer(ISSUER).setAudience(cfg.GOOGLE_CLIENT_ID).setExpirationTime('5m').sign(pair.privateKey);
   return new Response(JSON.stringify({id_token:token}),{headers:{'Content-Type':'application/json'}});
  };
  const google=await createGoogleAuth({db:storage.db,config:cfg,fetchImpl});
  await google.bindIdentity({issuer:ISSUER,subject:'storage-verified-subject',userId:old.user.id,email:'storage-review@example.test',approvedBy:'trusted-independent-fixture-only'});
  const browser=crypto.randomBytes(32).toString('base64url'),begin=await google.begin({browserSessionId:browser});
  nonce=new URL(begin.authorizationUrl).searchParams.get('nonce');
  const result=await google.callback({state:begin.state,code:'controlled-not-real-code',browserSessionId:browser});
  assert.equal(result.ok,true);assert.equal(exchanges,1);assert.equal(result.user.id,old.user.id);assert.equal(result.tenant.id,old.tenant.id);
  assert.equal((await storage.repositories.auth.getSession(result.token)).user.id,old.user.id);
  assert.equal(await storage.repositories.auth.getSession(legacy.token),null,'binding does not resurrect revoked password session');
  const migrations=(await storage.adapter.query('SELECT name,applied_at FROM schema_migrations ORDER BY name')).rows;
  const sessionRow=(await storage.adapter.query('SELECT * FROM sessions WHERE token_hash=$1',[sha(result.token)])).rows[0];
  assert.ok(sessionRow);assert.notEqual(sessionRow.token_hash,result.token);
  await storage.close();storage=null;

  storage=await createStorage(opts);
  assert.equal((await storage.repositories.auth.getSession(result.token)).user.id,old.user.id);
  assert.equal(await storage.repositories.auth.getSession(legacy.token),null);
  assert.deepEqual(await assets(storage,old.user.id),before);
  assert.equal(await storage.repositories.keys.decryptApiKey(old.user.id),syntheticKey);
  assert.deepEqual((await storage.adapter.query('SELECT * FROM sessions WHERE token_hash=$1',[sha(result.token)])).rows[0],sessionRow);
  assert.deepEqual((await storage.adapter.query('SELECT name,applied_at FROM schema_migrations ORDER BY name')).rows,migrations);
  assert.equal((await storage.adapter.query('SELECT user_id FROM google_identities WHERE subject=$1',['storage-verified-subject'])).rows[0].user_id,old.user.id);
 }finally{try{if(storage)await storage.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}}
});
