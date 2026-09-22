"use strict";
/**
 * A0 Contract 加载与轻量校验（无外部 JSON Schema 依赖）。
 * A1+ Parser / Workflow 必须引用本包导出的枚举与形状检查。
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  PROVIDERS,
  EVENT_NAMES,
  IMPORT_STATUSES,
  ATTRIBUTION_MODELS,
  PANEL_TABS,
  INVARIANTS,
  isUuid,
  isProvider,
  isEventName,
} = require("./invariants");

const ROOT = __dirname;

function loadJson(name) {
  const p = path.join(ROOT, name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const CONTRACTS = Object.freeze({
  context: loadJson("context.json"),
  canonicalAd: loadJson("canonical-ad.json"),
  canonicalEvent: loadJson("canonical-event.json"),
  attributionResult: loadJson("attribution-result.json"),
  importJob: loadJson("import-job.json"),
  healthReport: loadJson("health-report.json"),
  panelRegistration: loadJson("panel-registration.json"),
  toolRegistration: loadJson("tool-registration.json"),
  workflows: loadJson("workflows.json"),
  freeze: loadJson("freeze.json"),
});

function fail(errors, msg) {
  errors.push(msg);
}

function assertCanonicalAd(row, errors = []) {
  if (!row || typeof row !== "object") {
    fail(errors, "CanonicalAdRecord 必须是对象");
    return errors;
  }
  if (!isProvider(row.provider)) fail(errors, "provider 非法");
  if (!isProvider(row.sourceProvider)) fail(errors, "sourceProvider 非法");
  if (typeof row.workspaceId !== "string" || !row.workspaceId) fail(errors, "workspaceId 必填");
  if (typeof row.accountId !== "string" || !row.accountId) fail(errors, "accountId 必填");
  if (typeof row.campaignId !== "string" || !row.campaignId) fail(errors, "campaignId 必填");
  if (typeof row.creativeId !== "string" || !row.creativeId) fail(errors, "creativeId 必填");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ""))) fail(errors, "date 需 YYYY-MM-DD");
  if (typeof row.currency !== "string" || row.currency.length !== 3) fail(errors, "currency 需 3 位");
  for (const k of ["spend", "impressions", "clicks"]) {
    if (typeof row[k] !== "number" || !(row[k] >= 0)) fail(errors, `${k} 需非负数字`);
  }
  if (!Number.isInteger(row.impressions) || !Number.isInteger(row.clicks)) {
    fail(errors, "impressions/clicks 需整数");
  }
  if (!row.sourceFileId) fail(errors, "sourceFileId 必填");
  if (!Number.isInteger(row.sourceRowNumber) || row.sourceRowNumber < 1) {
    fail(errors, "sourceRowNumber 需 >=1 整数");
  }
  if (row.rawSource !== "csv_export" && row.rawSource !== "xlsx_export") {
    fail(errors, "rawSource 一期仅 csv_export|xlsx_export");
  }
  return errors;
}

function assertCanonicalEvent(row, errors = []) {
  if (!row || typeof row !== "object") {
    fail(errors, "CanonicalEvent 必须是对象");
    return errors;
  }
  if (!isUuid(row.tenantId)) fail(errors, "tenantId 需 UUID（来自 Context）");
  if (!row.workspaceId) fail(errors, "workspaceId 必填");
  if (!isUuid(row.eventId)) fail(errors, "eventId 需 UUID");
  if (!isEventName(row.eventName)) fail(errors, "eventName 不在白名单");
  if (!Number.isInteger(row.timestamp) || row.timestamp < 0) fail(errors, "timestamp 需非负整数毫秒");
  if (!row.rawEvent || typeof row.rawEvent !== "object" || Array.isArray(row.rawEvent)) {
    fail(errors, "rawEvent 必填且为对象（与标准化字段分离）");
  }
  if (typeof row.receivedAt !== "string") fail(errors, "receivedAt 必填");
  return errors;
}

function assertImportStatus(status, errors = []) {
  if (!IMPORT_STATUSES.includes(status)) fail(errors, `import status 非法: ${status}`);
  return errors;
}

function assertAttributionResult(row, errors = []) {
  if (!row || typeof row !== "object") {
    fail(errors, "AttributionResultRow 必须是对象");
    return errors;
  }
  if (!ATTRIBUTION_MODELS.includes(row.attributionModel)) fail(errors, "attributionModel 非法");
  if (!["matched", "ambiguous_name", "no_match", "partial"].includes(row.confidence)) {
    fail(errors, "confidence 非法");
  }
  if (row.provider != null && !isProvider(row.provider)) fail(errors, "provider 非法");
  return errors;
}

/** 冒烟：合约文件齐全 + 样例形状通过 */
function selfCheck() {
  const report = { ok: true, errors: [], files: Object.keys(CONTRACTS) };
  const adErrors = assertCanonicalAd({
    workspaceId: "ws_demo",
    provider: "meta",
    accountId: "act_1",
    campaignId: "c1",
    adGroupId: null,
    creativeId: "ad_1",
    creativeName: "hook",
    campaignName: "launch",
    date: "2026-09-01",
    currency: "USD",
    spend: 1.5,
    impressions: 10,
    clicks: 2,
    conversions: null,
    revenue: null,
    rawSource: "csv_export",
    importedAt: "2026-09-21T00:00:00.000Z",
    sourceFileId: "file_1",
    sourceRowNumber: 2,
    sourceProvider: "meta",
    sourceVersion: "a0.1",
  });
  const evErrors = assertCanonicalEvent({
    tenantId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "ws_demo",
    eventId: "7f9c24a0-1111-4111-8111-111111111111",
    eventName: "visit",
    timestamp: 1720000000000,
    visitorId: "v1",
    userId: null,
    sessionId: null,
    utmSource: "meta",
    utmMedium: "paid",
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    country: null,
    amount: null,
    currency: null,
    model: null,
    totalTokens: null,
    rawEvent: { event_id: "7f9c24a0-1111-4111-8111-111111111111", event_name: "visit" },
    receivedAt: "2026-09-21T00:00:00.000Z",
    webhookId: "wh_1",
  });
  report.errors.push(...adErrors.map((e) => `ad: ${e}`), ...evErrors.map((e) => `event: ${e}`));
  if (!CONTRACTS.freeze || CONTRACTS.freeze.status !== "frozen") {
    report.errors.push("freeze.json status 必须为 frozen");
  }
  if (PANEL_TABS.length !== 5) report.errors.push("PANEL_TABS 必须 5 个");
  report.ok = report.errors.length === 0;
  return report;
}

module.exports = {
  CONTRACTS,
  PROVIDERS,
  EVENT_NAMES,
  IMPORT_STATUSES,
  ATTRIBUTION_MODELS,
  PANEL_TABS,
  INVARIANTS,
  isUuid,
  isProvider,
  isEventName,
  assertCanonicalAd,
  assertCanonicalEvent,
  assertImportStatus,
  assertAttributionResult,
  selfCheck,
  loadJson,
};

if (require.main === module) {
  const r = selfCheck();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
