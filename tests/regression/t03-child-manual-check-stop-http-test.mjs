import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const { createTaskStore } = require("../../shell/tasks/store.cjs");
const { createExternalOperationsWorker } = require("../../shell/tasks/external-operations-worker.cjs");
const { createPowerTokensQueryAdapters } = require("../../shell/tasks/provider-adapters.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = "2026-10-18T00:00:00.000Z";

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForClose(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not exit")), timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

test("chat stop reports unresolved child manual_check even when parent externalState is empty", { timeout: 30_000 }, async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false,
    "fixture must use isolated PGlite, never an external database");
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "northstar-child-manual-stop-"));
  const dbDir = path.join(temp, "db");
  const masterKeyFile = path.join(temp, "master.key");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const shutdownToken = `fixture-${crypto.randomBytes(16).toString("hex")}`;
  let storage, child;
  let output = "";
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({ username: "child-manual-stop", password: "FixturePass123" });
    assert.equal(registered.ok, true);
    const user = registered.user;
    const identity = { userId: user.id, tenantId: user.tenant_id };
    const token = crypto.randomBytes(32).toString("hex");
    await storage.db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", [
      user.id, crypto.createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 120_000).toISOString(),
    ]);
    const conversation = await storage.repositories.conversations.create(user.id);
    const runs = createTaskStore(storage.adapter);
    const owner = "manual-child-parent-owner";
    let withChild = (await runs.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: "manual-child-stop", policyVersion: "fixture",
      request: { question: "create an image", attachments: [] },
    }, { owner, ttlMs: 30_000 })).run;
    withChild = await runs.transition(identity, withChild.runId, "running", withChild.revision, owner);
    await runs.externalOperations.createIntent(identity, withChild.runId, {
      operationKey: "image:manual-child", provider: "fixture", runLeaseOwner: owner,
    });
    await runs.externalOperations.recordTaskId(identity, withChild.runId, "image:manual-child", {
      taskId: "known-manual-child-task", runLeaseOwner: owner,
    });
    await runs.releaseLease(identity, withChild.runId, owner);
    const requests = [];
    const queryAdapters = createPowerTokensQueryAdapters({
      baseUrl: "https://fixture.invalid",
      providerMappings: { fixture: { kind: "image", successStatuses: new Set(["complete"]), failureStatuses: new Set(["failed"]), pendingStatuses: new Set() } },
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method });
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: "unmapped-provider-state" }) };
      },
    });
    const queryWorker = createExternalOperationsWorker({
      store: runs.externalOperations, queryAdapters, credentialProvider: async () => "fixture-only",
      owner: "manual-child-query-worker",
      clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
    });
    assert.deepEqual(await queryWorker.runOnce(), { processed: 1 });
    await queryWorker.stop();
    assert.deepEqual(requests, [{ url: "https://fixture.invalid/v1/tasks/known-manual-child-task", method: "GET" }]);
    assert.equal((await runs.externalOperations.get(identity, withChild.runId, "image:manual-child")).status, "manual_check");
    const parentBefore = await runs.getRun(identity, withChild.runId);
    assert.equal(parentBefore.externalState, null, "the child status must not be mirrored into the legacy parent field");
    assert.equal(parentBefore.state, "waiting_external");

    const noChildOwner = "no-child-parent-owner";
    let noChild = (await runs.createRun(identity, {
      conversationId: conversation.id, idempotencyKey: "no-child-stop", policyVersion: "fixture",
      request: { question: "plain task", attachments: [] },
    }, { owner: noChildOwner, ttlMs: 30_000 })).run;
    noChild = await runs.transition(identity, noChild.runId, "running", noChild.revision, noChildOwner);
    noChild = await runs.transition(identity, noChild.runId, "awaiting_confirmation", noChild.revision, noChildOwner);
    await runs.releaseLease(identity, noChild.runId, noChildOwner);
    assert.equal(noChild.externalState, null);
    assert.equal(await runs.externalOperations.hasUnresolved(identity, noChild.runId), false);
    await storage.close(); storage = null;

    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin", HOME: path.join(temp, "home"), TMPDIR: path.join(temp, "tmp"), LANG: "C",
      PT_RUNTIME_DIR: path.join(temp, "runtime"), PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: path.join(temp, "logs"), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: "127.0.0.1",
      PT_TEST_SHUTDOWN_TOKEN: shutdownToken, PT_KEY_LIVE_VERIFY: "0", PT_HEARTBEAT_ENABLED: "0",
    };
    for (const name of ["HOME", "TMPDIR", "PT_RUNTIME_DIR", "PT_LOG_DIR"]) fs.mkdirSync(env[name], { recursive: true });
    child = spawn(process.execPath, ["shell/server.cjs", "--port", String(port)], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try { if ((await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, `fixture server did not start: ${output}`);

    const stop = async (runId) => {
      const response = await fetch(origin + "/api/chat/stop", {
        method: "POST",
        headers: { Cookie: `pt_session=${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.runId, runId);
      return body;
    };
    assert.equal((await stop(withChild.runId)).upstreamMayStillRun, true,
      "child manual_check must be reflected even when parent externalState is empty");
    assert.equal((await stop(noChild.runId)).upstreamMayStillRun, false,
      "an otherwise ordinary Run without external operations has no unresolved provider work");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await fetch(origin + "/__test_shutdown", {
          method: "POST", headers: { "x-shutdown-token": shutdownToken }, signal: AbortSignal.timeout(1500),
        });
      } catch { child.kill("SIGTERM"); }
      await waitForClose(child).catch(() => child.kill("SIGKILL"));
    }
    await storage?.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
