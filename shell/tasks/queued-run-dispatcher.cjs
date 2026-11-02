"use strict";

function createQueuedRunDispatcher({ execution, intervalMs = 500, batchSize = 8, onError = () => {} }) {
  if (!execution || typeof execution.dispatchQueued !== "function") throw new TypeError("execution.dispatchQueued is required");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60000) throw new TypeError("intervalMs is invalid");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError("batchSize is invalid");
  let timer = null, stopped = false, ticking = null;
  async function tick() {
    if (stopped || ticking) return ticking;
    ticking = execution.dispatchQueued({ limit: batchSize }).catch((error) => { try { onError(error); } catch {} }).finally(() => { ticking = null; });
    return ticking;
  }
  return {
    start() { if (stopped) throw new Error("dispatcher is stopped"); if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); void tick(); } },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; return ticking || Promise.resolve(); },
    tick,
  };
}

module.exports = { createQueuedRunDispatcher };
