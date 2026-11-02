// Repeatable acceptance regressions, independent of candidate-authored tests.
// A nonzero exit means the candidate MUST NOT be integrated as-is.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Context} from '../../shell/node_modules/@deepseek-ai/cordis/lib/index.js';
const args=process.argv.slice(2),candidate=args.includes('--candidate')?args[args.indexOf('--candidate')+1]:'shell/runtime/dsh-native-context-r4-candidate.mjs';
const {ChatAdmissionTicketManager,installNativeContextGateR4:install}=await import(pathToFileURL(path.resolve(candidate)));
const results=[];
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,code:error.code||'ASSERTION_FAILED'});}};
await check('ticket-requires-budget-admission',()=>{
 const manager=new ChatAdmissionTicketManager();assert.throws(()=>manager.issueTicket({runId:'r',sessionId:'s',provider:'p',model:'m'}));
});
await check('ticket-requires-complete-binding',()=>{
 const manager=new ChatAdmissionTicketManager();assert.throws(()=>manager.issueTicket({sessionId:'s',budgetAdmission:{allowed:true}}));
});
await check('ticket-rejects-nonfinite-ttl',()=>{
 const manager=new ChatAdmissionTicketManager();assert.throws(()=>manager.issueTicket({runId:'r',sessionId:'s',provider:'p',model:'m',ttlMs:Infinity,budgetAdmission:{allowed:true}}));
});
async function setup(config={}){
 const ctx=new Context();let dispatches=0,settles=0,maxTokens;
 let turn={sessionId:'s',runId:'r',tenantId:'t',maxOutputTokens:8,budget:{admit:()=>({allowed:true,settle:()=>settles++})}};
 const installed=install(ctx,{getActiveTurn:()=>turn,recordModelIntent:async()=>{},...config});
 const options={sessionId:'s',purpose:'compaction',provider:'p',model:'m',maxTokens:1024};
 const stream=()=>ctx.waterfall('llm/stream',options,()=>{dispatches++;maxTokens=options.maxTokens;return (async function*(){yield 'fixture';})();});
 return {installed,stream,options,get:()=>({dispatches,settles,maxTokens}),replace:()=>{turn={...turn,runId:'other'};}};
}
await check('replaced-active-run-rejected-before-dispatch',async()=>{
 let replace;const s=await setup({recordModelIntent:async()=>replace()});replace=s.replace;
 try{for await(const item of s.stream()){};}catch{}finally{s.installed.dispose();}
 assert.equal(s.get().dispatches,0);
});
await check('actual-output-token-cap-enforced',async()=>{
 const s=await setup();try{for await(const item of s.stream()){};}finally{s.installed.dispose();}
 assert.ok(s.get().maxTokens<=8);
});
await check('intent-failure-does-not-leak-error-detail',async()=>{
 const s=await setup({recordModelIntent:async()=>{throw Error('private-review-fixture');}});let message='';
 try{for await(const item of s.stream()){};}catch(error){message=error.message;}finally{s.installed.dispose();}
 assert.equal(s.get().dispatches,0);assert.equal(message.includes('private-review-fixture'),false);
});
await check('event-callback-failure-settles-admission',async()=>{
 const ctx=new Context();let settles=0,dispatches=0;
 const installed=install(ctx,{getActiveTurn:()=>({sessionId:'s',runId:'r',tenantId:'t',budget:{admit:()=>({allowed:true,settle:()=>settles++})},recordEvent:()=>{throw Error('fixture');}}),recordModelIntent:async()=>{}});
 try{const stream=ctx.waterfall('llm/stream',{sessionId:'s',purpose:'compaction',provider:'p',model:'m'},()=>{dispatches++;return (async function*(){yield 'fixture';})();});for await(const item of stream){};}catch{}finally{installed.dispose();}
 assert.equal(dispatches,0);assert.equal(settles,1);
});
await check('unconsumed-stream-return-releases-admission',async()=>{
 const s=await setup();try{const stream=s.stream();await stream.return();}finally{s.installed.dispose();}
 assert.equal(s.get().dispatches,0);assert.equal(s.get().settles,1);
});
console.log(JSON.stringify({candidate,status:results.every(result=>result.passed)?'REVIEW_REGRESSIONS_PASS':'BLOCKED_FOR_INTEGRATION',providerCalls:0,checks:results},null,2));
if(results.some(result=>!result.passed))process.exitCode=1;
