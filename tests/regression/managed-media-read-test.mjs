import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createManagedMediaReader,mediaByteRange}=require('../../shell/media/managed-media-read.cjs');
const id='11111111-2222-4333-8444-555555555555',filename='22222222-3333-4444-8555-666666666666.png';
test('media ranges accept bounded prefix/suffix and reject malformed or unsatisfiable requests',()=>{
 assert.equal(mediaByteRange(undefined,10),null);
 for(const [input,expected] of [['bytes=0-3',{start:0,end:3}],['bytes=5-',{start:5,end:9}],['bytes=-3',{start:7,end:9}],['bytes=-20',{start:0,end:9}],['bytes=0-99',{start:0,end:9}]])assert.deepEqual(mediaByteRange(input,10),expected);
 for(const input of ['bytes=-0','bytes=-','bytes=10-','bytes=5-4','bytes=0-1,4-5','bytes=1.5-2','bytes=9007199254740993-','other=0-1'])assert.throws(()=>mediaByteRange(input,10),{code:'MEDIA_RANGE_INVALID'});
});
test('owned media serves pinned GET/HEAD/Range and rejects tenant, Run, symlink and hardlink escapes',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'managed-media-read-'));
 const dir=path.join(root,id,'media-results',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,filename),'0123456789');
 let server,ownershipChecks=0;
 try{
  const reader=createManagedMediaReader({workspaceRoot:root,getRun:async(identity,runId)=>{ownershipChecks++;if(identity.userId!==id||identity.tenantId!==id||runId!==id)throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'NOT_FOUND'});return {runId,userId:identity.userId,tenantId:identity.tenantId};}});
  server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').searchParams.get('file')||filename;void reader(req,res,{userId:req.headers['x-fixture-foreign']?'99999999-2222-4333-8444-555555555555':id,tenantId:id},{runId:id,filename:name}).catch(()=>res.destroy());});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  let response=await fetch(base);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(await response.text(),'0123456789');
  response=await fetch(base,{headers:{Range:'bytes=2-5'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-5/10');assert.equal(await response.text(),'2345');
  response=await fetch(base,{method:'HEAD'});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),'10');assert.equal(await response.text(),'');
  response=await fetch(base,{headers:{Range:'bytes=0-1,3-4'}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */10');
  assert.equal((await fetch(base,{headers:{'x-fixture-foreign':'1'}})).status,404);
  const before=ownershipChecks;assert.equal((await fetch(base+'?file='+encodeURIComponent('../PRIVATE_SENTINEL'))).status,400);assert.equal(ownershipChecks,before);
  fs.unlinkSync(path.join(dir,filename));const outside=path.join(root,'private-fixture');fs.writeFileSync(outside,'PRIVATE_SENTINEL');fs.symlinkSync(outside,path.join(dir,filename));
  response=await fetch(base);assert.equal(response.status,404);assert.equal((await response.text()).includes('PRIVATE_SENTINEL'),false);
  fs.unlinkSync(path.join(dir,filename));fs.linkSync(outside,path.join(dir,filename));assert.equal((await fetch(base)).status,404);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
