import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const { createTaskStore } = require("../../shell/tasks/store.cjs");
const { createExternalOperationsWorker } = require("../../shell/tasks/external-operations-worker.cjs");
const { createPowerTokensQueryAdapters } = require("../../shell/tasks/provider-adapters.cjs");
const execFileAsync = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const NOW = "2026-10-18T00:00:00.000Z";
const operationKey = "image:process-restart-unknown-state";
const taskId = "known-task-process-restart";

function queryAdapters(requests, responseStatus = "unmapped-provider-state") {
  return createPowerTokensQueryAdapters({
    baseUrl: "https://fixture.invalid",
    providerMappings: {
      fixture: {
        kind: "image",
        successStatuses: new Set(["complete"]),
        failureStatuses: new Set(["failed"]),
        pendingStatuses: new Set(),
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ status: responseStatus }),
      };
    },
  });
}

function worker(operations, requests, owner) {
  return createExternalOperationsWorker({
    store: operations,
    queryAdapters: queryAdapters(requests),
    credentialProvider: async () => "fixture-only",
    owner,
    clock: { now: () => NOW, setInterval: () => ({ unref() {} }), clearInterval() {} },
  });
}

async function fixtureProcess(stage, dir, prior = null) {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false,
    "fixture must use isolated PGlite, never an external database");
  const storage = await createStorage({ dataDir: path.join(dir, "db"), masterKeyFile: path.join(dir, "key") });
  let queryWorker;
  try {
    const runs = createTaskStore(storage.adapter);
    const operations = runs.externalOperations;
    let identity;
    let runId;
    if (stage === "write") {
      const user = await storage.repositories.auth.register({ username: "manual-check-process-restart", password: "FixturePass123" });
      identity = { userId: user.user.id, tenantId: user.user.tenant_id };
      const conversation = await storage.repositories.conversations.create(identity.userId);
      const owner = "first-process-parent-owner";
      let run = (await runs.createRun(identity, {
        conversationId: conversation.id,
        idempotencyKey: "manual-check-process-restart",
        policyVersion: "fixture",
        request: { question: "create an image", attachments: [] },
      }, { owner, ttlMs: 30_000 })).run;
      run = await runs.transition(identity, run.runId, "running", run.revision, owner);
      await operations.createIntent(identity, run.runId, { operationKey, provider: "fixture", runLeaseOwner: owner });
      await operations.recordTaskId(identity, run.runId, operationKey, { taskId, runLeaseOwner: owner });
      await runs.releaseLease(identity, run.runId, owner);
      runId = run.runId;
    } else {
      assert.equal(stage, "reopen");
      assert.ok(prior?.identity && prior?.runId);
      ({ identity, runId } = prior);
      await runs.recoverInterrupted(identity);
    }

    const requests = [];
    queryWorker = worker(operations, requests, `${stage}-process-query-worker`);
    assert.deepEqual(await queryWorker.runOnce(), { processed: stage === "write" ? 1 : 0 });
    const operation = await operations.get(identity, runId, operationKey);
    const run = await runs.getRun(identity, runId);
    const events = (await runs.eventsAfter(identity, runId)).events;
    assert.equal(operation.status, "manual_check");
    assert.equal(operation.taskId, taskId);
    assert.equal(operation.queryAttempts, 1);
    assert.deepEqual(operation.lastQuery, {
      outcome: "provider_state_unknown", observedAt: NOW, providerStatus: null,
      reason: "unrecognized_provider_state", attempt: 1, queried: true,
    });
    assert.equal(run.state, "waiting_external");
    assert.equal(events.some((event) => event.type === "done"), false);
    assert.deepEqual(requests, stage === "write"
      ? [{ url: `https://fixture.invalid/v1/tasks/${taskId}`, method: "GET" }]
      : [], "reopened process must not GET or POST the known task again");
    process.stdout.write(`RESULT:${JSON.stringify({ identity, runId, requests })}\n`);
  } finally {
    if (queryWorker) await queryWorker.stop();
    await storage.close();
  }
}

if (process.argv[2] === "--fixture-process") {
  const [, , , stage, dir, priorJson] = process.argv;
  await fixtureProcess(stage, dir, priorJson ? JSON.parse(priorJson) : null);
} else {
  test("manual_check known task survives OS process restart without a second GET or POST", async () => {
    assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false,
      "fixture must use isolated PGlite, never an external database");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-manual-check-process-restart-"));
    const runStage = async (stage, prior) => {
      const args = [script, "--fixture-process", stage, dir];
      if (prior) args.push(JSON.stringify(prior));
      const { stdout } = await execFileAsync(process.execPath, args, { timeout: 30_000, maxBuffer: 64 * 1024 });
      const result = stdout.split("\n").find((line) => line.startsWith("RESULT:"));
      assert.ok(result, `missing ${stage} process result`);
      return JSON.parse(result.slice("RESULT:".length));
    };
    try {
      const initial = await runStage("write");
      const reopened = await runStage("reopen", { identity: initial.identity, runId: initial.runId });
      assert.equal(reopened.runId, initial.runId);
      assert.deepEqual(reopened.identity, initial.identity);
      assert.equal(initial.requests.length, 1);
      assert.deepEqual(reopened.requests, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
