import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {collectResponseUsage}=require('../../shell/runtime/usage.cjs');
const response=(seq,usage)=>({seq,type:'assistant/message',data:{usage}});
test('usage sums every observed response across a tool round trip',()=>{
 const result=collectResponseUsage([response(2,{inputTokens:10,outputTokens:1}),{seq:3,type:'tool/result'},response(5,{inputTokens:20,outputTokens:2})],2);
 assert.equal(result.usage.inputTokens,30);assert.equal(result.usage.outputTokens,3);assert.equal(result.usage.totalTokens,33);
 assert.equal(result.observedResponses,2);assert.equal(result.coverage,'complete');assert.equal(result.usage.cacheReadTokens,0);assert.equal(result.usage.cacheWriteTokens,0);
});
test('missing usage is unknown and does not make partial sums appear complete',()=>{
 const result=collectResponseUsage([response(1,{inputTokens:10,outputTokens:1}),response(2,undefined)]);
 assert.equal(result.observedResponses,2);assert.equal(result.usage.inputTokens,null);assert.equal(result.usage.outputTokens,null);
 assert.equal(result.coverage,'partial');assert.equal(result.usage.totalTokens,null);
});
test('zero components in nonzero usage are valid; duplicate event replay does not double count',()=>{
 const item=response(3,{inputTokens:0,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0});
 const result=collectResponseUsage([response(1,{inputTokens:99,outputTokens:99}),item,item],3);
 assert.equal(result.observedResponses,1);assert.equal(result.usage.totalTokens,2);assert.equal(result.usage.inputTokens,0);assert.equal(result.usage.cacheReadTokens,0);
});
test('locked SDK all-zero usage has no presence evidence and remains unknown',()=>{
 const item=response(3,{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0});
 const result=collectResponseUsage([item,item]);
 assert.equal(result.observedResponses,1);assert.equal(result.usage.totalTokens,null);
 assert.equal(result.coverage,'partial');assert.equal(result.totalSemantics,'unknown');
});
test('invalid or overflowing counters stay unknown',()=>{
 const result=collectResponseUsage([response(1,{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:-1}),response(2,{inputTokens:1,outputTokens:2})]);
 assert.equal(result.usage.inputTokens,null);assert.equal(result.usage.outputTokens,null);assert.equal(result.usage.totalTokens,null);
});
test('no response does not fabricate usage or request count',()=>{
 assert.deepEqual(collectResponseUsage([]),{usage:null,observedResponses:0,responses:[],coverage:'unavailable',totalSemantics:'unknown'});
});
test('SDK turn marker excludes a previous response at the cursor boundary',()=>{
 const result=collectResponseUsage([response(3,{inputTokens:100,outputTokens:100}),{seq:4,type:'turn/start'},response(5,{inputTokens:2,outputTokens:1})],3);
 assert.equal(result.usage.totalTokens,3);assert.equal(result.observedResponses,1);
});
