import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { guardPtVideoResult, MediaEngineGuardError } = require('../../shell/media/ptvideo-result-guard-candidate.cjs');

const PRIVATE_SENTINEL = 'PRIVATE_SENTINEL_SECRET_TOKEN_XYZ_98765';

function makeExpected(overrides = {}) {
  return {
    model: 'wan3.0-video',
    kind: 'video',
    taskId: null,
    billingParams: {
      model: 'wan3.0-video',
      kind: 'video',
      duration_s: 5,
      resolution: '720p',
      n_images: null,
      aspect_ratio: '16:9',
    },
    ...overrides,
  };
}

function makeRaw(overrides = {}) {
  return {
    ok: true,
    task_id: 'task-vid-001',
    model: 'wan3.0-video',
    kind: 'video',
    status: 'completed',
    result_urls: ['https://cdn.example.com/videos/output.mp4'],
    billing_params: {
      model: 'wan3.0-video',
      kind: 'video',
      duration_s: 5,
      resolution: '720p',
      n_images: null,
      aspect_ratio: '16:9',
    },
    cost_usd: null,
    cost_unknown: true,
    ...overrides,
  };
}

describe('guardPtVideoResult regression suite', () => {
  describe('1. Happy path: Valid completed outcomes', () => {
    it('normalizes valid completed video result', () => {
      const exp = makeExpected();
      const raw = makeRaw();
      const res = guardPtVideoResult(raw, exp);

      assert.equal(res.outcome, 'completed');
      assert.equal(res.ok, true);
      assert.equal(res.taskId, 'task-vid-001');
      assert.equal(res.requestedModel, 'wan3.0-video');
      assert.equal(res.kind, 'video');
      assert.deepEqual(res.resultUrls, ['https://cdn.example.com/videos/output.mp4']);
      assert.equal(res.errorCode, null);
      assert.equal(res.errorMessage, null);
      assert.equal(res.costCoverage, 'unknown');
      assert.equal(res.amount, null);
      assert.equal(res.modelIdentityEvidence, 'unknown');
    });

    it('normalizes valid completed image result (single)', () => {
      const exp = makeExpected({
        model: 'image-01',
        kind: 'image',
        billingParams: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 1, aspect_ratio: '1:1' },
      });
      const raw = makeRaw({
        model: 'image-01',
        kind: 'image',
        task_id: null,
        result_urls: ['https://cdn.example.com/images/art.png'],
        billing_params: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 1, aspect_ratio: '1:1' },
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'completed');
      assert.equal(res.ok, true);
      assert.equal(res.taskId, null);
      assert.equal(res.resultUrls.length, 1);
    });

    it('normalizes valid completed multi-image result (4 images)', () => {
      const urls = [
        'https://cdn.example.com/1.png',
        'https://cdn.example.com/2.png',
        'https://cdn.example.com/3.png',
        'https://cdn.example.com/4.png',
      ];
      const exp = makeExpected({
        model: 'image-01',
        kind: 'image',
        billingParams: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 4, aspect_ratio: '1:1' },
      });
      const raw = makeRaw({
        model: 'image-01',
        kind: 'image',
        task_id: null,
        result_urls: urls,
        billing_params: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 4, aspect_ratio: '1:1' },
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'completed');
      assert.equal(res.ok, true);
      assert.equal(res.resultUrls.length, 4);
    });

    it('normalizes valid completed seedance result', () => {
      const exp = makeExpected({
        model: 'dreamina-seedance-2-0',
        kind: 'seedance',
        billingParams: { model: 'dreamina-seedance-2-0', kind: 'seedance', duration_s: 5, resolution: '720p', n_images: null, aspect_ratio: '16:9' },
      });
      const raw = makeRaw({
        model: 'dreamina-seedance-2-0',
        kind: 'seedance',
        task_id: 'seed-task-99',
        result_urls: ['https://cdn.example.com/dance.mp4'],
        billing_params: { model: 'dreamina-seedance-2-0', kind: 'seedance', duration_s: 5, resolution: '720p', n_images: null, aspect_ratio: '16:9' },
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'completed');
      assert.equal(res.ok, true);
      assert.equal(res.taskId, 'seed-task-99');
    });
  });

  describe('2. Partial completion and local lifecycle hooks', () => {
    it('marks completed_partial when image returns fewer results than requested', () => {
      const exp = makeExpected({
        model: 'image-01',
        kind: 'image',
        billingParams: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 4, aspect_ratio: '1:1' },
      });
      const raw = makeRaw({
        model: 'image-01',
        kind: 'image',
        task_id: null,
        ok: true,
        status: 'completed',
        result_urls: ['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'],
        billing_params: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 4, aspect_ratio: '1:1' },
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'completed_partial');
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'IMAGE_RESULT_PARTIAL');
      assert.equal(res.resultUrls.length, 2);
    });

    it('marks completed_local_save_failed and preserves results and taskId', () => {
      const exp = makeExpected({ taskId: 'tid-save-fail' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-save-fail',
        status: 'completed_local_save_failed',
        error_code: 'ON_RESULT_FAILED',
        result_urls: ['https://cdn.example.com/video.mp4'],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'completed_local_save_failed');
      assert.equal(res.ok, false);
      assert.equal(res.taskId, 'tid-save-fail');
      assert.equal(res.resultUrls.length, 1);
      assert.equal(res.errorCode, 'COMPLETED_LOCAL_SAVE_FAILED');
      assert.match(res.errorMessage, /本地持久化失败/);
    });

    it('marks completed_locally_cancelled and retains urls without pretending 0 charge', () => {
      const exp = makeExpected({
        model: 'image-01',
        kind: 'image',
        billingParams: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 1, aspect_ratio: '1:1' },
      });
      const raw = makeRaw({
        model: 'image-01',
        kind: 'image',
        task_id: null,
        ok: false,
        status: 'completed_locally_cancelled',
        error_code: 'CANCELLED_AFTER_SUBMIT',
        result_urls: ['https://cdn.example.com/cancelled_image.png'],
        billing_params: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 1, aspect_ratio: '1:1' },
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'completed_locally_cancelled');
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'CANCELLED_AFTER_SUBMIT');
      assert.equal(res.resultUrls.length, 1);
    });
  });

  describe('3. Submission unknown and polling reconciliation', () => {
    it('normalizes submission_unknown and forbids auto-retry', () => {
      const exp = makeExpected();
      const raw = makeRaw({
        ok: false,
        task_id: null,
        status: 'submission_unknown',
        error_code: 'SUBMISSION_OUTCOME_UNKNOWN',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'submission_unknown');
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
      assert.match(res.errorMessage, /严禁自动重提/);
    });

    it('normalizes unknown_timeout as needs_reconciliation, preserving taskId', () => {
      const exp = makeExpected({ taskId: 'tid-poll-timeout' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-poll-timeout',
        status: 'unknown_timeout',
        error_code: 'POLL_TIMEOUT',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'needs_reconciliation');
      assert.equal(res.ok, false);
      assert.equal(res.taskId, 'tid-poll-timeout');
      assert.equal(res.errorCode, 'POLL_TIMEOUT');
      assert.match(res.errorMessage, /严禁自动重提/);
    });

    it('normalizes unknown_cancelled during poll as needs_reconciliation, preserving taskId', () => {
      const exp = makeExpected({ taskId: 'tid-poll-cancel' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-poll-cancel',
        status: 'unknown_cancelled',
        error_code: 'CANCELLED_DURING_POLL',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'needs_reconciliation');
      assert.equal(res.ok, false);
      assert.equal(res.taskId, 'tid-poll-cancel');
      assert.equal(res.errorCode, 'CANCELLED_DURING_POLL');
    });

    it('normalizes unknown_result_missing as needs_reconciliation, preserving taskId', () => {
      const exp = makeExpected({ taskId: 'tid-missing-url' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-missing-url',
        status: 'unknown_result_missing',
        error_code: 'VIDEO_RESULT_EMPTY',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'needs_reconciliation');
      assert.equal(res.ok, false);
      assert.equal(res.taskId, 'tid-missing-url');
      assert.equal(res.errorCode, 'VIDEO_RESULT_EMPTY');
    });

    it('rejects needs_reconciliation for video if taskId is missing', () => {
      const exp = makeExpected();
      const raw = makeRaw({
        ok: false,
        task_id: null, // missing taskId on poll error
        status: 'unknown_timeout',
        error_code: 'POLL_TIMEOUT',
        result_urls: [],
      });

      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });
  });

  describe('4. Remote failures vs Pre-submit / Rejection states', () => {
    it('normalizes remote_failed when upstream reports task failure', () => {
      const exp = makeExpected({ taskId: 'tid-failed' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-failed',
        status: 'failed',
        error_code: 'REMOTE_TASK_FAILED',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'remote_failed');
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'REMOTE_FAILED');
      assert.equal(res.resultUrls.length, 0);
    });

    it('normalizes remote_cancelled when upstream reports cancelled', () => {
      const exp = makeExpected({ taskId: 'tid-cancelled' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-cancelled',
        status: 'cancelled',
        error_code: 'REMOTE_TASK_CANCELLED',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'remote_cancelled');
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'REMOTE_CANCELLED');
    });

    it('normalizes not_submitted when rejected before POST', () => {
      const exp = makeExpected();
      const raw = makeRaw({
        ok: false,
        task_id: null,
        status: null,
        error_code: 'INVALID_REQUEST',
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.equal(res.outcome, 'not_submitted');
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'INVALID_REQUEST');
      assert.equal(res.amount, null);
      assert.equal(res.costCoverage, 'unknown');
    });

    it('normalizes rejected on HTTP 401/403/429/5xx before submit', () => {
      const rejectCodes = [
        'KEY_INVALID',
        'MODEL_NOT_PERMITTED',
        'UPSTREAM_FORBIDDEN',
        'UPSTREAM_BAD_REQUEST',
        'RATE_LIMITED',
        'QUOTA_INSUFFICIENT',
        'UPSTREAM_SERVER_ERROR',
        'SEEDANCE_AGREEMENT_REQUIRED',
      ];

      for (const c of rejectCodes) {
        const exp = makeExpected();
        const raw = makeRaw({
          ok: false,
          task_id: null,
          status: null,
          error_code: c,
          result_urls: [],
        });
        const res = guardPtVideoResult(raw, exp);
        assert.equal(res.outcome, 'rejected');
        assert.equal(res.ok, false);
        assert.equal(res.errorCode, c);
      }
    });

    it('rejects not_submitted or rejected if host already has a known taskId', () => {
      const exp = makeExpected({ taskId: 'existing-task-id' });
      const raw = makeRaw({
        ok: false,
        task_id: null, // dropped existing taskId
        status: null,
        error_code: 'INVALID_REQUEST',
        result_urls: [],
      });

      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });
  });

  describe('5. Tampering, Mismatch, and Cost Invariants', () => {
    it('rejects model mismatch', () => {
      const exp = makeExpected({ model: 'wan3.0-video' });
      const raw = makeRaw({ model: 'tampered-model-name' });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects kind mismatch', () => {
      const exp = makeExpected({ kind: 'video' });
      const raw = makeRaw({ kind: 'image' });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects altered task_id when host provided expected.taskId', () => {
      const exp = makeExpected({ taskId: 'original-tid' });
      const raw = makeRaw({ task_id: 'swapped-tid-attack' });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects altered billing_params (duration_s altered)', () => {
      const exp = makeExpected();
      const raw = makeRaw({
        billing_params: {
          ...exp.billingParams,
          duration_s: 999, // tampered duration
        },
      });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects non-null cost_usd (engine must never dictate billing amount)', () => {
      const exp = makeExpected();
      const raw = makeRaw({ cost_usd: 0.15 });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects cost_unknown !== true', () => {
      const exp = makeExpected();
      const raw = makeRaw({ cost_unknown: false });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects unknown fields on raw', () => {
      const exp = makeExpected();
      const raw = makeRaw({ injected_field: 'malicious_payload' });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects unknown fields on expected', () => {
      const exp = makeExpected({ injected_expected_key: 'malicious' });
      const raw = makeRaw();
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_EXPECTATION_INVALID',
      });
    });
  });

  describe('6. URL security and schema boundary', () => {
    it('rejects file:// scheme', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['file:///etc/passwd'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects javascript: scheme', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['javascript:alert(1)'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects data: scheme', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['data:video/mp4;base64,AAAA'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects URL with userinfo (credentials embedded)', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['https://admin:password@cdn.example.com/video.mp4'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects URL with control characters', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['https://cdn.example.com/video\x00.mp4'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects URL with empty host', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['http:///video.mp4'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects URL with invalid port', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: ['https://cdn.example.com:999999/video.mp4'] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects duplicate URLs in result array', () => {
      const exp = makeExpected({
        model: 'image-01',
        kind: 'image',
        billingParams: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 2, aspect_ratio: '1:1' },
      });
      const raw = makeRaw({
        model: 'image-01',
        kind: 'image',
        task_id: null,
        result_urls: ['https://cdn.example.com/pic.png', 'https://cdn.example.com/pic.png'],
        billing_params: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 2, aspect_ratio: '1:1' },
      });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects more than 9 URLs', () => {
      const urls = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.png`);
      const exp = makeExpected({
        model: 'image-01',
        kind: 'image',
        billingParams: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 9, aspect_ratio: '1:1' },
      });
      const raw = makeRaw({
        model: 'image-01',
        kind: 'image',
        task_id: null,
        result_urls: urls,
        billing_params: { model: 'image-01', kind: 'image', duration_s: null, resolution: null, n_images: 9, aspect_ratio: '1:1' },
      });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects URL longer than 8192 characters', () => {
      const longUrl = 'https://cdn.example.com/' + 'a'.repeat(8200) + '.mp4';
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: [longUrl] });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });
  });

  describe('7. Non-plain JSON, Getters, Proxies, and Size Bounds', () => {
    it('rejects getters without executing them', () => {
      let getterExecuted = false;
      const raw = makeRaw();
      Object.defineProperty(raw, 'malicious_getter', {
        get() {
          getterExecuted = true;
          return 'pwned';
        },
        enumerable: true,
      });

      const exp = makeExpected();
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
      assert.equal(getterExecuted, false, 'Getter must NOT be executed');
    });

    it('rejects circular references', () => {
      const raw = makeRaw();
      raw.cycle = raw;
      const exp = makeExpected();

      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects deep nesting exceeding 8 levels', () => {
      const exp = makeExpected();
      let deep = {};
      let curr = deep;
      for (let i = 0; i < 10; i++) {
        curr.nested = {};
        curr = curr.nested;
      }
      const raw = makeRaw({ deep });

      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects payloads larger than 128 KiB', () => {
      const exp = makeExpected();
      const largeString = 'x'.repeat(130 * 1024);
      const raw = makeRaw({ error_hint: largeString, ok: false, status: 'submission_unknown', error_code: 'SUBMISSION_OUTCOME_UNKNOWN', result_urls: [] });

      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects non-plain object prototypes', () => {
      class CustomObject {}
      const raw = Object.assign(new CustomObject(), makeRaw());
      const exp = makeExpected();

      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });
  });

  describe('8. Redaction of PRIVATE_SENTINEL and Immutability', () => {
    it('does not leak PRIVATE_SENTINEL from error_hint into errorMessage', () => {
      const exp = makeExpected();
      const raw = makeRaw({
        ok: false,
        status: 'submission_unknown',
        error_code: 'SUBMISSION_OUTCOME_UNKNOWN',
        error_hint: `Upstream error containing ${PRIVATE_SENTINEL}`,
        result_urls: [],
      });

      const res = guardPtVideoResult(raw, exp);
      assert.ok(!res.errorMessage.includes(PRIVATE_SENTINEL));
      assert.ok(!JSON.stringify(res).includes(PRIVATE_SENTINEL));
    });

    it('does not leak PRIVATE_SENTINEL when invalid field causes error', () => {
      const exp = makeExpected();
      const raw = makeRaw();
      raw[`attack_${PRIVATE_SENTINEL}`] = 'val';

      try {
        guardPtVideoResult(raw, exp);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.equal(err.code, 'MEDIA_ENGINE_RESULT_INVALID');
        assert.ok(!err.message.includes(PRIVATE_SENTINEL));
      }
    });

    it('does not leak PRIVATE_SENTINEL when invalid URL causes error', () => {
      const exp = makeExpected();
      const raw = makeRaw({ result_urls: [`file:///path/to/${PRIVATE_SENTINEL}`] });

      try {
        guardPtVideoResult(raw, exp);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.equal(err.code, 'MEDIA_ENGINE_RESULT_INVALID');
        assert.ok(!err.message.includes(PRIVATE_SENTINEL));
      }
    });

    it('deeply freezes returned object and preserves input immutability', () => {
      const exp = makeExpected();
      const raw = makeRaw();
      const rawSnapshot = JSON.stringify(raw);
      const expSnapshot = JSON.stringify(exp);

      const res = guardPtVideoResult(raw, exp);

      // Verify input objects were NOT mutated
      assert.equal(JSON.stringify(raw), rawSnapshot);
      assert.equal(JSON.stringify(exp), expSnapshot);

      // Verify returned result is deep-frozen
      assert.ok(Object.isFrozen(res));
      assert.ok(Object.isFrozen(res.resultUrls));
      assert.ok(Object.isFrozen(res.billingParams));

      assert.throws(() => {
        res.ok = false;
      }, TypeError);

      assert.throws(() => {
        res.resultUrls.push('https://cdn.example.com/evil.mp4');
      }, TypeError);
    });
  });

  describe('9. State contradictions', () => {
    it('rejects ok:true paired with non-empty error_code', () => {
      const exp = makeExpected();
      const raw = makeRaw({ ok: true, error_code: 'SOME_ERROR' });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects ok:false paired with status completed and no error_code', () => {
      const exp = makeExpected();
      const raw = makeRaw({ ok: false, status: 'completed', error_code: null });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects remote_failed paired with non-empty result_urls', () => {
      const exp = makeExpected({ taskId: 'tid-fail-url' });
      const raw = makeRaw({
        ok: false,
        task_id: 'tid-fail-url',
        status: 'failed',
        error_code: 'REMOTE_TASK_FAILED',
        result_urls: ['https://cdn.example.com/should_not_exist.mp4'],
      });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });

    it('rejects submission_unknown paired with non-empty result_urls', () => {
      const exp = makeExpected();
      const raw = makeRaw({
        ok: false,
        status: 'submission_unknown',
        error_code: 'SUBMISSION_OUTCOME_UNKNOWN',
        result_urls: ['https://cdn.example.com/ghost.mp4'],
      });
      assert.throws(() => guardPtVideoResult(raw, exp), {
        name: 'MediaEngineGuardError',
        code: 'MEDIA_ENGINE_RESULT_INVALID',
      });
    });
  });
});

test('main review: proxies never execute traps or escape fixed guard errors',()=>{
 let called=0;const proxy=new Proxy(makeRaw(),{getPrototypeOf(){called++;throw Error(PRIVATE_SENTINEL);}});
 assert.throws(()=>guardPtVideoResult(proxy,makeExpected()),{code:'MEDIA_ENGINE_RESULT_INVALID'});assert.equal(called,0);
 assert.throws(()=>guardPtVideoResult(new Proxy(makeRaw(),{}),makeExpected()),{code:'MEDIA_ENGINE_RESULT_INVALID'});
});
test('main review: inherited codes and contradictory terminal state are rejected',()=>{
 for(const error_code of ['toString','__proto__','constructor'])assert.throws(()=>guardPtVideoResult(makeRaw({ok:false,task_id:null,status:null,result_urls:[],error_code}),makeExpected()),{code:'MEDIA_ENGINE_RESULT_INVALID'});
 assert.throws(()=>guardPtVideoResult(makeRaw({ok:false,status:'completed',result_urls:[],error_code:'REMOTE_TASK_FAILED'}),makeExpected()),{code:'MEDIA_ENGINE_RESULT_INVALID'});
});
test('main review: finite scalar billing and positive requested image count',()=>{
 for(const value of [Infinity,NaN,{x:1}]){const exp=makeExpected();exp.billingParams.duration_s=value;const raw=makeRaw({billing_params:{...exp.billingParams}});assert.throws(()=>guardPtVideoResult(raw,exp),{code:'MEDIA_ENGINE_EXPECTATION_INVALID'});if(typeof value==='object')assert.equal(Object.isFrozen(value),false);}
 const exp=makeExpected({model:'image',kind:'image',billingParams:{model:'image',kind:'image',n_images:0}});assert.throws(()=>guardPtVideoResult(makeRaw(),exp),{code:'MEDIA_ENGINE_EXPECTATION_INVALID'});
});
test('main review: genuine engine pre-submit empty billing binds host snapshot only',()=>{
 for(const error_code of ['INVALID_REQUEST','BEFORE_SUBMIT_REJECTED','CANCELLED_BEFORE_SUBMIT']){
  const exp=makeExpected(),raw=makeRaw({ok:false,task_id:null,status:null,result_urls:[],billing_params:{},error_code});
  const result=guardPtVideoResult(raw,exp);assert.equal(result.outcome,'not_submitted');assert.deepEqual(result.billingParams,exp.billingParams);assert.equal(Object.isFrozen(exp.billingParams),false);
 }
});
