import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('archive preflight passes original cases and main-review counterexamples offline',()=>{
 const result=spawnSync('python3',['-B','tests/regression/release-archive-preflight-candidate-test.py'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr.slice(-2000));assert.match(result.stderr,/Ran 41 tests/);assert.match(result.stderr,/\nOK\s*$/);
});
test('archive preflight independently accepts pinned candidate34 without extraction',()=>{
 const result=spawnSync('python3',['-B','scripts/northstar-release-archive-preflight-candidate.py','--archive','release-artifacts/northstar-controlled-trial-20261028-candidate-34-draft.tar.gz','--sha256','27dc651494661f7bf657404a0fe091be9a3319be10f79506b826dedf18dbb14c'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.ok,true);assert.equal(data.members,366);assert.equal(data.files,310);
});
