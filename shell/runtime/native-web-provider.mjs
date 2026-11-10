import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage(),fail=code=>Object.assign(new Error('Trusted web call is unavailable'),{code});
export function withNativeWebExecution(active,execution,next){
 if(!['web_search','web_fetch'].includes(execution.name))return next();
 return scope.run({active,execution,ordinal:0},next);
}
export function installNativeWebProvider(ctx,{getActiveTurn,request}){
 const web=ctx.get('web');if(!web?.registerSearchProvider||!web?.registerFetchProvider)throw fail('WEB_PROVIDER_UNAVAILABLE');
 function binding(kind,signal){
  const value=scope.getStore(),active=value&&getActiveTurn(value.execution.agent);
  if(!value||!active||active!==value.active||value.execution.agent!==active.agent||value.execution.name!==(kind==='search'?'web_search':'web_fetch')||!active.stepNames?.has(value.execution.rootCallId||value.execution.callId))throw fail('RUN_TOOL_CONTEXT_INVALID');
  if(active.cancelRequested||active.expired||value.execution.signal.aborted||signal?.aborted)throw fail('RUN_CANCELLED');
  if(!active.toolPolicy?.allowedTools?.includes(value.execution.name))throw fail('RUN_TOOL_NOT_ALLOWED');return value;
 }
 async function invoke(kind,args,signal){
  const value=binding(kind,signal),ordinal=value.ordinal++;
  if(ordinal>0)throw fail('WEB_CALL_LIMIT');
  const result=await request(value.active,{kind,callId:String(value.execution.callId),ordinal,args},value.execution.signal);
  if(binding(kind,signal)!==value)throw fail('RUN_TOOL_CONTEXT_INVALID');return result;
 }
 const available=()=>{const value=scope.getStore();return !!value&&getActiveTurn(value.execution.agent)===value.active&&!value.active.cancelRequested&&!value.active.expired;};
 const a=web.registerSearchProvider({id:'northstar-host',available,search:(args,signal)=>invoke('search',args,signal)});
 const b=web.registerFetchProvider({id:'northstar-host',available,fetch:(args,signal)=>invoke('fetch',args,signal)});
 return ()=>{a();b();};
}
