"use strict";

// Product boundary only: no execution, persistence, credentials, or DSH internals.
const { createHash } = require("node:crypto");
const runtime = require("../runtime/contract.cjs");
const VERSION = "1.0";
const LIMITS = Object.freeze({ jsonDepth: 64, jsonNodes: 10000, jsonBytes: 1024 * 1024, idempotencyKeyChars: 256, operationChars: 128 });
const TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled", "interrupted"]);
const TRANSITIONS = Object.freeze({
  queued: ["running", "cancelled", "failed", "interrupted"],
  running: ["waiting_external", "awaiting_confirmation", "cancelling", ...TERMINAL_STATES],
  waiting_external: ["running", "cancelling", ...TERMINAL_STATES],
  awaiting_confirmation: ["queued", "running", "cancelling", ...TERMINAL_STATES],
  cancelling: ["cancelled", "completed", "failed", "interrupted"],
  completed: [], failed: [], cancelled: [], interrupted: [],
});
const EVENT_TYPES = Object.freeze(["queued", "connecting", "delta", "tool.started", "tool.finished", "attachment.status", "artifact.ready", "usage", "state", "done", "error"]);
const text = (x) => typeof x === "string" && x.trim().length > 0;
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
const timestamp = (x) => typeof x === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(x) && Number.isFinite(Date.parse(x));
const hash = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const list = (x) => Array.isArray(x) && x.every(text);
const rules = {
  identity: { userId: text, tenantId: text },
  run: { version: (x) => x === VERSION, runId: text, conversationId: text, userId: text, tenantId: text, workspaceId: text, state: (x) => Object.hasOwn(TRANSITIONS, x), revision: integer, createdAt: timestamp, policyVersion: text },
  event: { version: (x) => x === VERSION, eventId: text, runId: text, conversationId: text, seq: (x) => integer(x) && x > 0, type: (x) => EVENT_TYPES.includes(x), occurredAt: timestamp, payload: object },
  attempt: { version: (x) => x === VERSION, attemptId: text, runId: text, requestedModel: text, resolvedModel: text, reportedModel: (x) => x === null || text(x), provider: text, endpointType: text, capability: text, requestId: (x) => x === null || text(x), state: (x) => ["pending", "running", "succeeded", "failed", "cancelled", "unknown"].includes(x), usageSource: (x) => x === null || text(x) },
  tool: { version: (x) => x === VERSION, callId: text, runId: text, toolId: text, toolVersion: text, category: (x) => ["skill", "mcp", "workflow", "builtin"].includes(x), authorization: (x) => ["allowed", "denied"].includes(x), state: (x) => ["pending", "running", "succeeded", "failed", "cancelled", "unknown"].includes(x) },
  attachment: { version: (x) => x === VERSION, attachmentId: text, userId: text, tenantId: text, workspaceId: text, sha256: hash, mediaType: text, byteLength: integer, parserVersion: (x) => x === null || text(x), state: (x) => ["uploaded", "parsing", "ready", "partial", "failed", "deleted"].includes(x), sources: (x) => Array.isArray(x) && x.every((source) => object(source) && ["page", "sheet", "slide", "paragraph", "line", "archive_path", "time"].includes(source.kind) && text(source.locator)) },
  artifact: { version: (x) => x === VERSION, artifactId: text, runId: text, userId: text, tenantId: text, workspaceId: text, revision: (x) => integer(x) && x > 0, sha256: hash, storageKey: text, mediaType: text, state: (x) => ["ready", "expired", "deleted", "failed"].includes(x) },
  model: { version: (x) => x === VERSION, modelId: text, provider: text, endpointTypes: list, inputModalities: list, outputModalities: list, tasks: list, capabilitySource: (x) => x === null || text(x), discovered: (x) => typeof x === "boolean", adapted: (x) => typeof x === "boolean", verified: (x) => typeof x === "boolean", autoEligible: (x) => typeof x === "boolean", observedAt: timestamp },
};

function validate(kind, value) {
  if (!Object.hasOwn(rules, kind)) throw new TypeError("Unknown contract: " + kind);
  if (!object(value)) return [kind + " must be an object"];
  const errors = [];
  try { canonicalJSON(value); } catch { return [kind + " must be bounded, serializable JSON"]; }
  for (const [field, check] of Object.entries(rules[kind])) {
    if (!check(value[field])) errors.push(kind + "." + field + " is invalid");
  }
  if (kind === "tool" && value.authorization === "denied" && ["running", "succeeded"].includes(value.state)) errors.push("denied tool cannot execute");
  if (kind === "run" && value.reconciliation !== undefined && !["not_required", "needs_reconciliation", "resolved"].includes(value.reconciliation)) errors.push("run.reconciliation is invalid");
  if (kind === "model" && value.autoEligible && !(value.discovered && value.adapted && value.verified && text(value.capabilitySource) && value.tasks?.length > 0 && value.endpointTypes?.length > 0)) errors.push("AUTO requires discovered, adapted, verified capabilities with evidence");
  if (kind === "model" && value.autoEligible && [value.tasks, value.endpointTypes, value.inputModalities, value.outputModalities].some((xs) => !Array.isArray(xs) || !xs.length || xs.some((x) => !text(x) || ["unknown", "unspecified"].includes(x.trim().toLowerCase())))) errors.push("AUTO requires explicit known input, output, task and endpoint capabilities");
  if (kind === "artifact" && text(value.storageKey) && (value.storageKey.includes("\\") || value.storageKey.startsWith("/") || /^[a-zA-Z]:/.test(value.storageKey) || value.storageKey.split("/").some((p) => p === ".." || p === "." || p === "") || /[\x00-\x1f]/.test(value.storageKey))) errors.push("artifact.storageKey must be a relative object key");
  if (kind === "event") {
    if (value.type === "tool.started" || value.type === "tool.finished") { if (!text(value.callId)) errors.push("tool event requires callId"); }
    if (value.type === "artifact.ready" && !text(value.artifactId)) errors.push("artifact event requires artifactId");
    if (value.type === "tool.finished" && !["succeeded", "failed", "cancelled", "unknown"].includes(value.payload?.state)) errors.push("finished tool requires terminal outcome");
  }
  return errors;
}
function assertContract(kind, value) {
  const errors = validate(kind, value);
  if (errors.length) throw Object.assign(new TypeError(errors.join("; ")), { code: "CONTRACT_INVALID", errors });
  return value;
}
function assertOwned(identity, value) {
  assertContract("identity", identity);
  if (!object(value) || identity.userId !== value.userId || identity.tenantId !== value.tenantId) throw Object.assign(new Error("Resource is not owned by identity"), { code: "FORBIDDEN" });
  return value;
}
function bindRun(identity, input) {
  assertContract("identity", identity);
  if (!object(input)) throw new TypeError("run input must be an object");
  // Callers resolve workspaceId themselves. Client identity overrides are rejected.
  for (const key of ["userId", "tenantId"]) if (input[key] !== undefined && input[key] !== identity[key]) throw Object.assign(new Error("Identity override rejected"), { code: "FORBIDDEN" });
  return assertContract("run", { ...input, userId: identity.userId, tenantId: identity.tenantId });
}
function transitionRun(run, next, expectedRevision) {
  assertContract("run", run);
  if (run.revision !== expectedRevision) throw Object.assign(new Error("Stale run revision"), { code: "REVISION_CONFLICT" });
  if (run.revision === Number.MAX_SAFE_INTEGER) throw Object.assign(new Error("Run revision exhausted"), { code: "REVISION_EXHAUSTED" });
  if (!TRANSITIONS[run.state].includes(next)) throw Object.assign(new Error("Invalid run transition"), { code: "INVALID_TRANSITION" });
  return { ...run, state: next, revision: run.revision + 1 };
}
function assertEventAfter(previous, event, run) {
  assertContract("run", run);
  assertContract("event", event);
  if (event.runId !== run.runId || event.conversationId !== run.conversationId) throw Object.assign(new Error("Event scope mismatch"), { code: "EVENT_SCOPE_MISMATCH" });
  // run is the snapshot at this append boundary, not the latest snapshot during replay.
  if (event.type === "done" && !TERMINAL_STATES.includes(run.state)) throw Object.assign(new Error("Done requires terminal run snapshot"), { code: "EVENT_STATE_MISMATCH" });
  if (event.type === "done" && event.payload.state !== undefined && event.payload.state !== run.state) throw Object.assign(new Error("Done outcome differs from run snapshot"), { code: "EVENT_STATE_MISMATCH" });
  if (previous !== null) {
    assertContract("event", previous);
    if (previous.runId !== event.runId || previous.conversationId !== event.conversationId || event.seq !== previous.seq + 1 || event.eventId === previous.eventId) throw Object.assign(new Error("Event sequence conflict"), { code: "EVENT_SEQUENCE_CONFLICT" });
  } else if (event.seq !== 1) throw Object.assign(new Error("Initial event must have seq 1"), { code: "EVENT_SEQUENCE_CONFLICT" });
  return event;
}
// Only JSON values can be fingerprinted; object-key ordering must not cause extra billing.
function canonicalJSON(value) {
  const ancestors = new Set();
  let nodes = 0;
  let bytes = 0;
  const account = (s) => {
    bytes += Buffer.byteLength(s);
    if (bytes > LIMITS.jsonBytes) throw new TypeError("JSON byte budget exceeded");
    return s;
  };
  function visit(v, depth) {
    if (++nodes > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) throw new TypeError("JSON structural budget exceeded");
    if (typeof v === "string" && v.length > LIMITS.jsonBytes) throw new TypeError("JSON string budget exceeded");
    if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return account(JSON.stringify(v));
    if (!Array.isArray(v) && !object(v)) throw new TypeError("Only finite JSON values are accepted");
    if (ancestors.has(v)) throw new TypeError("Cyclic JSON request");
    // Accept data objects only: JSON serialization must not invoke hidden hooks/getters.
    for (const key of Reflect.ownKeys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== "string" || descriptor.get || descriptor.set || (key !== "length" && !descriptor.enumerable) || key === "toJSON") throw new TypeError("Only plain JSON data properties are accepted");
    }
    ancestors.add(v);
    let result;
    if (Array.isArray(v)) {
      if (v.length > LIMITS.jsonNodes) throw new TypeError("JSON array budget exceeded");
      const items = [];
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i)) throw new TypeError("Sparse arrays are not JSON requests");
        items.push(visit(v[i], depth + 1));
      }
      account("[]" + ",".repeat(Math.max(0, items.length - 1)));
      result = "[" + items.join(",") + "]";
    } else {
      const keys = Object.keys(v).sort();
      if (keys.length > LIMITS.jsonNodes) throw new TypeError("JSON object budget exceeded");
      const items = keys.map((key) => account(JSON.stringify(key) + ":") + visit(v[key], depth + 1));
      account("{}" + ",".repeat(Math.max(0, items.length - 1)));
      result = "{" + items.join(",") + "}";
    }
    ancestors.delete(v);
    return result;
  }
  return visit(value, 0);
}
function fingerprint(request) { return createHash("sha256").update(canonicalJSON(request)).digest("hex"); }
function idempotencyClaim(identity, operation, key, request) {
  assertContract("identity", identity);
  if (![operation, key].every(text)) throw new TypeError("Operation and idempotency key are required");
  if (operation.length > LIMITS.operationChars || key.length > LIMITS.idempotencyKeyChars) throw new TypeError("Idempotency scope exceeds length limit");
  return { scope: fingerprint([identity.tenantId, identity.userId, operation, key]), requestHash: fingerprint(request) };
}
function compareIdempotency(existing, claim) {
  if (!object(claim) || !hash(claim.scope) || !hash(claim.requestHash)) throw new TypeError("Invalid idempotency claim");
  if (existing === null) return "new";
  if (!object(existing) || !hash(existing.scope) || !hash(existing.requestHash) || !text(existing.runId)) throw new TypeError("Invalid persisted idempotency record");
  if (existing.scope !== claim.scope) throw Object.assign(new Error("Different idempotency scope"), { code: "IDEMPOTENCY_SCOPE_MISMATCH" });
  if (existing.requestHash !== claim.requestHash) throw Object.assign(new Error("Key already used for a different request"), { code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
  return "replay";
}
module.exports = { VERSION, LIMITS, TERMINAL_STATES, EVENT_TYPES, validate, assertContract, assertOwned, bindRun, transitionRun, assertEventAfter, fingerprint, idempotencyClaim, compareIdempotency, runtimeMethods: Object.freeze([...runtime.RUNTIME_METHODS]), runtimeEvents: Object.freeze([...runtime.RUNTIME_EVENT_TYPES]) };
