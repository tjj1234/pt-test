import {AsyncLocalStorage} from 'node:async_hooks';
const executionScope=new AsyncLocalStorage();
const fail=code=>Object.assign(new Error('Native question requires an active scoped tool call'),{code});
export function withNativeQuestionExecution(active,execution,next) {
  if(execution.name!=='ask_user_question')return next();
  return executionScope.run({active,agent:execution.agent,callId:execution.callId,signal:execution.signal},next);
}
export function installNativeQuestionProvider(ctx,{getActiveTurn,ask}) {
  const service=ctx.get('userQuestions');
  if(!service?.registerProvider)throw fail('QUESTION_PROVIDER_UNAVAILABLE');
  return service.registerProvider({async ask(request){
    const binding=executionScope.getStore(),active=getActiveTurn(request.agent);
    if(!binding || !active || active!==binding.active || request.agent!==binding.agent || active.agent!==request.agent || !binding.callId || !active.stepNames?.has(binding.callId))throw fail('RUN_TOOL_CONTEXT_INVALID');
    if(active.cancelRequested || active.expired || binding.signal.aborted || request.signal?.aborted)throw fail('QUESTION_CANCELLED');
    if(!active.toolPolicy?.allowedTools?.includes('ask_user_question'))throw fail('RUN_TOOL_NOT_ALLOWED');
    if(!Array.isArray(request.questions)||request.questions.some(q=>q.intent!==undefined))throw fail('APPROVAL_SEAM_PENDING_SPEC');
    const questions=request.questions.map(q=>({id:q.id,question:q.question,...q.detail!==undefined?{detail:q.detail}:{},...q.header!==undefined?{header:q.header}:{},...q.options!==undefined?{options:q.options.map(o=>typeof o==='string'?o:o.label)}:{},...q.multiSelect!==undefined?{multiSelect:q.multiSelect}:{}}));
    const result=await ask(active,{callId:String(binding.callId),questions});
    if(active.cancelRequested || active.expired || binding.signal.aborted)throw fail('QUESTION_CANCELLED');
    return result;
  }});
}
