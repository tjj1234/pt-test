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

// Normalize only the native consumer's declared fields; the host reuses the
// exact side-effect-free validator used immediately before durable creation.
export function nativeQuestionPreflightArguments(execution) {
  const args=execution.arguments;
  if(!execution.callId||Buffer.byteLength(JSON.stringify(args)??'')>32768)throw fail('QUESTION_INPUT_INVALID');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='questions')||!Array.isArray(args.questions)||args.questions.length<1||args.questions.length>8)throw fail('QUESTION_INPUT_INVALID');
  const questions=args.questions.map(q=>{
    if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['id','question','header','options','multi_select'].includes(k)))throw fail('QUESTION_INPUT_INVALID');
    if(q.options!==undefined&&(!Array.isArray(q.options)||q.options.some(o=>!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!['label','description'].includes(k)))))throw fail('QUESTION_INPUT_INVALID');
    return {id:q.id,question:q.question,...(q.header!==undefined?{header:q.header}:{}),...(q.options!==undefined?{options:q.options.map(o=>o.label)}:{}),...(q.multi_select!==undefined?{multiSelect:q.multi_select}:{})};
  });
  return {callId:String(execution.callId),questions};
}
