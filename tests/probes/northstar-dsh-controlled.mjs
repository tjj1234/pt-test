/** Real DSH SDK + in-process deterministic LlmAdapter; no HTTP, .env, keys or paid model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'shell/package.json'));
const load = async n => import(pathToFileURL(req.resolve('@deepseek-ai/' + n)));
const deadline = (p, label) => { let timer; return Promise.race([p, new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error('timeout: '+label)),10000); })]).finally(()=>clearTimeout(timer)); };
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
const results=[];
const check=(name,fn)=>{fn();results.push(name);};
let ctx, fibers=[],handles=[];
try {
  const [{Context}, {default:Agents,installModelSelection}, {default:Sessions,SessionId}, {default:Llm,LlmAdapter,createUserMessage,CallId}, {default:Prompt}, {default:Tools,defineTool}, {default:Loop}] = await Promise.all(['cordis','dsh-agent','dsh-session','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop'].map(load));
  ctx=new Context();
  for(const [plugin,config] of [[Agents,undefined],[Sessions,undefined],[Llm,undefined],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}]]) {const f=ctx.plugin(plugin,...(config===undefined?[]:[config]));fibers.push(f);await f;}
  const calls=[], entered=[], toolDone=[], allEntered=deferred(), release=deferred(), counts=new Map();
  class Controlled extends LlmAdapter {
    async *stream(options) {
      const n=(counts.get(options.sessionId)||0)+1; counts.set(options.sessionId,n);
      calls.push({sessionId:options.sessionId,model:options.model,n,at:Date.now()});
      const block=n===1 ? {type:'tool-call',id:CallId('call-'+options.sessionId),name:'controlled_wait',arguments:{}} : {type:'text',text:'ok '+options.model};
      yield {type:'block-start',index:0,blockType:block.type};
      yield {type:'block-end',index:0,block};
      yield {type:'usage',usage:{inputTokens:10*n,outputTokens:n,cacheReadTokens:2}};
      yield {type:'finish',reason:{kind:n===1?'tool-calls':'stop'}};
    }
  }
  const unregister=ctx.llm.registerAdapter(['controlled'],new Controlled());
  const selections=new Map();
  for(const id of ['A','B']) {
    const selection={current:{provider:'controlled',model:'one'},assembled:undefined};selections.set(id,selection);
    handles.push(await ctx.agents.create({sessionId:SessionId(id),meta:{cwd:path.join(root,'tests/probes','workspace-'+id)},agentOptions:{provider:'controlled',model:'one'},setup(agentCtx){
      installModelSelection(agentCtx,selection);
      agentCtx.tools.register(defineTool({name:'controlled_wait',description:'Controlled cancellation barrier',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(_args,exec){
        const started={id:exec.agent.id,cwd:exec.agent.session.header.cwd,at:Date.now()};entered.push(started);if(entered.length===2)allEntered.resolve();
        await new Promise(resolve=>{if(exec.signal.aborted)return resolve();exec.signal.addEventListener('abort',resolve,{once:true});release.promise.then(resolve);});
        toolDone.push({id:exec.agent.id,aborted:exec.signal.aborted,at:Date.now()});
        if(exec.signal.aborted)throw new Error('controlled abort');
        return {id:exec.agent.id,cwd:started.cwd};
      }}));
    }}));
  }
  for(const h of handles)h.agent.followup(createUserMessage({content:[{type:'text',text:'controlled request'}],source:{kind:'user'}}));
  await deadline(allEntered.promise,'both tools entered');
  check('two real SDK sessions overlap before either tool finishes',()=>assert.equal(toolDone.length,0));
  check('session cwd metadata independent without chdir',()=>{assert.equal(entered.find(x=>x.id==='A').cwd,path.join(root,'tests/probes/workspace-A'));assert.equal(entered.find(x=>x.id==='B').cwd,path.join(root,'tests/probes/workspace-B'));assert.equal(process.cwd(),root);});
  handles[0].agent.cancel({kind:'user'});
  await deadline(handles[0].agent.whenIdle(),'cancel A');
  check('cancel A reaches controlled tool signal',()=>assert.equal(toolDone.find(x=>x.id==='A')?.aborted,true));
  check('cancel A does not end B tool',()=>assert.equal(toolDone.some(x=>x.id==='B'),false));
  release.resolve();await deadline(handles[1].agent.whenIdle(),'finish B');
  check('B completes after A cancellation',()=>{assert.equal(toolDone.find(x=>x.id==='B')?.aborted,false);assert.equal(calls.filter(x=>x.sessionId==='B').length,2);});
  const usage=handles[1].agent.session.events.filter(e=>e.type==='assistant/message').map(e=>e.data.usage).filter(Boolean);
  check('usage stays per model response across tool round trip',()=>{assert.equal(usage.length,2);assert.equal(usage.reduce((s,u)=>s+u.inputTokens,0),30);assert.equal(usage.reduce((s,u)=>s+u.outputTokens,0),3);});
  selections.get('B').current={provider:'controlled',model:'two'};
  handles[1].agent.followup(createUserMessage({content:[{type:'text',text:'next model'}],source:{kind:'user'}}));
  await deadline(handles[1].agent.whenIdle(),'hot model switch');
  check('public model selection changes next hot-session request',()=>assert.equal(calls.at(-1).model,'two'));
  for(const h of handles)await deadline(h.dispose(),'handle dispose');
  check('dispose removes agents and sessions',()=>{assert.equal(ctx.agents.list().length,0);assert.equal(ctx.sessions.get(SessionId('A')),undefined);assert.equal(ctx.sessions.get(SessionId('B')),undefined);});
  handles=[];
  const replacement=await ctx.agents.create({sessionId:SessionId('A'),agentOptions:{provider:'controlled',model:'two'}});
  handles.push(replacement);
  check('disposed identity can be recreated without registry collision',()=>assert.equal(ctx.agents.get(SessionId('A')),replacement.agent));
  await replacement.dispose();handles=[];
  const {default:LocalFs}=await load('dsh-fs-local');
  const fsFiber=ctx.plugin(LocalFs,{cwd:root});fibers.push(fsFiber);await fsFiber;
  const targetA=await ctx.fs.resolve('package.json',{cwd:path.join(root,'shell')});
  const targetB=await ctx.fs.resolve('package.json',{cwd:root});
  check('real filesystem provider honors per-call cwd without chdir',()=>{assert.equal(targetA.displayPath,path.join(root,'shell/package.json'));assert.equal(targetB.displayPath,path.join(root,'package.json'));assert.equal(process.cwd(),root);});
  const outside=await ctx.fs.resolve('../package.json',{cwd:path.join(root,'shell')});
  check('filesystem cwd is resolution only and permits parent path',()=>assert.equal(outside.displayPath,path.join(root,'package.json')));
  unregister();
  console.log(JSON.stringify({status:'PASS',scope:'real SDK with deterministic in-process model/tool only',paidCalls:0,assertions:results,requests:calls,usageB:usage},null,2));
} catch(e) {
  console.error(JSON.stringify({status:e.code==='ERR_MODULE_NOT_FOUND'||e.code==='MODULE_NOT_FOUND'?'BLOCKED':'FAIL',code:e.code||null,message:e.message,passed:results,paidCalls:0},null,2));process.exitCode=1;
} finally {
  for(const h of handles)try{await deadline(h.dispose(),'cleanup');}catch{}
  for(const f of fibers.reverse())try{await f.dispose();}catch{}
}
