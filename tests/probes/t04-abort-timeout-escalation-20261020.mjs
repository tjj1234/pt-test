import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t04-abort-timeout-"));
const originalSpawn = childProcess.spawn;
const children = [];
class FakeChild extends EventEmitter {
  constructor(outputFd) {
    super();
    this.exitCode = null;
    this.killed = false;
    this.outputFd = outputFd;
    this.messages = [];
    this.frames = [];
    this.stdin = { write: (line) => {
      const message = JSON.parse(String(line));
      this.messages.push(message);
      if (message.type === "abort") queueMicrotask(() => this.send({ type: "aborted", sessionId: message.sessionId }));
      return true;
    } };
    children.push(this);
  }
  send(frame) {
    this.frames.push(frame);
    fs.writeSync(this.outputFd, JSON.stringify({ protocolVersion: 1, ...frame }) + "\n");
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

childProcess.spawn = (_command, _args, options) => {
  const child = new FakeChild(options.stdio[1]);
  queueMicrotask(() => child.send({ type: "ready", runner: "persistent-runner", capabilities: ["task-v1", "tool-rpc-v1", "abort-v1"] }));
  return child;
};
const { createDshRuntime } = require("../../shell/runtime/dsh-adapter.cjs");
childProcess.spawn = originalSpawn;
const runtime = createDshRuntime({
  dshHome: path.join(temp, "dsh-home"),
  settingsTemplate: path.resolve("shell/dsh-settings.yaml"),
  persistentRunner: path.resolve("shell/persistent-runner.mjs"),
  tmpDir: path.join(temp, "logs"),
  idleMs: 60_000,
  taskTimeoutMs: 2_000,
  abortGraceMs: 40,
});
const waitFor = async (predicate, label, timeoutMs = 2_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  let jobA;
  const start = (sessionKey, question, timeoutMs, onSpawn, tenantId = "tenant-abort-timeout") => runtime.run({
    sessionKey, tenantId, userId: "user-1", workspace: temp,
    apiKey: "fixture-key", question, timeoutMs, onSpawn,
  });
  const drainedAbortA = start("done-A", "A abort drains", 5_000, undefined, "tenant-abort-done");
  const drainedAbortB = start("done-B", "B unaffected", 5_000, undefined, "tenant-abort-done");
  const drainedChild = await (async () => {
    await waitFor(() => children.length === 1 && children[0].messages.filter((m) => m.type === "task").length === 2, "drained A/B task dispatch");
    return children[0];
  })();
  const drainedTasks = drainedChild.messages.filter((message) => message.type === "task");
  const drainedTaskA = drainedTasks.find((message) => message.task.includes("A abort drains"));
  const drainedTaskB = drainedTasks.find((message) => message.task.includes("B unaffected"));
  assert(drainedTaskA && drainedTaskB);
  runtime.abort("done-A");
  await waitFor(() => drainedChild.frames.some((message) => message.type === "aborted" && message.sessionId === drainedTaskA.sessionId), "normal abort acknowledgement");
  drainedChild.send({ type: "done", sessionId: drainedTaskA.sessionId, ok: true, text: "runner omitted stopped fields" });
  const drainedResultA = await drainedAbortA;
  assert.equal(drainedResultA.ok, false, "abort keeps precedence over a success-shaped done frame");
  assert.equal(drainedResultA.stopped, true);
  assert.equal(drainedResultA.stopReason, "user");
  drainedChild.send({ type: "done", sessionId: drainedTaskB.sessionId, ok: true, text: "B remains successful" });
  const drainedResultB = await drainedAbortB;
  assert.equal(drainedResultB.ok, true);
  assert.equal(drainedResultB.text, "B remains successful");

  const promiseA = start("session-A", "A aborted without done", 5_000, (job) => { jobA = job; });
  const promiseB = start("session-B", "B times out", 160);
  const child = await (async () => {
    await waitFor(() => children.length === 2 && children[1].messages.filter((m) => m.type === "task").length === 2, "A/B task dispatch");
    return children[1];
  })();
  const tasks = child.messages.filter((message) => message.type === "task");
  const taskA = tasks.find((message) => message.task.includes("A aborted without done"));
  const taskB = tasks.find((message) => message.task.includes("B times out"));
  assert(taskA && taskB && jobA);

  jobA.abort();
  await waitFor(() => child.frames.some((message) => message.type === "aborted" && message.sessionId === taskA.sessionId), "A abort acknowledgement");
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.equal(child.killed, false, "A abort grace alone must not kill B's live child");

  await waitFor(() => child.killed, "B timeout escalation after A abort grace");
  const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
  assert.equal(resultA.stopped, true);
  assert.equal(resultA.stopReason, "user");
  assert.equal(resultA.code, "DSH_PROCESS_EXIT");
  assert.equal(resultB.code, "TIMEOUT");
  assert.equal(resultB.stopReason, "timeout");
  assert.equal(resultB.stopped, true);
  process.stdout.write("T04 abort drain + abort-no-done/sibling-timeout: PASS (A=user-cancelled, B=TIMEOUT, sibling success preserved)\n");
} finally {
  runtime.close();
  for (const child of children) child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
