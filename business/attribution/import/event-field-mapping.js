"use strict";
/**
 * A18 · 事件 CSV 列映射（规则优先，模式对齐 parsers/mapping.js）
 * 必填：event_name / user_id / event_time；UTM 等可选。
 */
const EVENT_MAP_FIELDS = Object.freeze([
  "event_name",
  "user_id",
  "event_time",
  "visitor_id",
  "session_id",
  "event_id",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "amount",
  "currency",
  "country",
]);

const EVENT_REQUIRED_MAP = Object.freeze(["event_name", "user_id", "event_time"]);

const EVENT_RULE_ALIASES = {
  event_name: [
    "event_name",
    "event name",
    "event",
    "eventname",
    "事件名",
    "事件名称",
    "行为",
    "action",
  ],
  user_id: [
    "user_id",
    "user id",
    "userid",
    "uid",
    "用户 id",
    "用户id",
    "用户",
    "customer id",
    "customer_id",
  ],
  event_time: [
    "event_time",
    "event time",
    "timestamp",
    "time",
    "datetime",
    "occurred_at",
    "occurred at",
    "事件时间",
    "时间",
    "发生时间",
  ],
  visitor_id: ["visitor_id", "visitor id", "visitor", "匿名 id", "client id", "client_id"],
  session_id: ["session_id", "session id", "session", "会话 id"],
  event_id: ["event_id", "event id", "事件 id", "uuid"],
  utm_source: ["utm_source", "utm source", "source", "来源"],
  utm_medium: ["utm_medium", "utm medium", "medium", "媒介"],
  utm_campaign: ["utm_campaign", "utm campaign", "campaign", "广告系列"],
  utm_content: ["utm_content", "utm content", "content", "广告内容", "ad id", "ad_id"],
  utm_term: ["utm_term", "utm term", "term", "关键词"],
  amount: ["amount", "value", "revenue", "金额", "充值金额", "purchase value"],
  currency: ["currency", "currency code", "币种", "货币"],
  country: ["country", "geo", "国家", "地区"],
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

function suggestEventMapping(headers) {
  const norms = headers.map((h) => ({ raw: h, norm: normHeader(h) })).filter((n) => n.norm);
  const candidates = [];
  for (const field of EVENT_MAP_FIELDS) {
    for (const a of EVENT_RULE_ALIASES[field] || []) {
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
  for (const field of EVENT_MAP_FIELDS) {
    if (!mapping[field]) mapping[field] = { column: null, source: "unmapped" };
  }
  return { mapping, audit };
}

function cell(rowObj, mapping, field) {
  const m = mapping[field];
  if (!m || !m.column) return "";
  return rowObj[m.column] !== undefined ? rowObj[m.column] : "";
}

/**
 * 解析事件时间为 epoch ms。
 * 支持：纯数字 epoch(ms)、ISO8601、YYYY-MM-DD[ HH:mm:ss]、YYYY/MM/DD…
 */
function parseEventTime(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) return null;
    // 10 位秒 → 毫秒
    if (n < 1e12) return n * 1000;
    return n;
  }
  // YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DDTHH:mm:ss(.sss)?Z?
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z)?$/.exec(s);
  if (m) {
    const ms = m[7] ? m[7].padEnd(3, "0") : "000";
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
    return Number.isFinite(t) ? t : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(s);
  if (m) {
    const hh = m[4] || "00";
    const mm = m[5] || "00";
    const ss = m[6] || "00";
    const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T${hh}:${mm}:${ss}.000Z`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  if (Number.isFinite(t) && t >= 0) return t;
  return null;
}

/**
 * CSV 行 → 适配层原始事件（结构校验通过后）。
 * 不做事件名白名单判断——那是 A17 的职责。
 */
function rowToRawEvent(rowObj, mapping, meta = {}) {
  const eventName = String(cell(rowObj, mapping, "event_name")).trim();
  if (!eventName) {
    return { ok: false, field: "event_name", reason: "event_name 为空" };
  }
  const userId = String(cell(rowObj, mapping, "user_id")).trim();
  if (!userId) {
    return { ok: false, field: "user_id", reason: "user_id 为空" };
  }
  const ts = parseEventTime(cell(rowObj, mapping, "event_time"));
  if (ts == null) {
    return { ok: false, field: "event_time", reason: "event_time 无法解析（需 epoch ms / ISO / YYYY-MM-DD[ HH:mm:ss]）" };
  }

  const raw = {
    event_name: eventName,
    user_id: userId,
    timestamp: ts,
  };

  const visitorId = String(cell(rowObj, mapping, "visitor_id")).trim();
  raw.visitor_id = visitorId || `csv:${userId}`;

  const sessionId = String(cell(rowObj, mapping, "session_id")).trim();
  if (sessionId) raw.session_id = sessionId;

  const eventId = String(cell(rowObj, mapping, "event_id")).trim();
  if (eventId) raw.event_id = eventId;

  for (const f of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "country"]) {
    const v = String(cell(rowObj, mapping, f)).trim();
    if (v) raw[f] = v;
  }

  const amountRaw = String(cell(rowObj, mapping, "amount")).trim();
  if (amountRaw) {
    const n = Number(String(amountRaw).replace(/[$,￥,\s]/g, ""));
    if (!Number.isFinite(n)) {
      return { ok: false, field: "amount", reason: "amount 非法数字" };
    }
    raw.amount = n;
  }
  const currency = String(cell(rowObj, mapping, "currency")).trim();
  if (currency) raw.currency = currency.toUpperCase();

  if (meta.sourceRowNumber != null) raw._source_row = meta.sourceRowNumber;
  if (meta.sourceFileId) raw._source_file_id = meta.sourceFileId;

  return { ok: true, raw };
}

module.exports = {
  EVENT_MAP_FIELDS,
  EVENT_REQUIRED_MAP,
  EVENT_RULE_ALIASES,
  suggestEventMapping,
  parseEventTime,
  rowToRawEvent,
  cell,
  normHeader,
};
