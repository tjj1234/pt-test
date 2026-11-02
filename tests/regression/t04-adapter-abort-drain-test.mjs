import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

const require = createRequire(import.meta.url);
const { createSessionScheduler } = require("../../shell/runtime/session-scheduler.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t04-abort-drain-"));
const children = [];
const originalSpawn = childProcess.spawn;
let deferNextReady = false;

class FakeChild extends EventEmitter {
  constructor(outputFd) {
    super();
    this.outputFd = outputFd;
    this.exitCode = null;
    this.killed = false;
    this.closed = false;
    this.messages = [];
    this.acknowledgements = [];
    this.stdin = { write: (line) => {
      const message = JSON.parse(String(line));
      this.messages.push(message);
      if (message.type === "abort") queueMicrotask(() => {
        this.send({ type: "tool_request", sessionId: message.sessionId, requestId: "late-before-ack-A", name: "media.route", args: { taskType: "text2image" } });
        this.acknowledgements.push(message.sessionId);
        this.send({ type: "aborted", sessionId: message.sessionId });
      });
      return true;
    } };
    children.push(this);
  }
  send(frame) {
    fs.writeSync(this.outputFd, JSON.stringify({ protocolVersion: 1, ...frame }) + "\n");
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.exitCode = 0;
    this.closed = true;
    this.emit("close", 0, null);
  }
}

childProcess.spawn = (_command, _args, options) => {
  const child = new FakeChild(options.stdio[1]);
  const sendReady = !deferNextReady;
  deferNextReady = false;
  if (sendReady) queueMicrotask(() => child.send({ type: "ready", runner: "persistent-runner", capabilities: ["task-v1", "tool-rpc-v1", "abort-v1"] }));
  return child;
};

const { createDshRuntime } = require("../../shell/runtime/dsh-adapter.cjs");
// The adapter captures spawn at require time. Restore the process-wide method
// immediately so node:test's own worker/IPC machinery is never intercepted.
childProcess.spawn = originalSpawn;
const runtime = createDshRuntime({
  dshHome: path.join(temp, "dsh-home"),
  settingsTemplate: path.resolve("shell/dsh-settings.yaml"),
  persistentRunner: path.resolve("shell/persistent-runner.mjs"),
  tmpDir: path.join(temp, "logs"),
  idleMs: 60_000,
  taskTimeoutMs: 2_000,
  // Keep the grace long enough for multi-frame assertions on the file-polled
  // child protocol; timeout-specific coverage waits past this interval below.
  abortGraceMs: 1_000,
});
const scheduler = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
const waitFor = async (predicate, label, timeoutMs = 2_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

function submit(runId, sessionId, onToolRequest = () => {}) {
  return scheduler.submit({
    runId, userId: "user-1", sessionId, processId: "tenant-process", context: {},
    execute: ({ signal }) => runtime.run({
      sessionKey: sessionId,
      tenantId: "tenant-shared",
      userId: "user-1",
      workspace: temp,
      apiKey: "fixture-key",
      question: runId,
      onToolRequest,
      onSpawn(job) {
        if (signal.aborted) job.abort();
        else signal.addEventListener("abort", () => job.abort(), { once: true });
      },
    }),
  });
}

test("T04 cancellation waits for runner drain and preserves a same-tenant sibling", async () => {
  let callsA = 0;
  let callsB = 0;
  const runA = submit("run-A", "session-A", () => { callsA++; return { side: "A" }; });
  const runB = submit("run-B", "session-B", () => { callsB++; return { side: "B" }; });
  let resultASettled = false;
  runA.result.catch(() => { resultASettled = true; });
  const child = await (async () => {
    await waitFor(() => children.length === 1 && children[0].messages.filter((m) => m.type === "task").length === 2, "shared child dispatching both sessions");
    return children[0];
  })();
  const tasks = child.messages.filter((message) => message.type === "task");
  const taskA = tasks.find((message) => message.task.includes("run-A"));
  const taskB = tasks.find((message) => message.task.includes("run-B"));
  assert(taskA && taskB);
  assert.notEqual(taskA.sessionId, taskB.sessionId);

  const cancelA = scheduler.cancel("run-A");
  await waitFor(() => child.messages.some((message) => message.type === "abort" && message.sessionId === taskA.sessionId), "A abort frame");
  await waitFor(() => child.messages.some((message) => message.type === "tool_response" && message.requestId === "late-before-ack-A"), "pre-ack late A request rejection");
  const rejectedBeforeAck = child.messages.find((message) => message.type === "tool_response" && message.requestId === "late-before-ack-A");
  assert.equal(rejectedBeforeAck.ok, false);
  assert.equal(rejectedBeforeAck.error.code, "SESSION_ABORTED");
  assert.equal(callsA, 0, "request arriving after abort write but before acknowledgement must not invoke the handler");
  await waitFor(() => child.acknowledgements.includes(taskA.sessionId), "A abort acknowledgement");
  assert.equal(runA.getState(), "running", "A remains running after abort acknowledgement");
  child.send({ type: "tool_request", sessionId: taskA.sessionId, requestId: "late-A", name: "media.route", args: { taskType: "text2image" } });
  await waitFor(() => child.messages.some((message) => message.type === "tool_response" && message.requestId === "late-A"), "late A request rejection");
  const rejectedA = child.messages.find((message) => message.type === "tool_response" && message.requestId === "late-A");
  assert.equal(rejectedA.ok, false);
  assert.equal(rejectedA.error.code, "SESSION_ABORTED");
  assert.equal(callsA, 0, "late A request must not invoke the parent handler");

  child.send({ type: "tool_request", sessionId: taskB.sessionId, requestId: "live-B", name: "media.route", args: { taskType: "text2image" } });
  await waitFor(() => child.messages.some((message) => message.type === "tool_response" && message.requestId === "live-B"), "B request remains callable");
  const responseB = child.messages.find((message) => message.type === "tool_response" && message.requestId === "live-B");
  assert.equal(responseB.ok, true);
  assert.deepEqual(responseB.result, { side: "B" });
  assert.equal(callsB, 1, "A cancellation does not block B parent requests");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resultASettled, false, "A result must not settle at the early aborted acknowledgement");

  child.send({ type: "done", sessionId: taskB.sessionId, ok: true, text: "B completed" });
  const resultB = await runB.result;
  assert.equal(resultB.text, "B completed");
  assert.equal(runB.getState(), "completed");
  assert.equal(runA.getState(), "running", "B completion does not settle A before A drains");
  assert.equal(resultASettled, false);

  child.send({ type: "done", sessionId: taskA.sessionId, ok: false, stopped: true, stopReason: "user", text: "" });
  const settledA = await cancelA;
  await assert.rejects(runA.result, { code: "SCHEDULER_CANCELLED" });
  assert.equal(settledA.state, "cancelled");
  assert.equal(runA.getState(), "cancelled");
  assert.equal(child.killed, false, "cancelling A leaves the shared child available to B");
  assert.equal(scheduler.stats().active, 0, "completed cancellation case leaves no scheduler entries");
  await scheduler.close();
  });

test("T04 timeout cannot kill or settle a shared child while a sibling remains active", async () => {
  const tenantId = "tenant-timeout-shared";
  let callsA = 0;
  let callsB = 0;
  const startRun = (sessionKey, question, timeoutMs, onToolRequest) => runtime.run({
    sessionKey, tenantId, userId: "user-1", workspace: temp, apiKey: "fixture-key", question, timeoutMs,
    onToolRequest,
  });
  const promiseA = startRun("timeout-session-A", "timeout-A", 80, () => { callsA++; return { side: "A" }; });
  const promiseB = startRun("timeout-session-B", "sibling-B", 5_000, () => { callsB++; return { side: "B" }; });
  let settledA = false;
  promiseA.then(() => { settledA = true; });
  const child = await (async () => {
    await waitFor(() => children.length === 2 && children[1].messages.filter((m) => m.type === "task").length === 2, "timeout sibling sessions share a child");
    return children[1];
  })();
  const tasks = child.messages.filter((message) => message.type === "task");
  const taskA = tasks.find((message) => message.task.includes("timeout-A"));
  const taskB = tasks.find((message) => message.task.includes("sibling-B"));
  assert(taskA && taskB);

  await waitFor(() => child.messages.some((message) => message.type === "abort" && message.sessionId === taskA.sessionId), "A timeout abort");
  await waitFor(() => child.acknowledgements.includes(taskA.sessionId), "A timeout acknowledgement");
  await new Promise((resolve) => setTimeout(resolve, 1_050)); // exceed the injected abort grace
  assert.equal(child.killed, false, "grace expiry must defer process kill while B remains active");
  assert.equal(settledA, false, "timeout acknowledgement/grace does not release A before drain or process close");

  const rejectedC = await startRun("timeout-session-C", "late C", 5_000, () => ({ side: "C" }));
  assert.equal(rejectedC.code, "DSH_PROCESS_DRAINING", "a poisoned child refuses new sessions");
  assert.equal(child.messages.filter((message) => message.type === "task").length, 2, "C is not dispatched to the draining runner");

  child.send({ type: "tool_request", sessionId: taskB.sessionId, requestId: "timeout-live-B", name: "media.route", args: { taskType: "text2image" } });
  await waitFor(() => child.messages.some((message) => message.type === "tool_response" && message.requestId === "timeout-live-B"), "B RPC succeeds during A timeout drain");
  const responseB = child.messages.find((message) => message.type === "tool_response" && message.requestId === "timeout-live-B");
  assert.equal(responseB.ok, true);
  assert.deepEqual(responseB.result, { side: "B" });
  assert.equal(callsA, 0);
  assert.equal(callsB, 1);

  child.send({ type: "done", sessionId: taskB.sessionId, ok: true, text: "B survived A timeout" });
  const resultB = await promiseB;
  assert.equal(resultB.ok, true, "B outcome is not contaminated by A's timeout");
  assert.equal(resultB.text, "B survived A timeout");
  assert.equal(resultB.stopped, false);
  assert.equal(settledA, false, "A remains pending until the last-resort child close");

  await waitFor(() => child.killed, "last-resort kill after no non-timed-out sibling remains");
  assert.equal(child.closed, true, "timeout waiter settles only after the child close event");
  const resultA = await promiseA;
  assert.equal(resultA.code, "TIMEOUT");
  assert.equal(resultA.stopReason, "timeout");
  assert.equal(resultA.stopped, true);
  });

test("T04 undispatched timeout settles locally and preserves queued siblings", async () => {
  const tenantId = "tenant-predispatch-timeout";
  deferNextReady = true;
  const startRun = (sessionKey, question, timeoutMs) => runtime.run({
    sessionKey, tenantId, userId: "user-1", workspace: temp, apiKey: "fixture-key", question, timeoutMs,
    onToolRequest: () => ({ ok: true }),
  });
  const promiseA = startRun("predispatch-A", "pending timeout A", 80);
  const promiseB = startRun("predispatch-B", "pending sibling B", 5_000);
  const child = await (async () => {
    await waitFor(() => children.length === 3, "delayed-ready child spawn");
    return children[2];
  })();
  assert.equal(child.messages.some((message) => message.type === "task"), false, "no task was sent before ready");

  const resultA = await promiseA;
  assert.equal(resultA.code, "TIMEOUT");
  assert.equal(resultA.stopReason, "timeout");
  assert.equal(child.killed, false, "A had no runner turn and does not kill the process while B remains queued");

  const rejectedC = await startRun("predispatch-C", "late C", 5_000);
  assert.equal(rejectedC.code, "DSH_PROCESS_DRAINING");
  child.send({ type: "ready", runner: "persistent-runner", capabilities: ["task-v1", "tool-rpc-v1", "abort-v1"] });
  await waitFor(() => child.messages.some((message) => message.type === "task" && message.task.includes("pending sibling B")), "existing queued B dispatches after ready");
  const taskB = child.messages.find((message) => message.type === "task" && message.task.includes("pending sibling B"));
  assert.equal(child.messages.some((message) => message.type === "abort"), false, "undispatched A does not send an abort frame");
  child.send({ type: "done", sessionId: taskB.sessionId, ok: true, text: "B completed" });
  const resultB = await promiseB;
  assert.equal(resultB.ok, true);
  assert.equal(resultB.text, "B completed");
  await waitFor(() => child.closed, "poisoned child retires after its last admitted sibling settles");
  });

test("T04 job.kill is a scoped abort alias with shared-child deferral", async () => {
    const tenantId = "tenant-kill-shared";
    let jobA;
    const startRun = (sessionKey, question, onSpawn) => runtime.run({
      sessionKey, tenantId, userId: "user-1", workspace: temp, apiKey: "fixture-key", question,
      timeoutMs: 5_000, onSpawn, onToolRequest: () => ({ side: sessionKey }),
    });
    const promiseA = startRun("kill-A", "kill alias A", (job) => { jobA = job; });
    const promiseB = startRun("kill-B", "kill sibling B");
    const child = await (async () => {
      await waitFor(() => children.length === 4 && children[3].messages.filter((m) => m.type === "task").length === 2, "kill alias sessions share a child");
      return children[3];
    })();
    const tasks = child.messages.filter((message) => message.type === "task");
    const taskA = tasks.find((message) => message.task.includes("kill alias A"));
    const taskB = tasks.find((message) => message.task.includes("kill sibling B"));
    assert(taskA && taskB && jobA);

    jobA.kill();
    await waitFor(() => child.acknowledgements.includes(taskA.sessionId), "job.kill abort acknowledgement");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(child.killed, false, "job.kill must defer process termination while B remains active");

    child.send({ type: "tool_request", sessionId: taskB.sessionId, requestId: "kill-live-B", name: "media.route", args: { taskType: "text2image" } });
    await waitFor(() => child.messages.some((message) => message.type === "tool_response" && message.requestId === "kill-live-B"), "B RPC remains live after job.kill(A)");
    assert.equal(child.messages.find((message) => message.type === "tool_response" && message.requestId === "kill-live-B").ok, true);
    child.send({ type: "done", sessionId: taskB.sessionId, ok: true, text: "B completed after kill alias" });
    const resultB = await promiseB;
    assert.equal(resultB.ok, true);
    assert.equal(resultB.text, "B completed after kill alias");
    await waitFor(() => child.closed, "last-resort child close after B drains");
    const resultA = await promiseA;
    assert.equal(resultA.stopped, true);
    assert.equal(resultA.stopReason, "user");
    assert.equal(resultA.code, "DSH_PROCESS_EXIT");
  });
test("runner diagnostic code and message survive the adapter waiter", async () => {
  const sessionKey = "diagnostic-session";
  const pending = runtime.run({
    sessionKey, tenantId: "tenant-diagnostic", userId: "user-1", workspace: temp,
    apiKey: "fixture-key", question: "simple hello", timeoutMs: 5_000,
  });
  const child = await (async () => {
    await waitFor(() => children.length === 5 && children[4].messages.some((message) => message.type === "task"), "diagnostic task dispatch");
    return children[4];
  })();
  const task = child.messages.find((message) => message.type === "task");
  child.send({
    type: "done", sessionId: task.sessionId, ok: false,
    code: "EMPTY_ASSISTANT_RESPONSE",
    error: "Agent turn completed without producing assistant text",
    reasonDetail: { code: "EMPTY_ASSISTANT_RESPONSE", message: "Agent turn completed without producing assistant text" },
  });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.equal(result.code, "EMPTY_ASSISTANT_RESPONSE");
  assert.equal(result.error, "Agent turn completed without producing assistant text");
});
test("T04 adapter fixture cleanup", () => {
  runtime.close();
  childProcess.spawn = originalSpawn;
  for (const child of children) child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
