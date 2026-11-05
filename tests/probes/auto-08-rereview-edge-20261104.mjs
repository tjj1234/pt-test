#!/usr/bin/env node
// Additional R3/R5/R6 input-boundary tests, no network or provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const args=process.argv.slice(2);
const value=n=>{const i=args.indexOf(n);return i===-1?null:args[i+1];};
assert.ok(value('--candidate-root'),'--candidate-root required');
const root=path.resolve(value('--candidate-root'));
const {createTaskRouter}=require(path.join(root,'shell/candidates/auto-20261103/index.cjs'));
const config=()=>({version:'edge-review-v1',routes:[{taskType:'textChat',candidates:['a','b'],fallback:['c'],pinVersion:'revision-locked'}]});
const all=['a','b','c'].map(modelId=>({modelId,eligible:true}));const onlyFallback=[{modelId:'c',eligible:true}];
const rows=[];
function test(id,fn){try{const result=fn();rows.push({id,status:'PASS',result});console.log('PASS '+id);}catch(e){rows.push({id,status:'FAIL',error:e.message});console.log('FAIL '+id);}}
for(const [label,val] of [['empty',''],['null',null],['false',false],['zero',0]]){
 test('R3-DISPATCH-'+label,()=>{const r=createTaskRouter(config()).selectModel('textChat',onlyFallback,{dispatchState:val});assert.equal(r.code,'CONFIG_INVALID',JSON.stringify(r));return r;});
 test('R3-SELECTION-'+label,()=>{const r=createTaskRouter(config()).selectModel('textChat',all,{selection:val});assert.equal(r.code,'CONFIG_INVALID',JSON.stringify(r));return r;});
}
test('R3-OPTIONS-null',()=>{const r=createTaskRouter(config()).selectModel('textChat',all,null);assert.equal(r.code,'CONFIG_INVALID',JSON.stringify(r));return r;});
for(const source of ['primary','fallback','manual'])test('PIN-RETURN-'+source,()=>{const r=createTaskRouter(config()).selectModel('textChat',source==='fallback'?onlyFallback:all,source==='manual'?{selection:{mode:'manual',modelId:'b'}}:{});assert.equal(r.pinVersion,'revision-locked');assert.equal(r.source,source);return r;});
test('SNAPSHOT-ARRAY-AND-PIN',()=>{const c=config();const router=createTaskRouter(c);c.routes[0].candidates.reverse();c.routes[0].pinVersion='mutated';c.routes[0].fallback=['b'];const r=router.selectModel('textChat',all);assert.equal(r.modelId,'a');assert.equal(r.pinVersion,'revision-locked');assert.deepEqual(router.validateConfig(),[]);return r;});
test('DEFAULT-OMITTED-VALID',()=>{const r=createTaskRouter(config()).selectModel('textChat',all);assert.equal(r.modelId,'a');return r;});
const report={time_utc:new Date().toISOString(),candidate_root:root,source_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'shell/candidates/auto-20261103/index.cjs'))).digest('hex'),scope:'Pure selector boundary tests only; no runtime integration, PT/network calls or deployment',total:rows.length,passed:rows.filter(x=>x.status==='PASS').length,failed:rows.filter(x=>x.status==='FAIL').length,results:rows};
if(value('--report'))fs.writeFileSync(path.resolve(value('--report')),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed}));if(report.failed)process.exitCode=1;
