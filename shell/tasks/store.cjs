"use strict";
const { randomUUID } = require("node:crypto");
const c = require("../contracts/phase1.cjs");
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const stamp = (v) => v instanceof Date ? v.toISOString() : String(v);
function decode(row) {
  if (!row) return null;
  return c.assertContract("run", {
    version: row.contract_version, runId: row.run_id, conversationId: row.conversation_id,
    userId: row.user_id, tenantId: row.tenant_id, workspaceId: row.workspace_id,
    policyVersion: row.policy_version, state: row.state, revision: row.revision,
    createdAt: stamp(row.created_at), updatedAt: stamp(row.updated_at),
    reconciliation: row.reconciliation, externalProvider: row.external_provider,
    externalOperationKey: row.external_operation_key, externalTaskId: row.external_task_id,
    externalState: row.external_state,
  });
}
function boundedText(value, field, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw fail("CONTRACT_INVALID", field + " is invalid", 400);
  return value;
}
function pageOptions(after = 0, limit = 100) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fail("CONTRACT_INVALID", "Invalid event cursor or limit", 400);
}
function createTaskStore(db, opts = {}) {
  if (!db || typeof db.query !== "function" || typeof db.transaction !== "function") throw new TypeError("Task store requires query and transaction");
  const workspaceForIdentity = opts.workspaceForIdentity || ((identity) => "ws_" + identity.tenantId);
  async function owned(tx, identity, runId, lock = false) {
    c.assertContract("identity", identity);
    const result = await tx.query("SELECT * FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3" + (lock ? " FOR UPDATE" : ""), [runId, identity.userId, identity.tenantId]);
    if (!result.rows.length) throw fail("NOT_FOUND", "Run not found", 404);
    return result.rows[0];
  }
  async function append(tx, row, spec) {
    c.fingerprint(spec); // reject getters, undefined, oversized and non-JSON input before reads
    const eventId = spec.eventId || randomUUID();
    const event = {
      version: c.VERSION, eventId, runId: row.run_id, conversationId: row.conversation_id,
      seq: row.next_seq, type: spec.type, occurredAt: spec.occurredAt || new Date().toISOString(), payload: spec.payload === undefined ? {} : spec.payload,
    };
    for (const field of ["callId", "attemptId", "artifactId"]) if (spec[field] !== undefined) event[field] = spec[field];
    // Request identity/scope/seq is always generated from the locked owned row.
    for (const field of ["runId", "conversationId", "version"]) if (spec[field] !== undefined && spec[field] !== event[field]) throw fail("EVENT_SCOPE_MISMATCH", "Event scope override rejected");
    const existing = await tx.query("SELECT event FROM agent_run_events WHERE event_id=$1 AND run_id=$2", [eventId, row.run_id]);
    if (existing.rows.length) {
      const prior = existing.rows[0].event;
      if (spec.seq !== undefined && spec.seq !== prior.seq) throw fail("EVENT_SCOPE_MISMATCH", "Event sequence override rejected");
      const candidate = { ...event, seq: prior.seq, occurredAt: spec.occurredAt || prior.occurredAt };
      if (c.fingerprint(prior) !== c.fingerprint(candidate)) throw fail("EVENT_ID_CONFLICT", "Event ID already has different content");
      return prior;
    }
    if (spec.seq !== undefined && spec.seq !== event.seq) throw fail("EVENT_SCOPE_MISMATCH", "Event sequence override rejected");
    if (event.type === "done") {
      const done = await tx.query("SELECT event_id FROM agent_run_events WHERE run_id=$1 AND event->>'type'='done'", [row.run_id]);
      if (done.rows.length) throw fail("TERMINAL_EVENT_EXISTS", "Run already has its terminal event");
    }
    const previous = await tx.query("SELECT event FROM agent_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1", [row.run_id]);
    c.assertEventAfter(previous.rows[0]?.event || null, event, decode(row));
    if (c.TERMINAL_STATES.includes(row.state) && ["delta", "connecting", "tool.started", "queued"].includes(event.type)) throw fail("RUN_TERMINAL", "Cannot resume terminal run");
    await tx.query("INSERT INTO agent_run_events (event_id,run_id,seq,event) VALUES ($1,$2,$3,$4::jsonb)", [event.eventId, event.runId, event.seq, JSON.stringify(event)]);
    await tx.query("UPDATE agent_runs SET next_seq=next_seq+1,updated_at=now() WHERE run_id=$1", [row.run_id]);
    row.next_seq++;
    return event;
  }
  async function change(tx, row, next, expectedRevision, patch = {}) {
    const updated = c.transitionRun(decode(row), next, expectedRevision);
    const result = await tx.query("UPDATE agent_runs SET state=$1,revision=$2,reconciliation=$3,external_provider=$4,external_operation_key=$5,external_task_id=$6,external_state=$7,updated_at=now() WHERE run_id=$8 AND revision=$9 RETURNING *", [updated.state, updated.revision, patch.reconciliation ?? row.reconciliation, patch.externalProvider ?? row.external_provider, patch.externalOperationKey ?? row.external_operation_key, patch.externalTaskId ?? row.external_task_id, patch.externalState ?? row.external_state, row.run_id, expectedRevision]);
    if (!result.rows.length) throw fail("REVISION_CONFLICT", "Stale run revision");
    const current = result.rows[0];
    await append(tx, current, { type: "state", payload: { state: next, reconciliation: current.reconciliation } });
    if (c.TERMINAL_STATES.includes(next)) await append(tx, current, { type: "done", payload: { state: next } });
    return decode(current);
  }
  async function createRun(identity, input) {
    c.assertContract("identity", identity);
    c.fingerprint(input);
    const conversationId = boundedText(input.conversationId, "conversationId");
    const workspaceId = workspaceForIdentity(identity);
    boundedText(workspaceId, "workspaceId");
    for (const field of ["tenantId", "userId", "workspaceId"]) if (input[field] !== undefined && input[field] !== ({ ...identity, workspaceId })[field]) throw fail("FORBIDDEN", "Identity override rejected", 403);
    const policyVersion = boundedText(input.policyVersion || "1", "policyVersion");
    const request = input.request;
    const claim = c.idempotencyClaim(identity, "create-run", input.idempotencyKey, { conversationId, policyVersion, request });
    return db.transaction(async (tx) => {
      const conversation = await tx.query("SELECT c.id FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND u.tenant_id=$3 FOR SHARE OF c,u", [conversationId, identity.userId, identity.tenantId]);
      if (!conversation.rows.length) throw fail("NOT_FOUND", "Conversation not found", 404);
      const runId = randomUUID();
      const result = await tx.query("INSERT INTO agent_runs (run_id,conversation_id,user_id,tenant_id,workspace_id,contract_version,policy_version,state,idempotency_scope,request_hash,request) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10::jsonb) ON CONFLICT (idempotency_scope) DO NOTHING RETURNING *", [runId, conversationId, identity.userId, identity.tenantId, workspaceId, c.VERSION, policyVersion, claim.scope, claim.requestHash, JSON.stringify(request)]);
      if (!result.rows.length) {
        const existing = (await tx.query("SELECT * FROM agent_runs WHERE idempotency_scope=$1 AND user_id=$2 AND tenant_id=$3", [claim.scope, identity.userId, identity.tenantId])).rows[0];
        if (!existing) throw fail("IDEMPOTENCY_CONFLICT", "Idempotency claim unavailable");
        c.compareIdempotency({ scope: existing.idempotency_scope, requestHash: existing.request_hash, runId: existing.run_id }, claim);
        return { run: decode(existing), replayed: true };
      }
      await append(tx, result.rows[0], { type: "queued", payload: {} });
      return { run: decode(result.rows[0]), replayed: false };
    });
  }
  async function getRun(identity, runId) { return decode(await owned(db, identity, runId)); }
  async function listRuns(identity, { afterRunId = null, limit = 100 } = {}) {
    c.assertContract("identity", identity);
    pageOptions(0, limit);
    const result = await db.query("SELECT * FROM agent_runs WHERE user_id=$1 AND tenant_id=$2 AND ($3::uuid IS NULL OR run_id>$3::uuid) ORDER BY run_id LIMIT $4", [identity.userId, identity.tenantId, afterRunId, limit + 1]);
    const runs = result.rows.slice(0, limit).map(decode);
    return { runs, nextCursor: runs.at(-1)?.runId ?? afterRunId, hasMore: result.rows.length > limit };
  }
  async function eventsAfter(identity, runId, { after = 0, limit = 100 } = {}) {
    pageOptions(after, limit);
    return db.transaction(async (tx) => {
      await owned(tx, identity, runId, true);
      const result = await tx.query("SELECT event FROM agent_run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [runId, after, limit + 1]);
      const events = result.rows.slice(0, limit).map((r) => r.event);
      return { events, nextCursor: events.at(-1)?.seq ?? after, hasMore: result.rows.length > limit };
    });
  }
  async function appendEvent(identity, runId, event) {
    try { return await db.transaction(async (tx) => append(tx, await owned(tx, identity, runId, true), event)); }
    catch (error) { if (error.code === "23505") throw fail("EVENT_ID_CONFLICT", "Event ID already exists"); throw error; }
  }
  async function transition(identity, runId, next, expectedRevision) {
    return db.transaction(async (tx) => change(tx, await owned(tx, identity, runId, true), next, expectedRevision));
  }
  async function recordExternalIntent(identity, runId, { provider, operationKey, expectedRevision }) {
    boundedText(provider, "provider"); boundedText(operationKey, "operationKey");
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (row.external_operation_key) throw fail("EXTERNAL_INTENT_EXISTS", "External submission intent already exists");
      return change(tx, row, "waiting_external", expectedRevision, { externalProvider: provider, externalOperationKey: operationKey, externalState: "submitting", reconciliation: "needs_reconciliation" });
    });
  }
  async function recordExternalTaskId(identity, runId, { taskId, expectedRevision }) {
    boundedText(taskId, "taskId");
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (row.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "Stale run revision");
      if (row.state !== "waiting_external" || !row.external_operation_key || row.external_task_id) throw fail("INVALID_TRANSITION", "No unconfirmed external submission");
      const result = await tx.query("UPDATE agent_runs SET external_task_id=$1,external_state='accepted',reconciliation='not_required',revision=revision+1,updated_at=now() WHERE run_id=$2 AND revision=$3 RETURNING *", [taskId, runId, expectedRevision]);
      await append(tx, result.rows[0], { type: "state", payload: { state: "waiting_external", externalState: "accepted" } });
      return decode(result.rows[0]);
    });
  }
  // Invoke only after the worker owner is known dead (startup/expired lease), never as a live-task poll.
  async function recoverInterrupted(identity) {
    c.assertContract("identity", identity);
    return db.transaction(async (tx) => {
      const rows = (await tx.query("SELECT * FROM agent_runs WHERE user_id=$1 AND tenant_id=$2 AND state IN ('queued','running','cancelling','waiting_external') ORDER BY run_id FOR UPDATE", [identity.userId, identity.tenantId])).rows;
      const recovered = [];
      for (const row of rows) {
        if (row.reconciliation === "needs_reconciliation" && ["unknown", "pending_query"].includes(row.external_state)) { recovered.push(decode(row)); continue; }
        if (row.state === "waiting_external") {
          const result = await tx.query("UPDATE agent_runs SET reconciliation='needs_reconciliation',external_state=$1,revision=revision+1,updated_at=now() WHERE run_id=$2 RETURNING *", [row.external_task_id ? "pending_query" : "unknown", row.run_id]);
          await append(tx, result.rows[0], { type: "state", payload: { state: "waiting_external", reconciliation: "needs_reconciliation", action: row.external_task_id ? "query_existing" : "manual_check" } });
          recovered.push(decode(result.rows[0]));
        } else recovered.push(await change(tx, row, "interrupted", row.revision, row.external_operation_key ? { reconciliation: "needs_reconciliation", externalState: row.external_task_id ? "pending_query" : "unknown" } : {}));
      }
      return recovered;
    });
  }
  async function recoverAllInterrupted() {
    const identities = await db.query("SELECT DISTINCT user_id,tenant_id FROM agent_runs WHERE state IN ('queued','running','cancelling','waiting_external') ORDER BY tenant_id,user_id");
    const recovered = [];
    for (const row of identities.rows) recovered.push(...await recoverInterrupted({ userId: row.user_id, tenantId: row.tenant_id }));
    return recovered;
  }
  return { createRun, getRun, listRuns, eventsAfter, appendEvent, transition, recordExternalIntent, recordExternalTaskId, recoverInterrupted, recoverAllInterrupted };
}
module.exports = { createTaskStore };
