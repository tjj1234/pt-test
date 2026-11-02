// Actual locked LLM capability validation; no manually interpreted wire maps.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const [{Context},{default:Llm,LlmAdapter}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-llm'].map(name=>import(pathToFileURL(require.resolve(name)))));
const ctx=new Context();await ctx.plugin(Llm);let streams=0;
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text'],...(model==='with-reasoning'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}:{})};}
 async *stream(){streams++;throw Error('Unexpected provider dispatch');}
}
ctx.llm.registerAdapter(['fixture'],new Adapter());
const info=await ctx.llm.resolveModelInfo('fixture','with-reasoning');
assert.deepEqual(info.reasoning.efforts.map(e=>e.id),['low','high']);
assert.equal(ctx.llm.resolveCallWithInfo({provider:'fixture',model:'with-reasoning',reasoningEffort:'high'},info).config.reasoningEffort,'high');
assert.throws(()=>ctx.llm.resolveCallWithInfo({provider:'fixture',model:'with-reasoning',reasoningEffort:'invented'},info),{code:'UNSUPPORTED_REASONING_EFFORT'});
await assert.rejects(ctx.llm.resolveCallConfig({provider:'fixture',model:'no-reasoning',reasoningEffort:'high'}),{code:'UNSUPPORTED_REASONING_EFFORT'});
const ordinary=await ctx.llm.resolveCallConfig({provider:'fixture',model:'no-reasoning'});assert.equal(ordinary.reasoningEffort,undefined);
assert.equal(streams,0);
console.log(JSON.stringify({result:'NATIVE_VALIDATION_VERIFIED',metadataSource:'actual ctx.llm.resolveModelInfo',validation:'actual ctx.llm.resolveCallWithInfo / resolveCallConfig',supported:['low','high'],unsupportedRejectedBeforeStream:true,providerCalls:streams}));
