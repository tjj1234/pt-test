import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'):JSON.stringify(value);
const scope=new AsyncLocalStorage();
const fail=code=>Object.assign(new Error('Exact operation approval is unavailable'),{code});
// Native approval deliberately has no tool arguments. Capture the exact trusted
// execution at the guard boundary; never reconstruct it from reason/query text.
export function installNativeOperationApproval(ctx,{getActiveTurn,requestApproval,consumeApproval}){
 if(typeof getActiveTurn!=='function'||typeof requestApproval!=='function'||typeof consumeApproval!=='function')throw fail('APPROVAL_CONFIGURATION_INVALID');
 const current=b=>b&&getActiveTurn(b.execution.agent)===b.active&&b.active.agent===b.execution.agent&&!b.active.expired&&!b.active.cancelRequested&&!b.execution.signal.aborted;
 const dispose=ctx.on('approval/request',async(request,next)=>{
  const binding=scope.getStore();
  if(!binding||request.agent!==binding.execution.agent||request.callId!==binding.execution.callId||request.toolName!==binding.execution.name)return next();
  if(!current(binding))return 'cancelled';
  const receipt=await requestApproval(binding.active,{callId:String(binding.execution.callId),payload:binding.operation},binding.execution.signal);
  if(!current(binding))return 'cancelled';
  if(receipt?.outcome==='allowed-once'){
   if(!/^[a-f0-9-]{36}$/i.test(receipt.approvalId||'')||receipt.payloadSha256!==createHash('sha256').update(canonical(binding.operation)).digest('hex'))return 'unavailable';
   binding.receipt=Object.freeze({approvalId:receipt.approvalId,payloadSha256:receipt.payloadSha256});return 'allowed-once';
  }
  return ['rejected','cancelled','unavailable'].includes(receipt?.outcome)?receipt.outcome:'unavailable';
 });
 async function execute(active,execution,operation,next){
  if(!active||!execution?.agent||typeof next!=='function'||!['bash','run_script'].includes(execution.name)||!execution.callId||!execution.signal||!active.stepNames?.has(execution.rootCallId||execution.callId))throw fail('APPROVAL_CONTEXT_INVALID');
  const root=execution.rootCallId||execution.callId;
  if((root===execution.callId&&active.stepNames.get(root)!==execution.name)||!active.toolPolicy?.allowedTools?.includes(execution.name))throw fail('APPROVAL_CONTEXT_INVALID');
  const copy=JSON.parse(JSON.stringify(operation));Object.freeze(copy);
  const binding={active,execution,operation:copy,receipt:null};
  if(!current(binding))throw fail('APPROVAL_CANCELLED');
  const approval=ctx.get('approval');if(!approval?.request)throw fail('APPROVAL_NATIVE_UNAVAILABLE');
  return scope.run(binding,async()=>{
   const outcome=await approval.request({agent:execution.agent,toolName:execution.name,callId:execution.callId,reason:'Approve only the exact operation shown in the owned Run card',signal:execution.signal});
   if(!current(binding))throw fail('APPROVAL_CANCELLED');
   if(outcome!=='allowed-once'||!binding.receipt)throw fail(outcome==='rejected'?'APPROVAL_REJECTED':outcome==='cancelled'?'APPROVAL_CANCELLED':'APPROVAL_UNAVAILABLE');
   const consumed=await consumeApproval(active,{approvalId:binding.receipt.approvalId,callId:String(execution.callId),payload:copy},execution.signal);
   if(consumed?.ok!==true)throw fail('APPROVAL_NOT_CONSUMABLE');
   if(!current(binding))throw fail('APPROVAL_CANCELLED');
   return next({receipt:binding.receipt,operation:copy});
  });
 }
 return Object.freeze({execute,dispose});
}
