import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const { createTaskStore } = require("../../shell/tasks/store.cjs");

function barrier() {
  let enter, release;
  return {
    entered: new Promise((resolve) => { enter = resolve; }),
    resume: new Promise((resolve) => { release = resolve; }),
    enter: () => enter(),
    release: () => release(),
  };
}

function gatedAdapter(adapter, matches, gate) {
  let used = false;
  return {
    ...adapter,
    transaction: (cb) => adapter.transaction((tx) => cb({
      ...tx,
      query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (!used && matches(sql)) {
          used = true;
          gate.enter();
          await gate.resume;
        }
        return result;
      },
    })),
  };
}

async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  assert.ok(process.env.PT_PG_DSN, "Set PT_PG_DSN to a disposable localhost PostgreSQL database");
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && key !== "PT_PG_DSN" && process.env[key]), false,
    "Do not inherit any other PostgreSQL settings");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-external-lock-order-pg-"));
  let storageA, storageB;
  try {
    storageA = await createStorage({ dataDir: path.join(dir, "unused-a"), masterKeyFile: path.join(dir, "key-a") });
    storageB = await createStorage({ dataDir: path.join(dir, "unused-b"), masterKeyFile: path.join(dir, "key-b") });
    assert.equal(storageA.db.adapter, "pg");
    assert.equal(storageB.db.adapter, "pg");
    const registered = await storageA.repositories.auth.register({ username: `external-lock-${randomUUID()}`, password: "FixturePass123" });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storageA.repositories.conversations.create(identity.userId);
    const runsA = createTaskStore(storageA.adapter);
    const runsB = createTaskStore(storageB.adapter);
    const createRunWithIntent = async (operationKey, knownTask = false, ttlMs = 30_000) => {
      const owner = `parent-${randomUUID()}`;
      let run = (await runsA.createRun(identity, {
        conversationId: conversation.id, idempotencyKey: randomUUID(), policyVersion: "fixture",
        request: { question: "synthetic external work", attachments: [] },
      }, { owner, ttlMs })).run;
      run = await runsA.transition(identity, run.runId, "running", run.revision, owner);
      await runsA.externalOperations.createIntent(identity, run.runId, { operationKey, provider: "fixture", runLeaseOwner: owner });
      if (knownTask) await runsA.externalOperations.recordTaskId(identity, run.runId, operationKey, { taskId: `task-${randomUUID()}`, runLeaseOwner: owner });
      return { runId: run.runId, owner };
    };
    return {
      storageA, storageB, identity, runsA, runsB, createRunWithIntent,
      async close() {
        await Promise.allSettled([storageA.close(), storageB.close()]);
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled([storageA?.close(), storageB?.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test("real PostgreSQL: recordQueryResult and expired-query recovery do not deadlock or duplicate audit", { timeout: 30_000 }, async () => {
  const f = await fixture();
  const recordGate = barrier();
  try {
    const operationKey = "image:query-race";
    const { runId, owner } = await f.createRunWithIntent(operationKey, true);
    await f.runsA.releaseLease(f.identity, runId, owner);
    const claim = await f.runsA.externalOperations.claimQuery(f.identity, runId, operationKey, { owner: "query-worker", ttlMs: 1000 });
    assert.equal(claim.acquired, true);
    await f.storageA.adapter.query("UPDATE run_external_operations SET query_expires_at=now()-interval '1 second' WHERE run_id=$1 AND operation_key=$2", [runId, operationKey]);

    const recordStore = createTaskStore(gatedAdapter(f.storageA.adapter,
      (sql) => sql.startsWith("SELECT * FROM agent_runs") && sql.endsWith(" FOR UPDATE"), recordGate)).externalOperations;
    const record = recordStore.recordQueryResult(f.identity, runId, operationKey, {
      owner: "query-worker", outcome: "succeeded", observedAt: new Date().toISOString(),
    });
    // Observe rejection before any barrier waits so a genuine lease loss is
    // asserted, never emitted as an unhandled rejection during test cleanup.
    const observedRecord = Promise.allSettled([record]);
    await within(recordGate.entered, 3000, "record Run-row lock");
    // Recovery now locks/skips the Run row first. It must skip this in-flight
    // writer, rather than wait for an obsolete operation-row gate.
    const skipped = await within(f.runsB.externalOperations.recoverExpiredQueries({ limit: 10 }), 3000, "recovery skips locked Run");
    assert.equal(skipped.some(operation => operation.runId === runId), false);
    recordGate.release();
    const [recordResult] = await within(observedRecord, 8000, "expired writer lease check");
    assert.equal(recordResult.status, "rejected", "expired query result must lose its lease");
    assert.equal(recordResult.reason.code, "LEASE_LOST");
    const recovered = await within(f.runsB.externalOperations.recoverExpiredQueries({ limit: 10 }), 3000, "recovery after writer releases Run");
    assert.equal(recovered.filter(operation => operation.runId === runId).length, 1);
    assert.equal((await f.runsB.externalOperations.recoverExpiredQueries({ limit: 10 })).some(operation => operation.runId === runId), false);
    const operation = await f.runsA.externalOperations.get(f.identity, runId, operationKey);
    assert.equal(operation.status, "pending_query");
    assert.equal(operation.queryAttempts, 1);
    assert.equal(operation.lastQuery.outcome, "query_claim_recovered");
    const events = (await f.runsA.eventsAfter(f.identity, runId)).events;
    assert.equal(events.filter((event) => event.payload?.operationKey === operationKey && event.payload?.action === "external_operation_query_recovered").length, 1);
  } finally {
    recordGate.release();
    await f.close();
  }
});

test("real PostgreSQL: task-ID record and expired-submission recovery serialize to one audit", { timeout: 30_000 }, async () => {
  const f = await fixture();
  const recordGate = barrier();
  try {
    const operationKey = "image:submission-race";
    const { runId, owner } = await f.createRunWithIntent(operationKey, false, 1000);
    const recordStore = createTaskStore(gatedAdapter(f.storageA.adapter,
      (sql) => sql.startsWith("SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs"), recordGate)).externalOperations;
    const record = recordStore.recordTaskId(f.identity, runId, operationKey, { taskId: "known-task-race", runLeaseOwner: owner });
    await within(recordGate.entered, 3000, "task-ID record Run-row lock");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const recovered = await within(f.runsB.externalOperations.recoverExpiredSubmissions({ limit: 10 }), 3000, "submission recovery skip-locked scan");
    assert.equal(recovered.some((operation) => operation.runId === runId), false,
      "recovery must skip the Run row held by the in-flight task-ID record");
    recordGate.release();
    const recorded = await within(record, 5000, "task-ID persistence");
    assert.equal(recorded.status, "accepted");
    assert.equal(recorded.taskId, "known-task-race");
    assert.equal((await f.runsB.externalOperations.recoverExpiredSubmissions({ limit: 10 })).some((operation) => operation.runId === runId), false);
    const events = (await f.runsA.eventsAfter(f.identity, runId)).events;
    assert.equal(events.filter((event) => event.payload?.operationKey === operationKey && event.payload?.action === "external_operation_task_id").length, 1);
    assert.equal(events.filter((event) => event.payload?.operationKey === operationKey && event.payload?.action === "external_operation_submission_recovered").length, 0);
  } finally {
    recordGate.release();
    await f.close();
  }
});
