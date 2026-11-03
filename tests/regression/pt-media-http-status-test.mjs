import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{callMediaRoute}=require('../../business/media/powertokens.cjs');
for(const [status,code] of [[401,'KEY_INVALID'],[402,'QUOTA_INSUFFICIENT'],[403,'UPSTREAM_FORBIDDEN']]){
 test('media POST '+status+' is classified without leaking body or retry',async()=>{
  let posts=0;const fetchImpl=async(_url,opts)=>{assert.equal(opts.method,'POST');posts++;return new Response('PRIVATE_UPSTREAM_SENTINEL',{status});};
  await assert.rejects(callMediaRoute({}, {taskType:'text2image',prompt:'fixture'}, {apiKey:'fixture',fetchImpl}),error=>{assert.equal(error.code,code);assert.equal(error.upstreamStatus,status);assert.doesNotMatch(error.message,/PRIVATE_UPSTREAM_SENTINEL/);return true;});assert.equal(posts,1);
 });
 test('media GET '+status+' keeps one submission and hides body',async()=>{
  const calls=[];const fetchImpl=async(_url,opts)=>{const method=opts.method||'GET';calls.push(method);return method==='POST'?new Response(JSON.stringify({id:'fixture-task'}),{status:200,headers:{'content-type':'application/json'}}):new Response('PRIVATE_UPSTREAM_SENTINEL',{status});};
  await assert.rejects(callMediaRoute({}, {taskType:'text2video',prompt:'fixture'}, {apiKey:'fixture',fetchImpl}),error=>{assert.equal(error.code,code);assert.doesNotMatch(error.message,/PRIVATE_UPSTREAM_SENTINEL/);return true;});assert.deepEqual(calls,['POST','GET']);
 });
}

test('unknown upstream status and URL never become success or leak raw status',async(t)=>{
 t.mock.method(globalThis,'setTimeout',fn=>{queueMicrotask(fn);return 0;});let posts=0,gets=0;
 const fetchImpl=async(_url,opts)=>{if(opts.method==='POST'){posts++;return new Response(JSON.stringify({id:'fixture-task'}));}gets++;return new Response(JSON.stringify({status:'PRIVATE_UPSTREAM_SENTINEL',progress:100,url:'https://cdn.example.test/result.mp4'}));};
 await assert.rejects(callMediaRoute({}, {taskType:'text2video',prompt:'fixture'}, {apiKey:'fixture',fetchImpl,timeoutMs:30000}),error=>{assert.doesNotMatch(error.message,/PRIVATE_UPSTREAM_SENTINEL/);assert.match(error.message,/状态缺失或未知/);return true;});assert.equal(posts,1);assert.equal(gets,40);
});
