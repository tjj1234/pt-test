import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const { createTaskStore } = require("../../shell/tasks/store.cjs");
const { createSessionScheduler } = require("../../shell/runtime/session-scheduler.cjs");
const { createRunExecutionService } = require("../../shell/tasks/execution.cjs");

test("response lost after durable Run admission; retry after completion replays without a second provider call", { timeout: 15000 }, async (t) => {
  assert.equal(
    Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]),
    false,
    "This fixture must use isolated local PGlite, not an externally configured PostgreSQL database",
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t03-lost-ack-replay-"));
  let storage;
  let scheduler;
  let acceptedBeforeResponseLoss;
  try {
    storage = await createStorage({ dataDir: path.join(dir, "db"), masterKeyFile: path.join(dir, "key") });
    const registered = await storage.repositories.auth.register({
      username: "t03-lost-ack-" + Date.now(),
      password: "FixturePass123",
    });
    assert.equal(registered.ok, true);
    const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    scheduler = createSessionScheduler({ perUserLimit: 1, globalLimit: 1 });

    let providerCalls = 0;
    const service = createRunExecutionService({
      store: createTaskStore(storage.adapter),
      scheduler,
      processId: "t03-lost-ack-fixture",
      executor: async ({ emit }) => {
        providerCalls++;
        await emit("connecting", { phase: "model" });
        return { ok: true, providerResult: "fixture" };
      },
    });

    const request = {
      conversationId: conversation.id,
      idempotencyKey: "lost-response-after-admission",
      request: { questionHash: "fixture-question-hash" },
    };
    let clientAttempts = 0;
    const submitThroughLostResponse = async () => {
      clientAttempts++;
      const accepted = await service.submit(identity, request);
      if (clientAttempts === 1) {
        acceptedBeforeResponseLoss = accepted;
        // The server durably admitted this Run, but the client received no acknowledgement.
        throw new TypeError("simulated response loss after durable admission");
      }
      return accepted;
    };

    await assert.rejects(submitThroughLostResponse(), /simulated response loss/);
    await acceptedBeforeResponseLoss.execution.result;

    const replay = await submitThroughLostResponse();
    assert.equal(clientAttempts, 2);
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.runId, acceptedBeforeResponseLoss.run.runId);
    assert.equal(replay.run.state, "completed");
    assert.equal(replay.execution, null, "completed Run replay does not schedule another execution");
    assert.equal(providerCalls, 1, "retry after a lost response must not call the provider twice");

    const stored = await createTaskStore(storage.adapter).getRun(identity, replay.run.runId);
    assert.equal(stored.state, "completed");
  } finally {
    await Promise.allSettled([scheduler?.close(), storage?.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

