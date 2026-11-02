// Independent gate counterexamples. Controlled dispatch only, no provider/network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Context} from '../../shell/node_modules/@deepseek-ai/cordis/lib/index.js';
import {ChatAdmissionTicketManager,installNativeContextGateR3} from '../../shell/runtime/dsh-native-context-r3-candidate.mjs';
const results=[];
async function scenario(name,setup){
 const ctx=new Context(),tickets=new ChatAdmissionTicketManager();let calls=0,settles=0;
 const turn={sessionId:'s',runId:'r',tenantId:'t',budget:{admit:()=>({allowed:true,settle:()=>settles++})}};
 const config={getActiveTurn:()=>turn,ticketManager:tickets};
 const input={purpose:'compaction',sessionId:'s',provider:'p',model:'m'};
 const extra=setup({turn,config,input,tickets});
 const installed=installNativeContextGateR3(ctx,config);
 let error=null;
 try{const stream=ctx.waterfall('llm/stream',input,()=>{calls++;return (async function*(){yield 'fixture';})();});
 await extra?.beforeConsume?.();for await(const chunk of stream){};
 }catch(e){error=e.code||e.message;}
 installed.dispose();results.push({name,dispatches:calls,settles,error});
}
await scenario('chat-ticket-without-active-run',({config,input,tickets})=>{
 config.getActiveTurn=()=>null;input.purpose='chat';input.admissionTicket=tickets.issueTicket({runId:'r',sessionId:'s',provider:'p',model:'m'});
});
await scenario('chat-ticket-old-run-client-overrides-active-run',({input,tickets})=>{
 input.purpose='chat';input.runId='old';input.admissionTicket=tickets.issueTicket({runId:'old',sessionId:'s',provider:'p',model:'m'});
});
await scenario('auxiliary-missing-required-intent-recorder',()=>{});
await scenario('auxiliary-canceled-while-awaiting-intent',({turn,config})=>{
 config.recordModelIntent=async()=>{turn.cancelRequested=true;};
});
await scenario('auxiliary-canceled-after-stream-created-before-consume',({turn,config})=>{
 config.recordModelIntent=async()=>{};return {beforeConsume:async()=>{turn.cancelRequested=true;}};
});
assert.ok(results.every(row=>row.dispatches===1),'documented counterexamples remain reproducible');
const result={status:'BLOCKED_FOR_INTEGRATION',providerCalls:0,controlledDispatchCounterexamples:results};
fs.writeFileSync(new URL('../../docs/refactor/evidence/context-r3-main-review-20261101.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
