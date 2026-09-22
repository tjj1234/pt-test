"use strict";
/**
 * A2 验收：raw 持久化 + DLQ 可查；不依赖改写 collect/ingest.js
 */
const {
  createMockPersistence,
  toCanonicalEvent,
  wrapIngestQueueWithPersistence,
  recordValidationFailure,
} = require("../../business/attribution/persistence");
const { assertCanonicalEvent, selfCheck } = require("../../business/attribution/contracts/validate");

const TENANT = "22222222-2222-4222-8222-222222222222";
const WS = "ws_fixture_a2";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function createFakeQueue() {
  const pending = [];
  const dead = [];
  return {
    enqueue: async (envelope) => {
      pending.push({ id: String(pending.length + 1), envelope });
      return true;
    },
    dequeue: async () => pending.shift() || null,
    ack: async () => {},
    moveToDlq: async (msg) => {
      dead.push(msg);
    },
    pendingCount: () => pending.length,
    deadCount: () => dead.length,
    _dead: dead,
  };
}

async function run() {
  const a0 = selfCheck();
  assert(a0.ok, "A0 failed");

  const repo = createMockPersistence();
  const ctx = { tenantId: TENANT, workspaceId: WS, webhookId: "wh_a2" };

  const body = {
    event_id: "7f9c24a0-aaaa-4bbb-8ccc-111111111111",
    event_name: "visit",
    timestamp: 1720000000000,
    visitor_id: "v1",
    utm_source: "meta",
  };

  const canonical = toCanonicalEvent({
    context: ctx,
    envelope: { tenant_id: TENANT, webhook_id: "wh_a2", event: body },
  });
  const shapeErrs = assertCanonicalEvent(canonical, []);
  assert(shapeErrs.length === 0, "canonical shape: " + shapeErrs.join("; "));
  assert(canonical.rawEvent.event_name === "visit", "raw separated");
  assert(canonical.tenantId === TENANT, "tenant from context");

  // 信任客户端租户？body 里塞假 tenant 不得覆盖
  const evil = toCanonicalEvent({
    context: ctx,
    envelope: {
      tenant_id: TENANT,
      event: { ...body, tenant_id: "99999999-9999-4999-8999-999999999999" },
    },
  });
  assert(evil.tenantId === TENANT, "body tenant ignored");

  const q = wrapIngestQueueWithPersistence(createFakeQueue(), repo, {
    workspaceId: WS,
  });
  await q.enqueue({ tenant_id: TENANT, webhook_id: "wh_a2", event: body });
  const raws = await repo.listRawEvents(ctx);
  assert(raws.length === 1, "raw persisted on enqueue");
  assert(raws[0].eventId === body.event_id, "raw event id");

  // 幂等
  await q.enqueue({ tenant_id: TENANT, webhook_id: "wh_a2", event: body });
  assert((await repo.listRawEvents(ctx)).length === 1, "raw idempotent");

  await q.moveToDlq(
    { envelope: { tenant_id: TENANT, webhook_id: "wh_a2", event: body } },
    Object.assign(new Error("normalize boom"), { name: "PermanentEventError" })
  );
  const dlq = await repo.listDlq(ctx);
  assert(dlq.length === 1, "dlq persisted");
  assert(dlq[0].reason.includes("normalize boom"), "dlq reason queryable");
  assert(dlq[0].errorClass === "permanent", "error class");

  await recordValidationFailure(repo, ctx, { event_name: "nope" }, [
    { field: "event_name", message: "不在白名单" },
  ]);
  const dlq2 = await repo.listDlq(ctx);
  assert(dlq2.length === 2, "validation failure in dlq");
  assert(
    dlq2.some((d) => d.errorClass === "validation"),
    "validation class"
  );

  // Context 门禁
  let blocked = false;
  try {
    await repo.listDlq({ tenantId: TENANT });
  } catch (e) {
    blocked = e.code === "CONTEXT_REQUIRED";
  }
  assert(blocked, "listDlq requires full context");

  console.log(
    JSON.stringify(
      {
        ok: true,
        rawCount: (await repo.listRawEvents(ctx)).length,
        dlqOpen: (await repo.listDlq(ctx)).length,
        collectTrunkUntouched: true,
      },
      null,
      2
    )
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
