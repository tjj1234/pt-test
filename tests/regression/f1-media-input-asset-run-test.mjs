import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createMediaInputAsset}=require('../../shell/tasks/media-input-asset.cjs');
const {createManagedMediaExecutor}=require('../../shell/media/managed-result-publisher.cjs');
const {createMediaRunHandler}=require('../../shell/tasks/media-run-handler.cjs');
const identity={userId:'user',tenantId:'tenant'},taskRun={runId:'11111111-1111-4111-8111-111111111111',leaseOwner:'lease',emit:async()=>{}};
const requestId='22222222-2222-4222-8222-222222222222';

test('asset upload persists distinct intent, task and result before generation receives asset ref',async()=>{
 const calls=[];
 const operations={createIntent:async(_i,_r,p)=>calls.push(['intent',p.operationKey,p.provider]),recordTaskId:async(_i,_r,_k,p)=>calls.push(['task',p.taskId]),recordSubmissionResult:async(_i,_r,_k,p)=>calls.push(['result',p.outcome]),markUnknownSubmission:async()=>calls.push(['unknown'])};
 const bridgeFactory=()=>({upload:async p=>{await p.onBeforeSubmit();await p.onSubmissionStarted();await p.onTaskId({taskId:'upload_task_1'});await p.onAssetId({assetId:'asset_1'});return {ok:true,outcome:'succeeded',taskId:'upload_task_1',assetId:'asset_1'};}});
 const upload=createMediaInputAsset({operations,emit:async(_type,p)=>calls.push(['asset',p.assetId]),bridgeFactory});
 const ref=await upload({identity,taskRun,requestId,bytes:Buffer.from('image'),apiKey:'fixture',signal:new AbortController().signal});
 assert.equal(ref,'asset://asset_1');
 assert.deepEqual(calls.map(x=>x[0]),['intent','task','asset','result']);
 assert.equal(calls[0][1],`${taskRun.runId}:${requestId}:asset`);
 let received;
 const execute=createManagedMediaExecutor({executeMedia:async(_ctx,args,opts)=>{received=args.inputImageUrl;await opts.onExternalResult({outcome:'succeeded'});return {kind:'video',url:'https://fixture.test/video.mp4'};},publishResult:async r=>r,inputImageUrl:'data:image/png;base64,AAAA'});
 await execute({}, {taskType:'image2video',prompt:'test'}, {preparedInputImageUrl:ref,onExternalResult:async()=>{}});
 assert.equal(received,ref);
});

test('unknown submission is durable and never automatically resubmitted',async()=>{
 const calls=[];
 const operations={createIntent:async()=>calls.push('intent'),recordTaskId:async()=>calls.push('task'),recordSubmissionResult:async()=>calls.push('result'),markUnknownSubmission:async()=>calls.push('manual_check')};
 const upload=createMediaInputAsset({operations,emit:async()=>{},bridgeFactory:()=>({upload:async p=>{await p.onBeforeSubmit();await p.onSubmissionStarted();throw Error('connection lost');}})});
 await assert.rejects(upload({identity,taskRun,requestId,bytes:Buffer.from('image'),apiKey:'fixture'}),e=>e.code==='MEDIA_ASSET_UPLOAD_INCOMPLETE');
 assert.deepEqual(calls,['intent','manual_check']);
});

test('known upload task recovers by anonymous GET before video submission',async()=>{
 const calls=[];
 const operations={createIntent:async()=>calls.push('intent'),recordTaskId:async()=>calls.push('task'),recordSubmissionResult:async()=>calls.push('succeeded'),markUnknownSubmission:async()=>calls.push('unknown')};
 let uploads=0,recovers=0;
 const bridgeFactory=()=>({upload:async p=>{uploads++;await p.onBeforeSubmit();await p.onSubmissionStarted();await p.onTaskId({taskId:'asset_task_2'});throw Object.assign(Error('poll failed'),{code:'ASSET_ENGINE_FAILED'});},
  recover:async p=>{recovers++;assert.equal(p.apiKey,undefined);await p.onAssetId({assetId:'asset_2'});return {ok:true,outcome:'succeeded',taskId:'asset_task_2',assetId:'asset_2'};}});
 const upload=createMediaInputAsset({operations,emit:async()=>calls.push('asset'),bridgeFactory});
 assert.equal(await upload({identity,taskRun,requestId,bytes:Buffer.from('image'),apiKey:'fixture'}),'asset://asset_2');
 assert.deepEqual(calls,['intent','task','asset','succeeded']);
 assert.equal(uploads,1);assert.equal(recovers,1);
});

test('image2video host RPC uploads and commits asset before video intent',async()=>{
 const calls=[],states=new Map();
 const operations={
  createIntent:async(_i,_r,p)=>{calls.push(['intent',p.operationKey]);states.set(p.operationKey,{taskId:null});},
  recordTaskId:async(_i,_r,k,p)=>{calls.push(['task',k]);states.get(k).taskId=p.taskId;},
  recordSubmissionResult:async(_i,_r,k,p)=>calls.push(['result',k,p.outcome]),
  markUnknownSubmission:async()=>calls.push(['unknown']),
  get:async(_i,_r,k)=>states.get(k),
 };
 const assetBridgeFactory=()=>({upload:async p=>{await p.onBeforeSubmit();await p.onSubmissionStarted();await p.onTaskId({taskId:'asset_task_1'});await p.onAssetId({assetId:'asset_1'});return {ok:true,outcome:'succeeded',taskId:'asset_task_1',assetId:'asset_1'};}});
 const handler=createMediaRunHandler({store:{externalOperations:operations},identity,taskRun:{...taskRun,signal:new AbortController().signal,emit:async(_t,p)=>calls.push(['event',p.action])},
  loadCredential:async()=> 'fixture',resolveRoute:async()=>({adapterId:'pt-python-seedance-v1',kind:'seedance',provider:'fixture'}),assetBridgeFactory,inputImageBytes:Buffer.from('image'),
  executeMedia:async(_ctx,_args,opts)=>{assert.equal(opts.preparedInputImageUrl,'asset://asset_1');calls.push(['video']);await opts.onExternalIntent({provider:'fixture'});await opts.onExternalSubmissionStarted();await opts.onExternalTaskId({taskId:'video_task_1'});await opts.onExternalResult({outcome:'succeeded',providerStatus:'succeeded'});return {kind:'video'};},
 });
 await handler.handle({requestId,name:'media.route',args:{taskType:'image2video',prompt:'fixture'},signal:new AbortController().signal});
 const assetResult=calls.findIndex(x=>x[0]==='result'&&x[1].endsWith(':asset'));
 const videoIntent=calls.findIndex(x=>x[0]==='intent'&&!x[1].endsWith(':asset'));
 assert.ok(assetResult>=0&&videoIntent>assetResult);
 assert.equal(calls.filter(x=>x[0]==='video').length,1);
});
