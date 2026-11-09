'use strict';
const {createQuestionManager,validateQuestionInput}=require('./manager.cjs');
const {createQuestionStore}=require('./store.cjs');
const fail=code=>Object.assign(new Error('Question request could not be completed'),{code});
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function createQuestionService({db}) {
  function prepareQuestions(args) {
    if (!isObject(args) || Object.keys(args).some(k=>!['callId','questions'].includes(k)) || typeof args.callId!=='string' || args.callId.length<1 || args.callId.length>128 || !Array.isArray(args.questions) || args.questions.length<1 || args.questions.length>8 || new Set(args.questions.map(q=>q?.id)).size!==args.questions.length || Buffer.byteLength(JSON.stringify(args))>32768) throw fail('QUESTION_INPUT_INVALID');
    const questions=args.questions.map(q=>{
      if (!isObject(q) || Object.keys(q).some(k=>!['id','question','detail','header','options','multiSelect','intent'].includes(k)) || (q.intent!==undefined&&q.intent!==null)) throw fail('APPROVAL_SEAM_PENDING_SPEC');
      if(typeof q.id!=='string'||q.id.length>128)throw fail('QUESTION_INPUT_INVALID');
      const spec={type:'clarification',question:q.question,detail:q.detail??null,header:q.header??null,options:q.options,multiSelect:q.multiSelect??false,timeoutMs:60000,callId:args.callId};
      validateQuestionInput({questionId:q.id,...spec});
      return {id:q.id,spec};
    });
    return questions;
  }
  async function ask({identity,runId,leaseOwner,args,signal}) {
    const questions=prepareQuestions(args);
    const store=createQuestionStore({db,identity,runId,callId:args.callId,leaseOwner});
    const manager=createQuestionManager({...identity,runId,store});
    if(signal?.aborted) {await manager.cancelRun('Run aborted');throw fail('QUESTION_CANCELLED');}
    const abort=()=>{manager.cancelRun('Run aborted').catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const answers=await Promise.all(questions.map(async ({id,spec})=>{
        const result=await manager.askQuestion(id,spec),answer=result.answer;
        return {id,selected:Array.isArray(answer?.selected)?answer.selected:typeof answer==='string'?[answer]:[],...(typeof answer?.custom==='string'?{custom:answer.custom}:typeof answer==='string'&&!spec.options?{custom:answer}:{})};
      }));
      return {answers};
    } catch(error) {
      await manager.cancelRun('Question batch ended').catch(()=>{});
      throw error;
    } finally {signal?.removeEventListener('abort',abort);}
  }
  async function list(identity,runId) {
    const owned=await db.query('SELECT run_id FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3',[runId,identity.userId,identity.tenantId]);
    if(!owned.rows.length)throw fail('NOT_FOUND');
    const rows=(await db.query('SELECT call_id,question_id FROM agent_run_questions WHERE run_id=$1 ORDER BY call_id,question_id LIMIT 32',[runId])).rows;
    const questions=[];
    for(const row of rows){
      const store=createQuestionStore({db,identity,runId,callId:row.call_id});
      const record=await store.get(row.question_id);
      if(record)questions.push(Object.fromEntries(['id','callId','type','question','detail','header','options','multiSelect','deadline','status'].map(k=>[k,record[k]??null])));
    }
    return {questions};
  }
  async function answer(identity,runId,id,input) {
    if (!isObject(input) || Object.keys(input).sort().join(',')!=='answer,callId' || !isObject(input.answer) || Object.keys(input.answer).some(k=>!['selected','custom'].includes(k)) || Buffer.byteLength(JSON.stringify(input))>16384) throw fail('INVALID_ANSWER');
    if(!(Array.isArray(input.answer.selected)&&input.answer.selected.length) && !(typeof input.answer.custom==='string'&&input.answer.custom.trim()))throw fail('INVALID_ANSWER');
    const store=createQuestionStore({db,identity,runId,callId:input.callId});
    const manager=createQuestionManager({...identity,runId,store});
    return manager.submitAnswer(id,input.answer,{respondentTenantId:identity.tenantId,respondentUserId:identity.userId});
  }
  return Object.freeze({ask,list,answer,validate:args=>{prepareQuestions(args);return {valid:true};}});
}
module.exports={createQuestionService};
