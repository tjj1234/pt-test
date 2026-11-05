#!/usr/bin/env node
// Independent acceptance probe: calls original 08 implementation; makes no network/provider requests.
// Known unsafe results remain FAIL and set a nonzero exit code. This is not a patched router.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const candidateArg=process.argv.indexOf('--candidate-root');
if(candidateArg!==-1)assert.ok(process.argv[candidateArg+1],'--candidate-root requires path');
const root=candidateArg===-1?path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'):path.resolve(process.argv[candidateArg+1]);
const require=createRequire(import.meta.url);
const {createTaskRouter,validateRouteConfig}=require(path.join(root,'shell/candidates/auto-20261103/index.cjs'));
const fixture=()=>({version:'review-1',routes:[{taskType:'textChat',candidates:['model-a','model-b'],fallback:['model-c']}]});
const eligible=()=>['model-a','model-b','model-c'].map(modelId=>({modelId,eligible:true}));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
const protectedPaths=['docs/refactor/GEMINI-AUTO-DELIVERY-PACKAGE-20261103.md','shell/candidates/auto-20261103/index.cjs','shell/candidates/auto-20261103/CONTRACT.md','tests/probes/auto-delivery-20261103.mjs'];
const before=Object.fromEntries(protectedPaths.map(p=>[p,sha(p)]));
const results=[];
function check(id,group,label,fn){let actual;try{actual=fn();results.push({id,group,label,status:'PASS',actual});console.log(`PASS ${id} ${label}`);}catch(e){results.push({id,group,label,status:'FAIL',actual:e.actual??null,expected:e.expected??null,error:e.message});console.log(`FAIL ${id} ${label}`);}}
const rejected=r=>assert.equal(r.ok,false,JSON.stringify(r));
check('CTRL-01','control','原正常pre-dispatch选择首选',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',eligible());assert.equal(r.modelId,'model-a');return r;});
check('CTRL-02','control','原pre-dispatch资格预筛可选fallback',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',[{modelId:'model-c',eligible:true}],{dispatchState:'pre-dispatch'});assert.equal(r.modelId,'model-c');return r;});
check('CTRL-03','control','原dispatched后的fallback分支确实被拦',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',[{modelId:'model-c',eligible:true}],{dispatchState:'dispatched'});assert.equal(r.code,'FALLBACK_AFTER_DISPATCH');return r;});
check('CTRL-04','control','所有资格false时不选模型',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',eligible().map(x=>({...x,eligible:false})));rejected(r);return r;});
check('R1-01','R1','PAYMENT_UNKNOWN不能被跳过后选其他primary',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',[{modelId:'model-a',eligible:true,reason:'PAYMENT_UNKNOWN'},{modelId:'model-b',eligible:true}],{dispatchState:'pre-dispatch'});assert.equal(r.code,'UNKNOWN_PAYMENT_RESULT',JSON.stringify(r));return r;});
check('R1-02','R1','显式UNKNOWN_PAYMENT_RESULT不能变成fallback',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',[{modelId:'model-a',eligible:false,reason:'UNKNOWN_PAYMENT_RESULT'},{modelId:'model-c',eligible:true}],{dispatchState:'pre-dispatch'});assert.equal(r.code,'UNKNOWN_PAYMENT_RESULT',JSON.stringify(r));return r;});
check('R2-01','R2','dispatched不能改选第二个primary',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',[{modelId:'model-a',eligible:false},{modelId:'model-b',eligible:true}],{dispatchState:'dispatched'});rejected(r);return r;});
check('R2-02','R2','dispatched不能改选manual模型',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',eligible(),{dispatchState:'dispatched',selection:{mode:'manual',modelId:'model-b'}});rejected(r);return r;});
check('R3-01','R3','未知dispatchState不能视为pre-dispatch',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',[{modelId:'model-c',eligible:true}],{dispatchState:'unknown'});assert.equal(r.code,'CONFIG_INVALID',JSON.stringify(r));return r;});
check('R3-02','R3','非法selection.mode不能默认为auto',()=>{const r=createTaskRouter(fixture()).selectModel('textChat',eligible(),{selection:{mode:'unrecognized'}});assert.equal(r.code,'CONFIG_INVALID',JSON.stringify(r));return r;});
check('R4-01','R4','重复fallback应被严格配置校验拒绝',()=>{const c=fixture();c.routes[0].fallback=['model-c','model-c'];const e=validateRouteConfig(c);assert.ok(e.some(x=>x.includes('DUPLICATE_CANDIDATE')),JSON.stringify(e));return e;});
check('R4-02','R4','primary与fallback重复模型应拒绝',()=>{const c=fixture();c.routes[0].fallback=['model-a'];const e=validateRouteConfig(c);assert.ok(e.some(x=>x.includes('DUPLICATE_CANDIDATE')),JSON.stringify(e));return e;});
check('R5-01','R5','空pinVersion不能被当有效版本pin',()=>{const c=fixture();c.routes[0].pinVersion='';const e=validateRouteConfig(c);assert.ok(e.length>0,JSON.stringify(e));return e;});
check('R6-01','R6','外部config突变不能使router与选择结果版本不同',()=>{const c=fixture();const router=createTaskRouter(c);c.version='mutated-unpublished';const r=router.selectModel('textChat',eligible());assert.equal(r.configVersion,router.configVersion,JSON.stringify({routerVersion:router.configVersion,result:r}));return r;});
const original=spawnSync(process.execPath,['tests/probes/auto-delivery-20261103.mjs'],{cwd:root,encoding:'utf8',timeout:30000});
const originalSummary=(original.stdout||'').match(/共 (\d+) 项，通过 (\d+) 项，失败 (\d+) 项/);
const originalResult={command:'node tests/probes/auto-delivery-20261103.mjs',exit_code:original.status,error:original.error?.message??null,total:originalSummary?Number(originalSummary[1]):null,passed:originalSummary?Number(originalSummary[2]):null,failed:originalSummary?Number(originalSummary[3]):null};
const unchanged=protectedPaths.every(p=>sha(p)===before[p]);
const report={time_utc:new Date().toISOString(),scope:'Independent original 08 selection/config behavior review only; no runtime integration, network, PT calls or deployment',node:process.version,protected_sha256:before,protected_unchanged:unchanged,original_probe:originalResult,total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
const index=process.argv.indexOf('--report');
if(index!==-1){assert.ok(process.argv[index+1],'--report requires path');const p=path.resolve(root,process.argv[index+1]);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({original_probe:originalResult,review_total:report.total,review_passed:report.passed,review_failed:report.failed,protected_unchanged:unchanged}));
if(report.failed||original.status!==0||!unchanged)process.exitCode=1;
