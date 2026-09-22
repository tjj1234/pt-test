"use strict";
/**
 * A0 铁律（冻结）。后续 Parser / Collect / Workflow / Panel 不得违反。
 */
const PROVIDERS = Object.freeze(["google", "meta", "x"]);
const EVENT_NAMES = Object.freeze([
  "visit",
  "signup",
  "key_created",
  "model_call",
  "recharge",
  "auto_recharge_toggle",
]);
const IMPORT_STATUSES = Object.freeze([
  "pending",
  "validating",
  "ready",
  "importing",
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
]);
const ATTRIBUTION_MODELS = Object.freeze(["last_touch"]);
const PANEL_TABS = Object.freeze(["overview", "creatives", "users", "product", "health"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVARIANTS = Object.freeze({
  identityFromContextOnly:
    "tenantId / workspaceId 只来自 AttributionContext（secret 反查或 session），禁止读客户端 body / query / 文件行。",
  noClientTenantHeaderInBusiness:
    "业务线 Workflow 不信任 X-Tenant-Id；若基座注入，必须在 Adapter 内完成并写入 Context。记 Base Gap。",
  noSecondDatabase:
    "禁止第二套 PGlite / Pool。仓储只通过 base.storage（A8 前测试用 Mock Repository）。",
  noProductionDemoSeed:
    "生产（PT_ENV=production 或未显式 PT_ALLOW_DEMO_SEED=1）不得自动 seed 演示租户。",
  noFrontendRoi:
    "ROI / CPA / 漏斗人数由 Workflow 返回；前端只渲染。禁止用演示数字填空态。",
  eventIdempotency: "同一 (tenantId, eventId) 重放不得重复计数。",
  rawAndCanonicalSeparated: "原始事件 rawEvent 与标准化 CanonicalEvent 分字段保存。",
  illegalEventsToDlq: "非法事件进入持久化 DLQ / 错误记录，可查询，不丢弃无痕。",
  noOfficialAdsApiInA1: "A1 只解析导出文件，不做 Google/Meta/X OAuth 或官方 API。",
  noShellEdits:
    "本分支不修改 shell/server.cjs、tenant.cjs、persistent-runner.mjs、auth、DSH Adapter。",
});

function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}
function isProvider(v) {
  return PROVIDERS.includes(v);
}
function isEventName(v) {
  return EVENT_NAMES.includes(v);
}

module.exports = {
  PROVIDERS,
  EVENT_NAMES,
  IMPORT_STATUSES,
  ATTRIBUTION_MODELS,
  PANEL_TABS,
  INVARIANTS,
  isUuid,
  isProvider,
  isEventName,
};
