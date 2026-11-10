import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
import {installNativeOperationApproval} from '../../shell/runtime/native-operation-approval.mjs';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const load=name=>import(pathToFileURL(require.resolve(name)));
const [{Context},{default:Approval},{Session,SessionId}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-user-approval','@deepseek-ai/dsh-session'].map(load));
const {operationSnapshot}=require('./approvals/store.cjs');
const operation=()=>({command:'printf hello',workdir:'.',timeoutMs:1000,maxOutputBytes:64000,policyRevision:'r34-v1'});
async function fixture(handler,consume=async()=>({ok:true})){const ctx=new Context();await ctx.plugin(Approval,{policy:'ask'});const turns=new Map();
 const bridge=installNativeOperationApproval(ctx,{getActiveTurn:agent=>turns.get(agent),requestApproval:handler,consumeApproval:consume});
 function turn(){const session=Session.create(SessionId(randomUUID()));session.append('turn/start',{turn:0});const agent={session},callId=randomUUID(),controller=new AbortController(),active={agent,stepNames:new Map([[callId,'bash']]),toolPolicy:{allowedTools:['bash']}};turns.set(agent,active);return {agent,session,active,controller,execution:{agent,callId,name:'bash',signal:controller.signal}};}
 return {ctx,bridge,turns,turn};
}
const receipt=payload=>({outcome:'allowed-once',approvalId:randomUUID(),payloadSha256:operationSnapshot(payload).sha256});
test('actual native approval service audits exact-operation allow and rejects unbound requests',async()=>{
 let asked=0,executed=0;const f=await fixture(async(_active,args)=>{asked++;return receipt(args.payload);}),t=f.turn();
 const value=await f.bridge.execute(t.active,t.execution,operation(),({receipt:r,operation:o})=>{executed++;assert.equal(r.payloadSha256,operationSnapshot(o).sha256);return 'executed';});
 assert.equal(value,'executed');assert.equal(asked,1);assert.equal(executed,1);
 const events=t.session.events.filter(e=>e.type.startsWith('approval/'));assert.deepEqual(events.map(e=>e.type),['approval/asked','approval/decided']);assert.equal(events[0].data.id,events[1].data.id);assert.equal(events[1].data.outcome,'allowed-once');
 assert.equal(await f.ctx.approval.request({agent:t.agent,callId:'unbound',toolName:'bash',signal:t.controller.signal}),'unavailable');assert.equal(asked,1);f.bridge.dispose();
});
test('native rejection, bad receipt and stale warm Run never execute',async()=>{
 for(const mode of ['rejected','bad-hash','stale']){
  let executed=0,f;f=await fixture(async(active,args)=>{if(mode==='stale')f.turns.set(active.agent,{...active});if(mode==='rejected')return {outcome:'rejected'};return {...receipt(args.payload),...(mode==='bad-hash'?{payloadSha256:'0'.repeat(64)}:{})};});const t=f.turn();
  await assert.rejects(f.bridge.execute(t.active,t.execution,operation(),()=>executed++));assert.equal(executed,0,mode);f.bridge.dispose();
 }
});
test('in-flight abort cancels native audit and late host grant cannot run; parallel scope stays separate',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),seen=[];
 const f=await fixture(async(active,args)=>{seen.push(active);if(args.payload.command==='slow'){entered();await gate;}return receipt(args.payload);}),a=f.turn(),b=f.turn();let slowExecuted=0,fastExecuted=0;
 const pending=f.bridge.execute(a.active,a.execution,{...operation(),command:'slow'},()=>slowExecuted++);pending.catch(()=>{});await started;
 await f.bridge.execute(b.active,b.execution,operation(),()=>fastExecuted++);a.controller.abort();await assert.rejects(pending,{code:'APPROVAL_CANCELLED'});release();await new Promise(r=>setImmediate(r));
 assert.equal(slowExecuted,0);assert.equal(fastExecuted,1);assert.deepEqual(seen,[a.active,b.active]);assert.equal(a.session.events.filter(e=>e.type==='approval/decided').at(-1).data.outcome,'cancelled');f.bridge.dispose();
});

test('native allowed-once cannot execute without successful durable consumption',async()=>{
 let executed=0;const f=await fixture(async(_active,args)=>receipt(args.payload),async()=>({ok:false})),t=f.turn();
 await assert.rejects(f.bridge.execute(t.active,t.execution,operation(),()=>executed++),{code:'APPROVAL_NOT_CONSUMABLE'});
 assert.equal(executed,0);f.bridge.dispose();
});
