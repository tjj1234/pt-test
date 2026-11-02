import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { estimateBoundTextResponse } from '../../shell/usage/bound-text-estimate.cjs';
import { TRUSTED_TOTAL_SEMANTICS } from '../../shell/runtime/usage.cjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../../docs/refactor/candidates/pt-text-prices-observed-20261027.json', import.meta.url), 'utf8'));
const price = catalog.snapshots[0];
const intent = { turn: 1, step: 2, selectedModel: price.model, requestedAt: price.capturedAt,
  attemptId: '11111111-1111-4111-8111-111111111111', price: { coverage: 'selected', catalogId: 'a'.repeat(64),
    sourceSha256: createHash('sha256').update(catalog.sourceEvidence).digest('hex'), snapshot: price } };
const input = { selectedModel: price.model, totalSemantics: TRUSTED_TOTAL_SEMANTICS,
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 100 },
  identity: { configuredModelId: price.model, providerReportedModelId: price.model, turn: 1, step: 2 }, intents: [intent] };

test('captured official Standard text rates bind to one response without historical price guessing', () => {
  const result = estimateBoundTextResponse(input);
  assert.equal(result.amount, 0.000225);
  assert.equal(result.currency, 'USD');
  assert.equal(result.coverage, 'estimated');
  assert.equal(result.priceVersion, price.version);
  assert.equal(result.requestedAt, price.capturedAt);
  assert.equal(estimateBoundTextResponse({ ...input, intents: [{ ...intent, requestedAt: '2026-10-27T05:58:06Z' }] }).coverage, 'unknown');
  assert.equal(estimateBoundTextResponse({ ...input, intents: [{ ...intent, requestedAt: price.effectiveUntil }] }).coverage, 'unknown');
});

test('unknown upstream identity permits a requested-model estimate with an explicit basis', () => {
  const result = estimateBoundTextResponse({ ...input, identity: { ...input.identity, providerReportedModelId: null } });
  assert.equal(result.amount, 0.000225);
  assert.equal(result.pricingBasis, 'requested_model');
  assert.equal(result.coverage, 'estimated');
});

test('ambiguous retries, foreign model and incomplete usage remain unpriced', () => {
  for (const candidate of [
    { ...input, intents: [intent, { ...intent, attemptId: 'second-attempt' }] },
    { ...input, identity: { ...input.identity, providerReportedModelId: 'another-model' } },
    { ...input, identity: { ...input.identity, turn: undefined } },
    { ...input, totalSemantics: 'unknown' },
    { ...input, usage: { ...input.usage, cacheReadTokens: null } },
  ]) {
    const result = estimateBoundTextResponse(candidate);
    assert.equal(result.amount, null);
    assert.equal(result.coverage, 'unknown');
  }
});
