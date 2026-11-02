import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTextResponseCost } from '../../shell/usage/text-cost-estimate.cjs';

const price = { sourceUrl: 'https://powertokens.ai/pricing', capturedAt: '2026-10-26T00:00:00Z',
  version: 'snapshot-1', currency: 'USD', model: 'example-model',
  inputUsdPerMillion: 1, outputUsdPerMillion: 3, cacheReadUsdPerMillion: 0.5,
  cacheWriteUsdPerMillion: 2 };
const base = { requestedModel: 'example-model', providerModel: 'example-model',
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100 }, price };

test('versioned official price estimates explicit text and cache usage', () => {
  assert.deepEqual(estimateTextResponseCost(base), {
    amount: 0.002, currency: 'USD', coverage: 'estimated', priceVersion: 'snapshot-1',
    priceCapturedAt: '2026-10-26T00:00:00Z', priceSourceUrl: 'https://powertokens.ai/pricing',
  });
});

test('missing provider identity, usage, price version or cache dimension stays unknown', () => {
  for (const candidate of [
    { ...base, providerModel: null },
    { ...base, providerModel: 'different-model' },
    { ...base, usage: { inputTokens: null, outputTokens: 0 } },
    { ...base, price: { ...price, version: '' } },
    { ...base, price: { ...price, cacheReadUsdPerMillion: undefined } },
    { ...base, price: { ...price, cacheWriteUsdPerMillion: undefined } },
    { ...base, usage: { ...base.usage, cacheReadTokens: null } },
  ]) assert.deepEqual(estimateTextResponseCost(candidate), { amount: null, currency: null, coverage: 'unknown' });
});

test('known zero usage is a calculable zero estimate', () => {
  assert.equal(estimateTextResponseCost({ ...base, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, price }).amount, 0);
});

test('explicit requested-model estimates do not invent an upstream model identity', () => {
  const result = estimateTextResponseCost({ ...base, providerModel: null, allowRequestedModelEstimate: true });
  assert.equal(result.amount, 0.002);
  assert.equal(result.coverage, 'estimated');
  assert.equal(result.pricingBasis, 'requested_model');
  assert.equal(Object.hasOwn(result, 'providerModel'), false);
  assert.equal(estimateTextResponseCost({ ...base, providerModel: 'different-model', allowRequestedModelEstimate: true }).coverage, 'unknown');
});
