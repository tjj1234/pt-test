'use strict';

const { fingerprint } = require('../contracts/phase1.cjs');
const fail = code => Object.assign(new Error(code), { code });
const RPC_NAME = 'northstar.model_request_intent';

function createModelIntentHandler({ priceStore, selectedModel, emit, reserve }) {
  if (!priceStore || typeof priceStore.selectNow !== 'function' || typeof emit !== 'function') throw new TypeError('Model intent dependencies are required');
  const pending = new Map();
  async function handle(request) {
    const { requestId, args, signal } = request;
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) throw fail('MODEL_INTENT_INVALID');
    const signature = fingerprint(args);
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !['model', 'provider', 'turn', 'step', 'maxTokens', 'purpose'].includes(key)) ||
        (args.purpose!==undefined&&args.purpose!=='compaction') ||
        args.model !== selectedModel || typeof args.provider !== 'string' || !args.provider || args.provider.length > 256 ||
        !Number.isSafeInteger(args.turn) || args.turn < 0 || !Number.isSafeInteger(args.step) || args.step < 0 ||
        !(args.maxTokens === null || (Number.isSafeInteger(args.maxTokens) && args.maxTokens > 0))) throw fail('MODEL_INTENT_INVALID');
    const existing = pending.get(requestId);
    if (existing) {
      if (existing.signature !== signature) throw fail('MODEL_INTENT_CONFLICT');
      if(reserve)throw fail('MODEL_ATTEMPT_ALREADY_RESERVED');
      return existing.promise;
    }
    if (pending.size >= 100) throw fail('MODEL_INTENT_LIMIT');
    const promise = (async () => {
      if (signal?.aborted) throw fail('MODEL_INTENT_CANCELLED');
      const price = await priceStore.selectNow(selectedModel);
      if (signal?.aborted) throw fail('MODEL_INTENT_CANCELLED');
      // Persist the exact capture and rates before allowing the SDK request to proceed.
      const payload = { action: 'model_request_intent', attemptId: requestId,
        requestedAt: price.requestedAt, selectedModel, provider: args.provider,
        turn: args.turn, step: args.step, ...(args.purpose?{purpose:args.purpose}:{}), parameters: { maxOutputTokens: args.maxTokens },
        parametersCoverage: 'partial', submission: 'intent_only',
        price: { catalogId: price.catalogId, sourceSha256: price.sourceSha256, snapshot: price.snapshot,
          coverage: price.coverage, reasonCode: price.reasonCode },
      };
      if (reserve) await reserve(payload);
      else await emit('state',payload,{attemptId:requestId});
      return { recorded: true };
    })();
    pending.set(requestId, { signature, promise });
    return promise;
  }
  return { handle };
}

module.exports = { RPC_NAME, createModelIntentHandler };
