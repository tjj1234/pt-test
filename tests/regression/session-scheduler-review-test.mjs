import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionScheduler}=require('../../shell/runtime/session-scheduler.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function task(s,{id,user='u',session=id,process='p',context={},onStart}={}){
 const started=deferred(),end=deferred();let count=0;
 const h=s.submit({runId:id,userId:user,sessionId:session,processId:process,context,execute:async args=>{count++;started.resolve(args);onStart?.(args);return end.promise;}});
 return {...h,started:started.promise,end:end.resolve,count:()=>count};
}
test('independent: quotas and FIFO survive cancellation of a blocked head',async()=>{
 const s=createSessionScheduler({perUserLimit:1,globalLimit:2});
 const a=task(s,{id:'a',session:'same'}),a2=task(s,{id:'a2',session:'same'}),a3=task(s,{id:'a3',session:'same'}),b=task(s,{id:'b',user:'b'});
 await Promise.all([a.started,b.started]);await a2.cancel();await assert.rejects(a2.result,{code:'SCHEDULER_CANCELLED'});assert.equal(a2.count(),0);
 a.end();await a.result;await a3.started;assert.equal(b.getState(),'running');assert.equal(s.stats().running,2);
 a3.end();b.end();await Promise.all([a3.result,b.result]);assert.equal(s.stats().active,0);await s.close();
});
test('independent: non-Error rejection releases every quota and preserves failure outcome',async()=>{
 const s=createSessionScheduler({globalLimit:1});const broken=s.submit({runId:'bad',userId:'u',sessionId:'s',processId:'p',execute:()=>Promise.reject('synthetic failure')});const next=task(s,{id:'next',session:'s'});
 await assert.rejects(broken.result,{code:'EXECUTION_FAILED'});await next.started;assert.equal(broken.getState(),'failed');next.end();await next.result;await s.close();
});
test('independent: process failure before callback turn signals stop and never frees quota prematurely',async()=>{
 const s=createSessionScheduler({globalLimit:1});const a=task(s,{id:'a'}),queued=task(s,{id:'q'});const failure=s.failProcess('p',new Error('dead'));
 const args=await a.started;assert.equal(args.signal.aborted,true);assert.equal(queued.count(),0);assert.equal(s.stats().running,1);
 a.end();await failure;await assert.rejects(a.result,{code:'PROCESS_FAILED'});await assert.rejects(queued.result,{code:'PROCESS_FAILED'});assert.equal(s.stats().active,0);await s.close();
});
test('independent: caller mutations cannot change identity or nested scheduled context',async()=>{
 const s=createSessionScheduler();const shared={x:1};const original={nested:{value:'a'},sharedA:shared,sharedB:shared,userId:'spoof',processId:'spoof'};
 const a=task(s,{id:'a',context:original});original.nested.value='b';const args=await a.started;
 assert.equal(args.context.nested.value,'a');assert.equal(args.context.userId,'u');assert.equal(args.context.processId,'p');assert.equal(Object.isFrozen(args.context.sharedA),true);
 assert.throws(()=>{args.context.sharedA.x=3;},TypeError);a.end();await a.result;await s.close();
});
test('independent: repeated process errors keep first active failure authoritative',async()=>{
 const s=createSessionScheduler();const a=task(s,{id:'a'});await a.started;const first=new Error('first'),second=new Error('second');const f1=s.failProcess('p',first),f2=s.failProcess('p',second);
 a.end();await Promise.all([f1,f2]);await assert.rejects(a.result,e=>e.code==='PROCESS_FAILED'&&e.cause===first);await s.close();
});
test('independent: reentrant close from abort listener shares the single shutdown promise',async()=>{
 const s=createSessionScheduler({globalLimit:1});let nestedClose;
 const a=task(s,{id:'a',onStart:({signal})=>signal.addEventListener('abort',()=>{nestedClose=s.close();},{once:true})});await a.started;
 const outerClose=s.close();assert.ok(nestedClose);a.end();await Promise.all([nestedClose,outerClose]);await assert.rejects(a.result,{code:'SCHEDULER_CANCELLED'});
 assert.equal(nestedClose,outerClose,'reentrant close must return authoritative shared completion');assert.equal(s.close(),outerClose);
});
