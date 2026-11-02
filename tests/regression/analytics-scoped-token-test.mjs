import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
const http=require('node:http');
const {buildGaQueryExecutor}=require('../../business/attribution/ga-connector/executor.js');
test('tenant-scoped GA executor rejects another tenant before any HTTP request',async()=>{
 const original=http.request,requests=[];
 http.request=(options,onResponse)=>{
  requests.push(options);const req=new EventEmitter();req.setTimeout=()=>{};
  req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};onResponse(res);res.emit('data','{"ok":true}');res.emit('end');});
  return req;
 };
 try{
  const execute=buildGaQueryExecutor({tenantId:'tenant-a',tenantToken:'scoped-credential',dashPort:1});
  await assert.rejects(execute({}, {tenantId:'tenant-b'}),{code:'TENANT_SCOPE_MISMATCH'});
  assert.equal(requests.length,0);
  assert.deepEqual(await execute({}, {tenantId:'tenant-a'}),{ok:true});
  assert.equal(requests.length,1);assert.equal(requests[0].headers.authorization,'Bearer scoped-credential');
 }finally{http.request=original;}
});
