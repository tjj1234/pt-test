"use strict";

const fail = (code, message) => Object.assign(new Error(message), { code });

// Durable run lifecycle around an injected executor. It intentionally knows
// nothing about HTTP, DSH internals, credentials, or client supplied identity.
function createRunExecutionService({ store, scheduler, executor, processId = "product-runtime" }) {
  if (!store || !scheduler || typeof executor !== "function") throw new TypeError("store, scheduler and executor are required");
  const active = new Map();
  const listeners = new Map();
  const publishedSeq = new Map();

  function publish(runId, event) {
    const last = publishedSeq.get(runId) || 0;
    if (event.seq <= last) return;
    publishedSeq.set(runId, event.seq);
    const set = listeners.get(runId);
    if (set) for (const listener of [...set]) {
      try { listener(event); } catch { /* subscriber failure cannot stop execution */ }
    }
  }

  async function publishPersisted(identity, runId) {
    let after = publishedSeq.get(runId) || 0;
    do {
      const page = await store.eventsAfter(identity, runId, { after, limit: 500 });
      for (const event of page.events) publish(runId, event);
      after = page.nextCursor;
      if (!page.hasMore) break;
    } while (true);
  }

  async function submit(identity, input, executionContext = {}, options = {}) {
    // Keep user content in conversations. The run request is a minimal replay/audit descriptor.
    const request = input.request;
    const created = await store.createRun(identity, { ...input, request });
    const runId = created.run.runId;
    let replaying = typeof options.onEvent === "function", lastDelivered = 0;
    const buffered = [];
    const listener = options.onEvent ? (event) => {
      if (replaying) buffered.push(event);
      else if (event.seq > lastDelivered) { lastDelivered = event.seq; options.onEvent(event); }
    } : null;
    const unsubscribe = listener ? subscribe(runId, listener) : null;
    // Replay directly to this subscriber. publishPersisted deduplicates process-wide,
    // so it cannot serve as a per-subscriber replay mechanism after another client read it.
    if (listener) {
      let cursor = 0, more = true;
      while (more) {
        const page = await store.eventsAfter(identity, runId, { after: cursor, limit: 500 });
        for (const event of page.events) {
          if (event.seq > lastDelivered) { lastDelivered = event.seq; options.onEvent(event); }
        }
        cursor = page.nextCursor; more = page.hasMore;
        if (!page.events.length) break;
      }
      replaying = false;
      buffered.sort((a, b) => a.seq - b.seq).forEach((event) => {
        if (event.seq > lastDelivered) { lastDelivered = event.seq; options.onEvent(event); }
      });
    }
    if (created.replayed) return { ...created, execution: null, unsubscribe };
    const runExecutor = typeof options.executor === "function" ? options.executor : executor;
    const finalize = typeof options.finalize === "function" ? options.finalize : async (result) => result;
    const eventTail = { current: Promise.resolve(), failure: null };
    let entry;
    try {
      entry = scheduler.submit({
      runId,
      userId: identity.userId,
      sessionId: created.run.conversationId,
      processId,
      context: executionContext,
      execute: async ({ signal, context }) => {
        let run = await store.getRun(identity, runId);
        run = await store.transition(identity, runId, "running", run.revision);
        await publishPersisted(identity, runId);
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
          const result = await runExecutor({ identity, run: created.run, request, context, signal, emit });
          if (eventTail.failure) throw eventTail.failure;
          await eventTail.current;
          const finalized = await finalize(result, { identity, run: created.run, signal, emit });
          const latest = await store.getRun(identity, runId);
          const outcome = finalized?.runOutcome || finalized;
          if (eventTail.failure) throw eventTail.failure;
          await eventTail.current;
          if (eventTail.failure) throw eventTail.failure;
          const terminal = outcome && outcome.stopped ? "cancelled" : outcome && outcome.ok === false ? "failed" : "completed";
          await store.transition(identity, runId, terminal, latest.revision);
          await publishPersisted(identity, runId);
          return finalized;
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
            try { await publishPersisted(identity, runId); } catch { /* database recovery owns remaining replay */ }
          }
          throw error;
        }
      },
      });
    } catch (error) {
      try {
        const latest = await store.getRun(identity, runId);
        await store.appendEvent(identity, runId, { type: "error", payload: { code: String(error.code || "SCHEDULER_REJECTED").slice(0, 64) } });
        const refreshed = await store.getRun(identity, runId);
        await store.transition(identity, runId, "failed", refreshed.revision);
        await publishPersisted(identity, runId);
      } catch { /* retain the scheduler error; persistent storage recovery is separate */ }
      if (unsubscribe) unsubscribe();
      throw error;
    }
    active.set(runId, { identity, entry });
    entry.result.finally(() => active.delete(runId)).catch(() => {});
    return { ...created, execution: entry, unsubscribe };
  }

  async function cancel(identity, runId) {
    const item = active.get(runId);
    if (!item) return { stopped: false, run: await store.getRun(identity, runId) };
    // The scheduler may promote a queued run while we perform the database CAS.
    // Re-read and retry that specific race so cancel cannot lose to queued→running.
    let run = await store.getRun(identity, runId);
    if (!run) throw fail("NOT_FOUND", "Run not found");
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!["queued", "running", "waiting_external", "awaiting_confirmation"].includes(run.state)) break;
      if (run.state === "cancelling") break;
      const next = run.state === "queued" ? "cancelled" : "cancelling";
      try {
        run = await store.transition(identity, runId, next, run.revision);
        break;
      } catch (error) {
        if (error.code !== "REVISION_CONFLICT" || attempt === 3) throw error;
        run = await store.getRun(identity, runId);
        if (!run) throw fail("NOT_FOUND", "Run not found");
      }
    }
    await publishPersisted(identity, runId);
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
