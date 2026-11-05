#!/usr/bin/env node
// Source-bound isolated block review. Not full HTTP/browser E2E; no PT/network calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
assert.ok(value('--candidate'),'--candidate is required');
const candidate=path.resolve(value('--candidate'));
const expected=value('--commit')||'1e677a3ccae540e500830edfa6c5b7240749a87e';
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:candidate,encoding:'utf8'}).stdout.trim();assert.equal(head,expected,'Review must bind to delivered commit');
const source=fs.readFileSync(path.join(candidate,'shell/server.cjs'),'utf8');
const app=fs.readFileSync(path.join(candidate,'shell/public/app.js'),'utf8');
const require=createRequire(import.meta.url);
const artifacts=require(path.join(candidate,'shell/runtime/artifacts.cjs'));
const start=source.indexOf('  const htmlBlockMatch = reply');const end=source.indexOf('  const artifacts = ',start);
assert.ok(start>=0&&end>start,'Exact delivered HTML materialization block missing');
const block=source.slice(start,end);
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'r28-bugfix-review-'));const workspace=path.join(fixture,'tenant');fs.mkdirSync(workspace);
function materialize(text){const emitted=[];const c={reply:'```html\n<!DOCTYPE html><html><body>'+text+'</body></html>\n```',r:{artifacts:[]},tenantMod:{getTenantWorkspace:()=>workspace},me:{tenant:{id:'fixture-tenant'}},path,fs,RUNTIME:fixture,artifactsMod:artifacts,hostArtifacts:new Map(),sse:x=>emitted.push(x),log:{warn:()=>{}}};vm.runInNewContext(block,c,{timeout:1000});return emitted;}
const results=[];
function test(id,label,fn){try{fn();results.push({id,label,status:'PASS'});console.log('PASS '+id+' '+label);}catch(e){results.push({id,label,status:'FAIL',error:e.message});console.log('FAIL '+id+' '+label);}}
try{
 test('BR-HTML-01','两次HTML产物不得覆盖先前历史文件',()=>{const first=materialize('FIRST_RESULT');const old=fs.readFileSync(path.join(workspace,'report.html'),'utf8');const second=materialize('SECOND_RESULT');assert.ok(first[0]?.artifact&&second[0]?.artifact,'Original block must emit real artifacts');assert.equal(fs.readFileSync(path.join(workspace,'report.html'),'utf8'),old,'second run overwrote the first run report.html; both emitted same URL');});
 test('BR-HTML-02','HTML落盘不得跟随已有symlink写出授权目录',()=>{fs.unlinkSync(path.join(workspace,'report.html'));const victim=path.join(fixture,'outside-tenant.txt');fs.writeFileSync(victim,'ORIGINAL_OUTSIDE');fs.symlinkSync(victim,path.join(workspace,'report.html'));materialize('UNAUTHORIZED_REPLACEMENT');assert.equal(fs.readFileSync(victim,'utf8'),'ORIGINAL_OUTSIDE','writeFileSync followed report.html symlink outside tenant fixture');});
 test('BR-STREAM-01','旧对话已有assistant时仍保留本轮错误前增量',()=>{const a=app.indexOf('if (Array.isArray(obj.messages)) {\n                renderChat(obj.messages);');assert.ok(a>=0);const b=app.indexOf('              cm.textContent = "";',a);assert.ok(b>a);const exact=app.slice(a,b);let rendered=[];const partial='CURRENT_TURN_PARTIAL';vm.runInNewContext(exact,{obj:{messages:[{role:'assistant',text:'OLD_REPLY'},{role:'user',text:'NEW_QUESTION'}],error:'fixture error'},acc:partial,renderChat:m=>{rendered=[...m];},renderMessage:m=>rendered.push(m),restoreManualCheckHistory:()=>{},bubbleSys:()=>{},Date},{timeout:1000});assert.ok(rendered.some(m=>m.text===partial),'existing old assistant makes some(role=assistant) true; current partial is dropped');});
}finally{fs.rmSync(fixture,{recursive:true,force:true});}
const report={candidate,head,source_sha256:crypto.createHash('sha256').update(source).digest('hex'),app_sha256:crypto.createHash('sha256').update(app).digest('hex'),time_utc:new Date().toISOString(),scope:'Source-bound isolated original block execution + real temp files only. Not HTTP/UI E2E; no actual user data, network or PT calls.',total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
if(value('--report'))fs.writeFileSync(path.resolve(value('--report')),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed}));if(report.failed)process.exitCode=1;
