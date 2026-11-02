import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMediaReservationView,
  ERROR_CODE,
  MAX_RESERVATIONS,
  TASK_LABELS,
} from "../../shell/public/media-reservation-view-candidate.cjs";

// Main review corrected the original fixtures' task names to the actual API
// contract; the original 26 assertions remain, with independent counterexamples below.

const VALID_RUN_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const VALID_RES_ID = "f1e2d3c4-b5a6-4f7e-8d9c-0b1a2f3e4d5c";
const VALID_OP_UUID = "12345678-1234-4234-8234-123456789abc";
const VALID_OP_KEY = `${VALID_RUN_ID}:${VALID_OP_UUID}`;

function createValidReservation(overrides = {}) {
  return {
    reservationId: VALID_RES_ID,
    runId: VALID_RUN_ID,
    operationKey: VALID_OP_KEY,
    modelId: "seedance-v2-turbo",
    taskType: "image2video",
    status: "reserved",
    reservedAt: "2026-10-28T10:00:00.000Z",
    releasedAt: null,
    releaseReason: null,
    ...overrides,
  };
}

function createValidInput(overrides = {}) {
  return {
    reservations: [createValidReservation()],
    hasMore: false,
    ...overrides,
  };
}

test("1. task types: all four task types map to exact Chinese labels", () => {
  const types = [
    { type: "text2image", label: "文生图" },
    { type: "image2image", label: "图生图" },
    { type: "text2video", label: "文生视频" },
    { type: "image2video", label: "图生视频" },
  ];

  for (const { type, label } of types) {
    const input = createValidInput({
      reservations: [createValidReservation({ taskType: type })],
    });
    const res = buildMediaReservationView(input);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].taskLabel, label);
  }
});

test("2. status reserved: maps to '占位保留', specific detail and canRequestReconciliation true", () => {
  const input = createValidInput();
  const res = buildMediaReservationView(input);

  assert.equal(res.items[0].statusLabel, "占位保留");
  assert.equal(
    res.items[0].detail,
    "核对持久记录后，系统才会判断能否释放；结果未知会继续保留",
  );
  assert.equal(res.items[0].canRequestReconciliation, true);
});

test("3. status released: maps to '占位已释放', specific detail and canRequestReconciliation false", () => {
  const input = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        releasedAt: "2026-10-28T10:05:00.000Z",
        releaseReason: "external_task_succeeded",
      }),
    ],
  });
  const res = buildMediaReservationView(input);

  assert.equal(res.items[0].statusLabel, "占位已释放");
  assert.equal(
    res.items[0].detail,
    "原授权仍已消费；再次执行需要新授权",
  );
  assert.equal(res.items[0].canRequestReconciliation, false);
});

test("4. empty list: returns empty items array and preserves hasMore", () => {
  const input1 = createValidInput({ reservations: [], hasMore: false });
  const res1 = buildMediaReservationView(input1);
  assert.deepEqual(res1.items, []);
  assert.equal(res1.hasMore, false);

  const input2 = createValidInput({ reservations: [], hasMore: true });
  const res2 = buildMediaReservationView(input2);
  assert.deepEqual(res2.items, []);
  assert.equal(res2.hasMore, true);
});

test("5. plain text output: output contains no HTML markup tags", () => {
  const input = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        releasedAt: "2026-10-28T10:05:00.000Z",
        releaseReason: "verified_cancelled",
      }),
    ],
  });
  const res = buildMediaReservationView(input);
  const item = res.items[0];

  for (const val of [item.taskLabel, item.statusLabel, item.detail, item.modelId]) {
    assert.equal(/<[^>]*>/.test(val), false, `Text should not contain HTML tags: ${val}`);
  }
});

test("6. HTML markup in input fields is rejected", () => {
  // HTML in modelId
  const inputA = createValidInput({
    reservations: [createValidReservation({ modelId: "<script>alert(1)</script>" })],
  });
  assert.throws(() => buildMediaReservationView(inputA), { code: ERROR_CODE });

  // HTML in releaseReason
  const inputB = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        releasedAt: "2026-10-28T10:05:00.000Z",
        releaseReason: "<img src=x onerror=alert(1)>",
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(inputB), { code: ERROR_CODE });
});

test("7. unknown status is rejected", () => {
  for (const status of ["pending", "completed", "failed", "cancelled", "unknown"]) {
    const input = createValidInput({
      reservations: [createValidReservation({ status })],
    });
    assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
  }
});

test("8. unknown root fields are rejected", () => {
  const input = createValidInput({ extraRootProp: "malicious" });
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("9. unknown reservation item fields are rejected", () => {
  const item = createValidReservation({ extraItemProp: "malicious" });
  const input = createValidInput({ reservations: [item] });
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("10. reservations list exceeding 100 items is rejected", () => {
  const items = Array.from({ length: 101 }, () => createValidReservation());
  const input = createValidInput({ reservations: items });
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("11. object depth exceeding 5 is rejected", () => {
  let deep = "leaf";
  for (let i = 0; i < 6; i++) {
    deep = { next: deep };
  }
  const input = createValidInput({ deepProp: deep });
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("12. payload size exceeding 64 KiB is rejected", () => {
  const input = createValidInput({
    reservations: [
      createValidReservation({
        modelId: "x".repeat(65000),
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("13. invalid timestamps are rejected", () => {
  // Non-UTC
  const input1 = createValidInput({
    reservations: [createValidReservation({ reservedAt: "2026-10-28T10:00:00+08:00" })],
  });
  assert.throws(() => buildMediaReservationView(input1), { code: ERROR_CODE });

  // Invalid date string
  const input2 = createValidInput({
    reservations: [createValidReservation({ reservedAt: "invalid-date" })],
  });
  assert.throws(() => buildMediaReservationView(input2), { code: ERROR_CODE });
});

test("14. chronology violation: releasedAt before reservedAt is rejected", () => {
  const input = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        reservedAt: "2026-10-28T10:00:00.000Z",
        releasedAt: "2026-10-28T09:59:59.000Z",
        releaseReason: "timeout",
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("15. invalid UUID format is rejected", () => {
  const input1 = createValidInput({
    reservations: [createValidReservation({ reservationId: "not-a-uuid" })],
  });
  assert.throws(() => buildMediaReservationView(input1), { code: ERROR_CODE });

  const input2 = createValidInput({
    reservations: [createValidReservation({ runId: "not-a-uuid" })],
  });
  assert.throws(() => buildMediaReservationView(input2), { code: ERROR_CODE });
});

test("16. invalid operationKey format is rejected", () => {
  // Second part not UUID
  const input1 = createValidInput({
    reservations: [createValidReservation({ operationKey: `${VALID_RUN_ID}:not-uuid` })],
  });
  assert.throws(() => buildMediaReservationView(input1), { code: ERROR_CODE });

  // First part does not match runId
  const otherRunId = "99999999-9999-4999-8999-999999999999";
  const input2 = createValidInput({
    reservations: [createValidReservation({ operationKey: `${otherRunId}:${VALID_OP_UUID}` })],
  });
  assert.throws(() => buildMediaReservationView(input2), { code: ERROR_CODE });
});

test("17. contradictory reserved state: non-null releasedAt or releaseReason rejected", () => {
  const inputA = createValidInput({
    reservations: [
      createValidReservation({
        status: "reserved",
        releasedAt: "2026-10-28T10:01:00.000Z",
        releaseReason: null,
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(inputA), { code: ERROR_CODE });

  const inputB = createValidInput({
    reservations: [
      createValidReservation({
        status: "reserved",
        releasedAt: null,
        releaseReason: "cancelled",
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(inputB), { code: ERROR_CODE });
});

test("18. contradictory released state: null or empty releasedAt or releaseReason rejected", () => {
  const inputA = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        releasedAt: null,
        releaseReason: "cancelled",
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(inputA), { code: ERROR_CODE });

  const inputB = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        releasedAt: "2026-10-28T10:05:00.000Z",
        releaseReason: null,
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(inputB), { code: ERROR_CODE });

  const inputC = createValidInput({
    reservations: [
      createValidReservation({
        status: "released",
        releasedAt: "2026-10-28T10:05:00.000Z",
        releaseReason: "   ",
      }),
    ],
  });
  assert.throws(() => buildMediaReservationView(inputC), { code: ERROR_CODE });
});

test("19. getter execution protection: getters are detected and NOT executed", () => {
  let getterInvoked = false;
  const input = createValidInput();
  Object.defineProperty(input, "malicious_prop", {
    get() {
      getterInvoked = true;
      throw new Error("Getter must never be executed!");
    },
    enumerable: true,
  });

  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
  assert.equal(getterInvoked, false, "Getter accessor must not be invoked");
});

test("20. proxy trap protection: Proxy is detected and rejected without invoking trap", () => {
  let trapInvoked = false;
  const target = createValidInput();
  const proxy = new Proxy(target, {
    get(t, p, r) {
      trapInvoked = true;
      return Reflect.get(t, p, r);
    },
    ownKeys(t) {
      trapInvoked = true;
      return Reflect.ownKeys(t);
    },
    has(t, p) {
      trapInvoked = true;
      return Reflect.has(t, p);
    },
  });

  assert.throws(() => buildMediaReservationView(proxy), { code: ERROR_CODE });
  assert.equal(trapInvoked, false, "Proxy traps must not be invoked");
});

test("21. revoked proxy protection: revoked Proxy is rejected with fixed error code", () => {
  const { proxy: rootProxy, revoke: revokeRoot } = Proxy.revocable(createValidInput(), {});
  revokeRoot();
  assert.throws(() => buildMediaReservationView(rootProxy), { code: ERROR_CODE });

  const input = createValidInput();
  const { proxy: nestedProxy, revoke: revokeNested } = Proxy.revocable({}, {});
  revokeNested();
  input.reservations = nestedProxy;
  assert.throws(() => buildMediaReservationView(input), { code: ERROR_CODE });
});

test("22. circular and shared references are rejected", () => {
  // Circular
  const inputA = createValidInput();
  inputA.self = inputA;
  assert.throws(() => buildMediaReservationView(inputA), { code: ERROR_CODE });

  // Shared
  const shared = { some: "val" };
  const inputB = createValidInput();
  inputB.propA = shared;
  inputB.propB = shared;
  assert.throws(() => buildMediaReservationView(inputB), { code: ERROR_CODE });
});

test("23. symbol properties and explicit undefined are rejected", () => {
  const inputA = createValidInput();
  inputA[Symbol("forbidden")] = "val";
  assert.throws(() => buildMediaReservationView(inputA), { code: ERROR_CODE });

  const inputB = createValidInput({ extraUndefined: undefined });
  assert.throws(() => buildMediaReservationView(inputB), { code: ERROR_CODE });
});

test("24. non-finite numbers (NaN/Infinity) are rejected", () => {
  const inputA = createValidInput({ nanProp: Number.NaN });
  assert.throws(() => buildMediaReservationView(inputA), { code: ERROR_CODE });

  const inputB = createValidInput({ infProp: Number.POSITIVE_INFINITY });
  assert.throws(() => buildMediaReservationView(inputB), { code: ERROR_CODE });
});

test("25. immutability and deep freeze: input untouched and output deeply frozen", () => {
  const input = createValidInput();
  const snapshotBefore = JSON.stringify(input);

  const res = buildMediaReservationView(input);

  assert.equal(JSON.stringify(input), snapshotBefore, "Input must remain unmodified");
  assert.equal(Object.isFrozen(res), true, "Root output must be frozen");
  assert.equal(Object.isFrozen(res.items), true, "items must be frozen");
  assert.equal(Object.isFrozen(res.items[0]), true, "items[0] must be frozen");

  assert.throws(() => {
    res.hasMore = !res.hasMore;
  }, TypeError);

  assert.throws(() => {
    res.items[0].statusLabel = "tampered";
  }, TypeError);
});

test("26. PRIVATE_SENTINEL redaction: error messages never leak sentinel key or value", () => {
  const SENTINEL_VALUE = "PRIVATE_SENTINEL_TOKEN_!@#$%^&*()";
  const SENTINEL_KEY = "PRIVATE_SENTINEL_KEY";

  // Case A: Sentinel in invalid value
  const inputA = createValidInput({
    reservations: [createValidReservation({ modelId: SENTINEL_VALUE })],
  });
  try {
    buildMediaReservationView(inputA);
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.code, ERROR_CODE);
    assert.equal(err.message.includes(SENTINEL_VALUE), false, "Must not leak sentinel value");
    assert.equal(err.message.includes("PRIVATE_SENTINEL"), false, "Must not leak sentinel token");
  }

  // Case B: Sentinel in unknown key name
  const inputB = createValidInput();
  inputB[SENTINEL_KEY] = "foo";
  try {
    buildMediaReservationView(inputB);
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.code, ERROR_CODE);
    assert.equal(err.message.includes(SENTINEL_KEY), false, "Must not leak sentinel key");
    assert.equal(err.message.includes("PRIVATE_SENTINEL"), false, "Must not leak sentinel token");
  }
});

test('main review: actual API tasks accept and invented or inherited task names reject',()=>{
  for(const taskType of ['image_generation','video_generation','media_generation','seedance_generation','__proto__','constructor','toString'])assert.throws(()=>buildMediaReservationView(createValidInput({reservations:[createValidReservation({taskType})]})),{code:ERROR_CODE});
});
test('main review: normalized impossible dates and non-ISO dates reject',()=>{
  for(const reservedAt of ['2026-02-30T10:00:00.000Z','2026-10-28T10:00:00+00:00Z','2026-10-28T25:00:00.000Z'])assert.throws(()=>buildMediaReservationView(createValidInput({reservations:[createValidReservation({reservedAt})]})),{code:ERROR_CODE});
});
test('main review: non-array objects with Array.prototype are never plain records',()=>{
  const item=Object.assign(Object.create(Array.prototype),createValidReservation());
  assert.throws(()=>buildMediaReservationView(createValidInput({reservations:[item]})),{code:ERROR_CODE});
  assert.throws(()=>buildMediaReservationView(Object.assign(Object.create(Array.prototype),createValidInput())),{code:ERROR_CODE});
});
test('main review: oversized list rejects before inspecting a single item descriptor',()=>{
  const reservations=Array.from({length:101},()=>createValidReservation()),original=Object.getOwnPropertyDescriptor;
  let inspected=0;
  Object.getOwnPropertyDescriptor=function(target,key){if(target===reservations&&key!=='length')inspected++;return original(target,key);};
  try{assert.throws(()=>buildMediaReservationView(createValidInput({reservations})),{code:ERROR_CODE});assert.equal(inspected,0);}
  finally{Object.getOwnPropertyDescriptor=original;}
});
test('main review: schema traversal never constructs an unbounded descriptor map or invokes inherited serialization',()=>{
  const original=Object.getOwnPropertyDescriptors;let inherited=0;
  Object.getOwnPropertyDescriptors=()=>{throw Error('PRIVATE_SENTINEL');};
  Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value:()=>{inherited++;throw Error('PRIVATE_SENTINEL');}});
  try{assert.equal(buildMediaReservationView(createValidInput()).items.length,1);assert.equal(inherited,0);}
  finally{Object.getOwnPropertyDescriptors=original;delete Object.prototype.toJSON;}
});
test('main review: gateway model namespaces and 256-character labels are valid plain text',()=>{
  for(const modelId of ['vendor/model-v1','a'.repeat(256)])assert.equal(buildMediaReservationView(createValidInput({reservations:[createValidReservation({modelId})]})).items[0].modelId,modelId);
});
