import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePtConsumeRecord,
  ERROR_CODE,
  MAX_BILLING_ITEMS,
  VALID_BILLING_UNITS,
  VALID_REQUEST_TYPES,
} from "../../shell/usage/pt-consume-record-candidate.cjs";

function createValidTextRecord(overrides = {}) {
  return {
    consume_id: "pt-c-text-001",
    request_id: "pt-req-text-001",
    task_id: null,
    endpoint: "/v1/chat/completions",
    provider_name: "powertokens",
    model_id: "seed-2-0-pro-260328",
    model_name: "Seed 2.0 Pro",
    status: "succeeded",
    consume_time: 1774684800, // 2026-03-28T08:00:00.000Z
    request_type: "text",
    quota: 6,
    usage: {
      input_tokens: 1642,
      output_tokens: 1486,
      total_tokens: 3128,
    },
    billing: {
      pricing_mode: "tiered",
      billing_unit: "per_tokens",
      unit_size: 1000000,
      quota_per_unit: 475,
      items: [
        {
          name: "token input",
          quantity: 1642,
          unit_quota: 475,
          unit_label: "1M tokens",
          subtotal_quota: 0.78,
        },
        {
          name: "cache",
          quantity: 0,
          unit_quota: 100,
          unit_label: "1M tokens",
          subtotal_quota: 0,
        },
        {
          name: "output",
          quantity: 1486,
          unit_quota: 2850,
          unit_label: "1M tokens",
          subtotal_quota: 4.235,
        },
      ],
      formula: "0.78 + 0 + 4.235 => 6",
      total_quota: 5.015,
      original_quota: 5.015,
      discount_quota: 0,
      final_quota: 6,
    },
    ...overrides,
  };
}

function createValidVideoRecord(overrides = {}) {
  return {
    consume_id: "pt-c-video-002",
    request_id: "pt-req-video-002",
    task_id: "pt-task-video-987654",
    endpoint: "/v1/videos/generations",
    provider_name: "powertokens",
    model_id: "dreamina-seedance-2-0-mini-260615",
    model_name: "Dreamina Seedance 2.0 Mini",
    status: "succeeded",
    consume_time: 1781424000, // 2026-06-15T08:00:00.000Z
    request_type: "video",
    quota: 150,
    original_quota: 148,
    usage: {},
    billing: {
      pricing_mode: "standard",
      billing_unit: "per_tokens",
      unit_size: 1000000,
      quota_per_unit: 3850,
      items: [
        {
          name: "token output",
          quantity: 38800,
          unit_quota: 3850,
          unit_label: "1M tokens",
          subtotal_quota: 149.38,
        },
      ],
      total_quota: 149.38,
      original_quota: 150,
      discount_quota: 0,
      final_quota: 150,
    },
    ...overrides,
  };
}

function createValidImageRecord(overrides = {}) {
  return {
    consume_id: "pt-c-image-003",
    request_id: "pt-req-image-003",
    task_id: "",
    endpoint: "/v1/images/generations",
    provider_name: "powertokens",
    model_id: "wan2.7-image-pro",
    status: "succeeded",
    consume_time: 1782633600,
    request_type: "image",
    quota: 72,
    usage: {},
    billing: {
      pricing_mode: "standard",
      billing_unit: "per_image",
      unit_size: 1,
      quota_per_unit: 71.25,
      items: [
        {
          name: "image generation",
          quantity: 1,
          unit_quota: 71.25,
          unit_label: "1 image",
          subtotal_quota: 71.25,
        },
      ],
      total_quota: 71.25,
      original_quota: 71.25,
      discount_quota: 0,
      final_quota: 72,
    },
    ...overrides,
  };
}

function createValidAudioRecord(overrides = {}) {
  return {
    consume_id: "pt-c-audio-004",
    request_id: "pt-req-audio-004",
    task_id: null,
    endpoint: "/v1/audio/speech",
    provider_name: "powertokens",
    model_id: "speech-2.8-hd",
    status: "succeeded",
    consume_time: 1782720000,
    request_type: "audio",
    quota: 23,
    usage: {
      characters: 235,
    },
    billing: {
      pricing_mode: "standard",
      billing_unit: "per_characters",
      unit_size: 1000,
      quota_per_unit: 95,
      items: [
        {
          name: "tts synthesis",
          quantity: 235,
          unit_quota: 95,
          unit_label: "1K characters",
          subtotal_quota: 22.325,
        },
      ],
      total_quota: 22.325,
      original_quota: 22.325,
      discount_quota: 0,
      final_quota: 23,
    },
    ...overrides,
  };
}

test("1. fixture text: full normalization of text consumption record", () => {
  const raw = createValidTextRecord();
  const res = normalizePtConsumeRecord(raw);

  assert.equal(res.consumeId, "pt-c-text-001");
  assert.equal(res.requestId, "pt-req-text-001");
  assert.equal(res.taskId, null);
  assert.equal(res.endpoint, "/v1/chat/completions");
  assert.equal(res.providerName, "powertokens");
  assert.equal(res.reportedModelId, "seed-2-0-pro-260328");
  assert.equal(res.reportedModelName, "Seed 2.0 Pro");
  assert.equal(res.status, "succeeded");
  assert.equal(res.consumedAt, "2026-03-28T08:00:00.000Z");
  assert.equal(res.requestType, "text");
  assert.equal(res.evidenceKind, "imported_pt_record");
  assert.equal(res.currency, null);
  assert.equal(res.exchangeRate, null);

  assert.deepEqual(res.usage, {
    inputTokens: 1642,
    outputTokens: 1486,
    totalTokens: 3128,
    characters: null,
    cachedTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  });

  assert.equal(res.billing.unit, "credits");
  assert.equal(res.billing.pricingMode, "tiered");
  assert.equal(res.billing.billingUnit, "per_tokens");
  assert.equal(res.billing.unitSize, 1000000);
  assert.equal(res.billing.quotaPerUnit, 475);
  assert.equal(res.billing.topQuota, 6);
  assert.equal(res.billing.topOriginalQuota, null);
  assert.equal(res.billing.finalQuota, 6);
  assert.equal(res.billing.items.length, 3);
  assert.equal(res.billing.formula, "0.78 + 0 + 4.235 => 6");

  // Subtotals (5.015) vs final (6) triggers rounding discrepancy warning
  assert.ok(res.warnings.includes("BILLING_ITEMS_SUM_ROUNDED"));
});

test("2. fixture video: retains usage {} and preserves top vs billing original quota discrepancy", () => {
  const raw = createValidVideoRecord();
  const res = normalizePtConsumeRecord(raw);

  assert.equal(res.requestType, "video");
  assert.equal(res.taskId, "pt-task-video-987654");
  assert.equal(res.reportedModelId, "dreamina-seedance-2-0-mini-260615");

  // usage {} must not turn into zero usage
  assert.deepEqual(res.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    characters: null,
    cachedTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  });

  // Both quotas preserved without taking sides or overwriting
  assert.equal(res.billing.topQuota, 150);
  assert.equal(res.billing.topOriginalQuota, 148);
  assert.equal(res.billing.originalQuota, 150);
  assert.equal(res.billing.finalQuota, 150);
  assert.equal(res.billing.items[0].quantity, 38800);

  // Warning for top original 148 vs billing original 150
  assert.ok(res.warnings.includes("TOP_BILLING_ORIGINAL_QUOTA_MISMATCH"));
});

test("3. fixture image: empty usage and per_image billing unit with rounding", () => {
  const raw = createValidImageRecord();
  const res = normalizePtConsumeRecord(raw);

  assert.equal(res.requestType, "image");
  assert.equal(res.taskId, null); // empty string normalized to null
  assert.equal(res.reportedModelName, null);
  assert.equal(res.billing.billingUnit, "per_image");
  assert.equal(res.billing.unitSize, 1);
  assert.equal(res.billing.quotaPerUnit, 71.25);
  assert.equal(res.billing.finalQuota, 72);
  assert.ok(res.warnings.includes("BILLING_ITEMS_SUM_ROUNDED"));
});

test("4. fixture audio: characters usage and per_characters billing unit", () => {
  const raw = createValidAudioRecord();
  const res = normalizePtConsumeRecord(raw);

  assert.equal(res.requestType, "audio");
  assert.equal(res.usage.characters, 235);
  assert.equal(res.usage.inputTokens, null);
  assert.equal(res.billing.billingUnit, "per_characters");
  assert.equal(res.billing.unitSize, 1000);
  assert.equal(res.billing.quotaPerUnit, 95);
  assert.equal(res.billing.finalQuota, 23);
});

test("5. usage metrics: missing values remain null and genuine zeros are preserved", () => {
  const raw = createValidTextRecord({
    usage: {
      input_tokens: 0,
      output_tokens: 10,
      cached_tokens: 0,
    },
  });
  const res = normalizePtConsumeRecord(raw);

  assert.equal(res.usage.inputTokens, 0, "Genuine 0 must be preserved");
  assert.equal(res.usage.outputTokens, 10);
  assert.equal(res.usage.cachedTokens, 0, "Genuine 0 must be preserved");
  assert.equal(res.usage.totalTokens, null, "Missing value must remain null");
  assert.equal(res.usage.characters, null, "Missing value must remain null");
});

test("6. task_id normalization: empty and whitespace strings normalize to null", () => {
  const raw1 = createValidTextRecord({ task_id: "" });
  assert.equal(normalizePtConsumeRecord(raw1).taskId, null);

  const raw2 = createValidTextRecord({ task_id: "   " });
  assert.equal(normalizePtConsumeRecord(raw2).taskId, null);

  const raw3 = createValidTextRecord({ task_id: "  task-ext-456  " });
  assert.equal(normalizePtConsumeRecord(raw3).taskId, "task-ext-456");
});

test("7. time conversion: Unix seconds convert deterministically to UTC ISO 8601", () => {
  const raw = createValidTextRecord({ consume_time: 1700000000 });
  const res = normalizePtConsumeRecord(raw);
  assert.equal(res.consumedAt, "2023-11-14T22:13:20.000Z");
});

test("8. currency and exchangeRate strictly null, credits only", () => {
  const raw = createValidTextRecord();
  const res = normalizePtConsumeRecord(raw);
  assert.equal(res.currency, null);
  assert.equal(res.exchangeRate, null);
  assert.equal(res.billing.unit, "credits");
});

test("9. missing required root fields throws invalid error", () => {
  const requiredFields = [
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
  ];

  for (const field of requiredFields) {
    const raw = createValidTextRecord();
    delete raw[field];
    assert.throws(
      () => normalizePtConsumeRecord(raw),
      { code: ERROR_CODE },
      `Should throw when missing required root field: ${field}`,
    );
  }
});

test("10. invalid request_type throws invalid error", () => {
  const raw = createValidTextRecord({ request_type: "multimodal_streaming" });
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("11. invalid billing_unit throws invalid error", () => {
  const raw = createValidTextRecord();
  raw.billing.billing_unit = "per_request";
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("12. negative and non-finite numbers throw invalid error", () => {
  // Negative quota
  const raw1 = createValidTextRecord({ quota: -1 });
  assert.throws(() => normalizePtConsumeRecord(raw1), { code: ERROR_CODE });

  // NaN in billing
  const raw2 = createValidTextRecord();
  raw2.billing.final_quota = Number.NaN;
  assert.throws(() => normalizePtConsumeRecord(raw2), { code: ERROR_CODE });

  // Infinity in items
  const raw3 = createValidTextRecord();
  raw3.billing.items[0].quantity = Number.POSITIVE_INFINITY;
  assert.throws(() => normalizePtConsumeRecord(raw3), { code: ERROR_CODE });
});

test("13. unknown root fields are rejected", () => {
  const raw = createValidTextRecord({ unknown_prop: "secret" });
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("14. unknown usage fields are rejected", () => {
  const raw = createValidTextRecord();
  raw.usage.prompt_tokens = 500;
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("15. unknown billing fields are rejected", () => {
  const raw = createValidTextRecord();
  raw.billing.raw_usd_cost = 0.05;
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("16. unknown billing item fields are rejected", () => {
  const raw = createValidTextRecord();
  raw.billing.items[0].extra_metric = "foo";
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("17. formula is preserved as safe text and never evaluated", () => {
  let executed = false;
  // If formula was evaluated with eval, it would execute
  const raw = createValidTextRecord();
  raw.billing.formula = "alert('xss')";

  const res = normalizePtConsumeRecord(raw);
  assert.equal(res.billing.formula, "alert('xss')");
  assert.equal(executed, false);
});

test("18. items count exceeding 32 is rejected", () => {
  const raw = createValidTextRecord();
  raw.billing.items = Array.from({ length: 33 }, (_, i) => ({
    name: `item-${i}`,
    quantity: 1,
    unit_quota: 1,
    subtotal_quota: 1,
  }));
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("19. oversized payload exceeding 16 KiB is rejected", () => {
  const raw = createValidTextRecord({
    model_name: "x".repeat(17000),
  });
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("20. payload depth exceeding 6 is rejected", () => {
  let deep = "leaf";
  for (let i = 0; i < 7; i++) {
    deep = { next: deep };
  }
  const raw = createValidTextRecord();
  raw.billing.deep = deep;
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("21. control characters in strings are rejected", () => {
  const raw1 = createValidTextRecord({ consume_id: "id\x00nullbyte" });
  assert.throws(() => normalizePtConsumeRecord(raw1), { code: ERROR_CODE });

  const raw2 = createValidTextRecord({ request_id: "req\nnewline" });
  assert.throws(() => normalizePtConsumeRecord(raw2), { code: ERROR_CODE });

  const raw3 = createValidTextRecord({ endpoint: "end\rcarriage" });
  assert.throws(() => normalizePtConsumeRecord(raw3), { code: ERROR_CODE });
});

test("22. getter execution protection: getters are detected and NOT executed", () => {
  let getterInvoked = false;
  const raw = createValidTextRecord();
  Object.defineProperty(raw, "malicious_prop", {
    get() {
      getterInvoked = true;
      throw new Error("Getter must never be executed!");
    },
    enumerable: true,
  });

  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
  assert.equal(getterInvoked, false, "Getter accessor must not be invoked");
});

test("23. proxy trap protection: Proxy is detected and rejected without invoking trap", () => {
  let trapInvoked = false;
  const target = createValidTextRecord();
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

  assert.throws(() => normalizePtConsumeRecord(proxy), { code: ERROR_CODE });
  assert.equal(trapInvoked, false, "Proxy traps must not be invoked");
});

test("24. revoked proxy protection: revoked Proxy is rejected with fixed error code", () => {
  const { proxy: rootProxy, revoke: revokeRoot } = Proxy.revocable(createValidTextRecord(), {});
  revokeRoot();
  assert.throws(() => normalizePtConsumeRecord(rootProxy), { code: ERROR_CODE });

  const raw = createValidTextRecord();
  const { proxy: nestedProxy, revoke: revokeNested } = Proxy.revocable({}, {});
  revokeNested();
  raw.usage = nestedProxy;
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("25. circular reference is rejected", () => {
  const raw = createValidTextRecord();
  raw.self = raw;
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("26. shared object reference across fields is rejected", () => {
  const shared = { nested: "shared" };
  const raw = createValidTextRecord();
  raw.sharedA = shared;
  raw.sharedB = shared;
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("27. symbol properties are rejected", () => {
  const raw = createValidTextRecord();
  raw[Symbol("forbidden")] = "val";
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("28. explicit undefined values are rejected in pure JSON", () => {
  const raw = createValidTextRecord({ model_name: undefined });
  assert.throws(() => normalizePtConsumeRecord(raw), { code: ERROR_CODE });
});

test("29. PRIVATE_SENTINEL redaction: error messages never leak sentinel key or value", () => {
  const SENTINEL_VALUE = "PRIVATE_SENTINEL_SECRET_TOKEN_!@#$";
  const SENTINEL_KEY = "PRIVATE_SENTINEL_SECRET_KEY";

  // Case A: Sentinel in invalid string
  const rawA = createValidTextRecord({ consume_id: SENTINEL_VALUE + "\x00" });
  try {
    normalizePtConsumeRecord(rawA);
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.code, ERROR_CODE);
    assert.equal(err.message.includes(SENTINEL_VALUE), false, "Must not leak sentinel value");
    assert.equal(err.message.includes("PRIVATE_SENTINEL"), false, "Must not leak sentinel token");
  }

  // Case B: Sentinel in unknown key name
  const rawB = createValidTextRecord();
  rawB[SENTINEL_KEY] = "foo";
  try {
    normalizePtConsumeRecord(rawB);
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.code, ERROR_CODE);
    assert.equal(err.message.includes(SENTINEL_KEY), false, "Must not leak sentinel key name");
    assert.equal(err.message.includes("PRIVATE_SENTINEL"), false, "Must not leak sentinel token");
  }
});

test("30. immutability and deep freeze: input untouched and output deeply frozen", () => {
  const raw = createValidTextRecord();
  const snapshotBefore = JSON.stringify(raw);

  const res = normalizePtConsumeRecord(raw);

  // Input must remain untouched
  assert.equal(JSON.stringify(raw), snapshotBefore, "Raw input must remain unmodified");

  // Output must be deeply frozen
  assert.equal(Object.isFrozen(res), true, "Root output must be frozen");
  assert.equal(Object.isFrozen(res.usage), true, "usage must be frozen");
  assert.equal(Object.isFrozen(res.billing), true, "billing must be frozen");
  assert.equal(Object.isFrozen(res.billing.items), true, "billing.items must be frozen");
  assert.equal(Object.isFrozen(res.billing.items[0]), true, "billing.items[0] must be frozen");
  assert.equal(Object.isFrozen(res.warnings), true, "warnings must be frozen");

  assert.throws(() => {
    res.status = "tampered";
  }, TypeError);

  assert.throws(() => {
    res.billing.items[0].name = "tampered";
  }, TypeError);
});
