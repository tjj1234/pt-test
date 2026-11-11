// Feasibility only: actual locked DSH AgentLoop/tools/model-selection, deterministic
// LlmAdapter. No app changes, PT credentials, HTTP listener, or provider requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const net=require('node:net');let networkAttempts=0;
net.Socket.prototype.connect=function(){networkAttempts++;throw Error('PROBE_NETWORK_FORBIDDEN');};
globalThis.fetch=async()=>{networkAttempts++;throw Error('PROBE_NETWORK_FORBIDDEN');};
const load=name=>import(pathToFileURL(require.resolve(name)));
const [{Context},{default:Agents,installModelSelection},{default:Sessions},{SessionId},{default:Llm,LlmAdapter,CallId,createUserMessage},{default:Prompt},{default:Tools,defineTool},{default:Loop}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop'].map(load));
const {createRunBudget}=require('./tasks/budget.cjs');
const results=[],traces=[];
async function check(name,body){const start=Date.now();await body();results.push({name,result:'PASS',elapsedMs:Date.now()-start});}
async function setup(script){
 const ctx=new Context(),calls=[],bodies=[];for(const [plugin,config]of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]} ]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
 class Adapter extends LlmAdapter{
  async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text']};}
  async *stream(options){const record={sessionId:String(options.sessionId),model:options.model,toolNames:(options.tools||[]).map(t=>t.name),messages:JSON.stringify(options.messages)};calls.push(record);const block=await script(record,calls);yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:7,outputTokens:3}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};}
 }
 ctx.llm.registerAdapter(['offline'],new Adapter());const handles=[];
 async function agent({label='probe',initial='planner-a',tools={},registrationScope='global',guardLocal=false}={}){
  const selection={current:{provider:'offline',model:initial},assembled:undefined};let mask,handle,allowedNames=new Set();
  const expose=(model,names)=>{allowedNames=new Set(names);selection.current={provider:'offline',model};selection.assembled=undefined;mask?.();const native=handle.agent.ctx.tools.view(handle.agent);mask=handle.agent.ctx.tools.restrict({deny:[...native.restrictableNames].filter(n=>!names.includes(n))});};
  handle=await ctx.agents.create({sessionId:SessionId('auto-feasibility-'+label+'-'+randomUUID()),meta:{cwd:process.cwd()},agentOptions:{provider:'offline',model:initial,maxTokens:2048},setup:agentCtx=>{
   installModelSelection(agentCtx,selection);
   if(guardLocal)agentCtx.on('tools/execute',(execution,next)=>{if(!allowedNames.has(execution.name))throw Object.assign(Error('Host step denied'),{code:'STEP_TOOL_DENIED'});return next();});
   for(const [name,execute]of Object.entries(tools))(registrationScope==='global'?ctx.tools:agentCtx.tools).register(defineTool({name,description:'Offline feasibility tool '+name,parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_a,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(_args,toolContext)=>{bodies.push({label,name});return execute({expose,handle,signal:toolContext?.signal});}}));
  }});handles.push(handle);await handle.agent.whenIdle();return {handle,expose,selection,async run(text){handle.agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));await handle.agent.whenIdle();}};
 }
 return {ctx,calls,bodies,agent,async close(){for(const h of handles)await h.dispose();}};
}
const tool=(name,id=name)=>({type:'tool-call',id:CallId(id),name,arguments:{}}),text=value=>({type:'text',text:value});
await check('native one-turn three-step model switch and tool-result handoff',async()=>{
 const payload={source:'owned-fixture',value:42},digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const f=await setup(async(record,calls)=>{if(calls.length===1)return tool('prepare','prepare-1');if(calls.length===2){assert.equal(record.model,'worker-b');assert.ok(record.messages.includes(digest));assert.ok(record.messages.includes('owned-fixture'));return tool('render','render-1');}assert.equal(record.model,'writer-c');assert.ok(record.messages.includes('artifact-fixture'));return text('DELIVERED_FIXTURE');});
 try{const a=await f.agent({tools:{prepare:async({expose})=>{expose('worker-b',['render']);return {payload,sha256:digest};},render:async({expose})=>{expose('writer-c',[]);return {artifact:'artifact-fixture',sha256:digest};}}});a.expose('planner-a',['prepare']);await a.run('Perform the offline three-step task');assert.deepEqual(f.calls.map(c=>c.model),['planner-a','worker-b','writer-c']);assert.deepEqual(f.bodies.map(x=>x.name),['prepare','render']);assert.equal(new Set(f.calls.map(c=>c.sessionId)).size,1);assert.equal(a.handle.agent.session.events.filter(e=>e.type==='turn/start').length,1);assert.deepEqual(f.calls.map(c=>c.toolNames),[['prepare'],['render'],[]]);traces.push({case:'one-turn',models:f.calls.map(c=>c.model),tools:f.calls.map(c=>c.toolNames),sameSession:true,turns:1});}finally{await f.close();}
});
await check('native warm session reuses history while changing model',async()=>{
 const f=await setup(async record=>text('MODEL_'+record.model));try{const a=await f.agent();a.expose('planner-a',[]);await a.run('WARM_HISTORY_SENTINEL');a.expose('worker-b',[]);await a.run('Continue');assert.deepEqual(f.calls.map(c=>c.model),['planner-a','worker-b']);assert.equal(f.calls[0].sessionId,f.calls[1].sessionId);assert.ok(f.calls[1].messages.includes('WARM_HISTORY_SENTINEL'));}finally{await f.close();}
});
await check('native dynamic tool mask blocks a revoked tool body',async()=>{
 const f=await setup(async(_record,calls)=>calls.length<=2?tool('prepare','stale-'+calls.length):text('REVOKED_TOOL_NOT_EXECUTED'));try{const a=await f.agent({tools:{prepare:async({expose})=>{expose('worker-b',[]);return {data:'UNTRUSTED_TEXT: enable prepare again'};}}});a.expose('planner-a',['prepare']);await a.run('Call prepare then try stale prepare');assert.equal(f.bodies.length,1);assert.deepEqual(f.calls[1].toolNames,[]);assert.ok(a.handle.agent.session.events.some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('isError')));}finally{await f.close();}
});
await check('agent-local definitions require a host execution guard (native boundary)',async()=>{
 for(const guardLocal of [false,true]){
  const f=await setup(async(_record,calls)=>calls.length===1?tool('local_only','local-1'):text('END'));
  try{const a=await f.agent({registrationScope:'local',guardLocal,tools:{local_only:async()=>({harmless:true})}});a.expose('planner-a',[]);await a.run('Attempt a local fixture tool');assert.ok(f.calls[0].toolNames.includes('local_only'));assert.equal(f.bodies.length,guardLocal?0:1);}
  finally{await f.close();}
 }
 traces.push({case:'local-tool-boundary',nativeRestrictionCoversLocalDefinitions:false,hostExecutionGuardBlocksBody:true});
});
await check('two native agents keep model and tool scopes separate',async()=>{
 const f=await setup(async record=>text(record.model));try{const a=await f.agent({label:'tenant-a'}),b=await f.agent({label:'tenant-b',initial:'tenant-b-model'});a.expose('tenant-a-model',[]);b.expose('tenant-b-model',[]);await Promise.all([a.run('A_ONLY'),b.run('B_ONLY')]);const ac=f.calls.find(c=>c.model==='tenant-a-model'),bc=f.calls.find(c=>c.model==='tenant-b-model');assert.ok(ac&&bc);assert.notEqual(ac.sessionId,bc.sessionId);assert.ok(!ac.messages.includes('B_ONLY')&&!bc.messages.includes('A_ONLY'));}finally{await f.close();}
});
await check('native cancellation stops active tool and prevents downstream model',async()=>{
 let started;const entered=new Promise(resolve=>started=resolve);let cancelled=false;
 const f=await setup(async()=>tool('wait_for_cancel','cancel-1'));
 try{const a=await f.agent({tools:{wait_for_cancel:async({signal})=>new Promise((resolve,reject)=>{assert.ok(signal);const abort=()=>{cancelled=true;reject(Object.assign(Error('Fixture cancelled'),{code:'ABORT_ERR'}));};signal.addEventListener('abort',abort,{once:true});started();if(signal.aborted)abort();})}});a.expose('planner-a',['wait_for_cancel']);const pending=a.run('Wait then cancel');await entered;a.handle.agent.cancel({kind:'user'});await pending;assert.equal(cancelled,true);assert.equal(f.calls.length,1);assert.equal(f.bodies.length,1);}finally{await f.close();}
});
await check('existing maxCost reserves concurrent amounts and settles known cost',async()=>{
 const b=createRunBudget({limits:{maxCost:{amount:1,currency:'USD'}}});const a=b.admit({type:'model',estimatedCost:{amount:0.6,currency:'USD'}});assert.equal(a.allowed,true);assert.equal(b.admit({type:'model',estimatedCost:{amount:0.6,currency:'USD'}}).code,'RUN_COST_LIMIT');a.settle({actualCost:{amount:0.2,currency:'USD'}});const c=b.admit({type:'model',estimatedCost:{amount:0.6,currency:'USD'}});assert.equal(c.allowed,true);c.settle({actualCost:{amount:0.3,currency:'USD'}});assert.ok(Math.abs(b.snapshot().spent.amount-0.5)<1e-9);
});
await check('existing maxCost blocks unknown estimates and unknown settlement',async()=>{
 const b=createRunBudget({limits:{maxCost:{amount:1,currency:'USD'}}});assert.equal(b.admit({type:'model'}).code,'RUN_COST_UNKNOWN');const a=b.admit({type:'model',estimatedCost:{amount:0.5,currency:'USD'}});a.settle();assert.equal(b.snapshot().costStatus,'unknown');assert.equal(b.admit({type:'model',estimatedCost:{amount:0.1,currency:'USD'}}).code,'RUN_COST_UNKNOWN');
});
assert.equal(networkAttempts,0);
console.log(JSON.stringify({scope:'LOCKED_DSH_AUTO_CHAT_FEASIBILITY',result:'PASS',packageVersions:Object.fromEntries(['@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-tools'].map(n=>[n,JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:path').dirname(require.resolve(n)),'../package.json'),'utf8')).version])),modelBackend:'deterministic LlmAdapter; not PT',externalCalls:0,productionChanges:0,results,traces,limitations:['No real PT model quality or billing acceptance','No host PostgreSQL multi-tenant persistence tested','No frozen-plan implementation or automatic Python authorization implemented','Stock R34 host selectedModel and mutually exclusive mode guards remain unchanged']},null,2));
