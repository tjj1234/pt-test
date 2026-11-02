// Reproduces review blockers; PASS means the unsafe candidate behavior exists.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {installNativeContextGateR2} from '../../shell/runtime/dsh-native-context-r2-candidate.mjs';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const {Context}=await import(require.resolve('@deepseek-ai/cordis'));
const {createRunBudget}=require('./tasks/budget.cjs');
const ctx=new Context();let dispatched=0;
const budget=createRunBudget({limits:{maxModelCalls:1}});
const cancelled={sessionId:'session-a',tenantId:'a',runId:'r',cancelRequested:true,budget};
installNativeContextGateR2(ctx,{getActiveTurn:sid=>sid==='session-a'?cancelled:null});
const consume=async options=>{const stream=await ctx.waterfall('llm/stream',options,async()=>{dispatched++;return(async function*(){yield 'fixture';})();});for await(const _ of stream){}};
await consume({purpose:'chat'});
assert.equal(dispatched,1);assert.equal(budget.snapshot().modelCalls,0);
await consume({purpose:'compaction',sessionId:'session-a'});
assert.equal(dispatched,2);assert.equal(budget.snapshot().modelCalls,1);
console.log(JSON.stringify({review:'BLOCKED_CANDIDATE_NOT_INTEGRATED',reproduced:['unbound-chat-dispatched-without-budget','cancelled-turn-compaction-dispatched'],fixtureDispatches:dispatched,providerCalls:0}));
