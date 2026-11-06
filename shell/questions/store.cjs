'use strict';
const {randomUUID} = require('node:crypto');
const contracts = require('../contracts/phase1.cjs');
const fail = code => Object.assign(new Error('Question authority unavailable'), {code});
const terminal = new Set(['completed','failed','cancelled','interrupted']);
const copy = value => JSON.parse(JSON.stringify(value));
const text = (value,max=128) => typeof value==='string' && value.trim().length>0 && value.length<=max && !/[\x00-\x1f\x7f]/.test(value);
const millis = value => value instanceof Date ? value.getTime() : Date.parse(value);

// A store is permanently bound to trusted host scope. No call accepts a new owner.
function createQuestionStore({db,identity,runId,callId,leaseOwner}={}) {
  contracts.assertContract('identity',identity);
  if (!db?.transaction || !text(runId) || !text(callId) || (leaseOwner!==undefined&&!text(leaseOwner))) throw fail('QUESTION_SCOPE_INVALID');
  identity=Object.freeze({...identity});
  const key=[runId,callId];
  async function owned(tx) {
    const r=await tx.query('SELECT * FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE',[runId,identity.userId,identity.tenantId]);
    if (!r.rows[0]) throw fail('NOT_FOUND');
    return r.rows[0];
  }
  async function clock(tx) {
    // Deliberately a separate statement AFTER Run and question row locks.
    return Number((await tx.query('SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS ms')).rows[0].ms);
  }
  async function getRow(tx,id) {
    return (await tx.query('SELECT record FROM agent_run_questions WHERE run_id=$1 AND call_id=$2 AND question_id=$3 FOR UPDATE',[...key,id])).rows[0]?.record || null;
  }
  async function cancelled(tx) {
    return (await tx.query('SELECT cancelled,reason FROM agent_question_scopes WHERE run_id=$1',[runId])).rows[0] || {cancelled:false};
  }
  function live(run,record,now) {
    return run.state==='running' && text(run.lease_owner) && millis(run.lease_expires_at)>now &&
      (!leaseOwner || run.lease_owner===leaseOwner) && (!record?.leaseOwner || run.lease_owner===record.leaseOwner);
  }
  async function event(tx,run,record,now) {
    if (terminal.has(run.state)) return;
    const question=Object.fromEntries(['id','callId','type','question','detail','header','options','multiSelect','deadline','status'].map(k=>[k,record[k]??null]));
    const e={version:contracts.VERSION,eventId:randomUUID(),runId,conversationId:run.conversation_id,seq:run.next_seq,type:'state',occurredAt:new Date(now).toISOString(),payload:{action:'user_question',question}};
    contracts.assertContract('event',e);
    await tx.query('INSERT INTO agent_run_events(event_id,run_id,seq,event) VALUES($1,$2,$3,$4::jsonb)',[e.eventId,runId,run.next_seq,JSON.stringify(e)]);
    await tx.query('UPDATE agent_runs SET next_seq=next_seq+1 WHERE run_id=$1',[runId]);
    run.next_seq++;
  }
  async function write(tx,run,record,next,updates,now) {
    const updated={...record,...updates,status:next,updatedAt:now};
    if (next==='answered') updated.answeredAt=now;
    if (next==='expired') updated.expiredAt=now;
    if (next==='cancelled') updated.cancelledAt=now;
    await tx.query('UPDATE agent_run_questions SET status=$1,record=$2::jsonb WHERE run_id=$3 AND call_id=$4 AND question_id=$5',[next,JSON.stringify(updated),...key,record.id]);
    await event(tx,run,updated,now);
    return updated;
  }
  async function current(tx,run,record,now) {
    if (!record || record.status!=='pending') return record;
    const stop=await cancelled(tx);
    if (stop.cancelled || !live(run,record,now)) return write(tx,run,record,'cancelled',{cancelReason:stop.reason || 'Run is no longer active'},now);
    if (now>=record.deadline) return write(tx,run,record,'expired',{},now);
    return record;
  }
  async function get(id) {
    if (!text(id)) throw fail('QUESTION_INPUT_INVALID');
    return db.transaction(async tx=>{const run=await owned(tx),r=await getRow(tx,id),now=await clock(tx);return current(tx,run,r,now);});
  }
  async function savePending(record) {
    if (!record || record.runId!==runId || record.tenantId!==identity.tenantId || record.userId!==identity.userId || record.callId!==callId || !text(record.id) || record.type!=='clarification' || record.status!=='pending' || !text(record.signature,128) || !Number.isSafeInteger(record.deadline) || record.deadline<=0 || Buffer.byteLength(JSON.stringify(record))>32768) throw fail('QUESTION_SCOPE_INVALID');
    return db.transaction(async tx=>{
      const run=await owned(tx),existing=await getRow(tx,record.id),now=await clock(tx);
      if (existing) {
        if (existing.signature!==record.signature) throw fail('ID_CONFLICT');
        return current(tx,run,existing,now);
      }
      const stop=await cancelled(tx);
      if (stop.cancelled || !live(run,null,now) || !leaseOwner) throw fail('QUESTION_CANCELLED');
      const count=Number((await tx.query('SELECT count(*) AS count FROM agent_run_questions WHERE run_id=$1',[runId])).rows[0].count);
      if (count>=32) throw fail('QUESTION_LIMIT');
      const saved=copy({...record,leaseOwner,status:now>=record.deadline?'expired':'pending'});
      await tx.query('INSERT INTO agent_run_questions(run_id,call_id,question_id,status,deadline,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...key,record.id,saved.status,saved.deadline,JSON.stringify(saved)]);
      await event(tx,run,saved,now);
      return saved;
    });
  }
  async function updateStatusIfPending(id,next,updates={},constraints={}) {
    if (!text(id) || !['answered','expired'].includes(next)) throw fail('QUESTION_INPUT_INVALID');
    if (constraints.runId!==runId || constraints.tenantId!==identity.tenantId || constraints.userId!==identity.userId) return {ok:false,code:'UNAUTHORIZED_SCOPE'};
    return db.transaction(async tx=>{
      const run=await owned(tx),raw=await getRow(tx,id),now=await clock(tx);
      if (!raw) return {ok:false,code:'QUESTION_NOT_FOUND'};
      const record=await current(tx,run,raw,now);
      if (record.status!=='pending') return {ok:false,code:record.status==='expired'?'QUESTION_TIMEOUT':record.status==='cancelled'?'QUESTION_CANCELLED':'ALREADY_FINALIZED',record};
      if (next==='expired') return {ok:false,code:'NOT_YET_EXPIRED',record};
      if (updates.respondentUserId!==identity.userId || updates.respondentTenantId!==identity.tenantId) return {ok:false,code:'UNAUTHORIZED_RESPONDENT'};
      if (Buffer.byteLength(JSON.stringify(updates))>16384) return {ok:false,code:'INVALID_ANSWER'};
      const answerUpdates=Object.fromEntries(['answer','selectedOptions','customText','respondentUserId','respondentTenantId'].filter(k=>updates[k]!==undefined).map(k=>[k,copy(updates[k])]));
      const updated=await write(tx,run,record,'answered',answerUpdates,now);
      return {ok:true,record:updated};
    });
  }
  async function cancelRun(expectedRun,expectedTenant,reason='Run cancelled') {
    if (expectedRun!==runId || expectedTenant!==identity.tenantId) throw fail('UNAUTHORIZED_SCOPE');
    return db.transaction(async tx=>{
      const run=await owned(tx);
      await tx.query('INSERT INTO agent_question_scopes(run_id,cancelled,reason) VALUES($1,TRUE,$2) ON CONFLICT(run_id) DO UPDATE SET cancelled=TRUE,reason=EXCLUDED.reason',[runId,String(reason).slice(0,200)]);
      const rows=(await tx.query("SELECT record FROM agent_run_questions WHERE run_id=$1 AND status='pending' ORDER BY call_id,question_id FOR UPDATE",[runId])).rows;
      const now=await clock(tx);
      for (const {record} of rows) {
        const updated={...record,status:'cancelled',cancelReason:String(reason).slice(0,200),cancelledAt:now,updatedAt:now};
        await tx.query("UPDATE agent_run_questions SET status='cancelled',record=$1::jsonb WHERE run_id=$2 AND call_id=$3 AND question_id=$4",[JSON.stringify(updated),runId,record.callId,record.id]);
        await event(tx,run,updated,now);
      }
    });
  }
  async function isRunCancelled(expectedRun,expectedTenant) {
    if (expectedRun!==runId || expectedTenant!==identity.tenantId) throw fail('UNAUTHORIZED_SCOPE');
    return db.transaction(async tx=>{const run=await owned(tx),now=await clock(tx),stop=await cancelled(tx);return {cancelled:stop.cancelled || !live(run,null,now),reason:stop.reason};});
  }
  return Object.freeze({get,savePending,updateStatusIfPending,cancelRun,isRunCancelled,pollIntervalMs:100});
}
module.exports={createQuestionStore};
