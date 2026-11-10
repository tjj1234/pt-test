import {AsyncLocalStorage} from 'node:async_hooks';import fs from 'node:fs';import path from 'node:path';
import {createHash} from 'node:crypto';
import {offlineAnalysisArguments,POLICY_REVISION} from './offline-analysis.mjs';
import {installNativeOperationApproval} from './native-operation-approval.mjs';
const scopes=new AsyncLocalStorage(),fail=code=>Object.assign(new Error('Read-only analysis is unavailable'),{code});
export function withNativeAnalysisExecution(active,execution,next){return ['analysis_list','analysis_read','run_script'].includes(execution.name)?scopes.run({active,execution},next):next();}
export function installNativeAnalysisProvider(ctx,{getActiveTurn,requestApproval,consumeApproval,argumentsFactory=offlineAnalysisArguments}){
 const approval=installNativeOperationApproval(ctx,{getActiveTurn,requestApproval,consumeApproval});
 let executing=false;
 function binding(){const b=scopes.getStore(),current=b&&getActiveTurn(b.execution.agent);if(!b||!current||current!==b.active||b.active.agent!==b.execution.agent||!b.active.analysisWorkspace||b.active.cancelRequested||b.active.expired||b.execution.signal.aborted||!b.active.stepNames?.has(b.execution.rootCallId||b.execution.callId))throw fail('ANALYSIS_CONTEXT_INVALID');return b;}
 const safe=text=>String(text).replace(/(?:\/(?:private|Users|home|root|var|etc|tmp|opt))\/[^\s"'<>,;]+/g,'[REDACTED_PATH]');
 async function list(){const b=binding(),target=await ctx.get('fs').resolve(b.active.analysisWorkspace.root,{signal:b.execution.signal});const entries=await ctx.get('fs').listDir(target,b.execution.signal);binding();return {files:b.active.analysisWorkspace.files.filter(file=>entries.some(entry=>entry.name===file.name))};}
 async function read(args){
  const b=binding();if(!args||Object.keys(args).join(',')!=='name'||!b.active.analysisWorkspace.files.some(file=>file.name===args.name))throw fail('ANALYSIS_FILE_NOT_ALLOWED');
  const file=path.join(b.active.analysisWorkspace.root,args.name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024)throw fail('ANALYSIS_INPUT_INVALID');
  const target=await ctx.get('fs').resolve(file,{signal:b.execution.signal}),bytes=await ctx.get('fs').readBytes(target,b.execution.signal,1024*1024);binding();
  if(createHash('sha256').update(bytes).digest('hex')!==b.active.analysisWorkspace.files.find(file=>file.name===args.name).sha256)throw fail('ANALYSIS_SNAPSHOT_CHANGED');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('ANALYSIS_BINARY_INPUT');}
  return {name:args.name,text:text.slice(0,16000),truncated:text.length>16000};
 }
 async function run(args){
  const b=binding();if(!args||Object.keys(args).sort().join(',')!=='code,language'||args.language!=='python'||typeof args.code!=='string'||args.code!==b.execution.arguments?.code||args.language!==b.execution.arguments?.language)throw fail('ANALYSIS_INPUT_INVALID');
  const config=argumentsFactory({workspaceRoot:b.active.analysisWorkspace.root,runtimeRoot:b.active.analysisWorkspace.runtimeRoot,code:args.code});
  const payload={command:args.code,workdir:'.',timeoutMs:config.timeoutMs,maxOutputBytes:config.maxOutputBytes,policyRevision:POLICY_REVISION};
  if(executing)throw fail('ANALYSIS_PROCESS_BUSY');executing=true;
  try{return await approval.execute(b.active,b.execution,payload,async()=>{
   binding();const timeout=AbortSignal.timeout(config.timeoutMs),signal=AbortSignal.any([b.execution.signal,timeout]);
   const handle=ctx.get('subprocess').spawn({argv:config.argv,cwd:b.active.analysisWorkspace.root,signal,graceMs:150,env:{},stdio:{stdin:'ignore',stdout:{maxBytes:config.maxOutputBytes},stderr:{maxBytes:config.maxOutputBytes}}});
   let outputExceeded=false;const timer=setInterval(()=>{for(const output of Object.values(handle.collected)){if(output.readFrom(0).nextOffset>config.maxOutputBytes){outputExceeded=true;handle.terminate();}}},20);
   try{const outcome=await handle.done;await handle.waitForExit();binding();const stdout=handle.collected.stdout.readFrom(0),stderr=handle.collected.stderr.readFrom(0);return {exitCode:outcome.exitCode,signal:outcome.signal,stdout:safe(stdout.text),stderr:safe(stderr.text),truncated:outputExceeded||stdout.lossy||stderr.lossy,timedOut:timeout.aborted,policyRevision:POLICY_REVISION};}
   finally{clearInterval(timer);handle.terminate();await handle.waitForExit();}
  });}finally{executing=false;}
 }
 return {list,read,run,dispose:approval.dispose};
}
