'use strict';
const {createApprovalStore}=require('./store.cjs');
const fail=code=>Object.assign(new Error('Operation approval is unavailable'),{code});
function createApprovalService({db}){
 const store=scope=>createApprovalStore({db,...scope});
 async function ask({identity,runId,leaseOwner,args,signal}){
  if(!args||Object.keys(args).sort().join(',')!=='callId,payload')throw fail('APPROVAL_INPUT_INVALID');
  if(signal?.aborted)throw fail('APPROVAL_CANCELLED');
  const authority=store({identity,runId,leaseOwner});let card=await authority.request(args);
  while(card.approvalState==='pending'){
   if(signal?.aborted){await authority.cancel(args.callId);return {outcome:'cancelled'};}
   await new Promise(resolve=>{let timer;const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};signal?.addEventListener('abort',finish,{once:true});timer=setTimeout(finish,50);if(signal?.aborted)finish();});
   if(signal?.aborted){await authority.cancel(args.callId);return {outcome:'cancelled'};}
   card=await authority.get(args.callId);if(!card)throw fail('APPROVAL_STORE_UNAVAILABLE');
  }
  if(signal?.aborted){await authority.cancel(args.callId);return {outcome:'cancelled'};}
  return {outcome:card.approvalState==='approved'?'allowed-once':card.approvalState==='rejected'?'rejected':['expired','cancelled'].includes(card.approvalState)?'cancelled':'unavailable',approvalId:card.id,payloadSha256:card.payloadSha256};
 }
 function list(identity,runId){return store({identity,runId}).list();}
 function consume({identity,runId,leaseOwner,args,signal}){
  if(signal?.aborted)throw fail('APPROVAL_CANCELLED');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='approvalId,callId,payload')throw fail('APPROVAL_INPUT_INVALID');
  return store({identity,runId,leaseOwner}).consume(args);
 }
 function decide(identity,runId,approvalId,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='callId,decision,payloadSha256')throw fail('APPROVAL_INPUT_INVALID');
  return store({identity,runId}).decide({approvalId,...input});
 }
 return Object.freeze({ask,list,decide,consume});
}
module.exports={createApprovalService};
