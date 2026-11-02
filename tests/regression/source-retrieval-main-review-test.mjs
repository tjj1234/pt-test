import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),r=require('../../shell/attachments/source-retrieval-candidate.cjs');
const make=()=>r.buildSourceIndex({tenantId:'t',documentId:'d',sourceSha256:'a'.repeat(64),format:'txt',blocks:[{text:'needle source'}]});
test('retrieval rejects incomplete source authority and forged derived fields',()=>{
 const index=make();assert.equal(r.querySourceIndex({tenantId:'t',query:'needle',indexes:[index],trustedSources:[{documentId:'d'}]}).returnedCount,0);
 const forged=JSON.parse(JSON.stringify(index));forged.blocks[0].charStart=999;forged.blocks[0].textSha256='f'.repeat(64);
 assert.equal(r.verifyIndexIntegrity(forged),false);
});
test('retrieval rejects oversized containers before enumeration and invalid result limits',()=>{
 let scans=0;const blocks=new Proxy(new Array(r.LIMITS.MAX_BLOCKS_PER_DOC+1),{ownKeys(target){scans++;return Reflect.ownKeys(target);}});
 assert.throws(()=>r.buildSourceIndex({tenantId:'t',documentId:'d',sourceSha256:'a'.repeat(64),blocks}));assert.equal(scans,0);
 const index=make();assert.throws(()=>r.querySourceIndex({tenantId:'t',query:'needle',indexes:[index],trustedSources:[],options:{maxResults:Infinity}}));
});
test('retrieval requires real structural locators and excludes foreign IDs from response audit',()=>{
 assert.throws(()=>r.buildSourceIndex({tenantId:'t',documentId:'d',sourceSha256:'a'.repeat(64),format:'xlsx',blocks:[{text:'needle'}]}));
 const other=r.buildSourceIndex({tenantId:'other',documentId:'private-foreign-name',sourceSha256:'b'.repeat(64),blocks:[{text:'needle'}]});
 const result=r.querySourceIndex({tenantId:'t',query:'needle',indexes:[other],trustedSources:[]});assert.equal(JSON.stringify(result).includes('private-foreign-name'),false);
});
