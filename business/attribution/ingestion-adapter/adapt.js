"use strict";
/**
 * A17 · 事件适配：翻译 event_name、补齐 event_id/timestamp、打数据质量标记。
 * 产出必须能通过 analytics/backend/collect/validate.js（本包不修改该文件）。
 */
const crypto = require("node:crypto");
const { EVENT_NAMES, isUuid } = require("../contracts/invariants");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

function isTimestampMs(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 确定性 UUID（sha1 → UUID v5 形态），同输入恒等，便于幂等。
 */
function deterministicEventId(workspaceId, seedParts) {
  const h = crypto
    .createHash("sha1")
    .update(["a17", String(workspaceId || ""), ...(seedParts || [])].join("\u0000"), "utf8")
    .digest();
  const bytes = Buffer.from(h.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function fingerprintRaw(raw) {
  const name = raw && (raw.event_name || raw.eventName || "");
  const ts = raw && (raw.timestamp != null ? String(raw.timestamp) : "");
  const visitor = raw && (raw.visitor_id || raw.visitorId || "");
  const user = raw && (raw.user_id || raw.userId || "");
  const sid = raw && (raw.session_id || raw.sessionId || "");
  const eid = raw && (raw.event_id || raw.eventId || "");
  return [name, ts, visitor, user, sid, eid].join("|");
}

/**
 * @param {object} raw 上游原始事件
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {{ resolve: Function }} opts.mappingStore
 * @param {number} [opts.receivedAtMs]
 * @param {object} [opts.qualityStats] record() 钩子
 */
function adaptEvent(raw, opts = {}) {
  const workspaceId = opts.workspaceId;
  if (!workspaceId) {
    throw Object.assign(new Error("workspaceId 必填"), { code: "WORKSPACE_REQUIRED" });
  }
  const mappingStore = opts.mappingStore;
  if (!mappingStore || typeof mappingStore.resolve !== "function") {
    throw Object.assign(new Error("mappingStore 必填"), { code: "MAPPING_STORE_REQUIRED" });
  }

  const receivedAtMs =
    typeof opts.receivedAtMs === "number" && Number.isFinite(opts.receivedAtMs)
      ? Math.trunc(opts.receivedAtMs)
      : Date.now();

  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const rawName = body.event_name != null ? body.event_name : body.eventName;
  const resolved = mappingStore.resolve(workspaceId, rawName);

  const quality = {
    event_id_is_client_native_unique: false,
    event_id_source: "adapter_fallback",
    timestamp_source: "client",
    event_name_raw: rawName == null ? null : String(rawName),
    event_name_mapped_to: null,
    mapping_configured: Boolean(resolved.configured),
    ignored: false,
    unmapped: false,
  };

  if (resolved.target === "ignore") {
    quality.ignored = true;
    quality.event_name_mapped_to = "ignore";
    if (opts.qualityStats && typeof opts.qualityStats.record === "function") {
      opts.qualityStats.record(workspaceId, { ignored: true, unmapped: false });
    }
    return {
      ok: true,
      ignored: true,
      event: null,
      quality,
      reason: "mapped_to_ignore",
    };
  }

  if (!resolved.target) {
    quality.unmapped = true;
    if (opts.qualityStats && typeof opts.qualityStats.record === "function") {
      opts.qualityStats.record(workspaceId, { ignored: false, unmapped: true });
    }
    return {
      ok: false,
      ignored: false,
      event: null,
      quality,
      reason: "unmapped_event_name",
      error: {
        code: "UNMAPPED_EVENT_NAME",
        message: `事件名「${rawName}」未映射到归因白名单，请在工作区事件映射中配置或标为 ignore`,
      },
    };
  }

  const eventName = resolved.target;
  quality.event_name_mapped_to = eventName;

  // event_id
  let eventId = body.event_id != null ? body.event_id : body.eventId;
  if (isValidUuid(eventId)) {
    quality.event_id_is_client_native_unique = true;
    quality.event_id_source = "client_native";
  } else {
    eventId = deterministicEventId(workspaceId, [fingerprintRaw(body), eventName]);
    quality.event_id_is_client_native_unique = false;
    quality.event_id_source = "adapter_fallback";
  }

  // timestamp
  let timestamp = body.timestamp;
  if (typeof timestamp === "string" && /^\d+$/.test(timestamp)) {
    timestamp = Number(timestamp);
  }
  if (!isTimestampMs(timestamp)) {
    timestamp = receivedAtMs;
    quality.timestamp_source = "received_at_fallback";
  }

  const adapted = {
    ...body,
    event_id: eventId,
    event_name: eventName,
    timestamp,
    // 数据质量标记（Collect 宽松透传；不进入三件套校验）
    _attribution_quality: quality,
  };
  delete adapted.eventId;
  delete adapted.eventName;

  if (opts.qualityStats && typeof opts.qualityStats.record === "function") {
    opts.qualityStats.record(workspaceId, {
      ignored: false,
      unmapped: false,
      eventIdNative: quality.event_id_is_client_native_unique,
      timestampFallback: quality.timestamp_source === "received_at_fallback",
      mapped: resolved.configured,
    });
  }

  return {
    ok: true,
    ignored: false,
    event: adapted,
    quality,
  };
}

function adaptBatch(events, opts) {
  const out = [];
  for (const raw of events || []) {
    out.push(adaptEvent(raw, opts));
  }
  return out;
}

module.exports = {
  adaptEvent,
  adaptBatch,
  deterministicEventId,
  isValidUuid,
  isTimestampMs,
  EVENT_NAMES,
  isUuid,
};
