"use strict";

const { types } = require("node:util");

const ERROR_CODE = "MEDIA_RESERVATION_VIEW_INVALID";
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB
const MAX_DEPTH = 5;
const MAX_RESERVATIONS = 100;

const TASK_LABELS = Object.freeze({
  text2image: "文生图",
  image2image: "图生图",
  text2video: "文生视频",
  image2video: "图生视频",
});

const ALLOWED_ROOT_KEYS = Object.freeze(new Set([
  "reservations",
  "hasMore",
]));

const ALLOWED_ITEM_KEYS = Object.freeze(new Set([
  "reservationId",
  "runId",
  "operationKey",
  "modelId",
  "taskType",
  "status",
  "reservedAt",
  "releasedAt",
  "releaseReason",
]));

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_OR_HTML_REGEX = /[\x00-\x1F\x7F<>&]/;

function createInvalidError(staticReason) {
  const err = new Error("Media reservation view input is invalid");
  err.code = ERROR_CODE;
  return err;
}

/**
 * Validates bounded pure JSON structure:
 * - Rejects active or revoked Proxies (without invoking traps)
 * - Rejects getters/setters (without invoking getters)
 * - Rejects Symbol properties
 * - Rejects non-plain prototypes
 * - Rejects circular/shared object references
 * - Rejects undefined and non-finite numbers
 * - Enforces max depth of 5 and max UTF-8 size of 64 KiB
 */
function scanPureJsonSafety(root) {
  const seen = new Set();
  let bytes = 0;
  const add = n => { bytes += n; if (bytes > MAX_PAYLOAD_BYTES) throw createInvalidError(); };
  const stringBytes = value => {
    if (value.length > MAX_PAYLOAD_BYTES) throw createInvalidError();
    let n = 2;
    for (const char of value) {
      const code = char.codePointAt(0);
      n += code < 32 ? ([8,9,10,12,13].includes(code) ? 2 : 6)
        : char === '"' || char === '\\' ? 2
        : code >= 0xd800 && code <= 0xdfff ? 6 : Buffer.byteLength(char,'utf8');
      if (n + bytes > MAX_PAYLOAD_BYTES) throw createInvalidError();
    }
    return n;
  };
  function scan(value, depth, shape) {
    if (depth > MAX_DEPTH || types.isProxy(value)) throw createInvalidError();
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { add(stringBytes(value)); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw createInvalidError(); add(String(value).length); return; }
    if (typeof value !== 'object' || !shape || seen.has(value)) throw createInvalidError();
    seen.add(value);
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (shape === 'list') {
      if (!array || proto !== Array.prototype) throw createInvalidError();
      const length = Object.getOwnPropertyDescriptor(value,'length').value;
      if (length > MAX_RESERVATIONS) throw createInvalidError();
      if (Reflect.ownKeys(value).length !== length + 1) throw createInvalidError();
      add(2);
      for (let i=0;i<length;i++) {
        const desc=Object.getOwnPropertyDescriptor(value,String(i));
        if (!desc || !desc.enumerable || !Object.hasOwn(desc,'value')) throw createInvalidError();
        if (i) add(1);
        scan(desc.value,depth+1,'item');
      }
      return;
    }
    if (array || (proto !== Object.prototype && proto !== null)) throw createInvalidError();
    const allowed=shape === 'root' ? ALLOWED_ROOT_KEYS : ALLOWED_ITEM_KEYS;
    const keys=Reflect.ownKeys(value);
    if (keys.length !== allowed.size) throw createInvalidError();
    add(2);
    for (let i=0;i<keys.length;i++) {
      const key=keys[i];
      if (typeof key !== 'string' || !allowed.has(key)) throw createInvalidError();
      const desc=Object.getOwnPropertyDescriptor(value,key);
      if (!desc || !desc.enumerable || !Object.hasOwn(desc,'value')) throw createInvalidError();
      add(stringBytes(key)+1+(i?1:0));
      scan(desc.value,depth+1,shape === 'root' && key === 'reservations' ? 'list' : null);
    }
  }
  if (types.isProxy(root) || root === null || typeof root !== 'object') throw createInvalidError();
  scan(root,1,'root');
}

function checkKnownKeys(obj, allowedKeys) {
  const ownKeys = Object.keys(obj);
  for (const k of ownKeys) {
    if (!allowedKeys.has(k)) {
      throw createInvalidError("Unknown field detected in payload");
    }
  }
}

function validateTimestamp(val) {
  if (typeof val !== 'string') throw createInvalidError();
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(val);
  if (!match) throw createInvalidError();
  const canonical=`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] || '').padEnd(3,'0')}Z`;
  const time=Date.parse(canonical);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) throw createInvalidError();
  return time;
}

/**
 * Builds the media reservation view model for UI presentation.
 * Pure function: deterministic, immutable input, deeply frozen output.
 *
 * @param {object} input - API response payload: { reservations, hasMore }
 * @returns {object} Deeply frozen view model: { items, hasMore }
 */
function buildMediaReservationView(input) {
  scanPureJsonSafety(input);
  checkKnownKeys(input, ALLOWED_ROOT_KEYS);

  if (typeof input.hasMore !== "boolean") {
    throw createInvalidError("Field hasMore must be a boolean");
  }
  const hasMore = input.hasMore;

  if (!Array.isArray(input.reservations)) {
    throw createInvalidError("Field reservations must be an array");
  }
  if (input.reservations.length > MAX_RESERVATIONS) {
    throw createInvalidError("Reservations list exceeds maximum limit of 100");
  }

  const items = input.reservations.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createInvalidError("Reservation item must be a plain object");
    }
    checkKnownKeys(item, ALLOWED_ITEM_KEYS);

    // Validate UUIDs
    if (typeof item.reservationId !== "string" || !UUID_REGEX.test(item.reservationId)) {
      throw createInvalidError("Field reservationId must be a valid UUID");
    }
    const reservationId = item.reservationId.toLowerCase();

    if (typeof item.runId !== "string" || !UUID_REGEX.test(item.runId)) {
      throw createInvalidError("Field runId must be a valid UUID");
    }
    const runId = item.runId.toLowerCase();

    // Validate operationKey in format ${runId}:${uuid}
    if (typeof item.operationKey !== "string") {
      throw createInvalidError("Field operationKey must be a string");
    }
    const opKeyParts = item.operationKey.split(":");
    if (opKeyParts.length !== 2 || opKeyParts[0].toLowerCase() !== runId || !UUID_REGEX.test(opKeyParts[1])) {
      throw createInvalidError("Field operationKey must match runId:UUID format");
    }

    // Validate modelId
    if (
      typeof item.modelId !== "string" ||
      !item.modelId.trim() ||
      item.modelId.length > 256 ||
      CONTROL_OR_HTML_REGEX.test(item.modelId)
    ) {
      throw createInvalidError("Field modelId must be a bounded alphanumeric string");
    }
    const modelId = item.modelId;

    // Validate taskType
    const taskLabel = Object.hasOwn(TASK_LABELS,item.taskType) ? TASK_LABELS[item.taskType] : null;
    if (!taskLabel) {
      throw createInvalidError("Field taskType must be one of the four supported types");
    }

    // Validate reservedAt
    const reservedAtMs = validateTimestamp(item.reservedAt, "reservedAt");

    // Validate status and corresponding release fields
    let statusLabel = "";
    let detail = "";
    let canRequestReconciliation = false;

    if (item.status === "reserved") {
      if (item.releasedAt !== null) {
        throw createInvalidError("Reserved item cannot have non-null releasedAt");
      }
      if (item.releaseReason !== null) {
        throw createInvalidError("Reserved item cannot have non-null releaseReason");
      }
      statusLabel = "占位保留";
      detail = "核对持久记录后，系统才会判断能否释放；结果未知会继续保留";
      canRequestReconciliation = true;
    } else if (item.status === "released") {
      if (item.releasedAt === null) {
        throw createInvalidError("Released item must have non-null releasedAt");
      }
      const releasedAtMs = validateTimestamp(item.releasedAt, "releasedAt");
      if (releasedAtMs < reservedAtMs) {
        throw createInvalidError("Chronology violation: releasedAt cannot precede reservedAt");
      }

      if (
        typeof item.releaseReason !== "string" ||
        !item.releaseReason.trim() ||
        item.releaseReason.length > 256 ||
        CONTROL_OR_HTML_REGEX.test(item.releaseReason)
      ) {
        throw createInvalidError("Released item must have a valid non-empty releaseReason without control/HTML chars");
      }

      statusLabel = "占位已释放";
      detail = "原授权仍已消费；再次执行需要新授权";
      canRequestReconciliation = false;
    } else {
      throw createInvalidError("Field status must be 'reserved' or 'released'");
    }

    return Object.freeze({
      reservationId,
      runId,
      modelId,
      taskLabel,
      statusLabel,
      detail,
      canRequestReconciliation,
    });
  });

  const output = {
    items: Object.freeze(items),
    hasMore,
  };

  return Object.freeze(output);
}

module.exports = {
  ERROR_CODE,
  MAX_DEPTH,
  MAX_PAYLOAD_BYTES,
  MAX_RESERVATIONS,
  TASK_LABELS,
  buildMediaReservationView,
};
