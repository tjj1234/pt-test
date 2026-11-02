import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionRunRegistry } = require("../../shell/tasks/session-runs.cjs");
const { createSessionScheduler } = require("../../shell/runtime/session-scheduler.cjs");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

function schedule(registry, scheduler, { userId = "u1", conversationId, runId, onStart }) {
  const registration = registry.register({ userId, conversationId, runId });
  const started = deferred();
  const finish = deferred();
  const job = scheduler.submit({
    runId, userId, sessionId: conversationId, processId: "runtime-p1",
    execute: async ({ signal }) => {
      started.resolve({ signal });
      onStart?.(signal);
      return finish.promise;
    },
  });
  registration.attachJob({ job, completion: job.result });
  return { registration, started: started.promise, finish, job };
}

test("registry indexes multiple runs per user and delegates FIFO/parallel limits to the scheduler", async () => {
  const registry = createSessionRunRegistry();
  const scheduler = createSessionScheduler({ perUserLimit: 2, globalLimit: 8 });
  const a1 = schedule(registry, scheduler, { conversationId: "conversation-A", runId: "run-A1" });
  const a2 = schedule(registry, scheduler, { conversationId: "conversation-A", runId: "run-A2" });
  const b1 = schedule(registry, scheduler, { conversationId: "conversation-B", runId: "run-B1" });

  await Promise.all([a1.started, b1.started]);
  assert.deepEqual(registry.list({ userId: "u1", conversationId: "conversation-A" }).map((r) => r.runId), ["run-A1", "run-A2"]);
  assert.equal(registry.current({ userId: "u1", conversationId: "conversation-A" }).runId, "run-A1");
  assert.deepEqual(registry.listUser({ userId: "u1" }).map((r) => r.runId), ["run-A1", "run-A2", "run-B1"]);
  assert.deepEqual(registry.listUser({ userId: "other-user" }), []);
  assert.equal(a2.job.getState(), "queued", "same conversation remains FIFO");
  assert.equal(b1.job.getState(), "running", "other conversation runs concurrently for the same user");
  assert.equal(registry.size(), 3, "one user's other run does not overwrite the first session job");

  a1.finish.resolve("A1 done");
  assert.equal(await a1.job.result, "A1 done");
  await a2.started;
  assert.equal(registry.get({ userId: "u1", conversationId: "conversation-A", runId: "run-A1" }), null);
  assert.equal(registry.current({ userId: "u1", conversationId: "conversation-A" }).runId, "run-A2");
  a2.finish.resolve("A2 done"); b1.finish.resolve("B1 done");
  await Promise.all([a2.job.result, b1.job.result]);
  assert.equal(registry.size(), 0, "settled completions release registry entries");
  await scheduler.close();
});

test("cancelling one conversation targets its current run and waits for actual executor settlement", async () => {
  const registry = createSessionRunRegistry();
  const scheduler = createSessionScheduler({ perUserLimit: 2, globalLimit: 8 });
  const signalA = {};
  const a = schedule(registry, scheduler, { conversationId: "A", runId: "run-A", onStart: (signal) => { signalA.value = signal; } });
  const b = schedule(registry, scheduler, { conversationId: "B", runId: "run-B" });
  await Promise.all([a.started, b.started]);

  const cancel = registry.cancelCurrent({ userId: "u1", conversationId: "A" });
  assert.equal(signalA.value.aborted, true);
  assert.equal(b.job.getState(), "running");
  assert.equal((await Promise.race([cancel.then(() => "settled"), Promise.resolve("pending")])) , "pending",
    "cancellation does not release the scheduler slot before executor settlement");
  a.finish.resolve("late completion");
  const cancelled = await cancel;
  assert.equal(cancelled.found, true);
  assert.equal(cancelled.result.state, "cancelled");
  await assert.rejects(a.job.result, { code: "SCHEDULER_CANCELLED" });
  assert.equal(registry.get({ userId: "u1", conversationId: "A", runId: "run-A" }), null);
  assert.equal(registry.get({ userId: "other-user", conversationId: "B", runId: "run-B" }), null,
    "lookup cannot cross the trusted user scope");

  b.finish.resolve("B unaffected");
  assert.equal(await b.job.result, "B unaffected");
  await scheduler.close();
});

test("unbound and rejected runs can be released without stale session indexes", async () => {
  const registry = createSessionRunRegistry();
  const identity = { userId: "u1", conversationId: "conv" };
  const registration = registry.register({ ...identity, runId: "run-1" });
  assert.equal(registry.hasSession(identity), true);
  assert.deepEqual(await registry.cancelCurrent(identity), { found: true, requested: false, run: registration.get() },
    "cancelCurrent is scoped and reports an unattached run without fabricating cancellation");
  assert.equal(registration.release(), true);
  assert.equal(registration.release(), false);
  assert.equal(registry.hasSession(identity), false);

  const failed = deferred();
  registry.register({ ...identity, runId: "run-2", job: { promise: failed.promise } });
  failed.reject(new Error("executor failure"));
  await failed.promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.size(), 0, "rejected completion also releases its index");

  const invalid = registry.register({ ...identity, runId: " run-3 " });
  assert.throws(() => registry.register({ ...identity, runId: "run-3" }), { code: "DUPLICATE_RUN" });
  assert.equal(registry.get({ ...identity, runId: "run-3" }).runId, "run-3");
  invalid.release();
  assert.throws(() => registry.register({ ...identity, runId: "run-4", completion: 5 }), TypeError);
  assert.equal(registry.size(), 0, "invalid attachment must not leak a partially registered run");
});
