/**
 * dsh-parent-rpc-test.mjs — DSH child-to-parent RPC transport regression.
 * Uses a fake child process and JSONL frames; no DSH/model/network is loaded.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-parent-rpc-"));
const children = [];
const originalSpawn = childProcess.spawn;
let nextReadyFrame = null;

class FakeChild extends EventEmitter {
  constructor(outputFd) {
    super();
    this.outputFd = outputFd;
    this.exitCode = null;
    this.killed = false;
    this.messages = [];
    this.onMessage = null;
    this.stdin = {
      write: (line) => {
        let message;
        try { message = JSON.parse(String(line)); } catch { return true; }
        this.messages.push(message);
        try { this.onMessage?.(message); } catch { /* test callback reports through assertions */ }
        if (message.type === "abort") {
          queueMicrotask(() => this.send({ type: "aborted", sessionId: message.sessionId }));
        }
        return true;
      },
    };
    children.push(this);
  }

  send(frame) {
    const normalized = { ...frame, protocolVersion: frame.protocolVersion ?? 1 };
    if (normalized.type === "ready") {
      normalized.runner ??= "persistent-runner";
      normalized.capabilities ??= ["task-v1", "tool-rpc-v1", "abort-v1"];
    }
    fs.writeSync(this.outputFd, JSON.stringify(normalized) + "\n");
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
  const ready = nextReadyFrame || { type: "ready" };
  nextReadyFrame = null;
  queueMicrotask(() => child.send(ready));
  return child;
};
const { createDshRuntime } = require("../../shell/runtime/dsh-adapter.cjs");
const runtime = createDshRuntime({
  dshHome: path.join(temp, "dsh-home"),
  settingsTemplate: path.resolve("shell/dsh-settings.yaml"),
  persistentRunner: path.resolve("shell/persistent-runner.mjs"),
  tmpDir: path.join(temp, "logs"),
  idleMs: 60_000,
  taskTimeoutMs: 2_000,
});

const waitFor = async (predicate, label, timeoutMs = 1_500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const baseSpec = (sessionKey, onToolRequest, timeoutMs) => ({
  sessionKey,
  tenantId: "rpc-test-tenant",
  userId: "rpc-test-user",
  workspace: temp,
  apiKey: "test-key-must-not-appear-in-errors",
  question: "RPC transport fixture",
  timeoutMs,
  onToolRequest,
});

let pass = 0;
function check(label, fn) {
  fn();
  pass++;
  console.log(`  ✅ ${label}`);
}

try {
  // Concurrent sessions prove the adapter binds each callback and response to
  // the sessionId/requestId received from the child frame.
  const received = [];
  const runA = runtime.run({ ...baseSpec("session-A", async (request) => {
    received.push({ side: "A", ...request });
    return { from: "A", echo: request.args.value };
  }), budgetProfile:"media:text2image" });
  const runB = runtime.run(baseSpec("session-B", async (request) => {
    received.push({ side: "B", ...request });
    return { from: "B", echo: request.args.value };
  }));
  const child = children[0];
  await waitFor(() => child.messages.filter((m) => m.type === "task").length === 2, "two task commands");
  const [taskA, taskB] = child.messages.filter((m) => m.type === "task");
  check("task commands carry the negotiated RPC protocol version", () => {
    assert.equal(taskA.protocolVersion, 1);
    assert.equal(taskB.protocolVersion, 1);
    assert.equal(taskA.budgetProfile,"media:text2image");
    assert.equal(taskB.budgetProfile,undefined);
  });
  child.send({ type: "tool_request", sessionId: taskA.sessionId, requestId: "req-A", name: "media.route", args: { value: "alpha" } });
  child.send({ type: "tool_request", sessionId: taskB.sessionId, requestId: "req-B", name: "audit.read", args: { value: "beta" } });
  await waitFor(() => child.messages.filter((m) => m.type === "tool_response").length === 2, "two correlated responses");
  const responses = child.messages.filter((m) => m.type === "tool_response");
  check("request callbacks retain matching sessionId/requestId and return on matching frame", () => {
    assert.deepEqual(received.map((r) => [r.side, r.sessionId, r.requestId]).sort(), [
      ["A", taskA.sessionId, "req-A"], ["B", taskB.sessionId, "req-B"],
    ].sort());
    assert.deepEqual(responses.map((r) => [r.sessionId, r.requestId]).sort(), [
      [taskA.sessionId, "req-A"], [taskB.sessionId, "req-B"],
    ].sort());
    assert(responses.every((response) => response.protocolVersion === 1), "tool responses must carry the negotiated protocol version");
    assert.deepEqual(responses.map((r) => r.result).sort((a, b) => a.from.localeCompare(b.from)), [
      { from: "A", echo: "alpha" }, { from: "B", echo: "beta" },
    ]);
  });
  child.send({ type: "done", sessionId: taskA.sessionId, ok: true, text: "A done" });
  child.send({ type: "done", sessionId: taskB.sessionId, ok: true, text: "B done" });
  await Promise.all([runA, runB]);

  // A duplicate requestId while its first handler is pending must not execute
  // twice or produce multiple replies.
  let releaseDuplicate;
  let duplicateCalls = 0;
  const duplicateRun = runtime.run(baseSpec("session-duplicate", () => {
    duplicateCalls++;
    return new Promise((resolve) => { releaseDuplicate = resolve; });
  }));
  const duplicateTask = child.messages.filter((m) => m.type === "task").at(-1);
  const duplicateFrame = { type: "tool_request", sessionId: duplicateTask.sessionId, requestId: "req-duplicate", name: "media.route", args: { taskType: "text2image" } };
  child.send(duplicateFrame);
  await waitFor(() => duplicateCalls === 1, "first duplicate handler call");
  child.send({ ...duplicateFrame, sessionId: "wrong-session-for-same-request-id" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseDuplicate({ accepted: true });
  await waitFor(() => child.messages.filter((m) => m.requestId === "req-duplicate" && m.type === "tool_response").length === 1, "single duplicate response");
  check("duplicate/cross-session request is ignored while original request is pending", () => {
    assert.equal(duplicateCalls, 1);
    const response = child.messages.find((m) => m.requestId === "req-duplicate" && m.type === "tool_response");
    assert.equal(response.sessionId, duplicateTask.sessionId);
  });
  child.send({ type: "done", sessionId: duplicateTask.sessionId, ok: true, text: "done" });
  await duplicateRun;

  // Errors expose only safe code/message fields; secret-bearing exception text
  // must not cross the process boundary.
  const errorRun = runtime.run(baseSpec("session-error", async () => {
    const error = new Error("secret key /private/config/api-key=abc");
    error.code = "UPSTREAM_FAILURE";
    throw error;
  }));
  const errorTask = child.messages.filter((m) => m.type === "task").at(-1);
  child.send({ type: "tool_request", sessionId: errorTask.sessionId, requestId: "req-error", name: "media.route", args: { prompt: "x" } });
  await waitFor(() => child.messages.some((m) => m.requestId === "req-error" && m.type === "tool_response"), "sanitized error response");
  const errorResponse = child.messages.find((m) => m.requestId === "req-error" && m.type === "tool_response");
  check("failed callback is reduced to safe error fields", () => {
    assert.deepEqual(Object.keys(errorResponse.error).sort(), ["code", "message"]);
    assert.equal(errorResponse.error.code, "UPSTREAM_FAILURE");
    assert.equal(errorResponse.error.message, "Parent tool request failed");
    assert(!JSON.stringify(errorResponse).includes("private/config"));
    assert(!JSON.stringify(errorResponse).includes("api-key=abc"));
  });
  child.send({ type: "done", sessionId: errorTask.sessionId, ok: true, text: "done" });
  await errorRun;

  // Abort clears the pending request; a late callback result must not be sent.
  let releaseAbort;
  let abortSignal;
  let abortJob;
  const abortTaskCount = child.messages.filter((message) => message.type === "task").length;
  const abortRun = runtime.run({ ...baseSpec("session-abort", (request) => {
    abortSignal = request.signal;
    return new Promise((resolve) => { releaseAbort = resolve; });
  }), onSpawn: (job) => { abortJob = job; } });
  await waitFor(() => child.messages.filter((message) => message.type === "task").length === abortTaskCount + 1, "abort task command");
  const abortTask = child.messages.filter((m) => m.type === "task").at(-1);
  child.send({ type: "tool_request", sessionId: abortTask.sessionId, requestId: "req-abort", name: "media.route", args: {} });
  await waitFor(() => typeof releaseAbort === "function", "abort handler start");
  abortJob.abort();
  await abortRun;
  releaseAbort({ tooLate: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  check("abort signals pending handler and suppresses its late response", () => {
    assert.equal(abortSignal.aborted, true);
    assert.equal(child.messages.filter((m) => m.requestId === "req-abort" && m.type === "tool_response").length, 0);
  });

  // Timeout follows the same cleanup rule, even if a callback settles later.
  let releaseTimeout;
  let timeoutSignal;
  // Earlier abort cases can replace the persistent child. Track all existing
  // children so this assertion follows the child runtime.run actually uses.
  const timeoutTaskCounts = new Map(children.map((candidate) => [
    candidate,
    candidate.messages.filter((message) => message.type === "task").length,
  ]));
  const timeoutRun = runtime.run(baseSpec("session-timeout", (request) => {
    timeoutSignal = request.signal;
    return new Promise((resolve) => { releaseTimeout = resolve; });
  }, 2_000));
  await waitFor(() => children.some((candidate) => (
    candidate.messages.filter((message) => message.type === "task").length > (timeoutTaskCounts.get(candidate) || 0)
  )), "timeout task command");
  const timeoutChild = children.find((candidate) => (
    candidate.messages.filter((message) => message.type === "task").length > (timeoutTaskCounts.get(candidate) || 0)
  ));
  const timeoutTask = timeoutChild.messages.filter((m) => m.type === "task").at(-1);
  timeoutChild.send({ type: "tool_request", sessionId: timeoutTask.sessionId, requestId: "req-timeout", name: "media.route", args: {} });
  await waitFor(() => typeof releaseTimeout === "function", "timeout handler start");
  const timeoutResult = await timeoutRun;
  releaseTimeout({ tooLate: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  check("timeout aborts pending handler and suppresses its late response", () => {
    assert.equal(timeoutSignal.aborted, true);
    assert.equal(timeoutResult.stopReason, "timeout");
    assert.equal(child.messages.filter((m) => m.requestId === "req-timeout" && m.type === "tool_response").length, 0);
  });

  // Transport behavior above is real adapter behavior; this source contract
  // confirms the trusted built-in media tool selects the fixed host RPC name.
  const runnerSource = fs.readFileSync(path.resolve("shell/persistent-runner.mjs"), "utf8");
  check("media_route forwards original args through the fixed media.route host handler", () => {
    assert.deepEqual([...runnerSource.matchAll(/registerRunTool\(agentCtx, sid, "([^"]+)"/g)].map(match => match[1]).sort(),
      ['get_current_time', 'media_route', 'csv_analyze', 'ga_query', 'attribution_query', 'attribution_quality', 'tracking_quality_audit'].sort(),
      "only the reviewed product tools are exposed; model intent RPC is not a model tool");
    assert.match(runnerSource, /requestParentTool\(sid,\s*["']media\.route["'],\s*args\s*\|\|\s*\{\}\)/);
    assert.doesNotMatch(runnerSource, /callMediaRoute\(\{\},\s*args\s*\|\|\s*\{\}\)/);
    assert.doesNotMatch(runnerSource, /name:\s*["']parent_rpc["']/);
    assert.match(runnerSource, /frame\.protocolVersion !== RPC_PROTOCOL_VERSION/);
    assert.match(runnerSource, /pendingToolRequests\.get\(frame\.requestId\)[\s\S]{0,160}pending\.sessionId\s*!==\s*frame\.sessionId/);
  });

  // A stale runner must be rejected before any task command can be dispatched.
  nextReadyFrame = { type: "ready", protocolVersion: 99, runner: "persistent-runner", capabilities: ["task-v1", "tool-rpc-v1", "abort-v1"] };
  const incompatibleRun = runtime.run({ ...baseSpec("session-incompatible", () => { throw new Error("must not run"); }), tenantId: "rpc-incompatible-tenant" });
  const incompatibleChild = children.at(-1);
  const incompatibleResult = await incompatibleRun;
  check("incompatible ready frame fails visibly before task/tool side effects", () => {
    assert.equal(incompatibleResult.ok, false);
    assert.equal(incompatibleResult.code, "DSH_PROTOCOL_MISMATCH");
    assert.equal(incompatibleChild.messages.some((m) => m.type === "task"), false);
  });
  const missingIntentRun = runtime.run({ ...baseSpec("session-no-intent", async () => ({})),
    tenantId: "rpc-no-intent-tenant", recordModelIntents: true });
  const missingIntentChild = children.at(-1);
  const missingIntentResult = await missingIntentRun;
  check("a runner missing durable model intent capability cannot receive a ledger-required task", () => {
    assert.equal(missingIntentResult.code, "DSH_MODEL_INTENT_UNSUPPORTED");
    assert.equal(missingIntentChild.messages.some(message => message.type === "task"), false);
  });

  const profileHome = path.join(temp, "profile-manifest-home");
  const profile = require("../../shell/runtime/dsh-adapter.cjs").makeProfile(
    profileHome,
    path.resolve("shell/dsh-settings.yaml"),
    path.resolve("shell/persistent-runner.mjs"),
  );
  const manifestPath = path.join(profile.dir, "northstar-profile-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  check("profile manifest records protocol and module hashes without paths or credentials", () => {
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.rpcProtocolVersion, 1);
    assert(Object.keys(manifest.files).includes("persistent-runner.mjs"));
    assert(Object.values(manifest.files).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
    assert(!JSON.stringify(manifest).includes(profileHome));
    assert(!JSON.stringify(manifest).includes("test-key"));
  });
  manifest.rpcProtocolVersion = 0;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  check("invalid protocol manifest blocks silent reuse", () => {
    assert.throws(() => require("../../shell/runtime/dsh-adapter.cjs").makeProfile(
      profileHome,
      path.resolve("shell/dsh-settings.yaml"),
      path.resolve("shell/persistent-runner.mjs"),
    ), { code: "PROFILE_MANIFEST_INVALID" });
  });

  console.log(`\n结果：${pass} 通过 / 0 失败`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  runtime.close();
  childProcess.spawn = originalSpawn;
  for (const child of children) child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
