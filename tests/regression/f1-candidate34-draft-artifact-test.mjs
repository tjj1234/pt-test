import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('historical candidate34 draft is reproducible against its hash-pinned frozen source plan',()=>{
 const result=spawnSync('python3',['-B','tests/helpers/check-frozen-candidate34.py','build'],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'DRAFT_NOT_FOR_DEPLOYMENT');
});
test('independent candidate34 audit checks archive, source, imports and pinned npm inputs',()=>{
 const result=spawnSync('python3',['-B','tests/helpers/check-frozen-candidate34.py','audit'],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.members,366);assert.equal(data.boundSources,165);assert.equal(data.status,'DRAFT_ARTIFACT_AUDIT_PASS_NOT_DEPLOYMENT_APPROVAL');
});
