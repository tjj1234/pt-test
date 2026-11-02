import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),{liveVerifyPtKey}=require('../../shell/key-routes.cjs');
test('PT key probe distinguishes invalid key, insufficient balance and forbidden without exposing upstream body',async()=>{
 let status=200;const server=http.createServer((req,res)=>{res.writeHead(status);res.end('PRIVATE_UPSTREAM_BODY');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{for(const [code,expected]of [[200,'OK'],[401,'AUTH_REJECTED'],[402,'QUOTA_INSUFFICIENT'],[403,'UPSTREAM_FORBIDDEN']]){status=code;const result=await liveVerifyPtKey('synthetic-fixture',{baseURL:'http://127.0.0.1:'+server.address().port});assert.equal(result.code,expected);assert.equal(result.status,code);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UPSTREAM_BODY|synthetic-fixture/);}}finally{await new Promise(resolve=>server.close(resolve));}
});
test('PT media status, legacy compatibility and Seedance wire checks run offline',()=>{const result=spawnSync('python3',['-B','tests/regression/pt-contract-status-20261102-test.py'],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 4 tests/);});
