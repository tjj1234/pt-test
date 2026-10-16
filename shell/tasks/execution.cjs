"use strict";

const { EventEmitter } = require("node:events");
const fail = (code, message) => Object.assign(new Error(message), { code });

// Durable run lifecycle around an injected executor. It intentionally knows
// nothing about HTTP, DSH internals, credentials, or client supplied identity.
function createRunExecutionService({ store, scheduler, executor, processId = "product-runtime" }) {
  if (!store || !scheduler || typeof executor !== "function") throw new TypeError("store, scheduler and executor are required");
  const active = new Map();
  const listeners = new Map();

  function publish(runId, event) {
    const set = listeners.get(runId);
    if (set) for (const listener of [...set]) {
      try { listener(event); } catch { /* subscriber failure cannot stop execution */ }
    }
  }

  async function submit(identity, input, executionContext = {}) {
    // Keep user content in conversations. The run request is a minimal replay/audit descriptor.
    const request = input.request;
    const created = await store.createRun(identity, { ...input, request });
    if (created.replayed) return { ...created, execution: null };
    const runId = created.run.runId;
    const eventTail = { current: Promise.resolve(), failure: null };
    const entry = scheduler.submit({
      runId,
      userId: identity.userId,
      sessionId: created.run.conversationId,
      processId,
      context: executionContext,
      execute: async ({ signal, context }) => {
        let run = await store.getRun(identity, runId);
        run = await store.transition(identity, runId, "running", run.revision);
        const emit = (type, payload = {}, extra = {}) => {
          // Runtime callbacks may be synchronous and may ignore returned promises.
          // Serialize and drain before terminal state so seq order and write failures are visible.
          const operation = eventTail.current.catch(() => {}).then(async () => {
            if (eventTail.failure) throw eventTail.failure;
            const saved = await store.appendEvent(identity, runId, { type, payload, ...extra });
            publish(runId, saved);
          });
          eventTail.current = operation;
          operation.catch((error) => { eventTail.failure ||= error; });
          return eventTail.current;
        };
        try {
          const result = await executor({ identity, run: created.run, request, context, signal, emit });
          if (eventTail.failure) throw eventTail.failure;
          await eventTail.current;
          const latest = await store.getRun(identity, runId);
          const terminal = result && result.stopped ? "cancelled" : result && result.ok === false ? "failed" : "completed";
          await store.transition(identity, runId, terminal, latest.revision);
          return result;
        } catch (error) {
          await eventTail.current.catch(() => {});
          const latest = await store.getRun(identity, runId);
          if (!["completed", "failed", "cancelled", "interrupted"].includes(latest.state)) {
            try { await store.appendEvent(identity, runId, { type: "error", payload: { code: String((eventTail.failure || error).code || "EXECUTION_FAILED").slice(0, 64) } }); }
            catch { /* Preserve the original failure; recovery can reconcile if persistence remains unavailable. */ }
            const refreshed = await store.getRun(identity, runId);
            const target = signal.aborted ? "cancelled" : "failed";
            try { await store.transition(identity, runId, target, refreshed.revision); }
            catch { /* Never mask the execution/event failure with a secondary finalization error. */ }
          }
          throw error;
        }
      },
    });
    active.set(runId, { identity, entry });
    entry.result.finally(() => active.delete(runId)).catch(() => {});
    return { ...created, execution: entry };
  }

  async function cancel(identity, runId) {
    const item = active.get(runId);
    if (!item) return { stopped: false, run: await store.getRun(identity, runId) };
    // Ownership is checked before state changes; scheduler cancellation only targets this run.
    const run = await store.getRun(identity, runId);
    if (!run) throw fail("NOT_FOUND", "Run not found");
    if (!["queued", "running", "waiting_external", "awaiting_confirmation"].includes(run.state)) return { stopped: false, run };
    if (run.state === "queued") {
      await store.transition(identity, runId, "cancelled", run.revision);
    } else {
      await store.transition(identity, runId, "cancelling", run.revision);
    }
    const settled = await scheduler.cancel(runId);
    const settledRun = await store.getRun(identity, runId);
    return { stopped: settled?.state === "cancelled" && settledRun.state === "cancelled", run: settledRun };
  }

  function subscribe(runId, listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    let set = listeners.get(runId);
    if (!set) listeners.set(runId, set = new Set());
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(runId); };
  }

  return { submit, cancel, subscribe, activeRunIds: () => [...active.keys()] };
}

module.exports = { createRunExecutionService };
