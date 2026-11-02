"use strict";

function createLeaseRecoverySweep({ store, intervalMs = 5000, onRecovered = () => {}, onError = () => {}, shouldStart = () => true, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!store || typeof store.recoverExpiredLeases !== "function") throw new TypeError("Lease recovery sweep requires a task store");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new TypeError("Lease recovery interval must be 1s to 60s");
  if (typeof shouldStart !== "function") throw new TypeError("shouldStart must be a function");
  let timer = null, inFlight = null, stopped = false;
  function sweep() {
    if (stopped || !shouldStart()) return Promise.resolve([]);
    if (inFlight) return inFlight;
    const pending = (async () => {
      try {
        const recovered = await store.recoverExpiredLeases({ limit: 100 });
        if (recovered.length) onRecovered(recovered);
        return recovered;
      } catch (error) {
        try { onError(error); } catch { /* a logger failure must not create an unhandled timer rejection */ }
        return [];
      } finally {
        inFlight = null;
      }
    })();
    inFlight = pending;
    return pending;
  }
  function start() {
    if (stopped) throw new Error("Lease recovery sweep is stopped");
    if (!shouldStart()) return false;
    if (timer) return;
    timer = setIntervalFn(() => { void sweep(); }, intervalMs);
    timer.unref?.();
    return true;
  }
  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await (inFlight || Promise.resolve());
  }
  return { sweep, start, stop };
}

module.exports = { createLeaseRecoverySweep };
