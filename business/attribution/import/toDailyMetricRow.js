"use strict";
/**
 * CanonicalAdRecord → upsertDailyMetric(client, row) 入参。
 *
 * 粒度：level=creative / entity_id=creativeId
 * （与 seed、funnel 的 utm_content ↔ creative 对齐；Canonical 必填 creativeId。）
 */
const {
  computeCtr,
  computeCpm,
  computeCpc,
  buildIdempotencyKey,
} = require("../../../analytics/backend/ads/ingest");

function round6(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.000000";
  return x.toFixed(6);
}

/**
 * @param {object} rec CanonicalAdRecord
 * @returns {object} upsertDailyMetric row
 */
function toDailyMetricRow(rec) {
  if (!rec || typeof rec !== "object") {
    throw Object.assign(new Error("CanonicalAdRecord 必填"), { code: "BAD_RECORD" });
  }
  const workspaceId = String(rec.workspaceId || "").trim();
  const platform = String(rec.provider || rec.sourceProvider || "").toLowerCase();
  const accountId = String(rec.accountId || "").trim();
  const entityId = String(rec.creativeId || "").trim();
  const date = String(rec.date || "").trim();
  const currency = String(rec.currency || "").trim().toUpperCase();

  if (!workspaceId || !platform || !accountId || !entityId || !date || !currency) {
    throw Object.assign(new Error("缺落库主键字段"), { code: "BAD_RECORD" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error("date 须为 YYYY-MM-DD"), { code: "BAD_RECORD" });
  }

  const level = "creative";
  const spendNum = Number(rec.spend) || 0;
  const impressions = Math.max(0, Math.trunc(Number(rec.impressions) || 0));
  const clicks = Math.max(0, Math.trunc(Number(rec.clicks) || 0));
  const conversions =
    rec.conversions == null || rec.conversions === ""
      ? 0
      : Number(rec.conversions) || 0;

  const ctr = computeCtr(clicks, impressions);
  const cpm = computeCpm(spendNum, impressions);
  const cpc = computeCpc(spendNum, clicks);

  const spend = round6(spendNum);
  const amountUsd = currency === "USD" ? spend : null;

  const dataSource =
    rec.rawSource === "xlsx_export" || rec.rawSource === "csv_export"
      ? rec.rawSource
      : "csv_export";

  return {
    workspaceId,
    platform,
    accountId,
    entityId,
    level,
    date,
    localDate: date,
    spend,
    impressions,
    clicks,
    conversions: round6(conversions),
    ctr: ctr === null ? null : round6(ctr),
    cpm: cpm === null ? null : round6(cpm),
    cpc: cpc === null ? null : round6(cpc),
    roas: null,
    currency,
    amountUsd,
    fxRate: null,
    fxDate: null,
    dataSource,
    idempotencyKey: buildIdempotencyKey(
      workspaceId,
      platform,
      accountId,
      entityId,
      level,
      date,
      rec.sourceFileId || "import",
      String(rec.sourceRowNumber || "")
    ),
  };
}

module.exports = { toDailyMetricRow };
