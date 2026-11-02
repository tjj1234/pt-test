"use strict";

const { types } = require("node:util");

const ERROR_CODE = "MEDIA_RECONCILIATION_INVALID";
const MAX_UTF8_BYTES = 16 * 1024; // 16 KiB
const MAX_DEPTH = 6;

// Terminal status whitelists derived from shell/tasks/provider-adapters.cjs and provider-reconciliation.cjs
const POLLER_SUCCESS_STATUSES = Object.freeze(new Set([
  "completed",
  "succeeded",
  "success",
  "successful",
  "finished",
  "done",
  "ready",
  "ok",
]));

const POLLER_FAILURE_STATUSES = Object.freeze(new Set([
  "failed",
  "error",
  "expired",
  "rejected",
  "timeout",
]));

const POLLER_CANCELLED_STATUSES = Object.freeze(new Set([
  "cancelled",
  "canceled",
]));

const VALID_TASK_TYPES = Object.freeze(new Set([
  "text2image",
  "image2image",
  "text2video",
  "image2video",
]));

const VALID_OPERATION_STATUSES = Object.freeze(new Set([
  "submitting",
  "accepted",
  "querying",
  "pending_query",
  "manual_check",
  "succeeded",
  "failed",
  "cancelled",
]));

const VALID_LAST_QUERY_OUTCOMES = Object.freeze(new Set([
  "succeeded",
  "failed",
  "cancelled",
  "provider_pending",
  "query_temporary_failure",
  "query_retry_exhausted",
  "provider_state_unknown",
  "unknown_submission",
  "query_claim_recovered",
]));

const ALLOWED_ROOT_KEYS = Object.freeze(new Set(["reservation", "operation"]));

const ALLOWED_RESERVATION_KEYS = Object.freeze(new Set([
  "reservationId",
  "grantId",
  "runId",
  "operationKey",
  "credentialScopeId",
  "modelId",
  "taskType",
  "provider",
  "status",
  "reservedAt",
]));

const ALLOWED_OPERATION_KEYS = Object.freeze(new Set([
  "operationId",
  "runId",
  "operationKey",
  "provider",
  "status",
  "taskId",
  "lastQuery",
  "updatedAt",
]));

const ALLOWED_LAST_QUERY_KEYS = Object.freeze(new Set([
  "outcome",
  "observedAt",
  "providerStatus",
  "reason",
  "queried",
  "attempt",
  "source",
]));

function createInvalidError() {
  return Object.assign(new Error("Media reservation reconciliation input is invalid"), { code: ERROR_CODE });
}

// Validate the exact flat schema before reading values or serializing anything.
// Reflect.ownKeys is necessary to reject non-enumerable and Symbol properties;
// never copy an unbounded descriptor map or stringify the caller's object.
function validatePureJsonStructure(root) {
  const seen = new Set();
  let bytes = 0;
  const add = (n) => { bytes += n; if (bytes > MAX_UTF8_BYTES) throw createInvalidError(); };
  const stringBytes = (value) => {
    if (value.length > MAX_UTF8_BYTES) throw createInvalidError();
    let n = 2;
    for (const c of value) {
      const code = c.codePointAt(0);
      n += code < 32 ? ([8,9,10,12,13].includes(code) ? 2 : 6)
        : c === '"' || c === "\\" ? 2
        : code >= 0xd800 && code <= 0xdfff ? 6 : Buffer.byteLength(c, "utf8");
      if (n + bytes > MAX_UTF8_BYTES) throw createInvalidError();
    }
    return n;
  };
  function scan(value, depth, shape) {
    if (depth > MAX_DEPTH || types.isProxy(value)) throw createInvalidError();
    if (value === null) { add(4); return; }
    switch (typeof value) {
      case "string": add(stringBytes(value)); return;
      case "boolean": add(value ? 4 : 5); return;
      case "number":
        if (!Number.isFinite(value)) throw createInvalidError();
        add(String(value).length); return;
      case "object": break;
      default: throw createInvalidError();
    }
    if (!shape || Array.isArray(value) || seen.has(value)) throw createInvalidError();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw createInvalidError();
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > shape.size) throw createInvalidError();
    add(2);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key !== "string" || !shape.has(key)) throw createInvalidError();
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !desc.enumerable || !("value" in desc)) throw createInvalidError();
      add(stringBytes(key) + 1 + (i ? 1 : 0));
      const childShape = shape === ALLOWED_ROOT_KEYS
        ? (key === "reservation" ? ALLOWED_RESERVATION_KEYS : ALLOWED_OPERATION_KEYS)
        : shape === ALLOWED_OPERATION_KEYS && key === "lastQuery" ? ALLOWED_LAST_QUERY_KEYS : null;
      scan(desc.value, depth + 1, childShape);
    }
  }
  if (root === null || typeof root !== "object" || types.isProxy(root)) throw createInvalidError();
  scan(root, 1, ALLOWED_ROOT_KEYS);
}

function checkKnownKeys(obj, allowedKeys, label) {
  const ownKeys = Object.keys(obj);
  for (const k of ownKeys) {
    if (!allowedKeys.has(k)) {
      throw createInvalidError(`Unknown field detected in ${label}`);
    }
  }
}

function validateBoundedString(val, fieldName, maxLen = 256, regex = /^[a-zA-Z0-9_.:-]+$/) {
  if (typeof val !== "string" || !val.trim() || val.length > maxLen || !regex.test(val)) {
    throw createInvalidError(`Field ${fieldName} must be a bounded alphanumeric string`);
  }
  return val;
}

function validateTimestamp(val) {
  if (typeof val !== "string") throw createInvalidError();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(val);
  if (!match) throw createInvalidError();
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] || "").padEnd(3, "0")}Z`;
  const ms = Date.parse(canonical);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== canonical) throw createInvalidError();
  return ms;
}

/**
 * Decide media reservation reconciliation based on external operations audit trail.
 * Pure function: synchronous, deterministic, immutable input, frozen output.
 *
 * @param {object} input - { reservation, operation }
 * @returns {object} Frozen decision object
 */
function decideMediaReservationReconciliation(input) {
  validatePureJsonStructure(input);

  checkKnownKeys(input, ALLOWED_ROOT_KEYS, "root");

  const { reservation, operation } = input;
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    throw createInvalidError("reservation must be an object");
  }
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw createInvalidError("operation must be an object");
  }

  checkKnownKeys(reservation, ALLOWED_RESERVATION_KEYS, "reservation");
  checkKnownKeys(operation, ALLOWED_OPERATION_KEYS, "operation");

  // Validate reservation fields
  const reservationId = validateBoundedString(reservation.reservationId, "reservationId", 256);
  const grantId = validateBoundedString(reservation.grantId, "grantId", 256);
  const resRunId = validateBoundedString(reservation.runId, "reservation.runId", 256);
  const resOpKey = validateBoundedString(reservation.operationKey, "reservation.operationKey", 512);
  validateBoundedString(reservation.credentialScopeId, "credentialScopeId", 256);
  validateBoundedString(reservation.modelId, "modelId", 128);
  const resProvider = validateBoundedString(reservation.provider, "reservation.provider", 128);

  if (!VALID_TASK_TYPES.has(reservation.taskType)) {
    throw createInvalidError("Invalid taskType in reservation");
  }
  if (reservation.status !== "reserved") {
    throw createInvalidError("Reservation status must be 'reserved'");
  }
  const reservedAtMs = validateTimestamp(reservation.reservedAt, "reservedAt");

  // Validate operation fields
  validateBoundedString(operation.operationId, "operationId", 256);
  const opRunId = validateBoundedString(operation.runId, "operation.runId", 256);
  const opOpKey = validateBoundedString(operation.operationKey, "operation.operationKey", 512);
  const opProvider = validateBoundedString(operation.provider, "operation.provider", 128);

  if (!VALID_OPERATION_STATUSES.has(operation.status)) {
    throw createInvalidError("Invalid status in operation");
  }
  const updatedAtMs = validateTimestamp(operation.updatedAt, "updatedAt");

  if (operation.taskId !== null) {
    validateBoundedString(operation.taskId, "taskId", 512);
  }

  // Cross-entity identity correspondence check
  if (resRunId !== opRunId) {
    throw createInvalidError("Cross-entity runId mismatch");
  }
  if (resOpKey !== opOpKey) {
    throw createInvalidError("Cross-entity operationKey mismatch");
  }
  if (resProvider !== opProvider) {
    throw createInvalidError("Cross-entity provider mismatch");
  }

  // Chronology validation
  if (updatedAtMs < reservedAtMs) {
    throw createInvalidError("Chronology violation: updatedAt cannot precede reservedAt");
  }

  // Validate lastQuery if present
  let lastQuery = operation.lastQuery;
  let observedAtMs = null;
  if (lastQuery !== null) {
    if (typeof lastQuery !== "object" || Array.isArray(lastQuery)) {
      throw createInvalidError("lastQuery must be an object or null");
    }
    checkKnownKeys(lastQuery, ALLOWED_LAST_QUERY_KEYS, "lastQuery");

    if (!VALID_LAST_QUERY_OUTCOMES.has(lastQuery.outcome)) {
      throw createInvalidError("Invalid outcome in lastQuery");
    }

    observedAtMs = validateTimestamp(lastQuery.observedAt, "observedAt");
    if (observedAtMs < reservedAtMs) {
      throw createInvalidError("Chronology violation: observedAt cannot precede reservedAt");
    }
    // observedAt uses the host clock; updatedAt uses the database clock.
    // Both must follow the reservation, but cross-clock ordering is not proof.

    if (lastQuery.providerStatus !== null) {
      validateBoundedString(lastQuery.providerStatus, "providerStatus", 64, /^[a-zA-Z0-9_-]+$/);
    }
    if (lastQuery.reason !== null) {
      validateBoundedString(lastQuery.reason, "reason", 64);
    }
    if (typeof lastQuery.queried !== "boolean") {
      throw createInvalidError("lastQuery.queried must be a boolean");
    }
    if (
      !Number.isSafeInteger(lastQuery.attempt) ||
      lastQuery.attempt < 0 ||
      lastQuery.attempt > 100
    ) {
      throw createInvalidError("lastQuery.attempt must be a non-negative integer <= 100");
    }
    if (lastQuery.source !== undefined && lastQuery.source !== null) {
      validateBoundedString(lastQuery.source, "source", 64);
    }
  }

  // Decision logic
  let decision = "keep_reserved";
  let reasonCode = "IN_FLIGHT_PENDING";

  const opStatus = operation.status;

  if (opStatus === "submitting") {
    decision = "keep_reserved";
    reasonCode = "IN_FLIGHT_SUBMITTING";
  } else if (opStatus === "accepted") {
    decision = "keep_reserved";
    reasonCode = "IN_FLIGHT_ACCEPTED";
  } else if (opStatus === "querying") {
    decision = "keep_reserved";
    reasonCode = "IN_FLIGHT_QUERYING";
  } else if (opStatus === "pending_query") {
    decision = "keep_reserved";
    reasonCode = "IN_FLIGHT_PENDING_QUERY";
  } else if (opStatus === "manual_check") {
    decision = "keep_reserved";
    if (lastQuery?.outcome === "unknown_submission") {
      reasonCode = "MANUAL_CHECK_UNKNOWN_SUBMISSION";
    } else {
      reasonCode = "MANUAL_CHECK_REQUIRED";
    }
  } else if (opStatus === "succeeded") {
    if (!lastQuery) {
      throw createInvalidError("Terminal succeeded status requires lastQuery audit");
    }
    if (lastQuery.outcome !== "succeeded") {
      throw createInvalidError("Contradictory state: status succeeded but outcome does not match");
    }

    const provStatus = lastQuery.providerStatus ? lastQuery.providerStatus.toLowerCase() : null;
    if (provStatus) {
      if (POLLER_FAILURE_STATUSES.has(provStatus) || POLLER_CANCELLED_STATUSES.has(provStatus)) {
        throw createInvalidError("Contradictory state: status succeeded but providerStatus is failure/cancelled");
      }
      if (!POLLER_SUCCESS_STATUSES.has(provStatus)) {
        throw createInvalidError("Unrecognized providerStatus for succeeded operation");
      }
      decision = "release_allowed";
      reasonCode = "OPERATION_TERMINAL_SUCCEEDED";
    } else {
      if (lastQuery.queried === true) {
        decision = "release_allowed";
        reasonCode = "OPERATION_TERMINAL_SUCCEEDED";
      } else {
        // Without providerStatus or verified query, cannot release
        decision = "keep_reserved";
        reasonCode = "TERMINAL_EVIDENCE_INSUFFICIENT";
      }
    }
  } else if (opStatus === "failed") {
    if (!lastQuery) {
      throw createInvalidError("Terminal failed status requires lastQuery audit");
    }
    if (lastQuery.outcome !== "failed") {
      throw createInvalidError("Contradictory state: status failed but outcome does not match");
    }

    const provStatus = lastQuery.providerStatus ? lastQuery.providerStatus.toLowerCase() : null;
    if (provStatus) {
      if (POLLER_SUCCESS_STATUSES.has(provStatus) || POLLER_CANCELLED_STATUSES.has(provStatus)) {
        throw createInvalidError("Contradictory state: status failed but providerStatus is success/cancelled");
      }
      if (!POLLER_FAILURE_STATUSES.has(provStatus)) {
        throw createInvalidError("Unrecognized providerStatus for failed operation");
      }
      decision = "release_allowed";
      reasonCode = "OPERATION_TERMINAL_FAILED";
    } else {
      if (lastQuery.queried === true) {
        decision = "release_allowed";
        reasonCode = "OPERATION_TERMINAL_FAILED";
      } else {
        decision = "keep_reserved";
        reasonCode = "TERMINAL_EVIDENCE_INSUFFICIENT";
      }
    }
  } else if (opStatus === "cancelled") {
    if (!lastQuery) {
      throw createInvalidError("Terminal cancelled status requires lastQuery audit");
    }
    if (lastQuery.outcome !== "cancelled") {
      throw createInvalidError("Contradictory state: status cancelled but outcome does not match");
    }

    const provStatus = lastQuery.providerStatus ? lastQuery.providerStatus.toLowerCase() : null;

    if (provStatus && !POLLER_CANCELLED_STATUSES.has(provStatus)) throw createInvalidError();
    if (lastQuery.reason === "not_submitted" &&
        (operation.taskId !== null || lastQuery.queried !== false || lastQuery.source !== "host" || provStatus !== null)) throw createInvalidError();

    // Condition 1: Verified never submitted to external provider
    const isDeterminedNotSubmitted = (
      lastQuery.reason === "not_submitted" &&
      operation.taskId === null &&
      lastQuery.queried === false &&
      lastQuery.source === "host" &&
      provStatus === null
    );

    // Condition 2: Verified remote terminal cancellation
    const isRemoteVerifiedCancelled = (
      (lastQuery.queried === true || lastQuery.source === "host") &&
      provStatus !== null &&
      POLLER_CANCELLED_STATUSES.has(provStatus)
    );

    if (isDeterminedNotSubmitted) {
      decision = "release_allowed";
      reasonCode = "OPERATION_CANCELLED_NOT_SUBMITTED";
    } else if (isRemoteVerifiedCancelled) {
      decision = "release_allowed";
      reasonCode = "OPERATION_TERMINAL_CANCELLED";
    } else {
      // Local cancellation or unverified remote cancellation
      decision = "keep_reserved";
      reasonCode = "OPERATION_CANCELLED_UNVERIFIED_REMOTE";
    }
  } else {
    throw createInvalidError("Unsupported operation status");
  }

  // Contradictory local/unknown evidence cannot authorize slot release even
  // if another field happens to carry a terminal-looking provider label.
  if (decision === "release_allowed" && new Set([
    "unknown_submission", "local_timeout", "client_timeout", "user_aborted",
    "local_cancelled", "local_canceled",
  ]).has(lastQuery?.reason)) {
    decision = "keep_reserved";
    reasonCode = "LOCAL_OR_UNKNOWN_EVIDENCE";
  }

  const result = {
    decision,
    reservationId,
    grantId,
    runId: resRunId,
    operationKey: resOpKey,
    reasonCode,
    grantRemainsConsumed: true,
    mayResubmit: false,
  };

  return Object.freeze(result);
}

module.exports = {
  ERROR_CODE,
  MAX_DEPTH,
  MAX_UTF8_BYTES,
  POLLER_CANCELLED_STATUSES: Object.freeze([...POLLER_CANCELLED_STATUSES]),
  POLLER_FAILURE_STATUSES: Object.freeze([...POLLER_FAILURE_STATUSES]),
  POLLER_SUCCESS_STATUSES: Object.freeze([...POLLER_SUCCESS_STATUSES]),
  VALID_OPERATION_STATUSES: Object.freeze([...VALID_OPERATION_STATUSES]),
  VALID_TASK_TYPES: Object.freeze([...VALID_TASK_TYPES]),
  decideMediaReservationReconciliation,
};
Object.freeze(module.exports);
