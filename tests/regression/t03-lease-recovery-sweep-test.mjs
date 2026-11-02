import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const { createTaskStore } = require("../../shell/tasks/store.cjs");
const { createLeaseRecoverySweep } = require("../../shell/tasks/lease-recovery-sweep.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("periodic lease sweep skips a live lease, then interrupts it after expiry without replay", { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t03-lease-sweep-"));
  let storage, sweep;
  try {
    storage = await createStorage({ dataDir: path.join(dir, "db"), masterKeyFile: path.join(dir, "key") });
    const registered = await storage.repositories.auth.register({ username: "lease-sweep-" + Date.now(), password: "FixturePass123" });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter);
    let run = (await store.createRun(identity, { conversationId: conversation.id, idempotencyKey: "accepted-before-restart", request: { kind: "fixture.non-replayable" } }, { owner: "dead-process", ttlMs: 30000 })).run;
    run = await store.transition(identity, run.runId, "running", run.revision, "dead-process");
    await storage.adapter.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()+interval '1300 milliseconds' WHERE run_id=$1", [run.runId]);
    const first = await store.recoverExpiredLeases({ limit: 100 });
    assert.equal(first.some((item) => item.runId === run.runId), false, "initial scan leaves live lease untouched");
    assert.equal((await store.getRun(identity, run.runId)).state, "running");
    sweep = createLeaseRecoverySweep({ store, intervalMs: 1000 });
    sweep.start();
    for (let i = 0; i < 50 && (await store.getRun(identity, run.runId)).state !== "interrupted"; i++) await delay(100);
    assert.equal((await store.getRun(identity, run.runId)).state, "interrupted", "periodic scan finalizes expired lease");
    const events = (await store.eventsAfter(identity, run.runId)).events;
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.at(-1)?.payload?.state, "interrupted");
    assert.equal(events.filter((event) => event.type === "queued").length, 1, "recovery does not create a replacement Run");
  } finally {
    await sweep?.stop();
    await storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expired Run recovery honors its per-batch limit and advances on the next sweep", { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t03-lease-batch-"));
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(dir, "db"), masterKeyFile: path.join(dir, "key") });
    const registered = await storage.repositories.auth.register({ username: "lease-batch-" + Date.now(), password: "FixturePass123" });
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const store = createTaskStore(storage.adapter), runs = [];
    for (let i = 0; i < 3; i++) {
      let run = (await store.createRun(identity, { conversationId: conversation.id, idempotencyKey: "expired-" + i, request: {} }, { owner: "dead-worker", ttlMs: 30000 })).run;
      run = await store.transition(identity, run.runId, "running", run.revision, "dead-worker");
      runs.push(run);
    }
    await storage.adapter.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=ANY($1::uuid[])", [runs.map((run) => run.runId)]);
    const first = await store.recoverExpiredLeases({ limit: 2 });
    assert.equal(first.length, 2);
    assert.equal((await Promise.all(runs.map((run) => store.getRun(identity, run.runId)))).filter((run) => run.state === "running").length, 1);
    const second = await store.recoverExpiredLeases({ limit: 2 });
    assert.equal(second.length, 1);
    assert.equal((await Promise.all(runs.map((run) => store.getRun(identity, run.runId)))).filter((run) => run.state === "interrupted").length, 3);
    await assert.rejects(store.recoverExpiredLeases({ limit: 101 }), { code: "CONTRACT_INVALID" });
  } finally {
    await storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
