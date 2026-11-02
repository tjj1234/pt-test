// PASS means the recorded R3 candidate blockers were independently reproduced.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const candidate=path.resolve('shell/runtime/dsh-reasoning-selection-r3-candidate.mjs');
const {normalizeAuthoritativeReasoningMeta}=await import(pathToFileURL(candidate));
const raw=Object.fromEntries(Array.from({length:100},(_,index)=>['effort-'+index,'wire']));let descriptors=0;
const map=new Proxy(raw,{getOwnPropertyDescriptor(target,key){descriptors++;return Reflect.getOwnPropertyDescriptor(target,key);}});
assert.throws(()=>normalizeAuthoritativeReasoningMeta({reasoning:false,thinkingLevelMap:map}),{code:'CONTRADICTORY_REASONING_METADATA'});
assert.equal(descriptors,100,'reasoning=false still fully materializes Object.keys before rejecting');
assert.deepEqual(normalizeAuthoritativeReasoningMeta({thinkingLevelMap:{high:'unverified-wire-fixture'}}).supportedEfforts,['high']);
let echoed=false;try{normalizeAuthoritativeReasoningMeta({supportedEfforts:['private-fixture-marker']});}catch(error){echoed=error.message.includes('private-fixture-marker');}assert.equal(echoed,true);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reasoning-r3-review-'));
try{
 const profile=path.join(temp,'profile'),cwd=path.join(temp,'tenant-workspace');fs.mkdirSync(profile);fs.mkdirSync(cwd);
 const stub=path.join(cwd,'node_modules/@deepseek-ai/dsh-agent');fs.mkdirSync(stub,{recursive:true});
 fs.writeFileSync(path.join(stub,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-agent',version:'999.0.0',type:'module',exports:'./index.js'}));
 fs.writeFileSync(path.join(stub,'index.js'),'export const installModelSelection=()=>"UNVERIFIED_CWD_STUB";');
 const copied=path.join(profile,'selection.mjs');fs.copyFileSync(candidate,copied);
 const source=`const m=await import(${JSON.stringify(pathToFileURL(copied).href)});console.log(m.installModelSelection());`;
 const run=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd,env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'UNVERIFIED_CWD_STUB');
 console.log(JSON.stringify({review:'BLOCKED_CANDIDATE_NOT_INTEGRATED',reproduced:['unverified-cwd-dependency-fallback','reasoning-false-unbounded-key-materialization','arbitrary-wire-advertised-as-supported','error-echoes-metadata-value'],keyDescriptorsVisited:descriptors,providerCalls:0}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
