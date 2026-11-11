import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {open,migrate} from '../../shell/db.cjs';
const require=createRequire(import.meta.url),{basePrice,materializePrice}=require('../../shell/usage/price-time-rule.cjs'),{createTextPriceCatalogStore}=require('../../shell/usage/price-catalog-store.cjs'),{selectTextPriceSnapshot}=require('../../shell/usage/price-snapshot-selection-candidate.cjs');
const input=require('../../shell/usage/reviewed-text-prices-20261110.json'),source=input.snapshots.find(s=>s.timeRule);
test('reviewed UTC+8 tariff materializes half-open weekday periods without daily expiry',()=>{
 for(const [at,factor]of [['2026-11-11T00:59:59Z',1],['2026-11-11T01:00:00Z',2],['2026-11-11T03:59:59Z',2],['2026-11-11T04:00:00Z',1],['2026-11-11T06:00:00Z',2],['2026-11-11T10:00:00Z',1],['2026-11-14T01:00:00Z',1],['2026-12-01T02:00:00Z',2]]){
  const snapshot=materializePrice(source,at);assert.equal(snapshot.inputUsdPerMillion,.66*factor);assert.equal(snapshot.cacheWriteUsdPerMillion,null);assert(!Object.hasOwn(snapshot,'timeRule'));assert.equal(selectTextPriceSnapshot({snapshots:[snapshot],model:source.model,requestedAt:at}).coverage,'selected');assert.equal(selectTextPriceSnapshot({snapshots:[snapshot],model:source.model,requestedAt:snapshot.effectiveUntil}).coverage,'unknown');
 }
 assert.equal(source.inputUsdPerMillion,.66);
 assert.throws(()=>basePrice({...source,timeRule:'everyday-free'}),e=>e.code==='PRICE_CATALOG_TIME_RULE_INVALID');assert.throws(()=>basePrice({...source,model:'other'}));
});
test('store records raw reviewed rules immutably and selects future periods after reopening',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r34-tariff-'));let connection=await open({dataDir:dir});
 try{
  await migrate(connection.db,path.resolve('shell/db-migrations'));let store=createTextPriceCatalogStore(connection.db);const receipt=await store.importCatalog({...input,reviewed:true});
  assert.deepEqual(await store.importCatalog({...input,reviewed:true}),receipt);
  await assert.rejects(store.importCatalog({...input,reviewed:true,snapshots:[{...source,timeRule:'free'}]}),e=>e.code==='PRICE_CATALOG_TIME_RULE_INVALID');
  const raw=(await connection.db.query('SELECT snapshots FROM text_price_catalogs WHERE catalog_id=$1',[receipt.catalogId])).rows[0].snapshots;
  assert.equal(raw.find(s=>s.timeRule).inputUsdPerMillion,.66);
  assert.equal((await store.selectAt({model:source.model,requestedAt:new Date(Date.parse(receipt.recordedAt)-1).toISOString()})).snapshot,null);
  await connection.close();connection=await open({dataDir:dir});store=createTextPriceCatalogStore(connection.db);
  const peak=await store.selectAt({model:source.model,requestedAt:'2026-12-01T01:00:00Z'}),off=await store.selectAt({model:source.model,requestedAt:'2026-12-01T10:00:00Z'});
  assert.equal(peak.snapshot.inputUsdPerMillion,1.32);assert.equal(off.snapshot.inputUsdPerMillion,.66);assert.notEqual(peak.snapshot.version,off.snapshot.version);
 }finally{await connection.close();fs.rmSync(dir,{recursive:true,force:true});}
});
