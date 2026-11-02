import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
// The active draft has a strict current-source gate. Older frozen revisions
// retain their original archives/checks; this pointer does not rewrite them.
test('active draft binds current sources and independently audits exact archive bytes',()=>{
 const plan=JSON.parse(fs.readFileSync('docs/refactor/candidates/current-draft.json','utf8'));
 assert.equal(plan.status,'DRAFT_NOT_FOR_DEPLOYMENT');assert.match(plan.sha256,/^[a-f0-9]{64}$/);
 for(const [kind,file,args] of [['builder',plan.builder,['--check']],['audit',plan.audit,[]]]){
  assert.match(file,/^scripts\/(package|audit)-northstar-candidate34-r\d+-draft\.py$/);
  const result=spawnSync('python3',['-B',file,...args],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  if(kind==='builder'){assert.equal(data.status,plan.status);assert.equal(data.archiveSha256,plan.sha256);}
  else{assert.equal(data.status,'DRAFT_ARTIFACT_AUDIT_PASS_NOT_DEPLOYMENT_APPROVAL');assert.equal(data.boundSources,plan.boundSources);assert.equal(data.members,plan.members);}
 }
});
