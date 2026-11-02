import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLeaseRecoverySweep } = require("../../shell/tasks/lease-recovery-sweep.cjs");

test("lease sweep is bounded, single-flight, unrefed, and stops cleanly", async () => {
  let tick, intervalMs, timerCleared = false, unrefed = false, resolveRecovery;
  const calls = [], recovered = [], errors = [];
  const store = { recoverExpiredLeases(options) {
    calls.push(options);
    return new Promise((resolve) => { resolveRecovery = resolve; });
  } };
  const sweep = createLeaseRecoverySweep({
    store,
    intervalMs: 2500,
    setIntervalFn(callback, delay) {
      tick = callback; intervalMs = delay;
      return { unref() { unrefed = true; } };
    },
    clearIntervalFn(timer) { assert.equal(typeof timer.unref, "function"); timerCleared = true; },
    onRecovered: (runs) => recovered.push(runs),
    onError: (error) => errors.push(error),
  });
  sweep.start();
  sweep.start();
  assert.equal(intervalMs, 2500);
  assert.equal(unrefed, true);
  tick(); tick();
  assert.equal(calls.length, 1, "overlapping timer ticks share one in-flight recovery batch");
  assert.deepEqual(calls[0], { limit: 100 });
  const stopping = sweep.stop();
  assert.equal(timerCleared, true);
  assert.equal(calls.length, 1, "stop does not start another sweep");
  resolveRecovery([{ runId: "run-1" }]);
  await stopping;
  assert.equal(recovered.length, 1);
  assert.deepEqual(await sweep.sweep(), []);
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 0);
});

test("lease sweep contains logger failures and retries on the next timer tick", async () => {
  const failure = new Error("temporary store failure");
  let tick, calls = 0;
  const unhandled = [];
  const captureUnhandled = (error) => unhandled.push(error);
  const sweep = createLeaseRecoverySweep({
    store: { async recoverExpiredLeases() { if (++calls === 1) throw failure; return []; } },
    onError(error) { assert.equal(error, failure); throw new Error("logger failure"); },
    setIntervalFn(callback) { tick = callback; return { unref() {} }; },
    clearIntervalFn() {},
  });
  process.on("unhandledRejection", captureUnhandled);
  try {
    sweep.start();
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, "the next tick runs after both store and logger failures");
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", captureUnhandled);
    await sweep.stop();
  }
});

test("shutdown gate prevents startup from creating a late recovery interval", async () => {
  let shuttingDown = false, intervalsCreated = 0, storeCalls = 0;
  const sweep = createLeaseRecoverySweep({
    store: { async recoverExpiredLeases() { storeCalls++; return []; } },
    shouldStart: () => !shuttingDown,
    setIntervalFn() { intervalsCreated++; return { unref() {} }; },
    clearIntervalFn() {},
  });
  shuttingDown = true; // SIGTERM arrives while startup is still awaiting other initialization.
  assert.equal(sweep.start(), false);
  assert.deepEqual(await sweep.sweep(), []);
  assert.equal(intervalsCreated, 0);
  assert.equal(storeCalls, 0);
  await sweep.stop();
});
