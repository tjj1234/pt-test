"use strict";
const { randomUUID } = require("node:crypto");
const fail = (code, message) => Object.assign(new Error(message), { code });

function createRunExecutionService({ store, scheduler, executor, processId = randomUUID(), leaseTtlMs = 30000, onSchedule = null }) {
  if (!store || !scheduler || typeof executor !== "function") throw new TypeError("store, scheduler and executor are required");
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1000 || leaseTtlMs > 300000) throw new TypeError("leaseTtlMs must be 1s to 5m");
  const active = new Map(), listeners = new Map(), publishedSeq = new Map(), identities = new Map(), backfills = new Map(), conversationLeaseRuns = new Set();
  function clearRunCache(runId) { if (active.has(runId) || listeners.get(runId)?.size) return; publishedSeq.delete(runId); identities.delete(runId); }
  function scheduleBackfill(identity, runId, targetSeq) {
    const pending = backfills.get(runId); if (pending) { pending.targetSeq = Math.max(pending.targetSeq, targetSeq); return; }
    const state = { targetSeq }; backfills.set(runId, state);
    (async () => { do { const target = state.targetSeq; await publishPersisted(identity, runId); if ((publishedSeq.get(runId) || 0) >= state.targetSeq && state.targetSeq === target) break; } while (true); })().catch(() => {}).finally(() => { backfills.delete(runId); clearRunCache(runId); });
  }
  function publish(runId, event) {
    const last = publishedSeq.get(runId) || 0; if (event.seq <= last) return;
    if (event.seq !== last + 1) { const identity = identities.get(runId); if (identity) scheduleBackfill(identity, runId, event.seq); return; }
    publishedSeq.set(runId, event.seq); const set = listeners.get(runId); if (set) for (const listener of [...set]) { try { listener(event); } catch {} }
  }
  async function publishPersisted(identity, runId) {
    let after = publishedSeq.get(runId) || 0;
    do { const page = await store.eventsAfter(identity, runId, { after, limit: 500 }); for (const event of page.events) publish(runId, event); after = page.nextCursor; if (!page.hasMore) break; } while (true);
  }
  function subscribe(runId, listener, options = {}) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    let set = listeners.get(runId); if (!set) listeners.set(runId, set = new Set());
    // Observer cursors are untrusted and must never advance the shared durable
    // publication watermark: a future cursor would suppress other observers.
    if (options.identity) identities.set(runId, options.identity);
    set.add(listener); let closed = false, cursor = Number.isSafeInteger(options.after) && options.after >= 0 ? options.after : 0, polling = false, pollTimer = null;
    const identity = options.identity;
    if (identity) { const poll = async () => { if (closed || polling) return; polling = true; try { let more = true; while (!closed && more) { const page = await store.eventsAfter(identity, runId, { after: cursor, limit: 200 }); for (const event of page.events) { cursor = Math.max(cursor, event.seq); publish(runId, event); } more = page.hasMore; if (!page.events.length) break; } } catch {} finally { polling = false; } }; pollTimer = setInterval(poll, 500); pollTimer.unref?.(); void poll(); }
    return () => { closed = true; if (pollTimer) clearInterval(pollTimer); set.delete(listener); if (!set.size) listeners.delete(runId); clearRunCache(runId); };
  }
  async function attach(identity, run, request, executionContext = {}, options = {}, created = { run, replayed: false }) {
    const runId = run.runId; identities.set(runId, identity);
    let replaying = typeof options.onEvent === "function", lastDelivered = 0, replayTargetSeq = 0;
    const listener = options.onEvent ? (event) => { if (replaying) replayTargetSeq = Math.max(replayTargetSeq, event.seq); else if (event.seq > lastDelivered) { lastDelivered = event.seq; options.onEvent(event); } } : null;
    const unsubscribe = listener ? subscribe(runId, listener, { identity }) : null;
    if (listener) {
      try {
        let cursor = 0;
        while (true) {
          let more = true;
          while (more) {
            const page = await store.eventsAfter(identity, runId, { after: cursor, limit: 500 });
            for (const event of page.events) if (event.seq > lastDelivered) { lastDelivered = event.seq; options.onEvent(event); }
            cursor = page.nextCursor; more = page.hasMore;
            if (!page.events.length) break;
          }
          if (lastDelivered >= replayTargetSeq) break;
          if (cursor >= replayTargetSeq) break;
          throw fail("EVENT_REPLAY_GAP", "Persisted Run events did not reach the observed replay cursor");
        }
        replaying = false;
      }
      catch (error) { unsubscribe?.(); if (!created.replayed) await store.releaseLease(identity, runId, processId).catch(() => false); throw error; }
    }
    if (created.replayed) { if (!unsubscribe) clearRunCache(runId); return { ...created, execution: null, unsubscribe }; }
    const runExecutor = typeof options.executor === "function" ? options.executor : executor;
    const finalize = typeof options.finalize === "function" ? options.finalize : async (result) => result;
    const eventTail = { current: Promise.resolve(), failure: null };
    let leaseHeartbeat, entry, heartbeatBusy = false, heartbeatCancelRequested = false;
    const requestHeartbeatCancel = () => {
      if (heartbeatCancelRequested) return;
      heartbeatCancelRequested = true;
      void scheduler.cancel(runId).catch(() => {});
    };
    leaseHeartbeat = setInterval(async () => { if (heartbeatBusy) return; heartbeatBusy = true; try { await store.renewLease(identity, runId, processId, leaseTtlMs); if (conversationLeaseRuns.has(runId)) await store.renewConversationLease(identity, runId, processId, leaseTtlMs); const latest = await store.getRun(identity, runId); if (latest.state === "cancelling") requestHeartbeatCancel(); } catch (error) { if (error.code === "LEASE_LOST") requestHeartbeatCancel(); } finally { heartbeatBusy = false; } }, Math.max(100, Math.floor(leaseTtlMs / 3)));
    leaseHeartbeat.unref?.();
    try {
      entry = scheduler.submit({ runId, userId: identity.userId, sessionId: run.conversationId, processId, context: executionContext, execute: async ({ signal, context }) => {
        let conversationLease = false;
        while (!signal.aborted && !conversationLease) {
          conversationLease = await store.acquireConversationLease(identity, runId, processId, leaseTtlMs);
          if (!conversationLease) await new Promise((resolve) => {
            const timer = setTimeout(done, 100);
            function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
            signal.addEventListener("abort", done, { once: true });
          });
        }
        if (!conversationLease) throw fail("SCHEDULER_CANCELLED", "Run cancelled while waiting for conversation execution lease");
        if (signal.aborted) {
          await store.releaseConversationLease(identity, runId, processId).catch(() => false);
          throw fail("SCHEDULER_CANCELLED", "Run cancelled while acquiring conversation execution lease");
        }
        conversationLeaseRuns.add(runId);
        let current;
        try {
          current = await store.getRun(identity, runId);
          current = await store.transition(identity, runId, "running", current.revision, processId);
        } catch (error) {
          conversationLeaseRuns.delete(runId);
          await store.releaseConversationLease(identity, runId, processId).catch(() => false);
          throw error;
        }
        await publishPersisted(identity, runId);
        const emit = (type, payload = {}, extra = {}) => {
          const operation = eventTail.current.catch(() => {}).then(async () => { if (eventTail.failure) throw eventTail.failure; await store.appendEvent(identity, runId, { type, payload, ...extra, leaseOwner: processId }); await publishPersisted(identity, runId); });
          eventTail.current = operation; operation.catch((error) => { eventTail.failure ||= error; }); return eventTail.current;
        };
        try {
          const result = await runExecutor({ identity, run: current, request, context, signal, emit, leaseOwner: processId });
          if (eventTail.failure) throw eventTail.failure; await eventTail.current;
          const finalized = await finalize(result, { identity, run: current, signal, emit });
          const latest = await store.getRun(identity, runId), outcome = finalized?.runOutcome || finalized;
          if (eventTail.failure) throw eventTail.failure; await eventTail.current; if (eventTail.failure) throw eventTail.failure;
          const source = finalized?.completionPayload && typeof finalized.completionPayload === "object" ? finalized.completionPayload : {};
          const interrupted = outcome?.interrupted === true || source.code === "RUN_INTERRUPTED";
          const terminal = outcome?.stopped ? "cancelled" : interrupted ? "interrupted" : outcome?.ok === false ? "failed" : "completed";
          const donePayload = {};
          for (const key of ["ok", "stopped", "needKey", "archived", "stopReason", "code", "error"]) {
            if (source[key] === undefined) continue;
            if (["ok", "stopped", "needKey", "archived"].includes(key)) donePayload[key] = source[key] === true;
            else if (typeof source[key] === "string") donePayload[key] = source[key].slice(0, key === "error" ? 2000 : 128);
          }
          if (Array.isArray(source.reasonCodes)) donePayload.reasonCodes = [...new Set(source.reasonCodes.filter((code) => typeof code === "string").map((code) => code.slice(0, 64)))].slice(0, 8);
          await store.transition(identity, runId, terminal, latest.revision, processId, { donePayload }); await publishPersisted(identity, runId); return finalized;
        } catch (error) {
          await eventTail.current.catch(() => {});
          const latest = await store.getRun(identity, runId);
          if (!["completed", "failed", "cancelled", "interrupted"].includes(latest.state)) {
            try { await store.appendEvent(identity, runId, { type: "error", payload: { code: String((eventTail.failure || error).code || "EXECUTION_FAILED").slice(0,64) }, leaseOwner: processId }); } catch {}
            const refreshed = await store.getRun(identity, runId), target = signal.aborted ? "cancelled" : "failed";
            try { await store.transition(identity, runId, target, refreshed.revision, processId); } catch {}
            try { await publishPersisted(identity, runId); } catch {}
          }
          throw error;
        } finally {
          conversationLeaseRuns.delete(runId);
          await store.releaseConversationLease(identity, runId, processId).catch(() => false);
        }
      }});
    } catch (error) {
      try { const latest = await store.getRun(identity, runId); await store.appendEvent(identity, runId, { type: "error", payload: { code: String(error.code || "SCHEDULER_REJECTED").slice(0,64) }, leaseOwner: processId }); const refreshed = await store.getRun(identity, runId); await store.transition(identity, runId, "failed", refreshed.revision, processId); await publishPersisted(identity, runId); } catch {}
      clearInterval(leaseHeartbeat); unsubscribe?.(); clearRunCache(runId); throw error;
    }
    active.set(runId, { identity, entry });
    if (typeof onSchedule === "function") { try { onSchedule({ identity, run, entry }); } catch {} }
    const scheduledResult = entry.result;
    entry.result = scheduledResult.finally(() => { clearInterval(leaseHeartbeat); active.delete(runId); unsubscribe?.(); clearRunCache(runId); return store.releaseLease(identity, runId, processId).catch(() => false); });
    entry.result.catch(() => {});
    return { ...created, execution: entry, unsubscribe };
  }
  async function submit(identity, input, executionContext = {}, options = {}) {
    const request = input.request, created = await store.createRun(identity, { ...input, request }, { owner: processId, ttlMs: leaseTtlMs });
    return attach(identity, created.run, request, executionContext, options, created);
  }
  async function dispatchQueued({ limit = 8 } = {}) {
    const claims = await store.claimReplayableQueuedRuns(processId, { limit, ttlMs: leaseTtlMs }), launched = [];
    for (const claim of claims) {
      try { launched.push(await attach(claim.identity, claim.run, claim.request, { kind: "chat", recovered: true }, {}, { run: claim.run, replayed: false })); }
      catch (error) { launched.push({ run: claim.run, error }); }
    }
    return launched;
  }
  async function cancel(identity, runId) {
    const item = active.get(runId); let run = await store.getRun(identity, runId); if (!run) throw fail("NOT_FOUND", "Run not found");
    for (let attempt = 0; attempt < 4; attempt++) { if (!["queued","running","waiting_external","awaiting_confirmation"].includes(run.state) || run.state === "cancelling") break; try { run = await store.transition(identity, runId, run.state === "queued" ? "cancelled" : "cancelling", run.revision); break; } catch (error) { if (error.code !== "REVISION_CONFLICT" || attempt === 3) throw error; run = await store.getRun(identity, runId); if (!run) throw fail("NOT_FOUND", "Run not found"); } }
    await publishPersisted(identity, runId); if (!item) return { stopped: run.state === "cancelled", cancelRequested: run.state === "cancelling", run };
    const settled = await scheduler.cancel(runId), settledRun = await store.getRun(identity, runId); return { stopped: settled?.state === "cancelled" && settledRun.state === "cancelled", run: settledRun };
  }
  return { submit, dispatchQueued, cancel, subscribe, activeRunIds: () => [...active.keys()] };
}
module.exports = { createRunExecutionService };
