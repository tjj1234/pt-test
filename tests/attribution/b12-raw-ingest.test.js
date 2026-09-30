"use strict";
/**
 * B12 验收：SS-GTM 原始事件接入（raw-collect）全链路。
 *
 * 覆盖：
 *   1) 映射存储默认兜底：page_view/pageview → visit，且是最低优先级，
 *      租户自定义配置必须优先、绝不覆盖默认表；
 *   2) raw-collect 路由（经 buildUnifiedServer 真装配）：
 *      page_view（无 event_id）→ A17 归一化 → collect 三件套校验 → 入队；
 *      缺 Secret 401 / 错 Secret 403 / 未知端点 403 / 未映射事件 422 / 非法体 400；
 *   3) 原 collect 路由零改动回归：仍拒绝 page_view、仍卡 event_id、Secret 鉴权一致。
 *
 * 不修改 analytics/backend/collect/server.js / validate.js（只读引用）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sha256Hex, createPgCompatPool } = require("../../analytics/lib/db.cjs");
const { buildUnifiedServer } = require("../../analytics/backend/server");
const {
  createIngestionAdapter,
  DEFAULT_EVENT_MAPPINGS,
} = require("../../business/attribution/ingestion-adapter");
const { createEventMappingStore } = require("../../business/attribution/ingestion-adapter/mapping-store");
// 只读引用 Collect 校验；绝不修改该文件
const { validateEvent } = require("../../analytics/backend/collect/validate");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const TENANT = "33333333-3333-4333-8333-333333333333";
const WS = "ws_b12";
const SECRET = "b12-test-secret";
const SECRET_HASH = sha256Hex(SECRET);

function postJson(url, secret, payload) {
  return {
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-pt-webhook-secret": secret } : {}),
    },
    payload: JSON.stringify(payload),
  };
}

async function run() {
  // ── ① 映射存储默认兜底（最低优先级，绝不覆盖租户配置）──────────────
  const mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-b12-map-"));
  const store = createEventMappingStore({ storageDir: mapDir });
  const mws = "ws_b12_map";

  let r = store.resolve(mws, "page_view");
  assert(r.target === "visit" && r.configured === false && r.defaultMapped === true,
    "default page_view→visit");
  r = store.resolve(mws, "pageview");
  assert(r.target === "visit" && r.defaultMapped === true, "default pageview→visit");
  r = store.resolve(mws, "sign_up");
  assert(r.target === "signup" && r.defaultMapped === true, "default sign_up→signup");
  r = store.resolve(mws, "visit");
  assert(r.target === "visit" && r.passthrough === true && !r.defaultMapped,
    "whitelist passthrough (not default)");
  r = store.resolve(mws, "weird_custom");
  assert(r.target === null, "unknown name unmapped");

  store.putMappings(mws, { page_view: "signup" });
  r = store.resolve(mws, "page_view");
  assert(r.target === "signup" && r.configured === true && r.defaultMapped !== true,
    "custom config overrides default");

  assert(DEFAULT_EVENT_MAPPINGS.page_view === "visit", "DEFAULT_EVENT_MAPPINGS exported");
  assert(DEFAULT_EVENT_MAPPINGS.sign_up === "signup", "sign_up default mapping exported");

  // ── ② raw-collect 路由（真装配 buildUnifiedServer）──────────────────
  const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-b12-adapter-"));
  const adapter = createIngestionAdapter({ storageDir: adapterDir });

  const enqueued = [];
  const endpoints = new Map([
    ["wh_b12", { webhook_id: "wh_b12", tenant_id: TENANT, secret_hash: SECRET_HASH, status: "active" }],
  ]);
  const resolveEndpoint = async (id) => endpoints.get(id) ?? null;
  const enqueue = async (env) => { enqueued.push(env); return true; };
  const resolveWorkspaceId = async (tenantId) => (tenantId === TENANT ? WS : null);

  // A22 起 buildUnifiedServer 会把 pool 一路传给 createImportStore，
  // 后者强制要求真实 pool（带 .connect），空对象会直接抛错。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-b12-db-"));
  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });

  const app = buildUnifiedServer({
    resolveEndpoint,
    enqueue,
    resolveWorkspaceId,
    adapter,
    verifyAnalyticsToken: async () => null,
    pool,
    loadAuditLogs: async () => [],
    loadConfigFindings: async () => [],
    logger: false,
  });

  const rawUrl = "/api/v1/raw-collect/wh_b12";

  // (a) 真实原始 page_view（无 event_id）→ 归一化 → 入队
  let res = await app.inject(postJson(rawUrl, SECRET, { event_name: "page_view", visitor_id: "v1" }));
  assert(res.statusCode === 200, "raw page_view 200: " + res.body);
  let body = res.json();
  assert(body.ok === true && typeof body.event_id === "string", "response carries event_id");
  assert(enqueued.length === 1, "one envelope enqueued");
  assert(enqueued[0].tenant_id === TENANT, "tenant injected from endpoint (never from body)");
  assert(enqueued[0].event.event_name === "visit", "page_view normalized to visit");
  assert(enqueued[0].event.event_id === body.event_id, "enqueued id == response id");
  assert(validateEvent(enqueued[0].event).ok, "enqueued event passes collect three-piece validation");

  // (a2) GA4 sign_up + UTM/user_id → 默认映射为 signup 并完整入队
  res = await app.inject(postJson(rawUrl, SECRET, {
    event_name: "sign_up",
    timestamp: 1725000000000,
    user_id: "8022",
    utm_source: "x",
    utm_medium: "paid_social",
    utm_campaign: "202609",
  }));
  assert(res.statusCode === 200, "raw sign_up 200: " + res.body);
  assert(enqueued.length === 2, "sign_up envelope enqueued");
  assert(enqueued[1].event.event_name === "signup", "sign_up normalized to signup");
  assert(enqueued[1].event.user_id === "8022", "sign_up preserves product user_id");
  assert(enqueued[1].event.utm_source === "x", "sign_up preserves UTM fields");

  // (b) 缺 Secret → 401，且不入队
  enqueued.length = 0;
  res = await app.inject(postJson(rawUrl, undefined, { event_name: "page_view" }));
  assert(res.statusCode === 401, "missing secret 401");
  assert(enqueued.length === 0, "no enqueue on 401");

  // (c) 错 Secret → 403
  res = await app.inject(postJson(rawUrl, "wrong-secret", { event_name: "page_view" }));
  assert(res.statusCode === 403, "wrong secret 403");

  // (d) 未知端点 → 403
  res = await app.inject(postJson("/api/v1/raw-collect/wh_unknown", SECRET, { event_name: "page_view" }));
  assert(res.statusCode === 403, "unknown endpoint 403");

  // (e) 未映射事件名 → 422 且文案清晰
  res = await app.inject(postJson(rawUrl, SECRET, { event_name: "weird_custom", timestamp: 1 }));
  assert(res.statusCode === 422, "unmapped 422: " + res.body);
  body = res.json();
  assert(body.error && body.error.code === "UNMAPPED_EVENT_NAME", "unmapped code");
  assert(/未映射/.test(body.error.message), "unmapped message human-readable");

  // (f) 缺 event_name → 400
  res = await app.inject(postJson(rawUrl, SECRET, { visitor_id: "v1" }));
  assert(res.statusCode === 400, "missing event_name 400");

  // (g) 非对象 body → 400
  res = await app.inject(postJson(rawUrl, SECRET, [1, 2, 3]));
  assert(res.statusCode === 400, "array body 400");

  // (h) 租户自定义映射优先：page_view → signup（不再走默认 visit）
  adapter.putMapping(WS, { page_view: "signup" });
  res = await app.inject(postJson(rawUrl, SECRET, { event_name: "page_view", visitor_id: "v2" }));
  assert(res.statusCode === 200, "custom-mapped 200");
  const lastEnv = enqueued[enqueued.length - 1];
  assert(lastEnv.event.event_name === "signup", "custom config overrides default (page_view→signup)");

  // ── ③ 原 collect 路由零改动回归 ────────────────────────────────────
  const collectUrl = "/api/v1/collect/wh_b12";
  const nativeId = "7f9c24a0-1111-4111-8111-111111111111";

  // collect 仍收白名单规范化事件，事件体原样透传（不做适配）
  enqueued.length = 0;
  res = await app.inject(postJson(collectUrl, SECRET, {
    event_id: nativeId, event_name: "visit", timestamp: 1725000000000, visitor_id: "c1",
  }));
  assert(res.statusCode === 200, "collect valid 200: " + res.body);
  assert(enqueued.length === 1, "collect enqueued");
  assert(enqueued[0].event.event_id === nativeId, "collect passes body unchanged");
  assert(enqueued[0].event.event_name === "visit", "collect event_name unchanged");
  assert(enqueued[0].event.visitor_id === "c1", "collect extra field passthrough");

  // collect 仍拒绝 page_view（不在白名单，不做适配）→ 400
  enqueued.length = 0;
  res = await app.inject(postJson(collectUrl, SECRET, { event_name: "page_view", timestamp: 1725000000000 }));
  assert(res.statusCode === 400, "collect rejects non-whitelist page_view (no adaptation)");
  assert(enqueued.length === 0, "collect no enqueue on invalid");

  // collect 仍卡 event_id → 400
  res = await app.inject(postJson(collectUrl, SECRET, { event_name: "visit", timestamp: 1725000000000 }));
  assert(res.statusCode === 400, "collect missing event_id 400");

  // collect 仍卡 Secret → 401 / 403
  res = await app.inject(postJson(collectUrl, undefined, { event_id: nativeId, event_name: "visit", timestamp: 1725000000000 }));
  assert(res.statusCode === 401, "collect missing secret 401");
  res = await app.inject(postJson(collectUrl, "wrong-secret", { event_id: nativeId, event_name: "visit", timestamp: 1725000000000 }));
  assert(res.statusCode === 403, "collect wrong secret 403");

  await app.close();
  await pool.end();

  console.log(JSON.stringify({
    ok: true,
    defaultMapping: {
      page_view: "visit",
      pageview: "visit",
      sign_up: "signup",
      customOverrides: true,
      passthroughWhitelist: true,
    },
    rawIngest: {
      normalizedToVisit: true,
      tenantFromEndpoint: true,
      missingSecret: 401,
      wrongSecret: 403,
      unknownEndpoint: 403,
      unmapped: 422,
      missingEventName: 400,
      arrayBody: 400,
      customConfigOverridesDefault: true,
    },
    collectRegression: {
      validPassesThrough: true,
      rejectsPageView: 400,
      missingEventId: 400,
      missingSecret: 401,
      wrongSecret: 403,
    },
  }, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
