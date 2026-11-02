import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {open,migrate} from '../../shell/db.cjs';
import {initToolCalls} from '../../shell/tool-calls.cjs';

const require=createRequire(import.meta.url);
const {collectResponseUsage}=require('../../shell/runtime/usage.cjs');
const TRUSTED_TOTAL_SEMANTICS='dsh_pi_ai_disjoint_0_1_1_rc_2';

// Pinned local SDK shape: dsh-llm-pi-ai 0.1.1-rc.2 maps pi-ai Usage to
// TokenUsage, omitting cacheReadTokens/cacheWriteTokens when the source values
// are zero. dsh-session assistant/message events carry that usage under data.
// This fixture intentionally exercises the emitted shape without starting a
// provider or duplicating the adapter's mapping implementation.
const sessionMessage=(seq,turn,step,usage)=>({
  seq,
  type:'assistant/message',
  data:{turn,step,message:{role:'assistant',content:[]},...(usage===undefined?{}:{usage})},
});

test('DSH SDK-shaped terminal usage preserves omitted-cache, cache, and response boundaries',()=>{
  const events=[
    {seq:0,type:'turn/start',data:{turn:1}},
    // pi-ai done usage: input=10, output=2, cacheRead=0, cacheWrite=0.
    // Adapter output omits zero cache fields; at this locked DSH boundary
    // those omissions are normalized to zero.
    sessionMessage(1,1,1,{inputTokens:10,outputTokens:2}),
    {seq:2,type:'tool/result',data:{turn:1,step:1}},
    {seq:3,type:'turn/start',data:{turn:2}},
    // A second response after a tool step with nonzero cache counters.
    sessionMessage(4,2,2,{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheWriteTokens:1}),
  ];

  const result=collectResponseUsage(events,0);
  assert.deepEqual(result.responses,[
    {responseSeq:1,usage:{inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}},
    {responseSeq:4,usage:{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheWriteTokens:1}},
  ]);
  assert.equal(result.observedResponses,2);
  assert.equal(result.coverage,'complete');
  assert.equal(result.usage.inputTokens,17);
  assert.equal(result.usage.outputTokens,5);
  // pi-ai totalTokens includes cached input; the DSH normalized TokenUsage
  // has uncached input plus separate cache counters. The expected contract
  // total is 10+2 + 7+3 + 5+1 = 28; the current provider-neutral aggregate
  // reports the complete disjoint token total.
  assert.equal(10+2+7+3+5+1,28);
  assert.equal(result.usage.totalTokens,28);
  assert.equal(result.totalSemantics,TRUSTED_TOTAL_SEMANTICS);
});

test('DSH usage chunks dedupe against committed messages and preserve failed retry attempts',()=>{
  const usageChunk=(seq,turn,step,usage)=>({
    seq,
    type:'assistant/chunk',
    data:{turn,step,chunk:{type:'usage',usage}},
  });
  const textChunk=(seq,turn,step)=>({
    seq,
    type:'assistant/chunk',
    data:{turn,step,chunk:{type:'text-delta',index:0,text:'ok'}},
  });
  const events=[
    {seq:0,type:'turn/start',data:{turn:1}},
    usageChunk(1,1,1,{inputTokens:10,outputTokens:2}),
    textChunk(2,1,1),
    {...sessionMessage(3,1,1,{inputTokens:10,outputTokens:2}),sourceEventSeqs:[1,2]},
    // The adapter emits error usage as a usage chunk, but agent-loop retries
    // without committing an assistant/message for that failed attempt.
    usageChunk(4,1,2,{inputTokens:3,outputTokens:1}),
    usageChunk(5,1,2,{inputTokens:4,outputTokens:2}),
    textChunk(6,1,2),
    {...sessionMessage(7,1,2,{inputTokens:4,outputTokens:2}),sourceEventSeqs:[5,6]},
  ];

  const result=collectResponseUsage(events,0);
  assert.deepEqual(result.responses,[
    {responseSeq:3,usage:{inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}},
    {responseSeq:4,usage:{inputTokens:3,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}},
    {responseSeq:7,usage:{inputTokens:4,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}},
  ]);
  assert.equal(result.observedResponses,3);
  assert.equal(result.usage.totalTokens,22);
  assert.equal(result.totalSemantics,TRUSTED_TOTAL_SEMANTICS);
});

test('locked pi-ai all-zero placeholder on a successful message is unknown',()=>{
  // pi-ai initializes output.usage to zeros before the provider sends usage.
  // A completed stream without a usage-bearing chunk can retain that default.
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    sessionMessage(1,1,1,{inputTokens:0,outputTokens:0}),
  ],0);
  assert.equal(result.observedResponses,1);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('locked pi-ai all-zero placeholder on a failed usage chunk is unknown',()=>{
  // The adapter also emits a usage chunk for pi-ai error events even when the
  // upstream response never supplied usage; the failed attempt has no message.
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:0,outputTokens:0}}}},
  ],0);
  assert.equal(result.observedResponses,1);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('unreferenced DSH usage chunk is an unknown response when usage payload is absent',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:2}},
    {seq:1,type:'assistant/chunk',data:{turn:2,step:1,chunk:{type:'usage'}}},
  ],0);
  assert.equal(result.observedResponses,1);
  assert.deepEqual(result.responses,[{responseSeq:1,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}}]);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.coverage,'partial');
  assert.equal(result.totalSemantics,'unknown');
});

test('same-step usage chunk without a message citation cannot be double counted',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}},
    sessionMessage(2,1,1,{inputTokens:10,outputTokens:2}),
  ],0);
  assert.equal(result.observedResponses,1);
  assert.deepEqual(result.responses,[{responseSeq:2,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}}]);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('conflicting cited chunk and message usage cannot establish a trusted total',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}},
    {...sessionMessage(2,1,1,{inputTokens:9,outputTokens:2}),sourceEventSeqs:[1]},
  ],0);
  assert.equal(result.observedResponses,1);
  assert.deepEqual(result.responses,[{responseSeq:2,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}}]);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('two messages citing one usage chunk cannot establish two trusted responses',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}},
    {...sessionMessage(2,1,1,{inputTokens:10,outputTokens:2}),sourceEventSeqs:[1]},
    {...sessionMessage(3,1,1,{inputTokens:10,outputTokens:2}),sourceEventSeqs:[1]},
  ],0);
  assert.equal(result.observedResponses,2);
  assert.equal(result.responses.every((response)=>response.usage.inputTokens===null),true);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('future usage citation cannot establish a trusted total',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {...sessionMessage(1,1,1,{inputTokens:10,outputTokens:2}),sourceEventSeqs:[2]},
    {seq:2,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}},
  ],0);
  assert.equal(result.observedResponses,1);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('uncited same-step chunk after a cited chunk cannot be treated as a proven retry',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}},
    {seq:2,type:'assistant/chunk',data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:4,outputTokens:1}}}},
    {...sessionMessage(3,1,1,{inputTokens:10,outputTokens:2}),sourceEventSeqs:[1]},
  ],0);
  assert.equal(result.observedResponses,1);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});

test('conflicting replay of one event sequence cannot establish trusted usage',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    sessionMessage(1,1,1,{inputTokens:10,outputTokens:2}),
    sessionMessage(1,1,1,{inputTokens:99,outputTokens:2}),
  ],0);
  assert.equal(result.observedResponses,1);
  assert.equal(result.totalSemantics,'unknown');
});

test('usage citation across steps cannot establish trusted usage',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'assistant/chunk',data:{turn:1,step:2,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}},
    {...sessionMessage(2,1,1,{inputTokens:10,outputTokens:2}),sourceEventSeqs:[1]},
  ],0);
  assert.equal(result.totalSemantics,'unknown');
});

test('cache unknown stays unknown and only a proven total reaches usage persistence',async(t)=>{
  const unknown=collectResponseUsage([
    {seq:5,type:'turn/start',data:{turn:3}},
    sessionMessage(6,3,1,{inputTokens:10,outputTokens:2,cacheReadTokens:null,cacheWriteTokens:0}),
  ],5);
  assert.equal(unknown.usage.totalTokens,null);
  assert.equal(unknown.coverage,'partial');

  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-dsh-usage-shape-'));
  const {db,close}=await open({dataDir});
  t.after(async()=>{await close();fs.rmSync(dataDir,{recursive:true,force:true});});
  await migrate(db,path.resolve('shell/db-migrations'));
  const tenantId=(await db.query("INSERT INTO tenants (name) VALUES ('dsh-shape-usage') RETURNING id")).rows[0].id;
  const userId=(await db.query("INSERT INTO users (tenant_id,username,email,password_hash,role) VALUES ($1,'dsh-shape-usage',NULL,'scrypt$test$unused','admin') RETURNING id",[tenantId])).rows[0].id;
  const workspaceId=`ws_${tenantId}`;
  const runId='33333333-3333-4333-8333-333333333333';
  await db.query(`INSERT INTO agent_runs (run_id,conversation_id,user_id,tenant_id,workspace_id,contract_version,policy_version,state,idempotency_scope,request_hash,request)
    VALUES ($1,$2,$3,$4,$5,'v1','v1','completed','dsh-shape-scope','hash','{}'::jsonb)`,
    [runId,'44444444-4444-4444-8444-444444444444',userId,tenantId,workspaceId]);
  const toolCalls=await initToolCalls(db);
  const known=resultForPersistence();
  await toolCalls.logUsage({tenantId,userId,workspaceId,model:'fixture-model',runId,usageEvidence:known});
  const knownSummary=await toolCalls.usageSummary({tenantId,workspaceId,range:'month'});
  assert.equal(knownSummary.month.totalTokens,28);
  assert.equal(knownSummary.month.totalSemantics,TRUSTED_TOTAL_SEMANTICS);
  assert.equal(knownSummary.month.coverage,'complete');
  await toolCalls.logUsage({tenantId,userId,workspaceId,model:'fixture-model',runId,usageEvidence:unknown});
  const rows=(await db.query('SELECT response_seq,total_tokens,cache_read_tokens,cache_write_tokens,coverage,total_semantics FROM chat_usage ORDER BY response_seq')).rows;
  assert.equal(rows.length,3);
  assert.equal(Number(rows[0].total_tokens),12);
  assert.equal(Number(rows[0].cache_read_tokens),0);
  assert.equal(Number(rows[0].cache_write_tokens),0);
  assert.equal(rows[0].coverage,'complete');
  assert.equal(rows[0].total_semantics,TRUSTED_TOTAL_SEMANTICS);
  assert.equal(Number(rows[1].total_tokens),16);
  assert.equal(rows[2].total_tokens,null);
  assert.equal(rows[2].coverage,'partial');
  assert.equal(rows[2].total_semantics,'unknown');
  const mixedSummary=await toolCalls.usageSummary({tenantId,workspaceId,range:'month'});
  assert.equal(mixedSummary.month.totalTokens,null);
  assert.equal(mixedSummary.month.totalSemantics,'mixed');
  assert.equal(mixedSummary.month.coverage,'partial');
});

function resultForPersistence(){
  return collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    sessionMessage(1,1,1,{inputTokens:10,outputTokens:2}),
    {seq:2,type:'tool/result',data:{turn:1,step:1}},
    {seq:3,type:'turn/start',data:{turn:2}},
    sessionMessage(4,2,2,{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheWriteTokens:1}),
  ],0);
}

test('DSH SDK-shaped assistant/message with missing usage remains unknown',()=>{
  const result=collectResponseUsage([
    {seq:0,type:'turn/start',data:{turn:1}},
    sessionMessage(1,1,1,undefined),
  ],0);
  assert.equal(result.observedResponses,1);
  assert.deepEqual(result.responses,[{responseSeq:1,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}}]);
  assert.equal(result.coverage,'partial');
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.totalSemantics,'unknown');
});
