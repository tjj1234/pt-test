"use strict";

const { types } = require("node:util");

const ERROR_CODE = "PT_CONSUME_RECORD_INVALID";
const MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KiB
const MAX_DEPTH = 6;
const MAX_BILLING_ITEMS = 32;

// Private immutable enum definitions
const PRIVATE_VALID_REQUEST_TYPES = Object.freeze([
  "text",
  "video",
  "image",
  "audio",
]);

const PRIVATE_VALID_BILLING_UNITS = Object.freeze([
  "per_tokens",
  "per_image",
  "per_characters",
]);

// Private Sets for O(1) internal lookups (never exported or mutated)
const INTERNAL_REQUEST_TYPES_SET = Object.freeze(new Set(PRIVATE_VALID_REQUEST_TYPES));
const INTERNAL_BILLING_UNITS_SET = Object.freeze(new Set(PRIVATE_VALID_BILLING_UNITS));

// Strict schema key limits per layer
const MAX_ROOT_KEYS = 15;
const MAX_USAGE_KEYS = 7;
const MAX_BILLING_KEYS = 10;
const MAX_ITEM_KEYS = 5;

// Strict field whitelists per schema layer
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

const REQUIRED_ROOT_FIELDS = Object.freeze([
  "consume_id",
  "request_id",
  "endpoint",
  "provider_name",
  "model_id",
  "status",
  "consume_time",
  "request_type",
  "quota",
  "usage",
  "billing",
]);

const REQUIRED_BILLING_FIELDS = Object.freeze([
  "pricing_mode",
  "billing_unit",
  "unit_size",
  "quota_per_unit",
  "total_quota",
  "original_quota",
  "discount_quota",
  "final_quota",
  "items",
]);

const REQUIRED_ITEM_FIELDS = Object.freeze([
  "name",
  "quantity",
  "unit_quota",
  "subtotal_quota",
]);

function createInvalidError(staticReason) {
  const err = new Error(`PT consume record invalid: ${staticReason}`);
  err.code = ERROR_CODE;
  return err;
}

/**
 * Validates object graph safely according to R2 strict schema requirements:
 * 1. Proxy detection (active or revoked) before any property access or Array.isArray.
 * 2. Prototype validation: non-array objects must have Object.prototype or null prototype.
 * 3. Arrays allowed ONLY for billing.items, must be strictly plain Array.prototype.
 * 4. Length checked <= 32 before reading ANY array element (early rejection, trap/getter zero execution).
 * 5. Key count limits per layer checked before inspecting descriptors:
 *    - Root <= 15
 *    - Usage <= 7
 *    - Billing <= 10
 *    - Item <= 5
 * 6. Individual property descriptor inspection without bulk descriptor map allocation.
 * 7. Byte accumulation tracking (UTF8 field names and values <= 16 KiB) without JSON.stringify (zero toJSON execution).
 * 8. Depth <= 6.
 * 9. Desensitized error messages without leaking PRIVATE_SENTINEL.
 */
function scanStrictSchemaSafety(root) {
  if (types.isProxy(root)) {
    throw createInvalidError("Proxy objects are not permitted");
  }

  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw createInvalidError("Root payload must be a plain object");
  }

  const rootProto = Object.getPrototypeOf(root);
  if (rootProto !== Object.prototype && rootProto !== null) {
    throw createInvalidError("Unsupported root object prototype");
  }

  const seen = new Set();
  let accumulatedBytes = 0;

  function addBytes(n) {
    accumulatedBytes += n;
    if (accumulatedBytes > MAX_PAYLOAD_BYTES) {
      throw createInvalidError("Payload size exceeds maximum allowed boundary of 16 KiB");
    }
  }

  function validateObjectLayer(obj, allowedKeys, maxKeys, depth, layerName) {
    if (depth > MAX_DEPTH) {
      throw createInvalidError("Maximum object depth exceeded");
    }

    if (types.isProxy(obj)) {
      throw createInvalidError("Proxy objects are not permitted");
    }

    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw createInvalidError(`${layerName} must be a plain object`);
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw createInvalidError(`Unsupported ${layerName} prototype`);
    }

    if (Object.getOwnPropertySymbols(obj).length > 0) {
      throw createInvalidError("Symbol properties are not permitted");
    }

    if (seen.has(obj)) {
      throw createInvalidError("Circular or shared object references are not permitted");
    }
    seen.add(obj);

    const ownNames = Object.getOwnPropertyNames(obj);
    if (ownNames.length > maxKeys) {
      throw createInvalidError(`${layerName} key count exceeds maximum boundary`);
    }

    // Check unknown keys first
    for (let i = 0; i < ownNames.length; i++) {
      const key = ownNames[i];
      if (!allowedKeys.has(key)) {
        throw createInvalidError(`Unknown field detected in ${layerName}`);
      }
      addBytes(Buffer.byteLength(key, "utf8"));
    }

    // Inspect descriptors one by one
    for (let i = 0; i < ownNames.length; i++) {
      const key = ownNames[i];
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) {
        throw createInvalidError("Property descriptor not found");
      }
      if (desc.get || desc.set) {
        throw createInvalidError("Accessors (getters/setters) are not permitted");
      }
      if (!desc.enumerable) {
        throw createInvalidError("Non-enumerable properties are not permitted");
      }
      if (desc.value === undefined) {
        throw createInvalidError("Undefined values are not permitted");
      }

      const val = desc.value;
      if (val === null) {
        addBytes(4);
      } else if (typeof val === "boolean") {
        addBytes(4);
      } else if (typeof val === "number") {
        if (!Number.isFinite(val)) {
          throw createInvalidError("Non-finite numbers are not permitted");
        }
        addBytes(8);
      } else if (typeof val === "string") {
        addBytes(Buffer.byteLength(val, "utf8"));
      } else if (typeof val === "object") {
        // Nested layer validation
        if (layerName === "root" && key === "usage") {
          validateObjectLayer(val, ALLOWED_USAGE_KEYS, MAX_USAGE_KEYS, depth + 1, "usage");
        } else if (layerName === "root" && key === "billing") {
          validateBillingLayer(val, depth + 1);
        } else {
          throw createInvalidError("Unexpected nested object in payload");
        }
      } else {
        throw createInvalidError("Forbidden data type in payload");
      }
    }
  }

  function validateBillingLayer(billing, depth) {
    if (depth > MAX_DEPTH) {
      throw createInvalidError("Maximum object depth exceeded");
    }

    if (types.isProxy(billing)) {
      throw createInvalidError("Proxy objects are not permitted");
    }

    if (billing === null || typeof billing !== "object" || Array.isArray(billing)) {
      throw createInvalidError("billing must be a plain object");
    }

    const proto = Object.getPrototypeOf(billing);
    if (proto !== Object.prototype && proto !== null) {
      throw createInvalidError("Unsupported billing prototype");
    }

    if (Object.getOwnPropertySymbols(billing).length > 0) {
      throw createInvalidError("Symbol properties are not permitted");
    }

    if (seen.has(billing)) {
      throw createInvalidError("Circular or shared object references are not permitted");
    }
    seen.add(billing);

    const ownNames = Object.getOwnPropertyNames(billing);
    if (ownNames.length > MAX_BILLING_KEYS) {
      throw createInvalidError("billing key count exceeds maximum boundary");
    }

    for (let i = 0; i < ownNames.length; i++) {
      const key = ownNames[i];
      if (!ALLOWED_BILLING_KEYS.has(key)) {
        throw createInvalidError("Unknown field detected in billing");
      }
      addBytes(Buffer.byteLength(key, "utf8"));
    }

    for (let i = 0; i < ownNames.length; i++) {
      const key = ownNames[i];
      const desc = Object.getOwnPropertyDescriptor(billing, key);
      if (!desc) {
        throw createInvalidError("Property descriptor not found");
      }
      if (desc.get || desc.set) {
        throw createInvalidError("Accessors (getters/setters) are not permitted");
      }
      if (!desc.enumerable) {
        throw createInvalidError("Non-enumerable properties are not permitted");
      }
      if (desc.value === undefined) {
        throw createInvalidError("Undefined values are not permitted");
      }

      const val = desc.value;
      if (key === "items") {
        validateItemsArray(val, depth + 1);
      } else if (val === null) {
        addBytes(4);
      } else if (typeof val === "boolean") {
        addBytes(4);
      } else if (typeof val === "number") {
        if (!Number.isFinite(val)) {
          throw createInvalidError("Non-finite numbers are not permitted");
        }
        addBytes(8);
      } else if (typeof val === "string") {
        addBytes(Buffer.byteLength(val, "utf8"));
      } else {
        throw createInvalidError("Forbidden data type in billing");
      }
    }
  }

  function validateItemsArray(items, depth) {
    if (depth > MAX_DEPTH) {
      throw createInvalidError("Maximum object depth exceeded");
    }

    if (types.isProxy(items)) {
      throw createInvalidError("Proxy objects are not permitted");
    }

    if (!Array.isArray(items)) {
      throw createInvalidError("billing.items must be an array");
    }

    const proto = Object.getPrototypeOf(items);
    if (proto !== Array.prototype) {
      throw createInvalidError("billing.items must be a standard plain Array");
    }

    if (Object.getOwnPropertySymbols(items).length > 0) {
      throw createInvalidError("Symbol properties are not permitted");
    }

    if (seen.has(items)) {
      throw createInvalidError("Circular or shared object references are not permitted");
    }
    seen.add(items);

    // CRITICAL: Inspect length descriptor BEFORE reading any array element!
    const lenDesc = Object.getOwnPropertyDescriptor(items, "length");
    if (!lenDesc || typeof lenDesc.value !== "number" || lenDesc.value < 0) {
      throw createInvalidError("Invalid array length descriptor");
    }

    const len = lenDesc.value;
    if (len > MAX_BILLING_ITEMS) {
      // Early rejection: do not touch items[0], zero trap or getter execution!
      throw createInvalidError("billing.items count exceeds maximum limit of 32");
    }

    const ownNames = Object.getOwnPropertyNames(items);
    if (ownNames.length !== len + 1) { // +1 for 'length'
      throw createInvalidError("Unexpected properties on billing.items array");
    }

    // Now validate each item
    for (let i = 0; i < len; i++) {
      const idxStr = String(i);
      const desc = Object.getOwnPropertyDescriptor(items, idxStr);
      if (!desc) {
        throw createInvalidError("Sparse arrays are not permitted");
      }
      if (desc.get || desc.set) {
        throw createInvalidError("Accessors (getters/setters) are not permitted");
      }
      if (!desc.enumerable) {
        throw createInvalidError("Non-enumerable array elements are not permitted");
      }

      validateObjectLayer(desc.value, ALLOWED_ITEM_KEYS, MAX_ITEM_KEYS, depth + 1, "billing.item");
    }
  }

  validateObjectLayer(root, ALLOWED_ROOT_KEYS, MAX_ROOT_KEYS, 1, "root");
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
 * Normalizes a single PT consumption record (R2 Hardened Candidate).
 * Pure function: deterministic, immutable input, deeply frozen output.
 *
 * @param {object} raw - PT consumption record
 * @returns {object} Deeply frozen normalized record
 */
function normalizePtConsumeRecord(raw) {
  // Schema safety & early resource boundary checks
  scanStrictSchemaSafety(raw);

  // Check required root fields
  for (let i = 0; i < REQUIRED_ROOT_FIELDS.length; i++) {
    const f = REQUIRED_ROOT_FIELDS[i];
    if (raw[f] === undefined) {
      throw createInvalidError(`Missing required root field: ${f}`);
    }
  }

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

  // request_type: validated strictly against internal immutable Set
  if (!INTERNAL_REQUEST_TYPES_SET.has(raw.request_type)) {
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
  const pricingMode = checkBoundedString(raw.billing.pricing_mode, 1, 64);
  if (!INTERNAL_BILLING_UNITS_SET.has(raw.billing.billing_unit)) {
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
  let itemsSubtotalSum = 0;
  const normalizedItems = raw.billing.items.map((it) => {
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

// Export independent copies for public introspection without affecting internal validation
const exportedRequestTypes = new Set(PRIVATE_VALID_REQUEST_TYPES);
const exportedBillingUnits = new Set(PRIVATE_VALID_BILLING_UNITS);

module.exports = {
  ERROR_CODE,
  MAX_BILLING_ITEMS,
  MAX_DEPTH,
  MAX_PAYLOAD_BYTES,
  VALID_BILLING_UNITS: exportedBillingUnits,
  VALID_REQUEST_TYPES: exportedRequestTypes,
  VALID_REQUEST_TYPES_LIST: PRIVATE_VALID_REQUEST_TYPES,
  VALID_BILLING_UNITS_LIST: PRIVATE_VALID_BILLING_UNITS,
  normalizePtConsumeRecord,
};
