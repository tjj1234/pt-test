import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const {createMediaRunHandler}=createRequire(import.meta.url)('../../shell/tasks/media-run-handler.cjs');
function fixture(executeMedia){
 const writes=[];
 const externalOperations={createIntent:async()=>writes.push(['intent']),recordSubmissionResult:async(_i,_r,_k,value)=>writes.push(['result',value]),get:async()=>({status:'submitting',taskId:null}),markUnknownSubmission:async(_i,_r,_k,value)=>writes.push(['unknown',value]),recordTaskId:async()=>{}};
 const handler=createMediaRunHandler({store:{externalOperations},identity:{userId:'user',tenantId:'tenant'},taskRun:{runId:'run',leaseOwner:'owner'},loadCredential:async()=> 'fixture-key',executeMedia,fetchImpl:async()=>{throw Error('FETCH_FORBIDDEN');}});
 return {writes,handle:()=>handler.handle({name:'media.route',requestId:randomUUID(),args:{taskType:'text2video',prompt:'fixture'}})};
}
test('non-fetch POST with lost response is unknown, never cancelled as not submitted',async()=>{
 const f=fixture(async(_ctx,_args,opts)=>{await opts.onExternalIntent({provider:'fixture'});await opts.onExternalSubmissionStarted();throw Error('response lost');});
 await assert.rejects(f.handle(),/response lost/);assert.deepEqual(f.writes.map(w=>w[0]),['intent','unknown']);assert.equal(f.writes[1][1].reason,'submission_response_unknown');
});
test('submission before durable intent is rejected without a false external result',async()=>{
 const f=fixture(async(_ctx,_args,opts)=>{await opts.onExternalSubmissionStarted();});
 await assert.rejects(f.handle(),{code:'EXTERNAL_INTENT_MISSING'});assert.deepEqual(f.writes,[]);
});
test('intent acknowledged but subprocess not released remains not submitted',async()=>{
 const f=fixture(async(_ctx,_args,opts)=>{await opts.onExternalIntent({provider:'fixture'});throw Error('worker unavailable');});
 await assert.rejects(f.handle(),/worker unavailable/);assert.equal(f.writes[1][1].outcome,'cancelled');assert.equal(f.writes[1][1].reason,'not_submitted');
});
test('registered Python provider has GET-only recovery through the existing query adapter',async()=>{
 const {createPowerTokensQueryAdapters}=createRequire(import.meta.url)('../../shell/tasks/provider-adapters.cjs');
 const calls=[];const adapters=createPowerTokensQueryAdapters({baseUrl:'https://api.example.test',apiKey:'fixture-key',fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return {ok:true,status:200,text:async()=>JSON.stringify({status:'completed'})};}});
 await adapters['powertokens-video'].queryTask({provider:'powertokens-video',taskId:'task_fixture_1'});
 assert.deepEqual(calls,[{url:'https://api.example.test/v1/videos/task_fixture_1',method:'GET'}]);
});
