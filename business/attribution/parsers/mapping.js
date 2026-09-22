"use strict";
/**
 * A1 · 列映射（规则优先；无 AI 依赖，保证离线可测）
 * Canonical 字段对齐 contracts/canonical-ad.json
 */
const crypto = require("node:crypto");

const MAP_FIELDS = Object.freeze([
  "date",
  "accountId",
  "campaignId",
  "campaignName",
  "adGroupId",
  "creativeId",
  "creativeName",
  "spend",
  "impressions",
  "clicks",
  "conversions",
  "revenue",
  "currency",
]);

const REQUIRED_MAP = Object.freeze(["date", "spend", "impressions", "clicks"]);

const RULE_ALIASES = {
  date: [
    "date",
    "day",
    "reporting starts",
    "reporting start",
    "日期",
    "开始日期",
    "单日",
    "time period",
    "day start",
    "date start",
    "date_start",
    "segments.date",
  ],
  accountId: [
    "account id",
    "account_id",
    "ad account id",
    "customer id",
    "customer_id",
    "账户 id",
    "广告账户",
    "帐户编号",
  ],
  campaignId: ["campaign id", "campaign_id", "广告系列 id", "广告活动 id"],
  campaignName: [
    "campaign",
    "campaign name",
    "campaign_name",
    "系列",
    "广告系列",
    "广告活动",
  ],
  adGroupId: ["ad group id", "adset id", "ad set id", "adgroup id", "广告组 id"],
  creativeId: [
    "ad id",
    "ad_id",
    "creative id",
    "creative_id",
    "广告 id",
    "广告编号",
    "asset id",
    "tweet id",
  ],
  creativeName: [
    "ad name",
    "ad_name",
    "creative name",
    "creative",
    "广告名称",
    "素材名称",
    "ad title",
    "tweet text",
  ],
  spend: [
    "spend",
    "amount spent",
    "amount spent (usd)",
    "cost",
    "cost micros",
    "花费",
    "消耗",
    "费用",
    "metrics.cost",
    "total spend",
  ],
  impressions: ["impressions", "impr", "展示", "展示次数", "曝光", "metrics.impressions"],
  clicks: ["clicks", "link clicks", "链接点击", "点击", "点击次数", "metrics.clicks"],
  conversions: ["conversions", "conv", "转化", "results", "purchases"],
  revenue: ["revenue", "purchase value", "转化价值", "value", "conv value"],
  currency: ["currency", "currency code", "币种", "货币"],
};

/** 平台特征列，用于自动识别 provider */
const PROVIDER_HINTS = {
  google: ["customer id", "cost micros", "campaign status", "search keyword"],
  meta: ["reporting starts", "amount spent", "ad account id", "publisher platform"],
  x: ["tweet id", "promoted tweet", "tweet text", "engagements"],
};

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ");
}

function hasCjk(s) {
  return /[\u3400-\u9fff]/.test(s);
}

function aliasScore(headerNorm, aliasNorm) {
  if (!headerNorm || !aliasNorm) return 0;
  if (headerNorm === aliasNorm) return 1000 + aliasNorm.length;
  const tokens = headerNorm.split(" ");
  if (tokens.includes(aliasNorm)) return 800 + aliasNorm.length;
  if (hasCjk(aliasNorm) && aliasNorm.length >= 2 && headerNorm.includes(aliasNorm)) {
    return 600 + aliasNorm.length;
  }
  if (!hasCjk(aliasNorm) && aliasNorm.length >= 4 && headerNorm.includes(aliasNorm)) {
    return 400 + aliasNorm.length;
  }
  return 0;
}

function suggestMapping(headers) {
  const norms = headers.map((h) => ({ raw: h, norm: normHeader(h) })).filter((n) => n.norm);
  const candidates = [];
  for (const field of MAP_FIELDS) {
    for (const a of RULE_ALIASES[field] || []) {
      const an = normHeader(a);
      for (const n of norms) {
        const score = aliasScore(n.norm, an);
        if (score > 0) candidates.push({ field, column: n.raw, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedFields = new Set();
  const usedCols = new Set();
  const mapping = {};
  const audit = [];
  for (const c of candidates) {
    if (usedFields.has(c.field) || usedCols.has(c.column)) continue;
    usedFields.add(c.field);
    usedCols.add(c.column);
    mapping[c.field] = { column: c.column, source: "rule" };
    audit.push({ column: c.column, field: c.field, source: "rule" });
  }
  for (const field of MAP_FIELDS) {
    if (!mapping[field]) mapping[field] = { column: null, source: "unmapped" };
  }
  return { mapping, audit };
}

function detectProvider(headers, hint) {
  if (hint && ["google", "meta", "x"].includes(hint)) return hint;
  const norms = headers.map(normHeader);
  const scores = { google: 0, meta: 0, x: 0 };
  for (const [p, hints] of Object.entries(PROVIDER_HINTS)) {
    for (const h of hints) {
      const hn = normHeader(h);
      if (norms.some((n) => n.includes(hn) || hn.includes(n))) scores[p] += 1;
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return best[0];
  const err = new Error("无法识别平台：表头未匹配 google/meta/x 特征列");
  err.code = "PROVIDER_UNKNOWN";
  throw err;
}

function currencyFromHeaders(headers, mapping) {
  if (mapping.currency && mapping.currency.column) return null; // 行内取
  for (const h of headers) {
    const n = normHeader(h);
    const m = /\(([a-z]{3})\)$/i.exec(n) || /amount spent \(([a-z]{3})\)/i.exec(n);
    if (m) return m[1].toUpperCase();
  }
  return "USD";
}

/**
 * 解析为 YYYY-MM-DD。只认可确定年月日的字面格式，禁止 new Date() 本地时区往返。
 * 支持：YYYY-MM-DD[...], M/D/YYYY, YYYY/MM/DD
 */
function parseDate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parseNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).replace(/[$,￥,\s]/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Google Ads cost_micros → 本位币 spend；仅当列名标明 micros 时除以 1e6（不做大数值启发式）。 */
function normalizeSpend(raw, provider, mappingFieldIsMicros) {
  const n = parseNumber(raw);
  if (n === null) return null;
  if (provider === "google" && mappingFieldIsMicros) return n / 1e6;
  return n;
}

function cell(rowObj, mapping, field) {
  const m = mapping[field];
  if (!m || !m.column) return "";
  return rowObj[m.column] !== undefined ? rowObj[m.column] : "";
}

function synthId(prefix, seed) {
  const h = crypto.createHash("sha1").update(String(seed || "empty")).digest("hex").slice(0, 12);
  return `${prefix}:${h}`;
}

/**
 * 将一行映射结果转为 CanonicalAdRecord（或错误）
 * @param {object} ctx { workspaceId } — 必须来自 AttributionContext
 */
function rowToCanonical(rowObj, mapping, meta) {
  const {
    workspaceId,
    provider,
    sourceFileId,
    sourceRowNumber,
    rawSource,
    importedAt,
    sourceVersion = "a1.0",
    defaultCurrency = "USD",
  } = meta;

  if (!workspaceId) {
    return { ok: false, reason: "workspaceId 缺失（必须来自 Context）", field: "workspaceId" };
  }
  if (!["google", "meta", "x"].includes(provider)) {
    return { ok: false, reason: "provider 非法", field: "provider" };
  }

  const date = parseDate(cell(rowObj, mapping, "date"));
  if (!date) return { ok: false, reason: "日期无法解析", field: "date" };

  const spendCol = mapping.spend && mapping.spend.column;
  const spendIsMicros = spendCol && /micros/i.test(spendCol);
  let spend = normalizeSpend(cell(rowObj, mapping, "spend"), provider, spendIsMicros);
  if (spend === null || spend < 0) return { ok: false, reason: "spend 非法", field: "spend" };

  const impressionsRaw = parseNumber(cell(rowObj, mapping, "impressions"));
  const clicksRaw = parseNumber(cell(rowObj, mapping, "clicks"));
  if (impressionsRaw === null || impressionsRaw < 0) {
    return { ok: false, reason: "impressions 非法", field: "impressions" };
  }
  if (clicksRaw === null || clicksRaw < 0) {
    return { ok: false, reason: "clicks 非法", field: "clicks" };
  }

  const accountId = String(cell(rowObj, mapping, "accountId")).trim() || "account:unknown";
  const campaignNameRaw = String(cell(rowObj, mapping, "campaignName")).trim();
  const campaignIdRaw = String(cell(rowObj, mapping, "campaignId")).trim();
  const campaignId =
    campaignIdRaw ||
    (campaignNameRaw ? synthId("campaign", campaignNameRaw) : "campaign:unassigned");
  const campaignName = campaignNameRaw || null;

  const adGroupIdRaw = String(cell(rowObj, mapping, "adGroupId")).trim();
  const adGroupId = adGroupIdRaw || null;

  const creativeIdRaw = String(cell(rowObj, mapping, "creativeId")).trim();
  const creativeNameRaw = String(cell(rowObj, mapping, "creativeName")).trim();
  let creativeId = creativeIdRaw;
  let creativeName = creativeNameRaw || null;
  if (!creativeId && campaignNameRaw) {
    creativeId = synthId("creative", campaignNameRaw + "|" + date);
    if (!creativeName) creativeName = campaignNameRaw;
  } else if (!creativeId) {
    creativeId = synthId("daily", accountId + "|" + date);
    creativeName = creativeName || "未分系列 · 日汇总";
  } else if (!creativeName) {
    creativeName = creativeId;
  }

  let currency = String(cell(rowObj, mapping, "currency")).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) currency = defaultCurrency;

  const conversionsRaw = parseNumber(cell(rowObj, mapping, "conversions"));
  const revenueRaw = parseNumber(cell(rowObj, mapping, "revenue"));

  const record = {
    workspaceId,
    provider,
    accountId,
    campaignId,
    adGroupId,
    creativeId,
    creativeName,
    campaignName,
    date,
    currency,
    spend,
    impressions: Math.trunc(impressionsRaw),
    clicks: Math.trunc(clicksRaw),
    conversions: conversionsRaw === null ? null : conversionsRaw,
    revenue: revenueRaw === null ? null : revenueRaw,
    rawSource,
    importedAt,
    sourceFileId,
    sourceRowNumber,
    sourceProvider: provider,
    sourceVersion,
  };

  return { ok: true, record };
}

module.exports = {
  MAP_FIELDS,
  REQUIRED_MAP,
  RULE_ALIASES,
  normHeader,
  suggestMapping,
  detectProvider,
  currencyFromHeaders,
  parseDate,
  parseNumber,
  normalizeSpend,
  cell,
  rowToCanonical,
  synthId,
};
