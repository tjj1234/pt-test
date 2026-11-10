import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs');
test('PT login credentials are encrypted, identity authenticated and separate from model keys',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'billing-credential-'));let storage;try{
  storage=await createStorage({dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key')});const keys=storage.repositories.keys,identities=[];
  for(const username of ['billing-owner','billing-other']){const user=(await storage.repositories.auth.register({username,password:'FixturePass123'})).user;identities.push({userId:user.id,tenantId:user.tenant_id});}
  const [owner,other]=identities;await keys.encryptApiKey(owner.userId,'fixture-model-api-key');await keys.saveBillingToken(owner,'owner-login-fixture');
  assert.equal(await keys.decryptApiKey(owner.userId),'fixture-model-api-key');assert.equal(await keys.loadBillingToken(owner),'owner-login-fixture');assert.equal(await keys.loadBillingToken(other),null);
  const row=(await storage.db.query('SELECT * FROM pt_billing_credentials WHERE user_id=$1',[owner.userId])).rows[0];assert.ok(!JSON.stringify(row).includes('owner-login-fixture'));assert.deepEqual(Object.keys(await keys.billingTokenStatus(owner)).sort(),['configured','updatedAt']);
  await keys.saveBillingToken(other,'other-login-fixture');await storage.db.query('UPDATE pt_billing_credentials SET iv=$1,ciphertext=$2 WHERE user_id=$3',[row.iv,row.ciphertext,other.userId]);await assert.rejects(keys.loadBillingToken(other));
  await keys.removeBillingToken(owner);assert.equal(await keys.loadBillingToken(owner),null);assert.equal(await keys.decryptApiKey(owner.userId),'fixture-model-api-key');
  await assert.rejects(keys.saveBillingToken(owner,'sk-model-key'),{code:'BILLING_CREDENTIAL_INVALID'});
 }finally{await storage?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
