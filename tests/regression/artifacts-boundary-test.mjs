import test from 'node:test';
import assert from 'node:assert/strict';
import artifacts from '../../shell/runtime/artifacts.cjs';
test('cross-platform artifact paths normalize without admitting drive-relative or control paths',()=>{
 assert.deepEqual(artifacts.normalizeArtifact({rel:'out\\report.md'}),{name:'report.md',rel:'out/report.md',kind:'md',url:'/api/artifact?p=out%2Freport.md',size:0,mtime:0});
 for(const rel of ['C:report.md','C:\\report.md','\\\\host\\report.md','out\\..\\report.md','out/\u0000report.md','out/\nreport.md','out/\u007freport.md','out/\u0085report.md']) assert.equal(artifacts.normalizeArtifact({rel}),null,JSON.stringify(rel));
 assert.equal(artifacts.artifactUrlFor('out\\report.md'),'/api/artifact?p=out%2Freport.md');
});
