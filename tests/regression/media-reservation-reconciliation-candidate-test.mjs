import test from "node:test";
import assert from "node:assert/strict";
import reconciliation from "../../shell/tasks/media-reservation-reconciliation-candidate.cjs";
const { decideMediaReservationReconciliation, ERROR_CODE } = reconciliation;

function createValidReservation(overrides = {}) {
  return {
    reservationId: "res-001",
    grantId: "grant-001",
    runId: "run-001",
    operationKey: "opkey-media-gen-001",
    credentialScopeId: "scope-default",
    modelId: "seedance-v1",
    taskType: "image2video",
    provider: "powertokens",
    status: "reserved",
    reservedAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

function createValidOperation(overrides = {}) {
  return {
    operationId: "op-001",
    runId: "run-001",
    operationKey: "opkey-media-gen-001",
    provider: "powertokens",
    status: "succeeded",
    taskId: "task-ext-001",
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "completed",
      reason: null,
      queried: true,
      attempt: 2,
      source: "provider",
    },
    updatedAt: "2026-10-28T10:05:05.000Z",
    ...overrides,
  };
}

test("1. succeeded: verified with providerStatus 'completed' allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation();
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_SUCCEEDED");
  assert.equal(res.reservationId, "res-001");
  assert.equal(res.grantId, "grant-001");
  assert.equal(res.runId, "run-001");
  assert.equal(res.operationKey, "opkey-media-gen-001");
  assert.equal(res.grantRemainsConsumed, true);
  assert.equal(res.mayResubmit, false);
});

test("2. succeeded: synchronous image with taskId null allows release", () => {
  const reservation = createValidReservation({ taskType: "text2image" });
  const operation = createValidOperation({
    taskId: null,
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:01:00.000Z",
      providerStatus: "succeeded",
      reason: null,
      queried: false,
      attempt: 0,
      source: "host",
    },
    updatedAt: "2026-10-28T10:01:02.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_SUCCEEDED");
  assert.equal(res.grantRemainsConsumed, true);
  assert.equal(res.mayResubmit, false);
});

test("3. succeeded: queried=true with null providerStatus allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: null,
      queried: true,
      attempt: 3,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_SUCCEEDED");
});

test("4. failed: verified with providerStatus 'failed' allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "failed",
    lastQuery: {
      outcome: "failed",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "failed",
      reason: "inference_error",
      queried: true,
      attempt: 1,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_FAILED");
  assert.equal(res.grantRemainsConsumed, true);
  assert.equal(res.mayResubmit, false);
});

test("5. failed: verified with providerStatus 'error' allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "failed",
    lastQuery: {
      outcome: "failed",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "error",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_FAILED");
});

test("6. failed: verified with providerStatus 'timeout' allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "failed",
    lastQuery: {
      outcome: "failed",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "timeout",
      reason: null,
      queried: true,
      attempt: 4,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_FAILED");
});

test("7. failed: queried=true with null providerStatus allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "failed",
    lastQuery: {
      outcome: "failed",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: null,
      queried: true,
      attempt: 8,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_FAILED");
});

test("8. cancelled: confirmed not submitted allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "cancelled",
    taskId: null,
    lastQuery: {
      outcome: "cancelled",
      observedAt: "2026-10-28T10:01:00.000Z",
      providerStatus: null,
      reason: "not_submitted",
      queried: false,
      attempt: 0,
      source: "host",
    },
    updatedAt: "2026-10-28T10:01:05.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_CANCELLED_NOT_SUBMITTED");
  assert.equal(res.grantRemainsConsumed, true);
  assert.equal(res.mayResubmit, false);
});

test("9. cancelled: remote verified 'cancelled' allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "cancelled",
    lastQuery: {
      outcome: "cancelled",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "cancelled",
      reason: null,
      queried: true,
      attempt: 2,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_CANCELLED");
});

test("10. cancelled: remote verified alternate spelling 'canceled' allows release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "cancelled",
    lastQuery: {
      outcome: "cancelled",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "canceled",
      reason: null,
      queried: true,
      attempt: 2,
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "release_allowed");
  assert.equal(res.reasonCode, "OPERATION_TERMINAL_CANCELLED");
});

test("11. cancelled: local cancellation only (with taskId) must keep reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "cancelled",
    taskId: "task-ext-123",
    lastQuery: {
      outcome: "cancelled",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: "user_aborted",
      queried: false,
      attempt: 0,
      source: "host",
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "OPERATION_CANCELLED_UNVERIFIED_REMOTE");
});

test("12. cancelled: local timeout without remote confirmation must keep reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "cancelled",
    taskId: "task-ext-123",
    lastQuery: {
      outcome: "cancelled",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: "client_timeout",
      queried: false,
      attempt: 0,
      source: "host",
    },
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "OPERATION_CANCELLED_UNVERIFIED_REMOTE");
});

test("13. submitting: in-flight state keeps reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "submitting",
    taskId: null,
    lastQuery: null,
    updatedAt: "2026-10-28T10:01:00.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "IN_FLIGHT_SUBMITTING");
});

test("14. accepted: in-flight state keeps reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "accepted",
    taskId: "task-ext-001",
    lastQuery: null,
    updatedAt: "2026-10-28T10:02:00.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "IN_FLIGHT_ACCEPTED");
});

test("15. querying: in-flight state keeps reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "querying",
    taskId: "task-ext-001",
    lastQuery: null,
    updatedAt: "2026-10-28T10:03:00.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "IN_FLIGHT_QUERYING");
});

test("16. pending_query: in-flight state keeps reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "pending_query",
    taskId: "task-ext-001",
    lastQuery: {
      outcome: "provider_pending",
      observedAt: "2026-10-28T10:03:00.000Z",
      providerStatus: "processing",
      reason: null,
      queried: true,
      attempt: 1,
    },
    updatedAt: "2026-10-28T10:03:05.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "IN_FLIGHT_PENDING_QUERY");
});

test("17. manual_check: general manual check state keeps reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "manual_check",
    taskId: "task-ext-001",
    lastQuery: {
      outcome: "query_retry_exhausted",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: null,
      queried: true,
      attempt: 8,
    },
    updatedAt: "2026-10-28T10:05:05.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "MANUAL_CHECK_REQUIRED");
});

test("18. manual_check: unknown_submission without taskId keeps reserved", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "manual_check",
    taskId: null,
    lastQuery: {
      outcome: "unknown_submission",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: "expired_submission_lease",
      queried: false,
      attempt: 0,
    },
    updatedAt: "2026-10-28T10:05:05.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "MANUAL_CHECK_UNKNOWN_SUBMISSION");
});

test("19. fake reason keywords in submitting does not fool engine into release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "submitting",
    lastQuery: {
      outcome: "query_temporary_failure",
      observedAt: "2026-10-28T10:01:00.000Z",
      providerStatus: null,
      reason: "succeeded",
      queried: false,
      attempt: 0,
    },
    updatedAt: "2026-10-28T10:01:05.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "IN_FLIGHT_SUBMITTING");
});

test("20. fake reason keywords in manual_check does not fool engine into release", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "manual_check",
    lastQuery: {
      outcome: "provider_state_unknown",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: null,
      reason: "completed",
      queried: true,
      attempt: 1,
    },
    updatedAt: "2026-10-28T10:05:05.000Z",
  });
  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(res.decision, "keep_reserved");
  assert.equal(res.reasonCode, "MANUAL_CHECK_REQUIRED");
});

test("21. chronology violation: updatedAt before reservedAt throws invalid error", () => {
  const reservation = createValidReservation({ reservedAt: "2026-10-28T10:00:00.000Z" });
  const operation = createValidOperation({ updatedAt: "2026-10-28T09:59:59.000Z" });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("22. chronology violation: observedAt before reservedAt throws invalid error", () => {
  const reservation = createValidReservation({ reservedAt: "2026-10-28T10:00:00.000Z" });
  const operation = createValidOperation({
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T09:59:59.000Z",
      providerStatus: "completed",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("23. host observation may lead the database clock after reservation", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:05:00.001Z",
      providerStatus: "completed",
      reason: null,
      queried: true,
      attempt: 1,
    },
    updatedAt: "2026-10-28T10:05:00.000Z",
  });

  assert.equal(decideMediaReservationReconciliation({ reservation, operation }).decision,"release_allowed");
});

test("24. contradiction: status succeeded but outcome failed throws invalid error", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "succeeded",
    lastQuery: {
      outcome: "failed",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "completed",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("25. contradiction: status succeeded but providerStatus is failure throws invalid error", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "succeeded",
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "failed",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("26. contradiction: status failed but outcome succeeded throws invalid error", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "failed",
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "failed",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("27. contradiction: status failed but providerStatus is success throws invalid error", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "failed",
    lastQuery: {
      outcome: "failed",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "success",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("28. contradiction: status cancelled but outcome succeeded throws invalid error", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation({
    status: "cancelled",
    lastQuery: {
      outcome: "succeeded",
      observedAt: "2026-10-28T10:05:00.000Z",
      providerStatus: "cancelled",
      reason: null,
      queried: true,
      attempt: 1,
    },
  });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("29. identity mismatch: runId mismatch throws invalid error", () => {
  const reservation = createValidReservation({ runId: "run-A" });
  const operation = createValidOperation({ runId: "run-B" });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("30. identity mismatch: operationKey mismatch throws invalid error", () => {
  const reservation = createValidReservation({ operationKey: "key-A" });
  const operation = createValidOperation({ operationKey: "key-B" });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("31. identity mismatch: provider mismatch throws invalid error", () => {
  const reservation = createValidReservation({ provider: "powertokens" });
  const operation = createValidOperation({ provider: "doubao" });

  assert.throws(() => decideMediaReservationReconciliation({ reservation, operation }), {
    code: ERROR_CODE,
  });
});

test("32. security: getter accessor is detected and NOT executed", () => {
  let getterInvoked = false;
  const malicious = {
    get maliciousProp() {
      getterInvoked = true;
      throw new Error("Getter should not have executed!");
    },
  };

  const reservation = createValidReservation();
  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation: malicious }),
    { code: ERROR_CODE },
  );
  assert.equal(getterInvoked, false, "Getter must never be executed");
});

test("33. security: Proxy object is rejected without invoking trap", () => {
  let trapInvoked = false;
  const target = createValidOperation();
  const proxy = new Proxy(target, {
    get(t, p, r) {
      if (p === "trapped") trapInvoked = true;
      return Reflect.get(t, p, r);
    },
  });

  const reservation = createValidReservation();
  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation: proxy }),
    { code: ERROR_CODE },
  );
  assert.equal(trapInvoked, false);
});

test("34. security: circular reference is rejected", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation();
  operation.self = operation;

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );
});

test("35. security: shared object reference between reservation and operation is rejected", () => {
  const sharedObj = { nested: "shared" };
  const reservation = createValidReservation();
  reservation.shared = sharedObj;
  const operation = createValidOperation();
  operation.shared = sharedObj;

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );
});

test("36. security: symbol property is rejected", () => {
  const sym = Symbol("forbidden");
  const reservation = createValidReservation();
  reservation[sym] = "value";
  const operation = createValidOperation();

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );
});

test("37. security: non-finite numbers (NaN/Infinity) are rejected", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation();
  operation.lastQuery.attempt = Number.NaN;

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );

  operation.lastQuery.attempt = Number.POSITIVE_INFINITY;
  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );
});

test("38. security: unknown property (apiKey, prompt) is rejected", () => {
  const reservation = createValidReservation({ apiKey: "sk-secret-123456" });
  const operation = createValidOperation();

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );

  const cleanRes = createValidReservation();
  const opWithPrompt = createValidOperation({ prompt: "malicious prompt" });
  assert.throws(
    () => decideMediaReservationReconciliation({ reservation: cleanRes, operation: opWithPrompt }),
    { code: ERROR_CODE },
  );
});

test("39. security: payload depth exceeding 6 is rejected", () => {
  let deep = "leaf";
  for (let i = 0; i < 7; i++) {
    deep = { next: deep };
  }
  const reservation = createValidReservation();
  reservation.deep = deep;
  const operation = createValidOperation();

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );
});

test("40. security: oversized payload (> 16 KiB) is rejected", () => {
  const reservation = createValidReservation();
  const hugeString = "x".repeat(17000);
  const operation = createValidOperation();
  operation.lastQuery.reason = hugeString;

  assert.throws(
    () => decideMediaReservationReconciliation({ reservation, operation }),
    { code: ERROR_CODE },
  );
});

test("41. redaction: error messages never leak PRIVATE_SENTINEL field names or values", () => {
  const SENTINEL_VALUE = "PRIVATE_SENTINEL_SECRET_!@#$%^&*()";
  const SENTINEL_KEY = "PRIVATE_SENTINEL_FIELD_KEY";

  // Case A: Sentinel in invalid value
  const reservationA = createValidReservation({ modelId: SENTINEL_VALUE });
  const operationA = createValidOperation();

  try {
    decideMediaReservationReconciliation({ reservation: reservationA, operation: operationA });
    assert.fail("Should have thrown");
  } catch (err) {
    if (err.code === "ERR_ASSERTION") throw err;
    assert.equal(err.code, ERROR_CODE);
    assert.equal(err.message.includes(SENTINEL_VALUE), false, "Must not leak secret value");
    assert.equal(err.message.includes("PRIVATE_SENTINEL"), false, "Must not leak secret token");
  }

  // Case B: Sentinel in unknown key name
  const reservationB = createValidReservation();
  reservationB[SENTINEL_KEY] = "some-value";
  const operationB = createValidOperation();

  try {
    decideMediaReservationReconciliation({ reservation: reservationB, operation: operationB });
    assert.fail("Should have thrown");
  } catch (err) {
    if (err.code === "ERR_ASSERTION") throw err;
    assert.equal(err.code, ERROR_CODE);
    assert.equal(err.message.includes(SENTINEL_KEY), false, "Must not leak secret key name");
    assert.equal(err.message.includes("PRIVATE_SENTINEL"), false, "Must not leak secret token");
  }
});

test("42. immutability and deep freeze: inputs untouched and output deeply frozen", () => {
  const reservation = createValidReservation();
  const operation = createValidOperation();

  const originalReservationSnapshot = JSON.stringify(reservation);
  const originalOperationSnapshot = JSON.stringify(operation);

  const res = decideMediaReservationReconciliation({ reservation, operation });

  assert.equal(JSON.stringify(reservation), originalReservationSnapshot, "Reservation must remain unmodified");
  assert.equal(JSON.stringify(operation), originalOperationSnapshot, "Operation must remain unmodified");

  assert.equal(Object.isFrozen(res), true, "Result must be frozen");
  assert.throws(() => {
    res.decision = "tampered";
  }, TypeError);
});

test("43. fixed invariants: grantRemainsConsumed: true and mayResubmit: false across all decisions", () => {
  // Test keep_reserved invariant
  const res1 = decideMediaReservationReconciliation({
    reservation: createValidReservation(),
    operation: createValidOperation({ status: "submitting", taskId: null, lastQuery: null }),
  });
  assert.equal(res1.grantRemainsConsumed, true);
  assert.equal(res1.mayResubmit, false);

  // Test release_allowed invariant
  const res2 = decideMediaReservationReconciliation({
    reservation: createValidReservation(),
    operation: createValidOperation(),
  });
  assert.equal(res2.grantRemainsConsumed, true);
  assert.equal(res2.mayResubmit, false);
});


test("main: real grant task types and minimal external-operation projection", () => {
  for (const taskType of ["text2image", "image2image", "text2video", "image2video"]) {
    // Fields projected from controlled_media_reservations + associated grant,
    // and externalOperations.decode/recordSubmissionResult (source: host).
    const reservation = createValidReservation({ taskType });
    const operation = createValidOperation({ taskId: null });
    Object.assign(operation.lastQuery, { source: "host", queried: false, attempt: 0 });
    const result = decideMediaReservationReconciliation({ reservation, operation });
    assert.equal(result.decision, "release_allowed");
  }
});

test("main: strict calendar and ISO timestamps", () => {
  for (const timestamp of ["2026-02-30T00:00:00.000Z", "2026-10-28T24:00:00.000Z", "2026-10-28T10:00:00garbageZ", "2026-10-28T10:00:00.0001Z"]) {
    assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation({ reservedAt: timestamp }), operation: createValidOperation() }), { code: ERROR_CODE });
  }
  assert.equal(decideMediaReservationReconciliation({ reservation: createValidReservation({ reservedAt: "2026-10-28T10:00:00Z" }), operation: createValidOperation() }).decision, "release_allowed");
});

test("main: contradictory not-submitted cancellation never releases", () => {
  for (const changes of [{ providerStatus: "succeeded" }, { providerStatus: "cancelled" }, { queried: true }, { source: "provider" }]) {
    const operation = createValidOperation({ status: "cancelled", taskId: null });
    Object.assign(operation.lastQuery, { outcome: "cancelled", reason: "not_submitted", queried: false, source: "host", providerStatus: null }, changes);
    assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation(), operation }), { code: ERROR_CODE });
  }
});

test("main: trusted host remote cancellation is compatible without a query", () => {
  const operation = createValidOperation({ status: "cancelled" });
  Object.assign(operation.lastQuery, { outcome: "cancelled", providerStatus: "cancelled", queried: false, source: "host" });
  assert.equal(decideMediaReservationReconciliation({ reservation: createValidReservation(), operation }).decision, "release_allowed");
});

test("main: public whitelists cannot change internal release decisions", () => {
  for (const key of ["POLLER_SUCCESS_STATUSES", "POLLER_FAILURE_STATUSES", "POLLER_CANCELLED_STATUSES", "VALID_TASK_TYPES", "VALID_OPERATION_STATUSES"]) {
    assert.equal(Object.isFrozen(reconciliation[key]), true);
    assert.throws(() => reconciliation[key].push("local_timeout"), TypeError);
  }
  const operation = createValidOperation();
  operation.lastQuery.providerStatus = "local_timeout";
  assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation(), operation }), { code: ERROR_CODE });
});

test("main: revoked root and nested proxies receive only fixed errors", () => {
  const root = Proxy.revocable({}, {}); root.revoke();
  assert.throws(() => decideMediaReservationReconciliation(root.proxy), { code: ERROR_CODE });
  const nested = Proxy.revocable({}, {}); nested.revoke();
  assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation(), operation: nested.proxy }), { code: ERROR_CODE });
});

test("main: explicit undefined is not pure JSON", () => {
  const operation = createValidOperation();
  operation.lastQuery.source = undefined;
  assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation(), operation }), { code: ERROR_CODE });
});

test("main: large unknown keys and UTF8 values reject without JSON serialization", () => {
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = () => { calls++; throw new Error("PRIVATE_SENTINEL"); };
  try {
    const reservation = createValidReservation();
    reservation["PRIVATE_SENTINEL".repeat(100000)] = "x";
    assert.throws(() => decideMediaReservationReconciliation({ reservation, operation: createValidOperation() }), { code: ERROR_CODE });
    const operation = createValidOperation();
    operation.lastQuery.reason = "漢".repeat(6000);
    assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation(), operation }), { code: ERROR_CODE });
    assert.equal(calls, 0);
  } finally { JSON.stringify = stringify; }
});

test("main: all Proxy traps remain unexecuted", () => {
  let calls = 0;
  const proxy = new Proxy({}, { get() { calls++; throw new Error("PRIVATE_SENTINEL"); }, ownKeys() { calls++; throw new Error("PRIVATE_SENTINEL"); }, getPrototypeOf() { calls++; throw new Error("PRIVATE_SENTINEL"); } });
  assert.throws(() => decideMediaReservationReconciliation(proxy), { code: ERROR_CODE });
  assert.throws(() => decideMediaReservationReconciliation({ reservation: createValidReservation(), operation: proxy }), { code: ERROR_CODE });
  assert.equal(calls, 0);
});


test("main: terminal-looking fields never override explicit unknown/local evidence", () => {
  for (const reason of ["unknown_submission", "local_timeout", "client_timeout", "user_aborted", "local_cancelled", "local_canceled"]) {
    const operation = createValidOperation({ status: "failed" });
    Object.assign(operation.lastQuery, { outcome: "failed", providerStatus: "timeout", queried: false, source: "host", reason });
    assert.equal(decideMediaReservationReconciliation({ reservation: createValidReservation(), operation }).decision, "keep_reserved");
  }
});
