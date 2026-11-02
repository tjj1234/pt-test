import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createPtVideoBridge } = createRequire(import.meta.url)('../../shell/media/ptvideo-bridge.cjs');
const { guardPtVideoResult } = createRequire(import.meta.url)('../../shell/media/ptvideo-result-guard-candidate.cjs');
const worker = path.resolve('shell/media/ptvideo-worker.py');
// Runs the actual worker and reviewed engine; only the provider transport is replaced.
const fixture = `import importlib.util,sys,socket,json
from pathlib import Path
def blocked(*a,**k): raise RuntimeError('NETWORK_FORBIDDEN')
socket.socket.connect=blocked
socket.getaddrinfo=blocked
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
def transport(method,endpoint,key,body=None,timeout=None):
 with open(sys.argv[2],'a') as f: f.write(method+'\\n')
 if body and body.get('model')=='fixture-video-unknown': raise ConnectionResetError('PRIVATE_FIXTURE')
 if body and body.get('model')=='fixture-video': return {'id':'task_fixture_1'}
 if method=='GET': return {'status':'completed','url':'https://cdn.example.test/result.mp4'}
 return {'data':[{'url':'https://cdn.example.test/result.png'}]}
w.run(transport=transport)
`;
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptvideo-bridge-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const calls=path.join(dir,'calls'); let spawnOptions;
 const execute=createPtVideoBridge({validateResult:guardPtVideoResult,spawnImpl:(binary,args,options)=>{
  spawnOptions={args,options}; return spawn(binary,['-I','-B','-c',fixture,worker,calls],options);
 }});
 return {execute, calls:()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n'):[], options:()=>spawnOptions};
}
const input=()=>({apiKey:'fixture-private-key',request:{model:'fixture-image',kind:'image',prompt:'test'},baseUrl:'https://api.example.test',timeoutMs:3000,onBeforeSubmit:async()=>{},onTaskId:async()=>{},onResult:async()=>{}});
test('actual stdio worker waits for durable intent before one POST and result callback',async t=>{
 const f=setup(t), order=[]; const value=input();
 value.onBeforeSubmit=async()=>{assert.deepEqual(f.calls(),[]);order.push('intent');};
 value.onResult=async raw=>{assert.equal(raw.ok,true);assert.deepEqual(f.calls(),['POST']);order.push('result');};
 const result=await f.execute(value); assert.equal(result.ok,true); assert.deepEqual(order,['intent','result']);
 assert.ok(!JSON.stringify(f.options()).includes(value.apiKey));
});
test('intent persistence refusal yields zero provider requests',async t=>{
 const f=setup(t), value=input(); value.onBeforeSubmit=async()=>{throw Error(value.apiKey);};
 const result=await f.execute(value);assert.equal(result.ok,false);assert.equal(result.errorCode,'BEFORE_SUBMIT_REJECTED');assert.deepEqual(f.calls(),[]);
 assert.ok(!JSON.stringify(result).includes(value.apiKey));
});
test('local result persistence failure keeps generated assets without a second POST',async t=>{
 const f=setup(t), value=input(); value.onResult=async()=>{throw Error(value.apiKey);};
 const result=await f.execute(value);assert.equal(result.errorCode,'COMPLETED_LOCAL_SAVE_FAILED');assert.equal(result.resultUrls.length,1);assert.deepEqual(f.calls(),['POST']);
 assert.ok(!JSON.stringify(result).includes(value.apiKey));
});
test('cancellation before spawn and malformed gateway fail closed',async t=>{
 const f=setup(t), value=input(); value.signal=AbortSignal.abort();
 await assert.rejects(f.execute(value),{code:'MEDIA_ENGINE_CANCELLED'});assert.equal(f.options(),undefined);
 delete value.signal;value.baseUrl='https://@api.example.test';
 await assert.rejects(f.execute(value),{code:'MEDIA_BRIDGE_GATEWAY_INVALID'});assert.deepEqual(f.calls(),[]);
});

test('task ID must be durably acknowledged before polling',async t=>{
 const f=setup(t), value=input(); value.request={model:'fixture-video',kind:'video',prompt:'test'};
 value.onTaskId=async ({taskId})=>{assert.equal(taskId,'task_fixture_1');assert.deepEqual(f.calls(),['POST']);throw Error('PRIVATE');};
 const result=await f.execute(value);assert.equal(result.outcome,'needs_reconciliation');assert.equal(result.taskId,'task_fixture_1');assert.deepEqual(f.calls(),['POST']);
});
test('actual worker video protocol orders intent, ID, poll, result',async t=>{
 const f=setup(t), value=input(),order=[];value.request={model:'fixture-video',kind:'video',prompt:'test'};
 value.onBeforeSubmit=async()=>order.push('intent');value.onTaskId=async()=>order.push('id');value.onResult=async()=>order.push('result');
 const result=await f.execute(value);assert.equal(result.ok,true);assert.deepEqual(order,['intent','id','result']);assert.deepEqual(f.calls(),['POST','GET']);
});
function rogue(code,validateResult=raw=>raw){
 return createPtVideoBridge({validateResult,spawnImpl:(binary,args,options)=>spawn(binary,['-I','-B','-c',code],options)});
}
test('unsolicited success cannot bypass intent and result acknowledgements',async()=>{
 const code=`import sys,json
print(json.dumps({'version':1,'type':'ready'}),flush=True)
f=json.loads(sys.stdin.readline())
print(json.dumps({'version':1,'type':'done','requestId':f['requestId'],'result':{'ok':True}}),flush=True)
`;
 await assert.rejects(rogue(code)(input()),{code:'MEDIA_ENGINE_PROTOCOL_INVALID',submissionMayHaveStarted:false});
});
test('watchdog forcibly terminates an uncooperative process without exposing credentials',async()=>{
 const code=`import signal,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
print('{"version":1,"type":"ready"}',flush=True)
time.sleep(30)
`;
 const value=input();value.timeoutMs=150;value.killGraceMs=20;
 const start=Date.now();await assert.rejects(rogue(code)(value),error=>error.code==='MEDIA_ENGINE_TIMEOUT'&&!error.message.includes(value.apiKey));assert.ok(Date.now()-start<1500);
});
test('oversized worker output is bounded before JSON parsing',async()=>{
 await assert.rejects(rogue("import sys;sys.stdout.write('x'*300000);sys.stdout.flush()") (input()),{code:'MEDIA_ENGINE_STDOUT_LIMIT'});
});
test('watchdog retains a submitted task ID when its persistence callback hangs',async t=>{
 const f=setup(t),value=input();value.request={model:'fixture-video',kind:'video',prompt:'test'};value.timeoutMs=500;value.killGraceMs=20;
 value.onTaskId=async()=>new Promise(()=>{});
 await assert.rejects(f.execute(value),{code:'MEDIA_ENGINE_TIMEOUT',taskId:'task_fixture_1',submissionMayHaveStarted:true});assert.deepEqual(f.calls(),['POST']);
});
test('cancellation after intent acknowledgment reports possible submission and never resubmits',async t=>{
 const f=setup(t),value=input(),controller=new AbortController();value.signal=controller.signal;
 value.onResult=async()=>{controller.abort();};
 await assert.rejects(f.execute(value),{code:'MEDIA_ENGINE_CANCELLED',submissionMayHaveStarted:true});assert.deepEqual(f.calls(),['POST']);
});
test('qualified Run host traverses existing route executor, real worker and durable callbacks',async t=>{
 const f=setup(t),req=createRequire(import.meta.url);
 const {createMediaRunHandler}=req('../../shell/tasks/media-run-handler.cjs');
 const {callMediaRoute}=req('../../business/media/powertokens.cjs');
 const events=[];
 const route={schemaVersion:1,taskType:'text2video',model:'fixture-video',scopeId:'scope-fixture',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',endpoint:'openai-videos',provider:'powertokens-video',kind:'video'};
 const handler=createMediaRunHandler({identity:{userId:'fixture-user',tenantId:'fixture-tenant'},taskRun:{runId:'fixture-run',leaseOwner:'fixture-owner'},loadCredential:async()=> 'fixture-private-key',resolveRoute:async()=>route,
  store:{externalOperations:{createIntent:async()=>{assert.deepEqual(f.calls(),[]);events.push('intent');},recordTaskId:async(_i,_r,_k,v)=>{assert.equal(v.taskId,'task_fixture_1');assert.deepEqual(f.calls(),['POST']);events.push('task');},recordSubmissionResult:async(_i,_r,_k,v)=>{assert.equal(v.outcome,'succeeded');events.push('result');}}},
  executeMedia:(ctx,args,opts)=>callMediaRoute(ctx,args,{...opts,baseUrl:'https://api.example.test',ptVideoBridge:f.execute}),
 });
 const result=await handler.handle({name:'media.route',requestId:'12345678-1234-4123-8123-123456789012',args:{taskType:'text2video',prompt:'fixture'}});
 await handler.drain();assert.equal(result.url,'https://cdn.example.test/result.mp4');assert.deepEqual(events,['intent','task','result']);assert.deepEqual(f.calls(),['POST','GET']);
});
test('Python route cannot silently execute an unqualified JS adapter',async()=>{
 const {executePtVideoRoute}=createRequire(import.meta.url)('../../shell/media/ptvideo-executor.cjs');
 await assert.rejects(executePtVideoRoute({adapterId:'pt-video-generations-v1',taskType:'text2video'},{prompt:'fixture'}),{code:'MEDIA_ADAPTER_UNSUPPORTED'});
});
test('Python adapter preserves explicit parameters and reuses existing prompt parser',async()=>{
 const {callMediaRoute}=createRequire(import.meta.url)('../../business/media/powertokens.cjs');
 const route={schemaVersion:1,taskType:'text2video',model:'fixture-video',scopeId:'scope',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',endpoint:'openai-videos',provider:'powertokens-video',kind:'video'};
 let captured;
 const opts={resolvedRoute:route,apiKey:'fixture-key',onExternalIntent:async()=>{},onExternalSubmissionStarted:async()=>{},onExternalTaskId:async()=>{},onExternalResult:async()=>{},ptVideoBridge:async value=>{captured=value.request;return {outcome:'completed',ok:true,resultUrls:['https://cdn.example.test/a.mp4']};}};
 await callMediaRoute({}, {taskType:'text2video',prompt:'生成12秒，1080p视频'},opts);assert.equal(captured.duration,12);assert.equal(captured.resolution,'1080P');
 await callMediaRoute({}, {taskType:'text2video',prompt:'fixture',duration:8,resolution:'480p',ratio:'9:16'},opts);assert.equal(captured.duration,8);assert.equal(captured.resolution,'480p');assert.equal(captured.ratio,'9:16');
 captured=null;await assert.rejects(callMediaRoute({}, {taskType:'text2video',prompt:'fixture',duration:0},opts),{code:'MEDIA_REQUEST_PARAMETERS_INVALID'});assert.equal(captured,null);
 await assert.rejects(callMediaRoute({}, {taskType:'text2video',prompt:'fixture',n:3},opts),{code:'MEDIA_REQUEST_FIELD_UNSUPPORTED'});
});

test('real worker POST disconnect remains manual reconciliation in Run host with exactly one POST',async t=>{
 const f=setup(t),req=createRequire(import.meta.url),events=[];
 const {createMediaRunHandler}=req('../../shell/tasks/media-run-handler.cjs');const {callMediaRoute}=req('../../business/media/powertokens.cjs');
 const route={schemaVersion:1,taskType:'text2video',model:'fixture-video-unknown',scopeId:'scope',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',endpoint:'openai-videos',provider:'powertokens-video',kind:'video'};
 const handler=createMediaRunHandler({identity:{userId:'u',tenantId:'t'},taskRun:{runId:'run',leaseOwner:'owner'},loadCredential:async()=> 'fixture-private-key',resolveRoute:async()=>route,
  store:{externalOperations:{createIntent:async()=>events.push('intent'),get:async()=>({status:'submitting',taskId:null}),markUnknownSubmission:async()=>events.push('manual_check'),recordSubmissionResult:async()=>events.push('terminal')}},
  executeMedia:(ctx,args,opts)=>callMediaRoute(ctx,args,{...opts,baseUrl:'https://api.example.test',ptVideoBridge:f.execute})});
 await assert.rejects(handler.handle({name:'media.route',requestId:'12345678-1234-4123-8123-123456789012',args:{taskType:'text2video',prompt:'fixture'}}),{code:'SUBMISSION_OUTCOME_UNKNOWN'});
 await handler.drain();assert.deepEqual(f.calls(),['POST']);assert.deepEqual(events,['intent','manual_check']);
});
