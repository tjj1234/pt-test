// Independent adversarial review: intentionally red until boundary defects are fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import c from '../../shell/contracts/phase1.cjs';
const now='2026-10-16T00:00:00.000Z';
const identity={userId:'review-user',tenantId:'review-tenant'};
const run=(patch={})=>({...c.bindRun(identity,{version:c.VERSION,runId:'review-run',conversationId:'review-conv',workspaceId:'review-ws',state:'queued',revision:0,createdAt:now,policyVersion:'review-policy'}),...patch});
const event=(patch={})=>({version:c.VERSION,eventId:'review-event',runId:'review-run',conversationId:'review-conv',seq:1,type:'queued',occurredAt:now,payload:{},...patch});

test('review: cyclic fingerprint must reject with controlled TypeError, not stack overflow',()=>{
 const cyclic={};cyclic.self=cyclic;
 assert.throws(()=>c.fingerprint(cyclic),e=>e instanceof TypeError && !(e instanceof RangeError));
});
test('review: excessive nesting must reject before stack exhaustion',()=>{
 let nested={};for(let n=0;n<20000;n++)nested={nested};
 assert.throws(()=>c.fingerprint(nested),e=>e instanceof TypeError && !(e instanceof RangeError));
});
test('review: accepted event metadata must serialize safely',()=>{
 const cycle={};cycle.self=cycle;
 for(const payload of [{value:1n},cycle,{value:Infinity}]) {
  const e=event({payload});
  assert.notDeepEqual(c.validate('event',e),[], 'non-JSON payload must be rejected before persistence/SSE');
 }
});
test('review: extension fields cannot smuggle non-serializable values into accepted run',()=>{
 assert.notDeepEqual(c.validate('run',run({clientMetadata:1n})),[]);
});
test('review: revision increment must preserve valid run contract',()=>{
 const before=run({revision:Number.MAX_SAFE_INTEGER});
 assert.deepEqual(c.validate('run',before),[]);
 assert.throws(()=>c.transitionRun(before,'running',Number.MAX_SAFE_INTEGER),e=>e instanceof Error && !(e instanceof RangeError));
});
test('review: terminal done event cannot accompany queued run',()=>{
 assert.throws(()=>c.assertEventAfter(null,event({type:'done',payload:{state:'completed'}}),run()));
});
test('review: tool.finished event must require a terminal tool outcome',()=>{
 assert.notDeepEqual(c.validate('event',event({type:'tool.finished',callId:'review-call',payload:{state:'running'}})),[]);
});
test('review: explicit unknown capabilities must not enter AUTO',()=>{
 const model={version:c.VERSION,modelId:'review-model',provider:'pt',endpointTypes:['unknown'],inputModalities:['unknown'],outputModalities:['unknown'],tasks:['unknown'],capabilitySource:'unverified-name-guess',discovered:true,adapted:true,verified:true,autoEligible:true,observedAt:now};
 assert.notDeepEqual(c.validate('model',model),[]);
});
test('review: overlong idempotency key is rejected at boundary',()=>{
 assert.throws(()=>c.idempotencyClaim(identity,'create-run','k'.repeat(1024*1024),{}),TypeError);
});
test('review control: trusted identity override is rejected, same identity remains bound',()=>{
 assert.throws(()=>c.bindRun(identity,run({userId:'attacker'})),{code:'FORBIDDEN'});
 assert.throws(()=>c.bindRun(identity,run({tenantId:'other'})),{code:'FORBIDDEN'});
 assert.equal(c.bindRun(identity,run()).tenantId,identity.tenantId);
});
test('review control: wrong event run and conversation are rejected',()=>{
 for(const patch of [{runId:'other'},{conversationId:'other'}]) assert.throws(()=>c.assertEventAfter(null,event(patch),run()),{code:'EVENT_SCOPE_MISMATCH'});
});
test('review control: unknown reported model is preserved as null',()=>{
 const a={version:c.VERSION,attemptId:'a',runId:'review-run',requestedModel:'AUTO',resolvedModel:'routed-model',reportedModel:null,provider:'pt',endpointType:'chat',capability:'chat',requestId:null,state:'unknown',usageSource:null};
 assert.deepEqual(c.validate('attempt',a),[]);assert.equal(c.assertContract('attempt',a).reportedModel,null);
});

test('review control: done accepts each terminal append snapshot',()=>{
 for(const state of c.TERMINAL_STATES) {
  const e=event({type:'done',payload:{state}});
  assert.equal(c.assertEventAfter(null,e,run({state})),e);
 }
});
test('review control: tool.finished accepts terminal outcomes including unknown',()=>{
 for(const state of ['succeeded','failed','cancelled','unknown'])assert.deepEqual(c.validate('event',event({type:'tool.finished',callId:'call',payload:{state}})),[]);
});
test('review control: shared references are not confused with ancestor cycles',()=>{
 const shared={value:'hello'};assert.equal(c.fingerprint({a:shared,b:shared}),c.fingerprint({a:{value:'hello'},b:{value:'hello'}}));
});
test('review control: JSON byte, node and depth budgets accept boundaries and reject overflow',()=>{
 assert.match(c.fingerprint('a'.repeat(c.LIMITS.jsonBytes-2)),/^[a-f0-9]{64}$/);
 assert.throws(()=>c.fingerprint('a'.repeat(c.LIMITS.jsonBytes-1)),TypeError);
 assert.doesNotThrow(()=>c.fingerprint(Array(c.LIMITS.jsonNodes-1).fill(null)));
 assert.throws(()=>c.fingerprint(Array(c.LIMITS.jsonNodes).fill(null)),TypeError);
 let value=null;for(let i=0;i<c.LIMITS.jsonDepth;i++)value=[value];
 assert.doesNotThrow(()=>c.fingerprint(value));assert.throws(()=>c.fingerprint([value]),TypeError);
 assert.throws(()=>c.fingerprint('界'.repeat(Math.floor(c.LIMITS.jsonBytes/3)+1)),TypeError);
 assert.throws(()=>c.fingerprint({'long': '\u0000'.repeat(c.LIMITS.jsonBytes/6)}),TypeError);
});
test('review control: ordinary payload and exact idempotency limits remain usable',()=>{
 const payload={progress:0,message:'正常',details:[null,true,42,{nested:'text'}]};
 const e=event({payload});assert.deepEqual(c.validate('event',e),[]);assert.doesNotThrow(()=>JSON.stringify(e));
 assert.doesNotThrow(()=>c.idempotencyClaim(identity,'o'.repeat(c.LIMITS.operationChars),'k'.repeat(c.LIMITS.idempotencyKeyChars),payload));
 assert.throws(()=>c.idempotencyClaim(identity,'o'.repeat(c.LIMITS.operationChars+1),'k',{}),TypeError);
 assert.throws(()=>c.idempotencyClaim(identity,'o','k'.repeat(c.LIMITS.idempotencyKeyChars+1),{}),TypeError);
});
test('review control: last safe revision transition succeeds then rejects further increment',()=>{
 const result=c.transitionRun(run({revision:Number.MAX_SAFE_INTEGER-1}),'running',Number.MAX_SAFE_INTEGER-1);
 assert.deepEqual(c.validate('run',result),[]);assert.equal(result.revision,Number.MAX_SAFE_INTEGER);
 assert.throws(()=>c.transitionRun(result,'completed',Number.MAX_SAFE_INTEGER),{code:'REVISION_EXHAUSTED'});
});
test('review: done declared outcome must match terminal snapshot',()=>{
 assert.throws(()=>c.assertEventAfter(null,event({type:'done',payload:{state:'failed'}}),run({state:'completed'})));
});
test('review: hidden toJSON cannot bypass accepted metadata serialization safety',()=>{
 const payload={value:'normal'};Object.defineProperty(payload,'toJSON',{value(){throw new Error('serializer trap');},enumerable:false});
 assert.notDeepEqual(c.validate('event',event({payload})),[]);
});
