"use strict";

const { randomUUID } = require("node:crypto");
const MAX_QUERIES = 8;
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const label = (value, field, max = 256) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || !/^[a-zA-Z0-9_.:-]+$/.test(value)) throw fail("CONTRACT_INVALID", field + " is invalid", 400);
  return value;
};
const timestamp = (value, field) => {
  if (typeof value !== "string" || value.length > 35 || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail("CONTRACT_INVALID", field + " is invalid", 400);
  return value;
};
function decode(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    runId: row.run_id,
    operationKey: row.operation_key,
    provider: row.provider,
    status: row.status,
    taskId: row.task_id,
    queryAttempts: Number(row.query_attempts),
    nextQueryAt: row.next_query_at ? new Date(row.next_query_at).toISOString() : null,
    lastQuery: row.last_query || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// appendRunEvent, when supplied, must append through the caller's existing Run
// event store using this transaction; this module never allocates Run seq values.
function createExternalOperationsStore(db, { appendRunEvent = null } = {}) {
  if (!db || typeof db.query !== "function" || typeof db.transaction !== "function") throw new TypeError("External operations store requires query and transaction");
  if (appendRunEvent !== null && typeof appendRunEvent !== "function") throw new TypeError("appendRunEvent must be a function");

  async function ownedRun(tx, identity, runId, lock = false) {
    if (!identity || typeof identity.userId !== "string" || !identity.userId || typeof identity.tenantId !== "string" || !identity.tenantId) throw fail("CONTRACT_INVALID", "identity is invalid", 400);
    const result = await tx.query("SELECT * FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3" + (lock ? " FOR UPDATE" : ""), [runId, identity.userId, identity.tenantId]);
    if (!result.rows.length) throw fail("NOT_FOUND", "Run not found", 404);
    return result.rows[0];
  }
  async function activeRunLease(tx, runId, owner) {
    const result = await tx.query("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [runId]);
    if (result.rows[0]?.lease_owner !== owner || !result.rows[0]?.active) throw fail("LEASE_LOST", "Run lease is no longer owned or has expired");
  }
  async function runHasActiveLease(tx, run) {
    if (!run.lease_owner) return false;
    const result = await tx.query("SELECT lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1", [run.run_id]);
    return Boolean(result.rows[0]?.active);
  }
  async function operation(tx, identity, runId, operationKey, lock = false) {
    await ownedRun(tx, identity, runId, lock);
    const result = await tx.query("SELECT o.* FROM run_external_operations o JOIN agent_runs r ON r.run_id=o.run_id WHERE o.run_id=$1 AND o.operation_key=$2 AND r.user_id=$3 AND r.tenant_id=$4" + (lock ? " FOR UPDATE OF o" : ""), [runId, operationKey, identity.userId, identity.tenantId]);
    if (!result.rows.length) throw fail("NOT_FOUND", "External operation not found", 404);
    return result.rows[0];
  }
  async function event(tx, identity, runId, operationKey, status, action) {
    if (appendRunEvent) {
      const run = await ownedRun(tx, identity, runId);
      await appendRunEvent({ tx, identity, runId, type: "state", payload: { state: run.state, operationKey, operationStatus: status, action } });
    }
  }
  async function createIntentInTransaction(tx, identity, runId, { operationKey, provider, runLeaseOwner }) {
    label(operationKey, "operationKey", 512); label(provider, "provider", 128); label(runLeaseOwner, "runLeaseOwner");
    if (!tx || typeof tx.query !== "function") throw fail("CONTRACT_INVALID", "A trusted transaction is required", 400);
      const run = await ownedRun(tx, identity, runId, true);
      await activeRunLease(tx, runId, runLeaseOwner);
      if (!["running", "waiting_external"].includes(run.state)) throw fail("INVALID_TRANSITION", "Run cannot start an external operation in its current state");
      const id = randomUUID();
      let result;
      try {
        result = await tx.query("INSERT INTO run_external_operations (operation_id,run_id,operation_key,provider,status) VALUES ($1,$2,$3,$4,'submitting') RETURNING *", [id, runId, operationKey, provider]);
      } catch (error) {
        if (error.code === "23505") throw fail("EXTERNAL_OPERATION_EXISTS", "External operation key already exists for this Run");
        throw error;
      }
      await event(tx, identity, runId, operationKey, "submitting", "external_operation_intent");
      return decode(result.rows[0]);
  }
  async function createIntent(identity, runId, options) {
    return db.transaction(tx => createIntentInTransaction(tx, identity, runId, options));
  }
  async function recordTaskId(identity, runId, operationKey, { taskId, runLeaseOwner }) {
    label(operationKey, "operationKey", 512); label(taskId, "taskId", 512); label(runLeaseOwner, "runLeaseOwner");
    return db.transaction(async (tx) => {
      const run = await ownedRun(tx, identity, runId, true);
      await activeRunLease(tx, runId, runLeaseOwner);
      if (!["running", "waiting_external", "cancelling"].includes(run.state)) throw fail("INVALID_TRANSITION", "Run state cannot accept a late external task ID");
      const row = await operation(tx, identity, runId, operationKey, true);
      if (row.task_id) {
        if (row.task_id === taskId) return decode(row);
        throw fail("EXTERNAL_TASK_ID_CONFLICT", "External operation already has a different task ID");
      }
      if (row.status !== "submitting" && row.status !== "manual_check") throw fail("INVALID_TRANSITION", "External operation cannot accept a task ID in its current state");
      const result = await tx.query("UPDATE run_external_operations SET task_id=$1,status='accepted',next_query_at=now(),updated_at=now() WHERE operation_id=$2 AND task_id IS NULL RETURNING *", [taskId, row.operation_id]);
      await event(tx, identity, runId, operationKey, "accepted", "external_operation_task_id");
      return decode(result.rows[0]);
    });
  }
  async function recordSubmissionResult(identity, runId, operationKey, { outcome, providerStatus = null, reason = null, queried = false, runLeaseOwner, observedAt }) {
    label(operationKey, "operationKey", 512); label(runLeaseOwner, "runLeaseOwner"); timestamp(observedAt, "observedAt");
    if (!["succeeded", "failed", "cancelled"].includes(outcome)) throw fail("CONTRACT_INVALID", "outcome is invalid", 400);
    if (reason !== null) label(reason, "reason", 64);
    if (providerStatus !== null) label(providerStatus, "providerStatus", 64);
    if (typeof queried !== "boolean") throw fail("CONTRACT_INVALID", "queried is invalid", 400);
    return db.transaction(async (tx) => {
      const run = await ownedRun(tx, identity, runId, true);
      await activeRunLease(tx, runId, runLeaseOwner);
      if (!["running", "waiting_external", "cancelling"].includes(run.state)) throw fail("INVALID_TRANSITION", "Run state cannot record a submission result");
      const row = await operation(tx, identity, runId, operationKey, true);
      if (row.status === outcome) return decode(row);
      if (row.task_id ? !["accepted", "querying", "pending_query", "manual_check"].includes(row.status) : row.status !== "submitting") throw fail("INVALID_TRANSITION", "External operation has no unresolved submission result");
      const audit = { outcome, observedAt, providerStatus, reason, queried, attempt: Number(row.query_attempts), source: "host" };
      const result = await tx.query("UPDATE run_external_operations SET status=$1,next_query_at=NULL,last_query=$2::jsonb,query_owner=NULL,query_expires_at=NULL,updated_at=now() WHERE operation_id=$3 RETURNING *", [outcome, JSON.stringify(audit), row.operation_id]);
      await event(tx, identity, runId, operationKey, outcome, "external_operation_result");
      return decode(result.rows[0]);
    });
  }
  async function markUnknownSubmission(identity, runId, operationKey, { reason, runLeaseOwner, observedAt }) {
    label(operationKey, "operationKey", 512); label(runLeaseOwner, "runLeaseOwner"); label(reason, "reason", 64); timestamp(observedAt, "observedAt");
    return db.transaction(async (tx) => {
      const run = await ownedRun(tx, identity, runId, true);
      await activeRunLease(tx, runId, runLeaseOwner);
      if (!["running", "waiting_external", "cancelling"].includes(run.state)) throw fail("INVALID_TRANSITION", "Run state cannot record an unknown submission");
      const row = await operation(tx, identity, runId, operationKey, true);
      if (row.task_id || !["submitting", "manual_check"].includes(row.status)) throw fail("INVALID_TRANSITION", "Operation is not an unknown submission");
      const audit = { outcome: "unknown_submission", observedAt, reason, providerStatus: null, queried: false, attempt: 0 };
      const result = await tx.query("UPDATE run_external_operations SET status='manual_check',next_query_at=NULL,last_query=$1::jsonb,updated_at=now() WHERE operation_id=$2 RETURNING *", [JSON.stringify(audit), row.operation_id]);
      await event(tx, identity, runId, operationKey, "manual_check", "external_operation_unknown");
      return decode(result.rows[0]);
    });
  }
  async function listDue({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail("CONTRACT_INVALID", "limit is invalid", 400);
    const result = await db.query("SELECT o.*,r.user_id,r.tenant_id FROM run_external_operations o JOIN agent_runs r ON r.run_id=o.run_id WHERE o.task_id IS NOT NULL AND o.status IN ('accepted','pending_query') AND o.query_attempts<$2 AND (o.next_query_at IS NULL OR o.next_query_at<=clock_timestamp()) AND (o.query_owner IS NULL OR o.query_expires_at<=clock_timestamp()) AND (r.state IN ('completed','failed','cancelled','interrupted') OR r.lease_owner IS NULL OR r.lease_expires_at IS NULL OR r.lease_expires_at<=clock_timestamp()) ORDER BY COALESCE(o.next_query_at,o.updated_at),o.operation_id LIMIT $1", [limit, MAX_QUERIES]);
    return result.rows.map((row) => ({ identity: { userId: row.user_id, tenantId: row.tenant_id }, operation: decode(row), nextAttempt: Number(row.query_attempts) + 1 }));
  }
  async function claimQuery(identity, runId, operationKey, { owner, ttlMs = 30000 }) {
    label(operationKey, "operationKey", 512); label(owner, "owner");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail("CONTRACT_INVALID", "ttlMs must be 1s to 5m", 400);
    return db.transaction(async (tx) => {
      const run = await ownedRun(tx, identity, runId, true);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.state) && await runHasActiveLease(tx, run)) {
        const held = await operation(tx, identity, runId, operationKey, true);
        return { acquired: false, operation: decode(held) };
      }
      const row = await operation(tx, identity, runId, operationKey, true);
      if (!row.task_id || !["accepted", "pending_query"].includes(row.status) || Number(row.query_attempts) >= MAX_QUERIES) return { acquired: false, operation: decode(row) };
      const result = await tx.query("UPDATE run_external_operations SET status='querying',query_owner=$1,query_expires_at=now()+($2::int * interval '1 millisecond'),query_attempts=query_attempts+1,updated_at=now() WHERE operation_id=$3 AND (next_query_at IS NULL OR next_query_at<=clock_timestamp()) AND (query_owner IS NULL OR query_expires_at<=clock_timestamp()) RETURNING *", [owner, ttlMs, row.operation_id]);
      if (!result.rows.length) return { acquired: false, operation: decode(row) };
      await event(tx, identity, runId, operationKey, "querying", "external_operation_query_claim");
      return { acquired: true, owner, operation: decode(result.rows[0]), attempt: Number(result.rows[0].query_attempts) };
    });
  }
  async function recordQueryResult(identity, runId, operationKey, { owner, outcome, providerStatus = null, reason = null, observedAt, nextQueryAt = null }) {
    label(operationKey, "operationKey", 512); label(owner, "owner"); timestamp(observedAt, "observedAt");
    const validOutcomes = ["provider_pending", "query_temporary_failure", "query_retry_exhausted", "provider_state_unknown", "succeeded", "failed", "cancelled"];
    if (!validOutcomes.includes(outcome)) throw fail("CONTRACT_INVALID", "outcome is invalid", 400);
    if (providerStatus !== null) label(providerStatus, "providerStatus", 64);
    if (reason !== null) label(reason, "reason", 64);
    if (nextQueryAt !== null) timestamp(nextQueryAt, "nextQueryAt");
    return db.transaction(async (tx) => {
      const row = await operation(tx, identity, runId, operationKey, true);
      const lease = await tx.query("SELECT query_owner,query_expires_at>clock_timestamp() AS active FROM run_external_operations WHERE operation_id=$1", [row.operation_id]);
      if (lease.rows[0]?.query_owner !== owner || !lease.rows[0]?.active || row.status !== "querying") throw fail("LEASE_LOST", "External operation query lease is no longer owned or has expired");
      const attempts = Number(row.query_attempts);
      if (outcome === "query_retry_exhausted" && attempts < MAX_QUERIES) throw fail("INVALID_TRANSITION", "Query retry exhaustion requires all bounded attempts");
      const retry = outcome === "provider_pending" || outcome === "query_temporary_failure";
      let status;
      let auditOutcome = outcome;
      if (retry && attempts >= MAX_QUERIES) { status = "manual_check"; auditOutcome = "query_retry_exhausted"; nextQueryAt = null; }
      else if (retry) {
        if (nextQueryAt === null) throw fail("CONTRACT_INVALID", "Retryable query result requires nextQueryAt", 400);
        status = "pending_query";
      } else {
        if (nextQueryAt !== null) throw fail("CONTRACT_INVALID", "Terminal or manual result cannot schedule another query", 400);
        status = outcome === "provider_state_unknown" || outcome === "query_retry_exhausted" ? "manual_check" : outcome;
      }
      const audit = { outcome: auditOutcome, observedAt, providerStatus, reason, attempt: attempts, queried: true };
      const result = await tx.query("UPDATE run_external_operations SET status=$1,next_query_at=$2,last_query=$3::jsonb,query_owner=NULL,query_expires_at=NULL,updated_at=now() WHERE operation_id=$4 RETURNING *", [status, nextQueryAt, JSON.stringify(audit), row.operation_id]);
      await event(tx, identity, runId, operationKey, status, "external_operation_query_result");
      return decode(result.rows[0]);
    });
  }
  async function recoverExpiredQueries({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail("CONTRACT_INVALID", "limit is invalid", 400);
    return db.transaction(async (tx) => {
      // All query paths lock Run before child operation. Locking child first
      // here can deadlock against claimQuery/recordQueryResult on another worker.
      const rows = (await tx.query("SELECT o.*,r.user_id,r.tenant_id FROM run_external_operations o JOIN agent_runs r ON r.run_id=o.run_id WHERE o.status='querying' AND (o.query_owner IS NULL OR o.query_expires_at<=clock_timestamp()) ORDER BY o.updated_at,o.operation_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED", [limit])).rows;
      const recovered = [];
      for (const row of rows) {
        const current = await operation(tx, { userId: row.user_id, tenantId: row.tenant_id }, row.run_id, row.operation_key, true);
        if (current.status !== "querying") continue;
        const exhausted = Number(current.query_attempts) >= MAX_QUERIES;
        const status = exhausted ? "manual_check" : "pending_query";
        const audit = { outcome: exhausted ? "query_retry_exhausted" : "query_claim_recovered", observedAt: new Date().toISOString(), providerStatus: null, reason: "expired_query_lease", attempt: Number(current.query_attempts), queried: true };
        const result = await tx.query("UPDATE run_external_operations SET status=$1,next_query_at=CASE WHEN $2 THEN NULL ELSE now() END,last_query=$3::jsonb,query_owner=NULL,query_expires_at=NULL,updated_at=now() WHERE operation_id=$4 AND status='querying' AND (query_owner IS NULL OR query_expires_at<=clock_timestamp()) RETURNING *", [status, exhausted, JSON.stringify(audit), current.operation_id]);
        if (!result.rows.length) continue;
        await event(tx, { userId: row.user_id, tenantId: row.tenant_id }, row.run_id, row.operation_key, status, "external_operation_query_recovered");
        recovered.push(decode(result.rows[0]));
      }
      return recovered;
    });
  }
  async function recoverExpiredSubmissions({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail("CONTRACT_INVALID", "limit is invalid", 400);
    return db.transaction(async (tx) => {
      const rows = (await tx.query("SELECT o.*,r.user_id,r.tenant_id FROM run_external_operations o JOIN agent_runs r ON r.run_id=o.run_id WHERE o.status='submitting' AND o.task_id IS NULL AND (r.state IN ('completed','failed','cancelled','interrupted') OR r.lease_owner IS NULL OR r.lease_expires_at IS NULL OR r.lease_expires_at<=clock_timestamp()) ORDER BY o.updated_at,o.operation_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED", [limit])).rows;
      const recovered = [];
      for (const row of rows) {
        const current = await operation(tx, { userId: row.user_id, tenantId: row.tenant_id }, row.run_id, row.operation_key, true);
        if (current.status !== "submitting" || current.task_id) continue;
        const audit = { outcome: "unknown_submission", observedAt: new Date().toISOString(), providerStatus: null, reason: "expired_submission_lease", attempt: 0, queried: false };
        const result = await tx.query("UPDATE run_external_operations SET status='manual_check',next_query_at=NULL,last_query=$1::jsonb,updated_at=now() WHERE operation_id=$2 AND status='submitting' AND task_id IS NULL RETURNING *", [JSON.stringify(audit), current.operation_id]);
        if (!result.rows.length) continue;
        await event(tx, { userId: row.user_id, tenantId: row.tenant_id }, row.run_id, row.operation_key, "manual_check", "external_operation_submission_recovered");
        recovered.push(decode(result.rows[0]));
      }
      return recovered;
    });
  }
  async function get(identity, runId, operationKey) {
    label(operationKey, "operationKey", 512);
    return db.transaction(async (tx) => decode(await operation(tx, identity, runId, operationKey)));
  }
  async function hasUnresolved(identity, runId) {
    return db.transaction(async (tx) => {
      await ownedRun(tx, identity, runId, true);
      const result = await tx.query(
        "SELECT EXISTS (SELECT 1 FROM run_external_operations WHERE run_id=$1 AND (status IS NULL OR status NOT IN ('succeeded','failed','cancelled'))) AS unresolved",
        [runId],
      );
      if (result.rows.length !== 1 || typeof result.rows[0].unresolved !== "boolean") throw fail("EXTERNAL_OPERATION_LOOKUP_INVALID", "External operation status could not be confirmed", 503);
      return result.rows[0].unresolved;
    });
  }
  async function list(identity, runId, { limit = 100, afterOperationId = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("CONTRACT_INVALID", "limit must be between 1 and 100", 400);
    if (afterOperationId !== null && (typeof afterOperationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(afterOperationId))) {
      throw fail("CONTRACT_INVALID", "afterOperationId must be a UUID", 400);
    }
    return db.transaction(async (tx) => {
      await ownedRun(tx, identity, runId);
      const result = await tx.query(
        "SELECT * FROM run_external_operations WHERE run_id=$1 AND ($2::uuid IS NULL OR operation_id>$2::uuid) ORDER BY operation_id LIMIT $3",
        [runId, afterOperationId, limit + 1],
      );
      const page = result.rows.slice(0, limit);
      return { operations: page.map(decode), nextCursor: page.length ? page[page.length - 1].operation_id : null, hasMore: result.rows.length > limit };
    });
  }
  async function listRecent(identity, { range = "today", limit = 50, afterOperationId = null } = {}) {
    if (!identity || typeof identity.userId !== "string" || !identity.userId || typeof identity.tenantId !== "string" || !identity.tenantId) throw fail("CONTRACT_INVALID", "identity is invalid", 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("CONTRACT_INVALID", "limit must be between 1 and 100", 400);
    if (afterOperationId !== null && (typeof afterOperationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(afterOperationId))) {
      throw fail("CONTRACT_INVALID", "afterOperationId must be a UUID", 400);
    }
    // Match tool-call usage: ranges are calendar-day windows anchored at the
    // database's current day boundary, rather than rolling 24h/7d/30d windows.
    const interval = ({ today: "0 days", week: "7 days", month: "30 days" })[String(range || "").toLowerCase()];
    if (!interval) throw fail("CONTRACT_INVALID", "range must be today|week|month", 400);
    const result = await db.query(
      `SELECT o.operation_id,o.run_id,o.operation_key,o.provider,o.task_id,o.status,o.query_attempts,o.last_query,o.updated_at
         FROM run_external_operations o
         JOIN agent_runs r ON r.run_id=o.run_id
        WHERE r.user_id=$1 AND r.tenant_id=$2 AND o.updated_at >= date_trunc('day', now()) - $3::interval
          AND ($4::uuid IS NULL OR o.operation_id < $4::uuid)
        ORDER BY o.operation_id DESC LIMIT $5`,
      [identity.userId, identity.tenantId, interval, afterOperationId, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    const operations = page.map((row) => {
      const audit = row.last_query && typeof row.last_query === "object" && !Array.isArray(row.last_query) ? row.last_query : {};
      const observedAt = typeof audit.observedAt === "string" && Number.isFinite(Date.parse(audit.observedAt))
        ? audit.observedAt : null;
      return {
        runId: row.run_id,
        operationKey: row.operation_key,
        provider: row.provider,
        taskId: row.task_id,
        status: row.status,
        queryAttempts: Number(row.query_attempts),
        observedAt,
        cost: null,
        currency: null,
        costCoverage: "unknown",
      };
    });
    return { operations, nextCursor: page.length ? page[page.length - 1].operation_id : null, hasMore: result.rows.length > limit };
  }
  return { createIntent, createIntentInTransaction, recordTaskId, recordSubmissionResult, markUnknownSubmission, listDue, claimQuery, recordQueryResult, recoverExpiredQueries, recoverExpiredSubmissions, get, hasUnresolved, list, listRecent };
}

module.exports = { createExternalOperationsStore, MAX_QUERIES };
