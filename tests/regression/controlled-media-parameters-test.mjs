import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {controlledMediaParameters,matchesControlledMediaParameters}=require('../../shell/tasks/controlled-media-parameters.cjs');
const {createManagedMediaExecutor}=require('../../shell/media/managed-result-publisher.cjs');
const {callMediaRoute}=require('../../business/media/powertokens.cjs');
const route=(taskType,adapterId='pt-image-generations-v1')=>({schemaVersion:1,taskType,model:adapterId==='pt-image-generations-v1'?'seedream-5-0-260128':'fixture-video',scopeId:'fixture-scope',capabilityRevision:'a'.repeat(64),adapterId,adapterVersion:'1',endpoint:adapterId==='pt-image-generations-v1'?'openai-images-generations':'openai-videos',provider:adapterId==='pt-image-generations-v1'?'powertokens-image':'powertokens-video',kind:adapterId==='pt-image-generations-v1'?'image':'video'});
const callbacks={onExternalIntent:async()=>{},onExternalTaskId:async()=>{},onExternalResult:async value=>assert.equal(value.outcome,'succeeded'),onExternalSubmissionStarted:async()=>{}};
test('parameter confirmation is immutable and JSONB ordering does not change its meaning',()=>{
 const p=controlledMediaParameters('text2video');assert.equal(Object.isFrozen(p.executorOptions),true);
 assert.equal(matchesControlledMediaParameters('text2video',{parameterPolicy:p.policyVersion,generationParameters:{ratio:'16:9',resolution:'720P',durationSeconds:5}}),true);
 assert.equal(matchesControlledMediaParameters('text2video',{parameterPolicy:'old-version',generationParameters:p.generationParameters}),false);
 assert.equal(matchesControlledMediaParameters('text2video',{parameterPolicy:p.policyVersion,generationParameters:{...p.generationParameters,durationSeconds:30}}),false);
});
test('actual image POST cannot inherit prompt batch count, larger dimensions or caller options',async()=>{
 let body,posts=0;const execute=createManagedMediaExecutor({executeMedia:callMediaRoute,publishResult:async result=>result});
 await execute({}, {taskType:'text2image',prompt:'Generate 9 images at 4096x4096'}, {...callbacks,apiKey:'fixture',requireResolvedRoute:true,resolvedRoute:route('text2image'),n:9,size:'4096x4096',fetchImpl:async(_url,init)=>{posts++;body=JSON.parse(init.body);return new Response(JSON.stringify({data:[{url:'https://cdn.example.test/fixture.png'}]}),{headers:{'Content-Type':'application/json'}});}});
 assert.equal(posts,1);assert.equal(body.n,1);assert.equal(body.size,'2048x2048');assert.equal(body.sequential_image_generation,'disabled');
});
test('actual legacy video POST uses the confirmed duration/resolution despite a larger prompt',async()=>{
 let body,posts=0;const execute=createManagedMediaExecutor({executeMedia:callMediaRoute,publishResult:async result=>result});
 await execute({}, {taskType:'text2video',prompt:'Generate 30 seconds at 1080P'}, {...callbacks,apiKey:'fixture',requireResolvedRoute:true,resolvedRoute:route('text2video','pt-video-generations-v1'),duration:30,resolution:'1080P',fetchImpl:async(_url,init)=>{posts++;body=JSON.parse(init.body);return new Response(JSON.stringify({status:'completed',url:'https://cdn.example.test/fixture.mp4'}),{headers:{'Content-Type':'application/json'}});}});
 assert.equal(posts,1);assert.equal(body.seconds,'5');assert.equal(body.size,'720P');assert.equal(body.ratio,'16:9');
});
test('Python adapter receives only the confirmed bounded generation parameters',async()=>{
 let request;const execute=createManagedMediaExecutor({executeMedia:callMediaRoute,publishResult:async result=>result});
 await execute({}, {taskType:'text2video',prompt:'30 seconds at 1080P',duration:30,resolution:'1080P',ratio:'9:16'}, {...callbacks,apiKey:'fixture',requireResolvedRoute:true,resolvedRoute:route('text2video','pt-python-video-v1'),ptVideoBridge:async options=>{request=options.request;await options.onBeforeSubmit();const result={outcome:'completed',ok:true,resultUrls:['https://cdn.example.test/fixture.mp4'],taskId:'fixture'};await options.onResult(result);return result;}});
 assert.equal(request.duration,5);assert.equal(request.resolution,'720P');assert.equal(request.ratio,'16:9');
});
test('reference media uses only the trusted current upload, never the model supplied URL',async()=>{
 const source='data:image/png;base64,aG9zdC1maXh0dXJl';let body;
 const execute=createManagedMediaExecutor({executeMedia:callMediaRoute,inputImageUrl:source,publishResult:async result=>result});
 await execute({}, {taskType:'image2image',prompt:'edit fixture',inputImageUrl:'https://attacker.example.test/foreign.png'}, {...callbacks,apiKey:'fixture',requireResolvedRoute:true,resolvedRoute:route('image2image'),fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({data:[{url:'https://cdn.example.test/fixture.png'}]}),{headers:{'Content-Type':'application/json'}});}});
 assert.equal(body.image,source);assert.equal(JSON.stringify(body).includes('attacker.example'),false);
});
test('missing trusted reference fails before any executor or upload request',async()=>{
 let calls=0;const execute=createManagedMediaExecutor({executeMedia:async()=>{calls++;},publishResult:async()=>{}});
 await assert.rejects(execute({}, {taskType:'image2video',prompt:'fixture',inputImageUrl:'https://attacker.example.test/foreign.png'},callbacks),{code:'MEDIA_INPUT_IMAGE_REQUIRED'});assert.equal(calls,0);
});
