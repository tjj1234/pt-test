'use strict';

const PRICE_SOURCE = 'https://powertokens.ai/pricing';
const UNKNOWN = Object.freeze({ amount: null, currency: null, coverage: 'unknown' });

function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0; }

/** Explicit requested-model estimates preserve unknown upstream identity. */
function estimateTextResponseCost({ requestedModel, providerModel, usage, price, allowRequestedModelEstimate = false } = {}) {
  const requestedBasis = providerModel == null && allowRequestedModelEstimate === true;
  if (!price || price.sourceUrl !== PRICE_SOURCE || typeof price.version !== 'string' || !price.version.trim() ||
      !Number.isFinite(Date.parse(price.capturedAt)) || price.currency !== 'USD' ||
      typeof requestedModel !== 'string' || !requestedModel.trim() ||
      (!requestedBasis && (typeof providerModel !== 'string' || providerModel !== requestedModel)) || price.model !== requestedModel ||
      !usage || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens) ||
      !nonnegative(usage.cacheReadTokens) || !nonnegative(usage.cacheWriteTokens) ||
      !Number.isFinite(price.inputUsdPerMillion) || price.inputUsdPerMillion < 0 ||
      !Number.isFinite(price.outputUsdPerMillion) || price.outputUsdPerMillion < 0) return UNKNOWN;
  if ((usage.cacheReadTokens > 0 && (!Number.isFinite(price.cacheReadUsdPerMillion) || price.cacheReadUsdPerMillion < 0)) ||
      (usage.cacheWriteTokens > 0 && (!Number.isFinite(price.cacheWriteUsdPerMillion) || price.cacheWriteUsdPerMillion < 0))) return UNKNOWN;
  // DSH/pi-ai reports ordinary input, cache read and cache write as disjoint components.
  const amount = (usage.inputTokens * price.inputUsdPerMillion +
    usage.cacheReadTokens * (price.cacheReadUsdPerMillion || 0) +
    usage.cacheWriteTokens * (price.cacheWriteUsdPerMillion || 0) +
    usage.outputTokens * price.outputUsdPerMillion) / 1_000_000;
  if (!Number.isFinite(amount)) return UNKNOWN;
  return Object.freeze({ amount, currency: 'USD', coverage: 'estimated',
    ...(requestedBasis ? { pricingBasis: 'requested_model' } : {}),
    priceVersion: price.version, priceCapturedAt: price.capturedAt, priceSourceUrl: PRICE_SOURCE });
}

module.exports = { estimateTextResponseCost };
