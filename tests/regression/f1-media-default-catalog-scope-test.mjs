import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),catalog=require('../../shell/model-catalog.cjs');
test('implicit and explicit default endpoints share the exact credential/access scope used by media admission',async()=>{
 const cacheDir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'northstar-default-scope-'));
 const options={apiKey:'offline-scope-fixture',scopeId:'same-user',cacheDir,force:true,fetchImpl:async()=>new Response(JSON.stringify({data:[{id:'seedream-5-0-260128',supported_endpoint_types:['image-generation']}]}),{headers:{'Content-Type':'application/json'}})};
 try{
  const implicit=await catalog.getCatalog(options),explicit=await catalog.getCatalog({...options,baseURL:catalog.DEFAULT_BASE_URL});
  assert.equal(implicit.scopeId,explicit.scopeId);
  assert.equal(implicit.scopeId,catalog.resolveScopeId({apiKey:options.apiKey,scopeId:options.scopeId,baseURL:catalog.DEFAULT_BASE_URL}));
  assert.equal(implicit.scopeId,catalog.resolveScopeId({apiKey:options.apiKey,scopeId:options.scopeId}));
  assert.equal(implicit.models[0].capabilityRevision,explicit.models[0].capabilityRevision);
  assert.equal(fs.readdirSync(cacheDir).filter(x=>x.endsWith('.json')).length,1);
  const otherKey=await catalog.getCatalog({...options,apiKey:'different-offline-key'});assert.notEqual(otherKey.scopeId,implicit.scopeId);
  const otherBase=await catalog.getCatalog({...options,baseURL:'https://other.example.test/v1'});assert.notEqual(otherBase.scopeId,implicit.scopeId);
 }finally{fs.rmSync(cacheDir,{recursive:true,force:true});}
});
