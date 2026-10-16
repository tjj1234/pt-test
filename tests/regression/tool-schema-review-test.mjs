import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const {compileInputSchema:compile}=require('./tools/schema-validator.cjs');
const r=require('./tools/registry.cjs');
const permissions=require('./permissions/index.cjs');
const def=(name,inputSchema,execute,version='1')=>({name,type:'workflow',description:'independent review',version,inputSchema,outputType:'data',riskLevel:'read',requiredPermissions:[],...(execute?{execute}:{})});
test('independent: exact direct Ajv dependency matches lock and actual installed package',()=>{
 const pkg=require('./package.json'),lock=require('./package-lock.json');for(const [name,v] of [['ajv','8.20.0'],['ajv-formats','3.0.1']]){
  assert.equal(pkg.dependencies[name],v);assert.equal(lock.packages[''].dependencies[name],v);assert.equal(lock.packages['node_modules/'+name].version,v);assert.ok(lock.packages['node_modules/'+name].integrity);assert.equal(require(name+'/package.json').version,v);
 }
});
test('independent: malformed, cyclic and oversized params reach neither logger nor executor',async()=>{
 let logs=0,calls=0,getters=0;r.setToolCallLogger({async start(){logs++;return {id:'review'};},async finish(){logs++;}});
 try{
  r.registerTool(def('review-invalid',{type:'object',required:['rows'],additionalProperties:false,properties:{rows:{type:'array',items:{type:'object',required:['n'],additionalProperties:false,properties:{n:{type:'integer',minimum:1}}}}}},()=>{calls++;}));
  const cyc={};cyc.self=cyc;const getter=Object.defineProperty({},'rows',{enumerable:true,get(){getters++;return [];}});
  for(const value of [{rows:[{n:'1'}]},{rows:[{n:0}]},{rows:[],extra:true},cyc,getter,{rows:[],n:1n},{rows:[],x:Infinity},{rows:[],x:'x'.repeat(1024*1024+1)}])await assert.rejects(r.executeTool('review-invalid',value,{}),{code:'TOOL_INPUT_INVALID'});
  assert.deepEqual({logs,calls,getters},{logs:0,calls:0,getters:0});
 }finally{r.setToolCallLogger(null);}
});
test('independent: remote refs, async, unknown dialect/format/keyword reject without fetch',()=>{
 const original=globalThis.fetch;let fetched=0;globalThis.fetch=()=>{fetched++;throw new Error('must not fetch');};
 try{
  for(const schema of [{$ref:'https://attacker.test/schema'},{type:'object',$async:true},{$schema:'https://attacker.test/dialect'},{type:'string',format:'review-unknown'},{$data:true},{type:'object',additionalPropertiez:false},{$ref:'#'},{$defs:{loop:{$ref:'#/$defs/loop'}},$ref:'#/$defs/loop'}])assert.throws(()=>compile(schema),{code:'TOOL_SCHEMA_INVALID'});
  assert.equal(fetched,0);
 }finally{globalThis.fetch=original;}
});
test('independent: standard formats and modern unevaluated constraints cannot be ignored',()=>{
 assert.equal(compile({type:'string',format:'date-time'}).prepare('not-date').valid,false);
 const modern=compile({$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',allOf:[{properties:{a:{type:'integer'}}}],unevaluatedProperties:false});
 assert.equal(modern.prepare({a:1}).valid,true);assert.equal(modern.prepare({a:1,b:2}).valid,false);
});
test('independent: failed schema re-registration preserves prior accepted version',async()=>{
 r.registerTool(def('review-atomic',{type:'integer'},x=>x+1));
 assert.throws(()=>r.registerTool(def('review-atomic',{$ref:'https://attacker.test'},()=>999,'2')),{code:'TOOL_SCHEMA_INVALID'});
 assert.equal((await r.executeTool('review-atomic',2,{})).result,3);await assert.rejects(r.executeTool('review-atomic','x',{}),{code:'TOOL_INPUT_INVALID'});
});
test('independent: asynchronous permission and re-registration keep original validator/executor pair',async()=>{
 let release,ready;const gate=new Promise(x=>release=x),started=new Promise(x=>ready=x);permissions.setDb({async query(){ready();await gate;return {rows:[{role:'owner'}]};}});
 try{
  const original=def('review-version',{type:'object',required:['n'],properties:{n:{type:'integer'}}},x=>({v:1,n:x.n}));original.requiredPermissions=['tool:execute'];r.registerTool(original);
  const args={n:4};const pending=r.executeTool(original.name,args,{userId:'u',tenantId:'t'});await started;
  args.n='mutated';r.registerTool(def(original.name,{type:'string'},()=>({v:2}),'2'));release();assert.deepEqual((await pending).result,{v:1,n:4});
 }finally{permissions.setDb(null);}
});
test('independent: new schema version without executor must not silently reuse old implementation',async()=>{
 let oldCalls=0;r.registerTool(def('review-stale-executor',{type:'integer'},x=>{oldCalls++;return x*2;}));
 r.registerTool(def('review-stale-executor',{type:'string'},undefined,'2'));
 const output=await r.executeTool('review-stale-executor','not-a-number',{});
 assert.equal(oldCalls,0,'old executor received input validated against incompatible new schema');assert.equal(output.metadata.executed,false);
});
