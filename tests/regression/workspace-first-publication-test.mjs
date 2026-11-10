import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Worker} from 'node:worker_threads';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),modulePath=require.resolve('../../business/attribution/import/workspace-meta.js'),{createWorkspaceMetaStore}=require(modulePath);
const first='2026-11-09T00:00:00.000Z',second='2026-11-09T01:00:00.000Z';
async function race(stage,crash){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-publish-')),gate=new Int32Array(new SharedArrayBuffer(4));let worker;
 try{
  worker=new Worker(`const {workerData:d,parentPort}=require('node:worker_threads'),fs=require('node:fs'),gate=new Int32Array(d.gate),link=fs.linkSync;
   fs.linkSync=function(a,b){if(d.stage==='after')link.apply(this,arguments);parentPort.postMessage('paused');while(Atomics.load(gate,0)===0)Atomics.wait(gate,0,0,100);if(d.stage==='before')return link.apply(this,arguments);};
   try{const result=require(d.modulePath).createWorkspaceMetaStore({storageDir:d.dir}).markFirstConnected('fixture',d.first);parentPort.postMessage({result});}catch(e){parentPort.postMessage({error:e.code||e.message});}`,
   {eval:true,workerData:{modulePath,dir,gate:gate.buffer,stage,first}});
  let result;const paused=new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',m=>{if(m==='paused')resolve();else result=m;});});
  await Promise.race([paused,new Promise((_,reject)=>setTimeout(()=>reject(Error('publication barrier timeout')),3000).unref())]);
  const store=createWorkspaceMetaStore({storageDir:dir}),b=store.markFirstConnected('fixture',second),expected=stage==='after'?first:second;assert.equal(b.firstConnectedAt,expected);
  if(crash)await worker.terminate();else{const exit=new Promise(r=>worker.once('exit',r));Atomics.store(gate,0,1);Atomics.notify(gate,0);await exit;assert.equal(result.result.firstConnectedAt,expected);}
  assert.equal(createWorkspaceMetaStore({storageDir:dir}).load('fixture').firstConnectedAt,expected);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'_workspaces/fixture.json.first-connected'))).firstConnectedAt,expected);
 }finally{Atomics.store(gate,0,1);Atomics.notify(gate,0);await worker?.terminate();fs.rmSync(dir,{recursive:true,force:true});}
}
for(const stage of ['before','after'])for(const crash of [false,true])test(`atomic first publication: pause ${stage} commit, ${crash?'worker dies':'late worker resumes'}`,()=>race(stage,crash));
test('legacy committed timestamp wins and stale mutable metadata cannot erase its authority',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-legacy-'));try{
  fs.mkdirSync(path.join(dir,'_workspaces'));const file=path.join(dir,'_workspaces/fixture.json');fs.writeFileSync(file,JSON.stringify({workspaceId:'fixture',firstConnectedAt:first}));
  const store=createWorkspaceMetaStore({storageDir:dir});assert.equal(store.markFirstConnected('fixture',second).firstConnectedAt,first);
  fs.writeFileSync(file,JSON.stringify({workspaceId:'fixture',firstConnectedAt:null}));assert.equal(store.load('fixture').firstConnectedAt,first);
  assert.equal(store.save({workspaceId:'fixture',firstConnectedAt:second}).firstConnectedAt,first);
  fs.writeFileSync(file+'.first-connected','incomplete');assert.throws(()=>store.markFirstConnected('fixture',second),{code:'WORKSPACE_META_CORRUPTED'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
