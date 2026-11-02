'use strict';

const { estimateTextResponseCost } = require('./text-cost-estimate.cjs');
const { selectTextPriceSnapshot } = require('./price-snapshot-selection-candidate.cjs');
const { TRUSTED_TOTAL_SEMANTICS } = require('../runtime/usage.cjs');
const unknown = reasonCode => ({ amount: null, currency: null, coverage: 'unknown', reasonCode });

function estimateBoundTextResponse({ selectedModel, usage, totalSemantics, identity, intents }) {
  if (totalSemantics !== TRUSTED_TOTAL_SEMANTICS) return unknown('USAGE_SEMANTICS_UNKNOWN');
  if (!Number.isSafeInteger(identity?.turn) || !Number.isSafeInteger(identity?.step)) return unknown('REQUEST_COORDINATES_UNKNOWN');
  if (!Array.isArray(intents) || intents.length > 100) return unknown('REQUEST_INTENT_LIMIT');
  const matches = intents.filter(intent => intent.turn === identity.turn && intent.step === identity.step);
  if (matches.length !== 1) return unknown('REQUEST_INTENT_AMBIGUOUS');
  const intent = matches[0];
  if (intent.selectedModel !== selectedModel || identity.configuredModelId !== selectedModel ||
      (identity.providerReportedModelId != null && identity.providerReportedModelId !== selectedModel)) return unknown('MODEL_IDENTITY_MISMATCH');
  const price = intent.price;
  if (price?.coverage !== 'selected' || !/^[a-f0-9]{64}$/.test(price.catalogId || '') ||
      !/^[a-f0-9]{64}$/.test(price.sourceSha256 || '') || !price.snapshot) return unknown('PRICE_UNAVAILABLE');
  const checked = selectTextPriceSnapshot({ snapshots: [price.snapshot], model: selectedModel, requestedAt: intent.requestedAt });
  if (!checked.snapshot) return unknown('PRICE_BINDING_INVALID');
  const estimate = estimateTextResponseCost({ requestedModel: selectedModel, providerModel: identity.providerReportedModelId,
    usage, price: checked.snapshot, allowRequestedModelEstimate: true });
  if (estimate.coverage !== 'estimated') return unknown('USAGE_INCOMPLETE');
  return { ...estimate, pricingBasis: estimate.pricingBasis || 'provider_reported_model',
    catalogId: price.catalogId, attemptId: intent.attemptId, requestedAt: intent.requestedAt };
}

module.exports = { estimateBoundTextResponse };
