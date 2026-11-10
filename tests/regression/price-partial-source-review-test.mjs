import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{selectTextPriceSnapshot}=require('../../shell/usage/price-snapshot-selection-candidate.cjs'),{estimateTextResponseCost}=require('../../shell/usage/text-cost-estimate.cjs');
const snapshot={sourceUrl:'https://powertokens.ai/models/glm-4.7',version:'source-fixture',capturedAt:'2026-11-10T00:00:00Z',effectiveFrom:'2026-11-10T00:00:00Z',effectiveUntil:'2026-11-11T00:00:00Z',currency:'USD',model:'glm-4.7',inputUsdPerMillion:.6,outputUsdPerMillion:2.2,cacheReadUsdPerMillion:.11,cacheWriteUsdPerMillion:null};
test('official model-specific source and explicit unknown cache-write price remain evidence-bounded',()=>{
 const selected=selectTextPriceSnapshot({snapshots:[snapshot],model:snapshot.model,requestedAt:'2026-11-10T01:00:00Z'});assert.equal(selected.snapshot.cacheWriteUsdPerMillion,null);
 const estimate=usage=>estimateTextResponseCost({requestedModel:snapshot.model,providerModel:snapshot.model,price:selected.snapshot,usage});
 assert.equal(estimate({inputTokens:1000,outputTokens:100,cacheReadTokens:0,cacheWriteTokens:0}).amount,.00082);
 assert.equal(estimate({inputTokens:1000,outputTokens:100,cacheReadTokens:0,cacheWriteTokens:1}).coverage,'unknown');
 for(const sourceUrl of ['https://powertokens.ai/models/other-model','https://powertokens.ai.evil/models/glm-4.7'])assert.equal(selectTextPriceSnapshot({snapshots:[{...snapshot,sourceUrl}],model:snapshot.model,requestedAt:'2026-11-10T01:00:00Z'}).snapshot,null);
 assert.equal(selectTextPriceSnapshot({snapshots:[snapshot],model:snapshot.model,requestedAt:'2026-11-09T23:59:00Z'}).snapshot,null);
});
