import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createManagedResultPublisher,createManagedMediaExecutor}=require('../../shell/media/managed-result-publisher.cjs');
const id='11111111-2222-4333-8444-555555555555',file='22222222-3333-4444-8555-666666666666.png';
const identity={userId:id,tenantId:id},bytes=Buffer.from('fixture-media-bytes'),digest=createHash('sha256').update(bytes).digest('hex');
const result={kind:'image',url:'https://cdn.example.test/result.png?token=PRIVATE_SENTINEL',taskType:'text2image',model:'fixture-model'};
const context={identity,runId:id};
const receipt={rel:'media-results/'+id+'/'+file,kind:'image',mime:'image/png',size:bytes.length,sha256:digest};
const response=()=>new Response(bytes,{status:200,headers:{'Content-Type':'image/png','Content-Length':String(bytes.length)}});
const factory=extra=>createManagedResultPublisher({workspaceRoot:'/fixture/workspaces',allowedHosts:['cdn.example.test'],fetchImpl:async()=>response(),writeArtifact:async()=>receipt,...extra});
test('publisher downloads anonymously, binds tenant/run and emits only a managed receipt',async()=>{
 let writes=0,published=0;
 const publish=factory({fetchImpl:async(url,options)=>{assert.equal(new URL(url).hostname,'cdn.example.test');assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');assert.equal(options.headers,undefined);return response();},writeArtifact:async input=>{writes++;assert.equal(input.tenantId,id);assert.equal(input.runId,id);assert.deepEqual(input.buffer,bytes);return receipt;},onPublished:async media=>{published++;assert.equal(media.url,'/api/run-media/'+id+'/'+file);}});
 const saved=await publish(result,context);assert.equal(writes,1);assert.equal(published,1);assert.equal(Object.isFrozen(saved.managed),true);assert.equal(JSON.stringify(saved).includes('PRIVATE_SENTINEL'),false);assert.equal(saved.model,'fixture-model');
});
test('fetch failures, invalid receipt and callback failures never expose signed URL or original error',async()=>{
 for(const extra of [{fetchImpl:async()=>{throw Error('PRIVATE_SENTINEL');}},{writeArtifact:async()=>({...receipt,rel:'media-results/other/'+file})},{onPublished:async()=>{throw Error('PRIVATE_SENTINEL');}}])await assert.rejects(factory(extra)(result,context),error=>{assert.ok(['MEDIA_RESULT_LOCAL_SAVE_FAILED','MEDIA_PUBLISH_RECEIPT_INVALID'].includes(error.code));assert.equal(JSON.stringify(error).includes('PRIVATE_SENTINEL'),false);assert.equal(error.message.includes('PRIVATE_SENTINEL'),false);assert.equal(error.cause,undefined);return true;});
});
test('host allowlist is copied and cancellation refuses before writing',async()=>{
 const hosts=['cdn.example.test'];let writes=0;
 const publish=factory({allowedHosts:hosts,writeArtifact:async()=>{writes++;return receipt;}});hosts[0]='other.example.test';
 assert.equal((await publish(result,context)).kind,'image');assert.equal(writes,1);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(publish(result,{...context,signal:cancelled.signal}));assert.equal(writes,1);
});
test('executor awaits durable remote success before publishing and executes exactly once on local failure',async()=>{
 const order=[];let calls=0;
 const execute=createManagedMediaExecutor({executeMedia:async(_c,_a,options)=>{calls++;order.push('submit');await options.onExternalResult({outcome:'succeeded'});return result;},publishResult:async()=>{order.push('publish');throw Object.assign(Error('local failure'),{code:'MEDIA_RESULT_LOCAL_SAVE_FAILED'});}});
 await assert.rejects(execute({}, {taskType:'text2image'},{onExternalResult:async()=>{await Promise.resolve();order.push('durable-remote-success');}}),{code:'MEDIA_RESULT_LOCAL_SAVE_FAILED'});
 assert.deepEqual(order,['submit','durable-remote-success','publish']);assert.equal(calls,1);
});
test('missing acknowledgement, failed durable write or unknown provider outcome prevents all local publication',async()=>{
 for(const scenario of ['no-ack','write-failed','unknown']){
  let publications=0,calls=0;
  const execute=createManagedMediaExecutor({executeMedia:async(_c,_a,o)=>{calls++;if(scenario==='unknown')throw Object.assign(Error('fixture'),{code:'SUBMISSION_OUTCOME_UNKNOWN'});if(scenario==='write-failed')await o.onExternalResult({outcome:'succeeded'});return result;},publishResult:async()=>{publications++;}});
  await assert.rejects(execute({}, {taskType:'text2image'},{onExternalResult:async()=>{throw Error('durable write failed');}}));assert.equal(publications,0);assert.equal(calls,1);
 }
});
test('tenant, media kind and SDK metadata are snapshotted before asynchronous download',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 const mutable={...result},owner={...identity};
 const publish=factory({fetchImpl:async()=>{entered();await gate;return response();},writeArtifact:async args=>{assert.equal(args.tenantId,id);assert.equal(args.kind,'image');return receipt;}});
 const pending=publish(mutable,{identity:owner,runId:id});await ready;
 mutable.model='PRIVATE_SENTINEL';mutable.kind='video';owner.tenantId='99999999-2222-4333-8444-555555555555';release();
 const saved=await pending;assert.equal(saved.model,'fixture-model');assert.equal(saved.kind,'image');assert.equal(JSON.stringify(saved).includes('PRIVATE_SENTINEL'),false);
});
