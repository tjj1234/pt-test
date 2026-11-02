"use strict";

const { types } = require("node:util");

const ERROR_CODE = "PT_CONSUME_RECORD_INVALID";
const MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KiB
const MAX_DEPTH = 6;
const MAX_BILLING_ITEMS = 32;

// Allowed request_type enum
const VALID_REQUEST_TYPES = Object.freeze(new Set([
  "text",
  "video",
  "image",
  "audio",
]));

// Allowed billing_unit enum (credits only, not currency)
const VALID_BILLING_UNITS = Object.freeze(new Set([
  "per_tokens",
  "per_image",
  "per_characters",
]));

// Strict field whitelists
const ALLOWED_ROOT_KEYS = Object.freeze(new Set([
  "consume_id",
  "request_id",
  "task_id",
  "endpoint",
  "provider_name",
  "model_id",
  "model_name",
  "status",
  "consume_time",
  "request_type",
  "quota",
  "original_quota",
  "usage",
  "billing",
]));

const ALLOWED_USAGE_KEYS = Object.freeze(new Set([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "characters",
  "cached_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
]));

const ALLOWED_BILLING_KEYS = Object.freeze(new Set([
  "pricing_mode",
  "billing_unit",
  "unit_size",
  "quota_per_unit",
  "items",
  "formula",
  "total_quota",
  "original_quota",
  "discount_quota",
  "final_quota",
]));

const ALLOWED_ITEM_KEYS = Object.freeze(new Set([
  "name",
  "quantity",
  "unit_quota",
  "unit_label",
  "subtotal_quota",
]));

// Control characters regex: ASCII 0-31 and 127
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

function createInvalidError(staticReason) {
  const err = new Error(`PT consume record invalid: ${staticReason}`);
  err.code = ERROR_CODE;
  return err;
}

/**
 * Validates that an object graph is pure JSON and safe from:
 * - Active or revoked Proxies (without invoking traps)
 * - Accessors (getters/setters without executing them)
 * - Symbol properties
 * - Non-plain prototypes
 * - Circular or shared references
 * - Non-finite numbers (NaN, Infinity, -Infinity)
 * - Undefined values
 * - Depth > 6
 * - Payload size > 16 KiB
 */
function scanPureJsonSafety(root) {
  if (types.isProxy(root)) {
    throw createInvalidError("Proxy objects are not permitted");
  }

  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw createInvalidError("Root payload must be a plain object");
  }

  const seen = new Set();

  function traverse(val, depth) {
    if (depth > MAX_DEPTH) {
      throw createInvalidError("Maximum object depth exceeded");
    }

    if (val === null) return;

    const t = typeof val;
    if (t === "undefined") {
      throw createInvalidError("Undefined values are not permitted in pure JSON");
    }
    if (t === "symbol" || t === "function" || t === "bigint") {
      throw createInvalidError("Forbidden data type in payload");
    }
    if (t === "number") {
      if (!Number.isFinite(val)) {
        throw createInvalidError("Non-finite numbers are not permitted");
      }
      return;
    }
    if (t === "string") {
      if (val.length > MAX_PAYLOAD_BYTES) {
        throw createInvalidError("String length exceeds maximum boundary");
      }
      return;
    }
    if (t === "boolean") {
      return;
    }

    if (t === "object") {
      // Check for active or revoked proxy before touching any properties
      if (types.isProxy(val)) {
        throw createInvalidError("Proxy objects are not permitted");
      }

      const proto = Object.getPrototypeOf(val);
      if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) {
        throw createInvalidError("Unsupported object prototype");
      }

      if (Object.getOwnPropertySymbols(val).length > 0) {
        throw createInvalidError("Symbol properties are not permitted");
      }

      if (seen.has(val)) {
        throw createInvalidError("Circular or shared object references are not permitted");
      }
      seen.add(val);

      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          const desc = Object.getOwnPropertyDescriptor(val, String(i));
          if (!desc) {
            throw createInvalidError("Sparse arrays are not permitted");
          }
          if (desc.get || desc.set) {
            throw createInvalidError("Accessors (getters/setters) are not permitted");
          }
          traverse(desc.value, depth + 1);
        }
        // Ensure no extra non-index own properties on array
        const ownKeys = Object.getOwnPropertyNames(val);
        if (ownKeys.length !== val.length + 1) { // +1 for 'length'
          throw createInvalidError("Unexpected properties on array");
        }
      } else {
        const descriptors = Object.getOwnPropertyDescriptors(val);
        for (const [, desc] of Object.entries(descriptors)) {
          if (desc.get || desc.set) {
            throw createInvalidError("Accessors (getters/setters) are not permitted");
          }
          if (!desc.enumerable) {
            throw createInvalidError("Non-enumerable properties are not permitted");
          }
          traverse(desc.value, depth + 1);
        }
      }
    }
  }

  traverse(root, 1);

  // Check UTF-8 byte boundary
  const jsonText = JSON.stringify(root);
  if (Buffer.byteLength(jsonText, "utf8") > MAX_PAYLOAD_BYTES) {
    throw createInvalidError("Payload size exceeds maximum allowed boundary of 16 KiB");
  }
}

function checkKnownKeys(obj, allowedKeys) {
  const ownKeys = Object.keys(obj);
  for (const k of ownKeys) {
    if (!allowedKeys.has(k)) {
      throw createInvalidError("Unknown field detected in payload");
    }
  }
}

function checkBoundedString(val, minLen, maxLen, allowNull = false) {
  if (val === null && allowNull) return null;
  if (typeof val !== "string") {
    throw createInvalidError("Field must be a string");
  }
  if (val.length < minLen || val.length > maxLen) {
    throw createInvalidError("String length out of bounds");
  }
  if (CONTROL_CHARS_REGEX.test(val)) {
    throw createInvalidError("String contains invalid control characters");
  }
  return val;
}

function checkFiniteNonNegativeNumber(val) {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw createInvalidError("Numeric field must be a finite non-negative number");
  }
  return val;
}

function checkNonNegativeSafeIntegerOrNull(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) {
    throw createInvalidError("Token/character metrics must be non-negative safe integers or null");
  }
  return val;
}

/**
 * Normalizes a single PT consumption record.
 * Pure function: deterministic, immutable input, deeply frozen output.
 *
 * @param {object} raw - PT consumption record
 * @returns {object} Deeply frozen normalized record
 */
function normalizePtConsumeRecord(raw) {
  scanPureJsonSafety(raw);
  checkKnownKeys(raw, ALLOWED_ROOT_KEYS);

  // Validate root required strings
  const consumeId = checkBoundedString(raw.consume_id, 1, 256);
  const requestId = checkBoundedString(raw.request_id, 1, 256);
  const endpoint = checkBoundedString(raw.endpoint, 1, 256);
  const providerName = checkBoundedString(raw.provider_name, 1, 256);
  const reportedModelId = checkBoundedString(raw.model_id, 1, 256);
  const status = checkBoundedString(raw.status, 1, 64);

  // Optional string: model_name
  let reportedModelName = null;
  if (raw.model_name !== undefined && raw.model_name !== null) {
    reportedModelName = checkBoundedString(raw.model_name, 1, 256);
  }

  // task_id: string or null, empty string normalizes to null
  let taskId = null;
  if (raw.task_id !== undefined && raw.task_id !== null) {
    if (typeof raw.task_id !== "string") {
      throw createInvalidError("task_id must be a string or null");
    }
    if (CONTROL_CHARS_REGEX.test(raw.task_id)) {
      throw createInvalidError("task_id contains invalid control characters");
    }
    const trimmed = raw.task_id.trim();
    if (trimmed.length > 512) {
      throw createInvalidError("task_id length out of bounds");
    }
    taskId = trimmed.length > 0 ? trimmed : null;
  }

  // consume_time: safe integer Unix seconds
  if (
    typeof raw.consume_time !== "number" ||
    !Number.isSafeInteger(raw.consume_time) ||
    raw.consume_time < 0 ||
    raw.consume_time > 253402300799
  ) {
    throw createInvalidError("consume_time must be a valid safe integer Unix timestamp");
  }
  const consumedAt = new Date(raw.consume_time * 1000).toISOString();

  // request_type: strictly text, video, image, audio
  if (!VALID_REQUEST_TYPES.has(raw.request_type)) {
    throw createInvalidError("request_type must be text, video, image, or audio");
  }
  const requestType = raw.request_type;

  // quota & top original_quota
  const topQuota = checkFiniteNonNegativeNumber(raw.quota);
  let topOriginalQuota = null;
  if (raw.original_quota !== undefined && raw.original_quota !== null) {
    topOriginalQuota = checkFiniteNonNegativeNumber(raw.original_quota);
  }

  // usage: plain object, can be {} or known fields
  if (!raw.usage || typeof raw.usage !== "object" || Array.isArray(raw.usage)) {
    throw createInvalidError("usage must be a plain object");
  }
  checkKnownKeys(raw.usage, ALLOWED_USAGE_KEYS);

  const usageObj = {
    inputTokens: checkNonNegativeSafeIntegerOrNull(raw.usage.input_tokens),
    outputTokens: checkNonNegativeSafeIntegerOrNull(raw.usage.output_tokens),
    totalTokens: checkNonNegativeSafeIntegerOrNull(raw.usage.total_tokens),
    characters: checkNonNegativeSafeIntegerOrNull(raw.usage.characters),
    cachedTokens: checkNonNegativeSafeIntegerOrNull(raw.usage.cached_tokens),
    cacheReadTokens: checkNonNegativeSafeIntegerOrNull(raw.usage.cache_read_tokens),
    cacheCreationTokens: checkNonNegativeSafeIntegerOrNull(raw.usage.cache_creation_tokens),
  };

  // billing: plain object
  if (!raw.billing || typeof raw.billing !== "object" || Array.isArray(raw.billing)) {
    throw createInvalidError("billing must be a plain object");
  }
  checkKnownKeys(raw.billing, ALLOWED_BILLING_KEYS);

  const pricingMode = checkBoundedString(raw.billing.pricing_mode, 1, 64);
  if (!VALID_BILLING_UNITS.has(raw.billing.billing_unit)) {
    throw createInvalidError("billing_unit must be per_tokens, per_image, or per_characters");
  }
  const billingUnit = raw.billing.billing_unit;

  if (
    typeof raw.billing.unit_size !== "number" ||
    !Number.isFinite(raw.billing.unit_size) ||
    raw.billing.unit_size <= 0
  ) {
    throw createInvalidError("billing unit_size must be a positive finite number");
  }
  const unitSize = raw.billing.unit_size;

  const quotaPerUnit = checkFiniteNonNegativeNumber(raw.billing.quota_per_unit);
  const totalQuota = checkFiniteNonNegativeNumber(raw.billing.total_quota);
  const originalQuota = checkFiniteNonNegativeNumber(raw.billing.original_quota);
  const discountQuota = checkFiniteNonNegativeNumber(raw.billing.discount_quota);
  const finalQuota = checkFiniteNonNegativeNumber(raw.billing.final_quota);

  let formula = null;
  if (raw.billing.formula !== undefined && raw.billing.formula !== null) {
    formula = checkBoundedString(raw.billing.formula, 0, 512);
  }

  // billing items
  if (!Array.isArray(raw.billing.items)) {
    throw createInvalidError("billing.items must be an array");
  }
  if (raw.billing.items.length > MAX_BILLING_ITEMS) {
    throw createInvalidError("billing.items count exceeds maximum limit of 32");
  }

  let itemsSubtotalSum = 0;
  const normalizedItems = raw.billing.items.map((it) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) {
      throw createInvalidError("billing item must be a plain object");
    }
    checkKnownKeys(it, ALLOWED_ITEM_KEYS);

    const name = checkBoundedString(it.name, 1, 128);
    const quantity = checkFiniteNonNegativeNumber(it.quantity);
    if (quantity > 1e12) {
      throw createInvalidError("billing item quantity exceeds reasonable boundary");
    }
    const unitQuota = checkFiniteNonNegativeNumber(it.unit_quota);
    let unitLabel = null;
    if (it.unit_label !== undefined && it.unit_label !== null) {
      unitLabel = checkBoundedString(it.unit_label, 1, 64);
    }
    const subtotalQuota = checkFiniteNonNegativeNumber(it.subtotal_quota);
    itemsSubtotalSum += subtotalQuota;

    return Object.freeze({
      name,
      quantity,
      unitQuota,
      unitLabel,
      subtotalQuota,
    });
  });

  // Warnings collection
  const warnings = [];

  // Warning 1: Top original_quota vs billing original_quota mismatch
  if (topOriginalQuota !== null && topOriginalQuota !== originalQuota) {
    warnings.push("TOP_BILLING_ORIGINAL_QUOTA_MISMATCH");
  }

  // Warning 2: Items sum vs final_quota discrepancy due to rounding or minimum charge
  if (normalizedItems.length > 0 && Math.abs(itemsSubtotalSum - finalQuota) > 1e-4) {
    warnings.push("BILLING_ITEMS_SUM_ROUNDED");
  }

  // Warning 3: Top quota vs billing final_quota discrepancy
  if (Math.abs(topQuota - finalQuota) > 1e-4) {
    warnings.push("TOP_FINAL_QUOTA_MISMATCH");
  }

  const billingObj = {
    unit: "credits",
    pricingMode,
    billingUnit,
    unitSize,
    quotaPerUnit,
    topQuota,
    topOriginalQuota,
    totalQuota,
    originalQuota,
    discountQuota,
    finalQuota,
    formula,
    items: Object.freeze(normalizedItems),
  };

  const output = {
    consumeId,
    requestId,
    taskId,
    endpoint,
    providerName,
    reportedModelId,
    reportedModelName,
    status,
    consumedAt,
    requestType,
    usage: Object.freeze(usageObj),
    billing: Object.freeze(billingObj),
    warnings: Object.freeze(warnings),
    evidenceKind: "imported_pt_record",
    currency: null,
    exchangeRate: null,
  };

  return Object.freeze(output);
}

module.exports = {
  ERROR_CODE,
  MAX_BILLING_ITEMS,
  MAX_DEPTH,
  MAX_PAYLOAD_BYTES,
  VALID_BILLING_UNITS,
  VALID_REQUEST_TYPES,
  normalizePtConsumeRecord,
};
