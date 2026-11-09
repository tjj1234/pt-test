"use strict";
const { randomUUID } = require("node:crypto");
const c = require("../contracts/phase1.cjs");
const { createExternalOperationsStore } = require("./external-operations-store.cjs");
const { isReplayableChatRequest, chatRequestIdempotencyView } = require("./chat-request.cjs");
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const MAX_EXTERNAL_QUERIES = 8;
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
    reconciliationAttempts: Number(row.external_query_attempts || 0),
    nextQueryAt: row.external_next_query_at ? stamp(row.external_next_query_at) : null,
    lastQuery: row.external_last_query || null,
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
    if (c.TERMINAL_STATES.includes(next)) await tx.query("UPDATE agent_runs SET lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE run_id=$1", [row.run_id]);
    await append(tx, current, { type: "state", payload: { state: next, reconciliation: current.reconciliation } });
    if (c.TERMINAL_STATES.includes(next)) {
      const completion = patch.donePayload && typeof patch.donePayload === "object" && !Array.isArray(patch.donePayload) ? patch.donePayload : {};
      await append(tx, current, { type: "done", payload: { state: next, ...completion } });
    }
    return decode(current);
  }
  async function aggregateExternalOperations(tx, identity, runId) {
    let row = await owned(tx, identity, runId, true);
    const childResult = await tx.query(
      "SELECT count(*)::int AS count FROM run_external_operations WHERE run_id=$1 AND status NOT IN ('succeeded','failed','cancelled')",
      [runId],
    );
    const childUnresolved = Number(childResult.rows[0]?.count || 0) > 0;
    const legacyUnresolved = Boolean(row.external_operation_key) && row.reconciliation === "needs_reconciliation";
    const targetReconciliation = childUnresolved || legacyUnresolved
      ? "needs_reconciliation"
      : row.external_operation_key && row.reconciliation === "resolved" ? "resolved" : "not_required";
    const targetState = row.state === "running" && childUnresolved
      ? "waiting_external"
      : row.state === "waiting_external" && !childUnresolved && !legacyUnresolved ? "running" : row.state;

    if (targetState !== row.state) {
      await change(tx, row, targetState, row.revision, { reconciliation: targetReconciliation });
      row = await owned(tx, identity, runId, true);
    } else if (targetReconciliation !== row.reconciliation) {
      if (row.revision >= 2147483647) throw fail("REVISION_EXHAUSTED", "Run revision exhausted");
      const updated = await tx.query(
        "UPDATE agent_runs SET reconciliation=$1,revision=revision+1,updated_at=now() WHERE run_id=$2 AND revision=$3 RETURNING *",
        [targetReconciliation, runId, row.revision],
      );
      if (!updated.rows.length) throw fail("REVISION_CONFLICT", "Stale run revision");
      await append(tx, updated.rows[0], { type: "state", payload: { state: row.state, reconciliation: targetReconciliation, action: "aggregate_external_operations" } });
      row = await owned(tx, identity, runId, true);
    }
    return row;
  }
  async function createRun(identity, input, lease = null) {
    c.assertContract("identity", identity);
    c.fingerprint(input);
    const conversationId = boundedText(input.conversationId, "conversationId");
    const workspaceId = workspaceForIdentity(identity);
    boundedText(workspaceId, "workspaceId");
    for (const field of ["tenantId", "userId", "workspaceId"]) if (input[field] !== undefined && input[field] !== ({ ...identity, workspaceId })[field]) throw fail("FORBIDDEN", "Identity override rejected", 403);
    const policyVersion = boundedText(input.policyVersion || "1", "policyVersion");
    const request = input.request;
    let leaseOwner = null, leaseTtlMs = null;
    if (lease !== null) {
      leaseOwner = boundedText(lease.owner, "lease owner", 256);
      leaseTtlMs = lease.ttlMs === undefined ? 30000 : lease.ttlMs;
      if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1000 || leaseTtlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    }
    const claim = c.idempotencyClaim(identity, "create-run", input.idempotencyKey, { conversationId, policyVersion, request: chatRequestIdempotencyView(request, identity.tenantId) });
    return db.transaction(async (tx) => {
      const conversation = await tx.query("SELECT c.id FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND u.tenant_id=$3 FOR SHARE OF c,u", [conversationId, identity.userId, identity.tenantId]);
      if (!conversation.rows.length) throw fail("NOT_FOUND", "Conversation not found", 404);
      const runId = randomUUID();
      const result = await tx.query("INSERT INTO agent_runs (run_id,conversation_id,user_id,tenant_id,workspace_id,contract_version,policy_version,state,idempotency_scope,request_hash,request,lease_owner,lease_expires_at,lease_heartbeat_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10::jsonb,$11,CASE WHEN $11::text IS NULL THEN NULL ELSE now()+($12::int * interval '1 millisecond') END,CASE WHEN $11::text IS NULL THEN NULL ELSE now() END) ON CONFLICT (idempotency_scope) DO NOTHING RETURNING *", [runId, conversationId, identity.userId, identity.tenantId, workspaceId, c.VERSION, policyVersion, claim.scope, claim.requestHash, JSON.stringify(request), leaseOwner, leaseTtlMs]);
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
  async function getRunByIdempotencyKey(identity, key) {
    c.assertContract("identity", identity);
    const claim = c.idempotencyClaim(identity, "create-run", key, {});
    const result = await db.query(
      "SELECT * FROM agent_runs WHERE idempotency_scope=$1 AND user_id=$2 AND tenant_id=$3",
      [claim.scope, identity.userId, identity.tenantId],
    );
    return decode(result.rows[0] || null);
  }
  async function acquireLease(identity, runId, owner, ttlMs = 30000) {
    c.assertContract("identity", identity);
    boundedText(owner, "lease owner", 256);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (!["queued", "running", "cancelling", "waiting_external"].includes(row.state)) return { acquired: false, run: decode(row) };
      const result = await tx.query(
        "UPDATE agent_runs SET lease_owner=$1,lease_expires_at=now()+($2::int * interval '1 millisecond'),lease_heartbeat_at=now(),updated_at=now() WHERE run_id=$3 AND (lease_owner IS NULL OR lease_owner=$1 OR lease_expires_at<=now()) RETURNING lease_expires_at",
        [owner, ttlMs, runId],
      );
      if (!result.rows.length) return { acquired: false, run: decode(row) };
      return { acquired: true, owner, expiresAt: stamp(result.rows[0].lease_expires_at) };
    });
  }
  async function renewLease(identity, runId, owner, ttlMs = 30000) {
    c.assertContract("identity", identity);
    boundedText(owner, "lease owner", 256);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    const result = await db.query(
      "UPDATE agent_runs SET lease_expires_at=now()+($1::int * interval '1 millisecond'),lease_heartbeat_at=now(),updated_at=now() WHERE run_id=$2 AND user_id=$3 AND tenant_id=$4 AND lease_owner=$5 AND lease_expires_at>now() AND state IN ('queued','running','cancelling','waiting_external') RETURNING lease_expires_at",
      [ttlMs, runId, identity.userId, identity.tenantId, owner],
    );
    if (!result.rows.length) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
    return { owner, expiresAt: stamp(result.rows[0].lease_expires_at) };
  }
  async function releaseLease(identity, runId, owner) {
    c.assertContract("identity", identity);
    boundedText(owner, "lease owner", 256);
    const result = await db.query(
      "UPDATE agent_runs SET lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,updated_at=now() WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 AND lease_owner=$4 RETURNING run_id",
      [runId, identity.userId, identity.tenantId, owner],
    );
    return result.rows.length === 1;
  }
  async function acquireConversationLease(identity, runId, owner, ttlMs = 30000) {
    c.assertContract("identity", identity); boundedText(owner, "lease owner", 256);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    return db.transaction(async (tx) => {
      const run = await owned(tx, identity, runId, true);
      if (!["queued", "running", "cancelling", "waiting_external"].includes(run.state)) return false;
      const runLease = await tx.query(
        "SELECT 1 FROM agent_runs WHERE run_id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state IN ('queued','running','cancelling','waiting_external')",
        [runId, owner],
      );
      if (!runLease.rows.length) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
      const result = await tx.query(
        "INSERT INTO agent_conversation_leases (conversation_id,run_id,lease_owner,lease_expires_at,heartbeat_at,updated_at) VALUES ($1,$2,$3,clock_timestamp()+($4::int * interval '1 millisecond'),clock_timestamp(),clock_timestamp()) ON CONFLICT (conversation_id) DO UPDATE SET run_id=EXCLUDED.run_id,lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at,heartbeat_at=EXCLUDED.heartbeat_at,updated_at=EXCLUDED.updated_at WHERE agent_conversation_leases.lease_expires_at<=clock_timestamp() OR (agent_conversation_leases.run_id=EXCLUDED.run_id AND agent_conversation_leases.lease_owner=EXCLUDED.lease_owner) RETURNING run_id",
        [run.conversation_id, runId, owner, ttlMs],
      );
      return result.rows.length === 1;
    });
  }
  async function renewConversationLease(identity, runId, owner, ttlMs = 30000) {
    c.assertContract("identity", identity); boundedText(owner, "lease owner", 256);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    return db.transaction(async (tx) => {
      const run = await owned(tx, identity, runId, true);
      if (!["queued", "running", "cancelling", "waiting_external"].includes(run.state)) throw fail("LEASE_LOST", "Run is no longer active");
      const runLease = await tx.query(
        "SELECT 1 FROM agent_runs WHERE run_id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state IN ('queued','running','cancelling','waiting_external')",
        [runId, owner],
      );
      if (!runLease.rows.length) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
      const result = await tx.query(
        "UPDATE agent_conversation_leases l SET lease_expires_at=clock_timestamp()+($1::int * interval '1 millisecond'),heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE l.run_id=$2 AND l.conversation_id=$3 AND l.lease_owner=$4 AND l.lease_expires_at>clock_timestamp() RETURNING l.conversation_id",
        [ttlMs, runId, run.conversation_id, owner],
      );
      if (!result.rows.length) throw fail("LEASE_LOST", "Conversation execution lease is no longer owned or has expired");
      return true;
    });
  }
  async function releaseConversationLease(identity, runId, owner) {
    c.assertContract("identity", identity); boundedText(owner, "lease owner", 256);
    const result = await db.query(
      "DELETE FROM agent_conversation_leases l USING agent_runs r WHERE l.run_id=r.run_id AND l.run_id=$1 AND r.user_id=$2 AND r.tenant_id=$3 AND l.lease_owner=$4 RETURNING l.run_id",
      [runId, identity.userId, identity.tenantId, owner],
    );
    return result.rows.length === 1;
  }
  async function saveConversationMessages(identity, runId, owner, conversationId, messages) {
    c.assertContract("identity", identity); boundedText(owner, "lease owner", 256); boundedText(conversationId, "conversationId");
    c.fingerprint(messages);
    const list = Array.isArray(messages) ? messages : [];
    return db.transaction(async (tx) => {
      const run = await owned(tx, identity, runId, true);
      if (run.conversation_id !== conversationId) throw fail("CONVERSATION_SCOPE_MISMATCH", "Run does not own this conversation", 403);
      const runLease = await tx.query("SELECT 1 FROM agent_runs WHERE run_id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state IN ('running','cancelling','waiting_external')", [runId, owner]);
      if (!runLease.rows.length) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
      const conversationLease = await tx.query("SELECT 1 FROM agent_conversation_leases WHERE run_id=$1 AND conversation_id=$2 AND lease_owner=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE", [runId, conversationId, owner]);
      if (!conversationLease.rows.length) throw fail("LEASE_LOST", "Conversation execution lease is no longer owned or has expired");
      const current = await tx.query("SELECT title FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", [conversationId, identity.userId]);
      if (!current.rows.length) throw fail("NOT_FOUND", "Conversation not found", 404);
      let title = current.rows[0].title == null ? "" : String(current.rows[0].title);
      if (title.replace(/\s+/g, " ").trim() === "" || title.replace(/\s+/g, " ").trim() === "新对话") {
        const firstUser = list.find((message) => message && message.role === "user" && message.text);
        title = firstUser ? String(firstUser.text).replace(/\s+/g, " ").trim().slice(0, 15) : "新对话";
      }
      await tx.query("UPDATE conversations SET messages=$1::jsonb,title=$2,updated_at=now() WHERE id=$3 AND user_id=$4", [JSON.stringify(list), title, conversationId, identity.userId]);
      return { ok: true, title };
    });
  }
  async function listRuns(identity, { afterRunId = null, limit = 100 } = {}) {
    c.assertContract("identity", identity);
    pageOptions(0, limit);
    let afterCreatedAt = null;
    if (afterRunId) {
      const cursorRow = await db.query("SELECT created_at FROM agent_runs WHERE run_id=$1", [afterRunId]);
      if (cursorRow.rows.length) afterCreatedAt = cursorRow.rows[0].created_at;
    }
    const result = afterCreatedAt
      ? await db.query(
          "SELECT * FROM agent_runs WHERE user_id=$1 AND tenant_id=$2 AND (created_at < $3 OR (created_at = $3 AND run_id < $4::uuid)) ORDER BY created_at DESC, run_id DESC LIMIT $5",
          [identity.userId, identity.tenantId, afterCreatedAt, afterRunId, limit + 1]
        )
      : await db.query(
          "SELECT * FROM agent_runs WHERE user_id=$1 AND tenant_id=$2 AND ($3::uuid IS NULL OR run_id < $3::uuid) ORDER BY created_at DESC, run_id DESC LIMIT $4",
          [identity.userId, identity.tenantId, afterRunId, limit + 1]
        );
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
    try { return await db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (event?.leaseOwner !== undefined) {
        const owner = boundedText(event.leaseOwner, "lease owner", 256);
        const lease = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
        if (lease.rows[0]?.lease_owner !== owner || !lease.rows[0]?.active) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
      }
      const { leaseOwner: _leaseOwner, ...spec } = event || {};
      return append(tx, row, spec);
    }); }
    catch (error) { if (error.code === "23505") throw fail("EVENT_ID_CONFLICT", "Event ID already exists"); throw error; }
  }
  async function reserveModelRequest(identity, runId, owner, payload) {
    c.assertContract("identity",identity); boundedText(owner,"lease owner",256);
    c.fingerprint(payload);
    const purpose=payload?.purpose || 'chat';
    if(payload?.action!=='model_request_intent' || !['chat','compaction'].includes(purpose) ||
       !Number.isSafeInteger(payload.turn) || payload.turn<0 || !Number.isSafeInteger(payload.step) || payload.step<0 ||
       typeof payload.attemptId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(payload.attemptId) ||
       typeof payload.selectedModel!=='string' || !payload.selectedModel.trim() || payload.selectedModel.length>256 || typeof payload.provider!=='string' || !payload.provider.trim() || payload.provider.length>256)throw fail('MODEL_INTENT_INVALID','Invalid model request intent');
    return db.transaction(async tx=>{
      const row=await owned(tx,identity,runId,true);
      const lease=await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1",[runId]);
      if(row.state!=='running' || lease.rows[0]?.lease_owner!==owner || !lease.rows[0]?.active)throw fail('LEASE_LOST','Model request Run is no longer active');
      const unresolved=await tx.query("SELECT 1 FROM model_request_attempts WHERE run_id=$1 AND lease_owner<>$2 LIMIT 1",[runId,owner]);
      if(unresolved.rows.length)throw fail('MODEL_ATTEMPT_RECOVERY_REQUIRED','A previous worker may have submitted; automatic recovery denied');
      const prior=await tx.query("SELECT attempt_id FROM model_request_attempts WHERE run_id=$1 AND ((purpose=$2 AND turn=$3 AND step=$4) OR attempt_id=$5)",[runId,purpose,payload.turn,payload.step,payload.attemptId]);
      // Never re-authorize an attempt after a lost RPC acknowledgement or process restart.
      if(prior.rows.length)throw fail('MODEL_ATTEMPT_ALREADY_RESERVED','Prior submission may have started; automatic resubmission denied');
      const total=await tx.query('SELECT count(*)::int AS count FROM model_request_attempts WHERE run_id=$1',[runId]);
      if(total.rows[0].count>=100)throw fail('MODEL_INTENT_LIMIT','Run request limit reached');
      const record={...payload,submission:'reserved_submission_unknown'};
      await tx.query("INSERT INTO model_request_attempts(run_id,purpose,turn,step,attempt_id,signature,lease_owner,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[runId,purpose,payload.turn,payload.step,payload.attemptId,c.fingerprint({purpose,turn:payload.turn,step:payload.step,model:payload.selectedModel,provider:payload.provider,parameters:payload.parameters}),owner,JSON.stringify(record)]);
      await append(tx,row,{type:'state',payload:record,attemptId:payload.attemptId});
      return {recorded:true};
    });
  }
  async function transition(identity, runId, next, expectedRevision, leaseOwner = null, options = {}) {
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (leaseOwner !== null) {
        boundedText(leaseOwner, "lease owner", 256);
        const lease = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
        if (lease.rows[0]?.lease_owner !== leaseOwner || !lease.rows[0]?.active) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
      }
      return change(tx, row, next, expectedRevision, options);
    });
  }
  async function recordExternalIntent(identity, runId, { provider, operationKey, expectedRevision, leaseOwner }) {
    boundedText(provider, "provider"); boundedText(operationKey, "operationKey"); boundedText(leaseOwner, "lease owner", 256);
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      const lease = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
      if (lease.rows[0]?.lease_owner !== leaseOwner || !lease.rows[0]?.active) throw fail("LEASE_LOST", "External submission lease is no longer owned or has expired");
      if (row.external_operation_key) throw fail("EXTERNAL_INTENT_EXISTS", "External submission intent already exists");
      if (row.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "Stale run revision");
      if (row.state !== "running") throw fail("INVALID_TRANSITION", "Cannot start a paid operation unless the Run is running");
      return change(tx, row, "waiting_external", expectedRevision, { externalProvider: provider, externalOperationKey: operationKey, externalState: "submitting", reconciliation: "needs_reconciliation" });
    });
  }
  async function recordExternalTaskId(identity, runId, { taskId, expectedRevision, leaseOwner }) {
    boundedText(taskId, "taskId");
    boundedText(leaseOwner, "lease owner", 256);
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      const lease = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
      if (lease.rows[0]?.lease_owner !== leaseOwner || !lease.rows[0]?.active) throw fail("LEASE_LOST", "External task ID lease is no longer owned or has expired");
      if (row.external_task_id === taskId && row.external_operation_key) return decode(row);
      if (row.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "Stale run revision");
      if (!["waiting_external", "cancelling"].includes(row.state) || !row.external_operation_key || row.external_task_id) throw fail("INVALID_TRANSITION", "No unconfirmed external submission");
      const result = await tx.query("UPDATE agent_runs SET external_task_id=$1,external_state='accepted',reconciliation='needs_reconciliation',external_next_query_at=now(),revision=revision+1,updated_at=now() WHERE run_id=$2 AND revision=$3 RETURNING *", [taskId, runId, expectedRevision]);
      await append(tx, result.rows[0], { type: "state", payload: { state: row.state, externalState: "accepted", reconciliation: "needs_reconciliation" } });
      return decode(result.rows[0]);
    });
  }
  async function recordExternalSubmissionResult(identity, runId, { expectedRevision, leaseOwner, outcome, providerStatus = null, reason = null, observedAt }) {
    boundedText(leaseOwner, "lease owner", 256);
    if (!["succeeded", "failed", "cancelled"].includes(outcome)) throw fail("CONTRACT_INVALID", "Unsupported inline external outcome", 400);
    if (typeof observedAt !== "string" || observedAt.length > 35 || !/^\d{4}-\d\d-\d\dT.*Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) throw fail("CONTRACT_INVALID", "Invalid reconciliation timestamp", 400);
    if (providerStatus !== null && (typeof providerStatus !== "string" || providerStatus.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(providerStatus))) throw fail("CONTRACT_INVALID", "providerStatus is invalid", 400);
    if (reason !== null && (typeof reason !== "string" || reason.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(reason))) throw fail("CONTRACT_INVALID", "reason is invalid", 400);
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      const lease = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
      if (lease.rows[0]?.lease_owner !== leaseOwner || !lease.rows[0]?.active) throw fail("LEASE_LOST", "External result lease is no longer owned or has expired");
      if (!row.external_operation_key || row.reconciliation !== "needs_reconciliation") {
        if (row.external_operation_key && row.reconciliation === "resolved" && row.external_state === outcome) return decode(row);
        throw fail("INVALID_TRANSITION", "Run has no unresolved external operation");
      }
      if (!["waiting_external", "cancelling"].includes(row.state)) throw fail("INVALID_TRANSITION", "Run state cannot record an external result");
      if (row.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "Stale run revision");
      const audit = { outcome, observedAt, providerStatus, reason, attempt: Number(row.external_query_attempts || 0), source: "submission_worker" };
      const result = await tx.query("UPDATE agent_runs SET reconciliation='resolved',external_state=$1,external_next_query_at=NULL,external_last_query=$2::jsonb,revision=revision+1,updated_at=now() WHERE run_id=$3 AND revision=$4 RETURNING *", [outcome, JSON.stringify(audit), runId, expectedRevision]);
      if (!result.rows.length) throw fail("REVISION_CONFLICT", "Stale run revision");
      const aggregate = await aggregateExternalOperations(tx, identity, runId);
      await append(tx, aggregate, { type: "state", payload: { state: aggregate.state, reconciliation: aggregate.reconciliation, externalState: outcome, attempt: audit.attempt } });
      return decode(aggregate);
    });
  }
  async function listDueExternalReconciliations({ limit = 100 } = {}) {
    pageOptions(0, limit);
    const result = await db.query(
      "SELECT * FROM agent_runs WHERE reconciliation='needs_reconciliation' AND external_task_id IS NOT NULL AND external_state IN ('accepted','pending_query') AND external_query_attempts<$2 AND (external_next_query_at IS NULL OR external_next_query_at<=clock_timestamp()) AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY COALESCE(external_next_query_at,updated_at),run_id LIMIT $1",
      [limit, MAX_EXTERNAL_QUERIES],
    );
    return result.rows.map((row) => ({ identity: { userId: row.user_id, tenantId: row.tenant_id }, run: decode(row), nextAttempt: Number(row.external_query_attempts || 0) + 1 }));
  }
  async function claimExternalReconciliation(identity, runId, owner, ttlMs = 30000) {
    c.assertContract("identity", identity); boundedText(owner, "lease owner", 256);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (row.reconciliation !== "needs_reconciliation" || !row.external_task_id || !["accepted", "pending_query"].includes(row.external_state) || Number(row.external_query_attempts || 0) >= MAX_EXTERNAL_QUERIES) return { acquired: false, run: decode(row) };
      const result = await tx.query("UPDATE agent_runs SET lease_owner=$1,lease_expires_at=now()+($2::int * interval '1 millisecond'),lease_heartbeat_at=now(),external_state='querying',external_query_attempts=external_query_attempts+1,revision=revision+1,updated_at=now() WHERE run_id=$3 AND revision=$4 AND (external_next_query_at IS NULL OR external_next_query_at<=clock_timestamp()) AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *", [owner, ttlMs, runId, row.revision]);
      if (!result.rows.length) return { acquired: false, run: decode(row) };
      await append(tx, result.rows[0], { type: "state", payload: { state: row.state, externalState: "querying", reconciliation: "needs_reconciliation", attempt: Number(result.rows[0].external_query_attempts) } });
      return { acquired: true, owner, run: decode(result.rows[0]), attempt: Number(result.rows[0].external_query_attempts) };
    });
  }
  async function recordExternalReconciliation(identity, runId, { expectedRevision, leaseOwner, outcome, providerStatus = null, reason = null, observedAt, nextQueryAt = null, preserveLease = false }) {
    boundedText(leaseOwner, "lease owner", 256);
    if (typeof preserveLease !== "boolean" || (preserveLease && outcome !== "unknown_submission")) throw fail("CONTRACT_INVALID", "Only the submitting worker may preserve its lease for an unknown submission", 400);
    const outcomes = new Set(["provider_pending", "query_temporary_failure", "query_retry_exhausted", "provider_state_unknown", "unknown_submission", "succeeded", "failed", "cancelled"]);
    if (!outcomes.has(outcome)) throw fail("CONTRACT_INVALID", "Unsupported reconciliation outcome", 400);
    if (typeof observedAt !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(observedAt) || observedAt.length > 35 || !Number.isFinite(Date.parse(observedAt))) throw fail("CONTRACT_INVALID", "Invalid reconciliation timestamp", 400);
    const cleanLabel = (value, field) => {
      if (value === null) return null;
      if (typeof value !== "string" || value.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(value)) throw fail("CONTRACT_INVALID", field + " is invalid", 400);
      return value;
    };
    providerStatus = cleanLabel(providerStatus, "providerStatus");
    reason = cleanLabel(reason, "reason");
    if (nextQueryAt !== null && (typeof nextQueryAt !== "string" || nextQueryAt.length > 35 || !/^\d{4}-\d\d-\d\dT.*Z$/.test(nextQueryAt) || !Number.isFinite(Date.parse(nextQueryAt)))) throw fail("CONTRACT_INVALID", "Invalid next query timestamp", 400);
    return db.transaction(async (tx) => {
      const row = await owned(tx, identity, runId, true);
      if (row.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "Stale run revision");
      const lease = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
      if (lease.rows[0]?.lease_owner !== leaseOwner || !lease.rows[0]?.active) throw fail("LEASE_LOST", "Reconciliation lease is no longer owned or has expired");
      if (!row.external_operation_key || row.reconciliation !== "needs_reconciliation") throw fail("INVALID_TRANSITION", "Run is not awaiting external reconciliation");
      const queried = Boolean(row.external_task_id);
      if (queried && ["unknown_submission"].includes(outcome)) throw fail("INVALID_TRANSITION", "Known provider task cannot be marked as unknown submission");
      if (!queried && outcome !== "unknown_submission") throw fail("INVALID_TRANSITION", "A missing provider task ID can only be recorded as unknown submission");
      if (!queried && !["waiting_external", "cancelling"].includes(row.state)) throw fail("INVALID_TRANSITION", "Unknown submission can only be recorded while external work is unresolved");
      if (!queried && !["submitting", "unknown"].includes(row.external_state)) throw fail("INVALID_TRANSITION", "Unknown submission is not awaiting manual review");
      const pending = outcome === "provider_pending" || outcome === "query_temporary_failure";
      const attempts = Number(row.external_query_attempts || 0);
      if (queried && row.external_state !== "querying") throw fail("INVALID_TRANSITION", "External query must be claimed before recording its result");
      if (!queried && attempts !== 0) throw fail("INVALID_TRANSITION", "Unknown submission cannot have provider query attempts");
      if (!queried && providerStatus !== null) throw fail("CONTRACT_INVALID", "Unknown submission cannot include an unqueried provider status", 400);
      if (pending && attempts >= MAX_EXTERNAL_QUERIES) throw fail("RETRY_EXHAUSTED", "External query limit reached; manual review required");
      if (pending && nextQueryAt === null) throw fail("CONTRACT_INVALID", "Pending query requires nextQueryAt", 400);
      if (!pending && nextQueryAt !== null) throw fail("CONTRACT_INVALID", "Terminal/manual outcome cannot schedule another query", 400);
      const reconciliation = ["succeeded", "failed", "cancelled"].includes(outcome) ? "resolved" : "needs_reconciliation";
      const externalState = outcome === "provider_pending" || outcome === "query_temporary_failure" ? "pending_query"
        : outcome === "succeeded" || outcome === "failed" || outcome === "cancelled" ? outcome
          : "manual_check";
      const audit = { outcome, observedAt, providerStatus, reason, attempt: attempts, queried };
      c.fingerprint(audit);
      const result = await tx.query(
        "UPDATE agent_runs SET reconciliation=$1,external_state=$2,external_query_attempts=$3,external_next_query_at=$4,external_last_query=$5::jsonb,lease_owner=CASE WHEN $8 THEN lease_owner ELSE NULL END,lease_expires_at=CASE WHEN $8 THEN lease_expires_at ELSE NULL END,lease_heartbeat_at=CASE WHEN $8 THEN lease_heartbeat_at ELSE NULL END,revision=revision+1,updated_at=now() WHERE run_id=$6 AND revision=$7 RETURNING *",
        [reconciliation, externalState, attempts, nextQueryAt, JSON.stringify(audit), runId, expectedRevision, preserveLease],
      );
      if (!result.rows.length) throw fail("REVISION_CONFLICT", "Stale run revision");
      const aggregate = await aggregateExternalOperations(tx, identity, runId);
      await append(tx, aggregate, { type: "state", payload: { state: aggregate.state, reconciliation: aggregate.reconciliation, externalState, attempt: attempts } });
      return decode(aggregate);
    });
  }
  async function recoverExpiredExternalReconciliationClaims({ limit = 100 } = {}) {
    pageOptions(0, limit);
    return db.transaction(async (tx) => {
      const rows = (await tx.query(
        "SELECT * FROM agent_runs WHERE reconciliation='needs_reconciliation' AND (\n" +
        "  (external_task_id IS NOT NULL AND external_state='querying' AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp())) OR\n" +
        "  (external_operation_key IS NOT NULL AND external_task_id IS NULL AND external_state IN ('submitting','unknown') AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) AND state IN ('waiting_external','cancelling','completed','failed','cancelled','interrupted'))\n" +
        ") ORDER BY updated_at,run_id LIMIT $1 FOR UPDATE SKIP LOCKED",
        [limit],
      )).rows;
      const recovered = [];
      for (const row of rows) {
        if (!row.external_task_id) {
          const result = await tx.query(
            "UPDATE agent_runs SET external_state='manual_check',external_next_query_at=NULL,external_last_query=jsonb_build_object('outcome','unknown_submission','observedAt',clock_timestamp()::text,'providerStatus',NULL,'reason','recovered_expired_submission_lease','attempt',0,'queried',false),revision=revision+1,updated_at=now() WHERE run_id=$1 AND revision=$2 AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *",
            [row.run_id, row.revision],
          );
          if (!result.rows.length) continue;
          await append(tx, result.rows[0], { type: "state", payload: { state: row.state, reconciliation: "needs_reconciliation", externalState: "manual_check", action: "recover_unknown_submission", queried: false } });
          recovered.push(decode(result.rows[0]));
          continue;
        }
        const result = await tx.query(
          "UPDATE agent_runs SET lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,external_state=CASE WHEN external_query_attempts >= $2 THEN 'manual_check' ELSE 'pending_query' END,external_next_query_at=CASE WHEN external_query_attempts >= $2 THEN NULL ELSE now() END,revision=revision+1,updated_at=now() WHERE run_id=$1 AND revision=$3 RETURNING *",
          [row.run_id, MAX_EXTERNAL_QUERIES, row.revision],
        );
        if (!result.rows.length) continue;
        await append(tx, result.rows[0], { type: "state", payload: { state: row.state, externalState: result.rows[0].external_state, reconciliation: "needs_reconciliation", action: "recover_external_query", attempt: Number(row.external_query_attempts || 0) } });
        recovered.push(decode(result.rows[0]));
      }
      return recovered;
    });
  }
  // Invoke only after the worker owner is known dead (startup/expired lease), never as a live-task poll.
  async function recoverInterrupted(identity, onlyUnleasedOrExpired = false, selectedRunIds = null) {
    c.assertContract("identity", identity);
    if (selectedRunIds !== null && (!Array.isArray(selectedRunIds) || selectedRunIds.some((id) => typeof id !== "string"))) throw fail("CONTRACT_INVALID", "Selected recovery Run IDs are invalid", 400);
    return db.transaction(async (tx) => {
      const rows = (await tx.query("SELECT * FROM agent_runs WHERE user_id=$1 AND tenant_id=$2 AND (state IN ('queued','running','cancelling','waiting_external') OR (state IN ('completed','failed','cancelled','interrupted') AND reconciliation='needs_reconciliation' AND external_state='querying')) AND ($3::boolean=false OR lease_owner IS NULL OR lease_expires_at<=clock_timestamp()) AND ($4::uuid[] IS NULL OR run_id=ANY($4::uuid[])) ORDER BY run_id FOR UPDATE", [identity.userId, identity.tenantId, onlyUnleasedOrExpired, selectedRunIds])).rows;
      const recovered = [];
      for (const row of rows) {
        // Supported durable chat commands stay queued until an executor atomically
        // claims them. Invalid/legacy work is made terminal with a replay-safe error.
        if (row.state === "queued") {
          const replayable = isReplayableChatRequest(row.request, row.tenant_id);
          if (replayable && !row.external_operation_key && !row.external_task_id && row.reconciliation === "not_required") {
            const child = await tx.query("SELECT 1 FROM run_external_operations WHERE run_id=$1 LIMIT 1", [row.run_id]);
            if (!child.rows.length) continue;
          }
          const hasExternalWork = Boolean(row.external_operation_key || row.external_task_id) || (await tx.query("SELECT 1 FROM run_external_operations WHERE run_id=$1 LIMIT 1", [row.run_id])).rows.length > 0;
          recovered.push(await change(tx, row, "interrupted", row.revision, {
            ...(row.external_operation_key || row.external_task_id ? { reconciliation: "needs_reconciliation", externalState: row.external_task_id ? "pending_query" : "unknown" } : {}),
            donePayload: replayable || hasExternalWork
              ? { errorCode: "RUN_EXTERNAL_OPERATION_REQUIRES_RECONCILIATION", message: "Queued work with an external operation was not replayed." }
              : { errorCode: "RUN_REQUEST_NOT_REPLAYABLE", message: "Stored queued request failed replay validation." },
          }));
          continue;
        }
        if (row.state === "waiting_external" && (row.reconciliation === "resolved" || row.external_state === "manual_check")) {
          // Terminal provider evidence and explicit human-review outcomes must survive restart recovery.
          await tx.query("UPDATE agent_runs SET lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE run_id=$1 AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)", [row.run_id]);
          const refreshed = (await tx.query("SELECT * FROM agent_runs WHERE run_id=$1", [row.run_id])).rows[0];
          recovered.push(decode(refreshed));
          continue;
        }
        if (row.reconciliation === "needs_reconciliation" && row.external_state === "querying") {
          const result = await tx.query("UPDATE agent_runs SET lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,external_state=CASE WHEN external_query_attempts >= $2 THEN 'manual_check' ELSE 'pending_query' END,external_next_query_at=CASE WHEN external_query_attempts >= $2 THEN NULL ELSE now() END,revision=revision+1,updated_at=now() WHERE run_id=$1 RETURNING *", [row.run_id, MAX_EXTERNAL_QUERIES]);
          await append(tx, result.rows[0], { type: "state", payload: { state: row.state, externalState: result.rows[0].external_state, reconciliation: "needs_reconciliation", action: "recover_external_query", attempt: Number(row.external_query_attempts || 0) } });
          const refreshed = result.rows[0];
          recovered.push(decode(refreshed));
          continue;
        }
        if (row.state === "waiting_external") {
          const result = await tx.query("UPDATE agent_runs SET reconciliation='needs_reconciliation',external_state=$1,external_next_query_at=CASE WHEN external_task_id IS NULL THEN NULL ELSE now() END,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,updated_at=now() WHERE run_id=$2 RETURNING *", [row.external_task_id ? "pending_query" : "unknown", row.run_id]);
          await append(tx, result.rows[0], { type: "state", payload: { state: "waiting_external", reconciliation: "needs_reconciliation", action: row.external_task_id ? "query_existing" : "manual_check" } });
          recovered.push(decode(result.rows[0]));
        } else recovered.push(await change(tx, row, "interrupted", row.revision, row.external_operation_key ? { reconciliation: "needs_reconciliation", externalState: row.external_task_id ? "pending_query" : "unknown" } : {}));
      }
      return recovered;
    });
  }
  async function recoverExpiredLeases({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail("CONTRACT_INVALID", "Recovery batch limit must be 1 to 100", 400);
    const candidates = await db.query(
      "SELECT run_id,user_id,tenant_id FROM agent_runs WHERE (state IN ('queued','running','cancelling','waiting_external') OR (state IN ('completed','failed','cancelled','interrupted') AND reconciliation='needs_reconciliation' AND external_state='querying')) AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END,lease_expires_at NULLS FIRST,run_id LIMIT $1",
      [limit],
    );
    const byIdentity = new Map();
    for (const row of candidates.rows) {
      const key = row.user_id + "\0" + row.tenant_id;
      let group = byIdentity.get(key);
      if (!group) byIdentity.set(key, group = { identity: { userId: row.user_id, tenantId: row.tenant_id }, runIds: [] });
      group.runIds.push(row.run_id);
    }
    const recovered = [];
    for (const { identity, runIds } of byIdentity.values()) recovered.push(...await recoverInterrupted(identity, true, runIds));
    return recovered;
  }
  async function claimReplayableQueuedRuns(owner, { limit = 8, ttlMs = 30000 } = {}) {
    boundedText(owner, "lease owner", 256);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail("CONTRACT_INVALID", "Claim limit must be 1 to 100", 400);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "Lease duration must be 1s to 5m", 400);
    const candidateScanBudget = Math.min(100, Math.max(limit, limit * 4));
    return db.transaction(async (tx) => {
      const candidates = await tx.query(
        "SELECT * FROM agent_runs r WHERE r.state='queued' AND r.request->>'kind'='northstar.chat' AND r.request->>'schemaVersion' IN ('1','2','3','4') AND r.external_operation_key IS NULL AND r.external_task_id IS NULL AND r.reconciliation='not_required' AND (r.lease_owner IS NULL OR r.lease_expires_at IS NULL OR r.lease_expires_at<=clock_timestamp()) AND NOT EXISTS (SELECT 1 FROM run_external_operations eo WHERE eo.run_id=r.run_id) ORDER BY r.created_at,r.run_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED",
        [candidateScanBudget],
      );
      const claimed = [];
      for (const row of candidates.rows) {
        if (claimed.length >= limit) break;
        if (!isReplayableChatRequest(row.request, row.tenant_id)) {
          await change(tx, row, "interrupted", row.revision, {
            donePayload: {
              errorCode: "RUN_REQUEST_NOT_REPLAYABLE",
              message: "Stored queued request failed replay validation.",
            },
          });
          continue;
        }
        const result = await tx.query(
          "UPDATE agent_runs SET lease_owner=$1,lease_expires_at=clock_timestamp()+($2::int * interval '1 millisecond'),lease_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE run_id=$3 AND state='queued' AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *",
          [owner, ttlMs, row.run_id],
        );
        if (!result.rows.length) continue;
        const current = result.rows[0];
        claimed.push({ identity: { userId: current.user_id, tenantId: current.tenant_id }, run: decode(current), request: current.request });
      }
      return claimed;
    });
  }
  async function recoverAllInterrupted() {
    const identities = await db.query("SELECT DISTINCT user_id,tenant_id FROM agent_runs WHERE state IN ('queued','running','cancelling','waiting_external') ORDER BY tenant_id,user_id");
    const recovered = [];
    for (const row of identities.rows) recovered.push(...await recoverInterrupted({ userId: row.user_id, tenantId: row.tenant_id }));
    return recovered;
  }
  const externalOperations = createExternalOperationsStore(db, {
    appendRunEvent: async ({ tx, identity, runId, type, payload }) => {
      const row = await aggregateExternalOperations(tx, identity, runId);
      await append(tx, row, { type, payload: { ...payload, state: row.state, reconciliation: row.reconciliation } });
    },
  });
  return { reserveModelRequest, createRun, getRun, getRunByIdempotencyKey, listRuns, eventsAfter, appendEvent, transition, acquireLease, renewLease, releaseLease, acquireConversationLease, renewConversationLease, releaseConversationLease, saveConversationMessages, recordExternalIntent, recordExternalTaskId, recordExternalSubmissionResult, listDueExternalReconciliations, claimExternalReconciliation, recordExternalReconciliation, recoverExpiredExternalReconciliationClaims, recoverInterrupted, recoverAllInterrupted, recoverExpiredLeases, claimReplayableQueuedRuns, externalOperations };
}
module.exports = { createTaskStore };
