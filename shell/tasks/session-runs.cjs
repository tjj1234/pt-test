"use strict";

const fail = (code, message) => Object.assign(new Error(message), { code });
const activeStates = new Set(["queued", "running", "cancelling"]);
const terminalStates = new Set(["completed", "failed", "cancelled"]);
const identityKey = ({ userId, conversationId }) => JSON.stringify([userId, conversationId]);

function validId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

/**
 * Process-local index for active runs. Scheduling limits and same-session FIFO
 * remain owned by the injected session scheduler; this module never replaces a
 * different conversation's job when the same user starts another run.
 */
function createSessionRunRegistry() {
  const byRunId = new Map();
  const bySession = new Map();
  let sequence = 0;

  function validateIdentity(identity, withRunId = false) {
    if (!identity || !validId(identity.userId) || !validId(identity.conversationId) ||
        (withRunId && !validId(identity.runId))) {
      throw new TypeError(withRunId ? "userId, conversationId and runId are required" : "userId and conversationId are required");
    }
  }

  function stateOf(record) {
    if (record.state === "cancelling") return "cancelling";
    try {
      const state = record.job?.getState?.();
      if (typeof state === "string" && (activeStates.has(state) || terminalStates.has(state))) return state;
    } catch { /* use the last registry state */ }
    return record.state;
  }

  function view(record) {
    if (!record) return null;
    return Object.freeze({
      userId: record.userId,
      conversationId: record.conversationId,
      runId: record.runId,
      state: stateOf(record),
      job: record.job,
    });
  }

  function releaseRecord(record) {
    if (record.released) return false;
    record.released = true;
    if (byRunId.get(record.runId) === record) byRunId.delete(record.runId);
    const key = identityKey(record);
    const session = bySession.get(key);
    if (session) {
      session.delete(record.runId);
      if (!session.size) bySession.delete(key);
    }
    return true;
  }

  function attach(record, { job = null, completion, cancel } = {}) {
    if (record.released) return false;
    if (record.attached) throw fail("JOB_ALREADY_ATTACHED", "A job is already attached to this run");
    if (job !== null && (typeof job !== "object" && typeof job !== "function")) throw new TypeError("job must be an object");
    if (cancel !== undefined && typeof cancel !== "function") throw new TypeError("cancel must be a function");
    let settled = completion;
    if (settled === undefined) settled = job?.result ?? job?.promise ?? job?.completion;
    if (settled !== undefined && (settled === null || typeof settled.then !== "function")) {
      throw new TypeError("completion must be a promise");
    }
    record.job = job;
    record.cancel = cancel || (typeof job?.cancel === "function" ? (reason) => job.cancel(reason)
      : typeof job?.abort === "function" ? (reason) => job.abort(reason) : null);
    record.state = "running";
    record.attached = true;
    if (settled) Promise.resolve(settled).then(() => releaseRecord(record), () => releaseRecord(record));
    return true;
  }

  function register({ userId, conversationId, runId, job = null, completion, cancel } = {}) {
    validateIdentity({ userId, conversationId, runId }, true);
    const normalizedRunId = runId.trim();
    if (byRunId.has(normalizedRunId)) throw fail("DUPLICATE_RUN", "Run is already registered");
    const record = {
      userId: userId.trim(),
      conversationId: conversationId.trim(),
      runId: normalizedRunId,
      order: ++sequence,
      state: "queued",
      job: null,
      cancel: null,
      attached: false,
      released: false,
    };
    const key = identityKey(record);
    const registration = Object.freeze({
      runId: record.runId,
      attachJob: (spec = {}) => attach(record, spec),
      setState: (state) => {
        if (record.released) return false;
        if (typeof state !== "string" || (!activeStates.has(state) && !terminalStates.has(state))) throw new TypeError("invalid run state");
        record.state = state;
        return true;
      },
      release: () => releaseRecord(record),
      get: () => view(record),
    });
    if (job !== null || completion !== undefined || cancel !== undefined) attach(record, { job, completion, cancel });
    let session = bySession.get(key);
    if (!session) bySession.set(key, session = new Map());
    session.set(record.runId, record);
    byRunId.set(record.runId, record);
    return registration;
  }

  function get({ userId, conversationId, runId } = {}) {
    validateIdentity({ userId, conversationId, runId }, true);
    const record = byRunId.get(runId.trim());
    if (!record || record.userId !== userId.trim() || record.conversationId !== conversationId.trim()) return null;
    return view(record);
  }

  function list({ userId, conversationId } = {}) {
    validateIdentity({ userId, conversationId });
    const session = bySession.get(identityKey({ userId: userId.trim(), conversationId: conversationId.trim() }));
    return Object.freeze(session ? [...session.values()].sort((a, b) => a.order - b.order).map(view) : []);
  }

  function listUser({ userId } = {}) {
    if (!validId(userId)) throw new TypeError("userId is required");
    const runs = [];
    for (const session of bySession.values()) {
      for (const record of session.values()) {
        if (record.userId === userId.trim()) runs.push(view(record));
      }
    }
    runs.sort((a, b) => {
      const ar = byRunId.get(a.runId), br = byRunId.get(b.runId);
      return ar.order - br.order;
    });
    return Object.freeze(runs);
  }

  function current(identity) {
    const active = list(identity).filter((record) => activeStates.has(record.state));
    return active.find((record) => record.state === "running") || active[0] || null;
  }

  function hasSession(identity) {
    return current(identity) !== null;
  }

  async function cancelRun({ userId, conversationId, runId, reason } = {}) {
    validateIdentity({ userId, conversationId, runId }, true);
    const record = byRunId.get(runId.trim());
    if (!record || record.userId !== userId.trim() || record.conversationId !== conversationId.trim()) return { found: false };
    const cancel = record.cancel;
    if (!cancel) return { found: true, requested: false, run: view(record) };
    record.state = "cancelling";
    const result = await cancel(reason);
    return { found: true, requested: true, result, run: view(record) };
  }

  async function cancelCurrent(identity, reason) {
    const run = current(identity);
    if (!run) return { found: false };
    return cancelRun({ ...identity, runId: run.runId, reason });
  }

  return Object.freeze({ register, get, list, listUser, current, hasSession, cancelRun, cancelCurrent, size: () => byRunId.size });
}

module.exports = { createSessionRunRegistry };
