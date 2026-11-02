"use strict";
// Bounded task scheduling only. Does not create agents, sessions or DSH processes.
const { fingerprint } = require("../contracts/phase1.cjs");
const error = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
const text = (x) => typeof x === "string" && x.trim().length > 0;
const sessionKey = (userId, sessionId) => JSON.stringify([userId, sessionId]);
function freeze(value) {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function createSessionScheduler({ perUserLimit = 4, globalLimit = 16 } = {}) {
  for (const limit of [perUserLimit, globalLimit]) if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Concurrency limits must be positive integers");
  const entries = new Map();
  const queue = [];
  const sessions = new Set();
  const users = new Map();
  const disposedSessions = new Set();
  const failedProcesses = new Map();
  let running = 0;
  let closed = false;
  let closePromise;
  function finish(entry, value, failure) {
    if (entry.finished) return;
    entry.finished = true;
    if (entry.state === "running") {
      running--;
      sessions.delete(entry.sessionKey);
      const count = users.get(entry.userId) - 1;
      if (count) users.set(entry.userId, count); else users.delete(entry.userId);
    } else {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
    }
    const reason = entry.stopReason || failure;
    entry.state = reason ? (reason.code === "SCHEDULER_CANCELLED" ? "cancelled" : "failed") : "completed";
    entries.delete(entry.runId);
    if (reason) entry.reject(reason); else entry.resolve(value);
    entry.settledResolve({ runId: entry.runId, state: entry.state });
    drain();
  }
  function start(entry) {
    entry.state = "running";
    sessions.add(entry.sessionKey);
    users.set(entry.userId, (users.get(entry.userId) || 0) + 1);
    running++;
    Promise.resolve().then(() => entry.execute({ signal: entry.controller.signal, context: entry.context }))
      .then((value) => finish(entry, value), (failure) => finish(entry, undefined, failure instanceof Error ? failure : error("EXECUTION_FAILED", "Task execution rejected", failure)));
  }
  function drain() {
    if (closed) return;
    // FIFO among eligible heads; a blocked user/session cannot stall unrelated work.
    for (let i = 0; i < queue.length && running < globalLimit;) {
      const entry = queue[i];
      if (disposedSessions.has(entry.sessionKey) || failedProcesses.has(entry.processId)) { i++; continue; }
      if (sessions.has(entry.sessionKey) || (users.get(entry.userId) || 0) >= perUserLimit) { i++; continue; }
      queue.splice(i, 1);
      start(entry);
    }
  }
  function stop(entry, reason) {
    if (entry.finished) return entry.settled;
    // Process failure overrides ordinary cancellation; first process error remains authoritative.
    if (!entry.stopReason || (entry.stopReason.code === "SCHEDULER_CANCELLED" && reason.code !== "SCHEDULER_CANCELLED")) entry.stopReason = reason;
    entry.controller.abort(entry.stopReason);
    if (entry.state === "queued") finish(entry);
    return entry.settled;
  }
  function submit(spec) {
    if (closed) throw error("SCHEDULER_CLOSED", "Scheduler is closed");
    if (!spec || ![spec.runId, spec.userId, spec.sessionId, spec.processId].every(text) || typeof spec.execute !== "function") throw new TypeError("runId, userId, sessionId, processId and execute are required");
    if (entries.has(spec.runId)) throw error("DUPLICATE_RUN", "Run is already scheduled");
    const key = sessionKey(spec.userId, spec.sessionId);
    if (disposedSessions.has(key)) throw error("SESSION_DISPOSED", "Session is disposed");
    if (failedProcesses.has(spec.processId)) throw error("PROCESS_FAILED", "Process is unavailable", failedProcesses.get(spec.processId));
    const supplied = spec.context === undefined ? {} : spec.context;
    fingerprint(supplied); // bounded JSON data; no hidden getter or mutable caller-owned state
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new TypeError("Context must be a JSON object");
    const context = freeze({ ...structuredClone(supplied), runId: spec.runId, userId: spec.userId, sessionId: spec.sessionId, processId: spec.processId });
    const entry = { runId: spec.runId, userId: spec.userId, sessionKey: key, processId: spec.processId, context, execute: spec.execute, state: "queued", controller: new AbortController(), finished: false };
    const result = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    result.catch(() => {}); // lifecycle cleanup must not depend on immediate caller attachment
    entry.settled = new Promise((resolve) => { entry.settledResolve = resolve; });
    entries.set(entry.runId, entry);
    queue.push(entry);
    drain();
    return { result, cancel: () => stop(entry, error("SCHEDULER_CANCELLED", "Run cancelled")), getState: () => entry.state };
  }
  function cancel(runId) {
    const entry = entries.get(runId);
    return entry ? stop(entry, error("SCHEDULER_CANCELLED", "Run cancelled")) : Promise.resolve(null);
  }
  function failProcess(processId, cause) {
    if (!text(processId)) throw new TypeError("processId is required");
    failedProcesses.set(processId, cause);
    const affected = [...entries.values()].filter((entry) => entry.processId === processId);
    return Promise.all(affected.map((entry) => stop(entry, error("PROCESS_FAILED", "Shared runtime process failed", cause))));
  }
  function disposeSession({ userId, sessionId }) {
    if (![userId, sessionId].every(text)) throw new TypeError("userId and sessionId are required");
    const key = sessionKey(userId, sessionId);
    disposedSessions.add(key);
    return Promise.all([...entries.values()].filter((entry) => entry.sessionKey === key).map((entry) => stop(entry, error("SCHEDULER_CANCELLED", "Session disposed"))));
  }
  function close() {
    if (!closePromise) {
      closed = true;
      // Publish completion before stop() emits synchronous abort callbacks that may reenter close().
      let resolveClose, rejectClose;
      closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      try {
        Promise.all([...entries.values()].map((entry) => stop(entry, error("SCHEDULER_CANCELLED", "Scheduler closed")))).then(resolveClose, rejectClose);
      } catch (cause) { rejectClose(cause); }
    }
    return closePromise;
  }
  return { submit, cancel, failProcess, disposeSession, close, stats: () => ({ running, queued: queue.length, active: entries.size, closed }) };
}
module.exports = { createSessionScheduler };
