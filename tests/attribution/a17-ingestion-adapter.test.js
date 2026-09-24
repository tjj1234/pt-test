"use strict";
/**
 * A17 验收：适配层补齐三件套 → Collect validateEvent 全绿；
 * 连接测试对密钥错误 / 502 返回准确人话诊断；质量统计可读。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createIngestionAdapter,
  diagnoseHttpStatus,
  DIAG,
} = require("../../business/attribution/ingestion-adapter");
// 只读引用 Collect 校验；绝不修改该文件
const { validateEvent } = require("../../analytics/backend/collect/validate");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a17-"));
  const adapter = createIngestionAdapter({ storageDir: dir });
  const ws = "ws_a17_test";

  adapter.putMapping(ws, {
    page_view: "visit",
    CompleteRegistration: "signup",
    noise_ping: "ignore",
  });

  const receivedAtMs = 1_725_000_000_000;

  // ① 缺 event_id + 缺 timestamp + 原始名需映射
  const a1 = adapter.adapt(ws, { event_name: "page_view", visitor_id: "v1" }, { receivedAtMs });
  assert(a1.ok && a1.event, "adapt page_view");
  assert(a1.event.event_name === "visit", "mapped to visit");
  assert(a1.quality.event_id_source === "adapter_fallback", "id fallback");
  assert(a1.quality.event_id_is_client_native_unique === false, "not native");
  assert(a1.quality.timestamp_source === "received_at_fallback", "ts fallback");
  assert(a1.event.timestamp === receivedAtMs, "ts = received");
  const v1 = validateEvent(a1.event);
  assert(v1.ok, "collect validate missing-id/ts: " + JSON.stringify(v1.errors));

  // ② 非法 event_id 格式 → 确定性兜底，且同输入同 UUID
  const a2a = adapter.adapt(ws, { event_name: "page_view", event_id: "not-a-uuid", timestamp: 100 });
  const a2b = adapter.adapt(ws, { event_name: "page_view", event_id: "not-a-uuid", timestamp: 100 });
  assert(a2a.event.event_id === a2b.event.event_id, "deterministic id");
  assert(validateEvent(a2a.event).ok, "collect validate bad-id");

  // ③ 合法客户端 UUID 保留 + 质量标记
  const nativeId = "7f9c24a0-1111-4111-8111-111111111111";
  const a3 = adapter.adapt(ws, {
    event_name: "CompleteRegistration",
    event_id: nativeId,
    timestamp: 1_725_000_000_111,
  });
  assert(a3.event.event_name === "signup", "signup map");
  assert(a3.event.event_id === nativeId, "keep native id");
  assert(a3.quality.event_id_is_client_native_unique === true, "native flag");
  assert(a3.quality.timestamp_source === "client", "client ts");
  assert(validateEvent(a3.event).ok, "collect validate native");

  // ④ 未映射事件名
  const a4 = adapter.adapt(ws, { event_name: "weird_custom", timestamp: 1 });
  assert(!a4.ok && a4.quality.unmapped, "unmapped");
  assert(a4.error.code === "UNMAPPED_EVENT_NAME", "unmapped code");

  // ⑤ ignore
  const a5 = adapter.adapt(ws, { event_name: "noise_ping", timestamp: 1 });
  assert(a5.ok && a5.ignored, "ignored");

  // ⑥ 白名单原名直通（无配置）
  const a6 = adapter.adapt(ws, {
    event_name: "model_call",
    event_id: nativeId,
    timestamp: 99,
  });
  assert(a6.ok && a6.event.event_name === "model_call", "passthrough whitelist");
  assert(validateEvent(a6.event).ok, "collect validate passthrough");

  // 连接测试：密钥错误 (401)
  const secretBad = await adapter.testConnection(ws, {
    collectUrl: "https://collect.example/api/v1/collect/wh_1",
    secret: "wrong-secret",
    event: a1.event,
    fetch: async () => ({
      status: 401,
      text: async () => JSON.stringify({ error: { code: "INVALID_SECRET" } }),
    }),
  });
  assert(!secretBad.ok, "secret bad not ok");
  assert(secretBad.diagnosis.code === "SECRET_INVALID", "secret diagnosis");
  assert(/密钥/.test(secretBad.diagnosis.title + secretBad.diagnosis.hint), "secret 人话");

  // 连接测试：502
  const badGw = await adapter.testConnection(ws, {
    collectUrl: "https://collect.example/api/v1/collect/wh_1",
    secret: "ok-secret",
    event: a1.event,
    fetch: async () => ({
      status: 502,
      text: async () => "Bad Gateway",
    }),
  });
  assert(!badGw.ok, "502 not ok");
  assert(badGw.diagnosis.code === "TARGET_BAD_GATEWAY", "502 code");
  assert(/502/.test(badGw.diagnosis.title + badGw.diagnosis.hint), "502 人话");

  // 单元诊断函数快照
  assert(diagnoseHttpStatus(401, "INVALID_SECRET").code === DIAG.SECRET_INVALID.code, "diag 401");
  assert(diagnoseHttpStatus(502, "").code === DIAG.TARGET_BAD_GATEWAY.code, "diag 502");

  const stats = adapter.getQualityStats(ws);
  assert(stats.unmappedEventCount >= 1, "stats unmapped");
  assert(stats.eventIdQuality.adapter_fallback >= 1, "stats id fallback");
  assert(stats.timestampFallback.count >= 1, "stats ts fallback");
  assert(stats.ignored >= 1, "stats ignored");

  console.log(
    JSON.stringify(
      {
        ok: true,
        collectValidate: {
          missingIdTs: v1.ok,
          badId: validateEvent(a2a.event).ok,
          native: validateEvent(a3.event).ok,
        },
        qualityFlags: {
          fallbackId: a1.quality.event_id_is_client_native_unique === false,
          nativeId: a3.quality.event_id_is_client_native_unique === true,
        },
        connectionTest: {
          secretInvalid: secretBad.diagnosis,
          badGateway: badGw.diagnosis,
        },
        stats: {
          unmappedEventCount: stats.unmappedEventCount,
          eventIdFallback: stats.eventIdQuality.adapter_fallback,
          timestampFallbackRatio: stats.timestampFallback.ratio,
          ignored: stats.ignored,
        },
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
