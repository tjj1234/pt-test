'use strict';

/**
 * ptvideo-result-guard-candidate.cjs
 *
 * Strict, pure-function gate for consuming PowerTokens media engine results in Node.js host.
 * - Validates input bounds, depth, JSON purity (rejects getters, proxies, cycles, unknown fields).
 * - Matches model, kind, taskId, and billingParams against host expectation snapshot.
 * - Validates result URLs (scheme, host, userinfo, control chars, uniqueness).
 * - Maps results into finite, strictly normalized outcomes.
 * - No side-effects, no network, no DB/run writes, no credential leaks.
 */

const { types: { isProxy } } = require('node:util');
const MAX_UTF8_BYTES = 128 * 1024; // 128 KiB
const MAX_DEPTH = 8;
const MAX_URLS = 9;
const MAX_URL_LEN = 8192;
const MAX_ID_LEN = 256;
const MAX_MODEL_LEN = 256;

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

const ALLOWED_KINDS = new Set(['image', 'video', 'seedance']);
const EXPECTED_ALLOWED_KEYS = new Set(['model', 'kind', 'taskId', 'billingParams']);
const BILLING_ALLOWED_KEYS = new Set(['model', 'kind', 'duration_s', 'resolution', 'n_images', 'aspect_ratio']);
const RAW_ALLOWED_KEYS = new Set([
  'ok',
  'task_id',
  'model',
  'kind',
  'status',
  'result_urls',
  'billing_params',
  'cost_usd',
  'cost_unknown',
  'error_code',
  'error_hint',
]);

const REJECTED_ERROR_CODES = {
  KEY_INVALID: 'API Key 无效或过期，请求被拒绝',
  MODEL_NOT_PERMITTED: '无权使用该模型，请求被拒绝',
  UPSTREAM_FORBIDDEN: '上游拒绝访问 (403)',
  UPSTREAM_BAD_REQUEST: '上游请求参数错误 (400)',
  RATE_LIMITED: '上游频率受限 (429)',
  QUOTA_INSUFFICIENT: '账号余额不足',
  UPSTREAM_SERVER_ERROR: '上游服务端错误 (5xx)',
  SEEDANCE_AGREEMENT_REQUIRED: '需要签署协议',
};

const NOT_SUBMITTED_ERROR_CODES = {
  INVALID_REQUEST: '请求参数前置校验未通过，未提交上游',
  BEFORE_SUBMIT_REJECTED: '前置钩子拒绝提交，未提交上游',
  CANCELLED_BEFORE_SUBMIT: '提交前已取消，未提交上游',
};

class MediaEngineGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaEngineGuardError';
    this.code = code;
  }
}

/**
 * Safely inspect object graph for depth, circular references, and non-plain JSON structures
 * without executing user-defined getters or invoking unknown methods.
 */
function inspectSafeJsonStructure(val, depth, visited, errorCode, budget = {bytes:0,nodes:0}) {
  const reject = () => { throw new MediaEngineGuardError(errorCode, '输入非有界纯JSON结构'); };
  if (depth > MAX_DEPTH || ++budget.nodes > 16384) reject();
  if (typeof val === 'string') {
    if (val.length > MAX_UTF8_BYTES) reject();
    budget.bytes += Buffer.byteLength(val, 'utf8') + 2;
  } else if (typeof val === 'number') {
    if (!Number.isFinite(val)) reject();
    budget.bytes += 24;
  } else if (val === null || typeof val === 'boolean') budget.bytes += 5;
  else if (typeof val !== 'object') reject();
  if (budget.bytes > MAX_UTF8_BYTES) reject();
  if (val === null || typeof val !== 'object') return;
  if (isProxy(val) || visited.has(val)) reject();
  visited.add(val);
  const array = Array.isArray(val), proto = Object.getPrototypeOf(val);
  if (array ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) reject();
  const keys = Reflect.ownKeys(val);
  if (keys.length > 16384 || (array && val.length > 16384)) reject();
  for (const key of keys) {
    if (typeof key !== 'string') reject();
    if (array && key === 'length') continue;
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) reject();
    const desc = Object.getOwnPropertyDescriptor(val,key);
    if (!desc || !Object.hasOwn(desc,'value') || !desc.enumerable) reject();
    budget.bytes += Buffer.byteLength(key,'utf8') + 4;
    inspectSafeJsonStructure(desc.value, depth + 1, visited, errorCode, budget);
  }
  if (array && keys.length !== val.length + 1) reject();
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function validateUrl(urlStr) {
  if (typeof urlStr !== 'string') {
    return false;
  }
  if (urlStr.length === 0 || urlStr.length > MAX_URL_LEN) {
    return false;
  }
  if (CONTROL_CHAR_RE.test(urlStr) || /\s|\\/.test(urlStr) || !/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(urlStr) || urlStr.split('/')[2].includes('@')) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (!parsed.hostname || parsed.hostname.trim() === '') {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return false;
    }
  }
  return true;
}

/**
 * Gatekeeper for PowerTokens media engine results.
 *
 * @param {object} raw - Unsanitized result object parsed from Python engine JSON frame.
 * @param {object} expected - Trusted host snapshot: { model, kind, taskId?, billingParams }.
 * @returns {object} Deep-frozen normalized result.
 * @throws {MediaEngineGuardError}
 */
function guardPtVideoResult(raw, expected) {
  // 1. Validate expected snapshot
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入预期参数非法');
  }

  inspectSafeJsonStructure(expected, 1, new Set(), 'MEDIA_ENGINE_EXPECTATION_INVALID');

  for (const k of Object.keys(expected)) {
    if (!EXPECTED_ALLOWED_KEYS.has(k)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入预期包含未知字段');
    }
  }

  if (typeof expected.model !== 'string' || expected.model.length === 0 || expected.model.length > MAX_MODEL_LEN || CONTROL_CHAR_RE.test(expected.model)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入预期模型标识非法');
  }

  if (!ALLOWED_KINDS.has(expected.kind)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入预期类型非法');
  }

  if (expected.taskId !== undefined && expected.taskId !== null) {
    if (typeof expected.taskId !== 'string' || expected.taskId.length === 0 || expected.taskId.length > MAX_ID_LEN || CONTROL_CHAR_RE.test(expected.taskId)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入预期任务ID非法');
    }
  }

  if (typeof expected.billingParams !== 'object' || expected.billingParams === null || Array.isArray(expected.billingParams)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入计费参数非法');
  }

  for (const k of Object.keys(expected.billingParams)) {
    if (!BILLING_ALLOWED_KEYS.has(k)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID', '媒体引擎准入计费参数包含未知字段');
    }
  }

  for (const [key,value] of Object.entries(expected.billingParams)) {
    if (value !== null && !['string','number'].includes(typeof value)) throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID','计费参数必须为标量');
  }
  if (expected.kind === 'image' && (!Number.isSafeInteger(expected.billingParams.n_images) || expected.billingParams.n_images < 1 || expected.billingParams.n_images > MAX_URLS)) throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID','图片数量非法');
  if (expected.billingParams.model !== expected.model || expected.billingParams.kind !== expected.kind) throw new MediaEngineGuardError('MEDIA_ENGINE_EXPECTATION_INVALID','计费身份不一致');
  // 2. Validate raw result structure & bounds
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎结果非纯对象结构');
  }

  inspectSafeJsonStructure(raw, 1, new Set(), 'MEDIA_ENGINE_RESULT_INVALID');

  let rawJsonStr;
  try {
    rawJsonStr = JSON.stringify(raw);
  } catch {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎结果无法序列化');
  }

  if (Buffer.byteLength(rawJsonStr, 'utf8') > MAX_UTF8_BYTES) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎结果体积超出上限');
  }

  for (const k of Object.keys(raw)) {
    if (!RAW_ALLOWED_KEYS.has(k)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎结果包含未知字段');
    }
  }

  if (typeof raw.ok !== 'boolean') {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎结果ok字段非布尔类型');
  }

  // Cost invariants: engine must NEVER dictate cost
  if (raw.cost_usd !== null || raw.cost_unknown !== true) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎伪造费用或破坏cost_unknown边界');
  }

  // Model & kind exact match
  if (raw.model !== expected.model) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎返回模型与预期准入不符');
  }
  if (raw.kind !== expected.kind) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎返回类型与预期准入不符');
  }

  // Task ID validation & persistence check
  if (raw.task_id !== null && raw.task_id !== undefined) {
    if (typeof raw.task_id !== 'string' || raw.task_id.length === 0 || raw.task_id.length > MAX_ID_LEN || CONTROL_CHAR_RE.test(raw.task_id)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎任务ID格式非法');
    }
  }

  if (expected.taskId) {
    if (raw.task_id !== expected.taskId) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '已知任务ID被篡改或丢失');
    }
  }

  // Billing params exact match
  if (typeof raw.billing_params !== 'object' || raw.billing_params === null || Array.isArray(raw.billing_params)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎计费参数缺失或非对象');
  }

  for (const k of Object.keys(raw.billing_params)) {
    if (!BILLING_ALLOWED_KEYS.has(k)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎计费参数包含未知字段');
    }
  }

  const emptyPreSubmitBilling = raw.ok === false && raw.status == null && raw.task_id === null && Array.isArray(raw.result_urls) && raw.result_urls.length === 0 && Object.hasOwn(NOT_SUBMITTED_ERROR_CODES, raw.error_code) && Object.keys(raw.billing_params).length === 0;
  for (const k of BILLING_ALLOWED_KEYS) {
    if (emptyPreSubmitBilling) break;
    const expVal = expected.billingParams[k];
    const rawVal = raw.billing_params[k];
    if (expVal !== undefined || rawVal !== undefined) {
      if (expVal !== rawVal) {
        throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎计费参数与准入预期不一致');
      }
    }
  }

  // Result URLs validation
  if (!Array.isArray(raw.result_urls)) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '结果URL非数组结构');
  }

  if (raw.result_urls.length > MAX_URLS) {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '结果URL数量超出上限');
  }

  const seenUrls = new Set();
  for (const u of raw.result_urls) {
    if (!validateUrl(u)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '结果URL非法或包含不安全凭据');
    }
    if (seenUrls.has(u)) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '结果URL包含重复项');
    }
    seenUrls.add(u);
  }

  // Status & error_code type sanity
  if (raw.status !== null && raw.status !== undefined && typeof raw.status !== 'string') {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '状态字段错型');
  }
  if (raw.error_code !== null && raw.error_code !== undefined && typeof raw.error_code !== 'string') {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '错误码错型');
  }
  if (raw.error_hint !== null && raw.error_hint !== undefined && typeof raw.error_hint !== 'string') {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '错误提示错型');
  }

  // 3. Finite outcome state machine
  let outcome;
  let ok = false;
  let errorCode = null;
  let errorMessage = null;

  const expectedN = (expected.kind === 'image')
    ? (Number.isInteger(expected.billingParams?.n_images) ? expected.billingParams.n_images : 1)
    : 1;

  if (raw.ok === true && raw.status === 'completed' && !raw.error_code) {
    if (expected.kind === 'image') {
      if (raw.result_urls.length === expectedN) {
        outcome = 'completed';
        ok = true;
      } else if (raw.result_urls.length > 0 && raw.result_urls.length < expectedN) {
        outcome = 'completed_partial';
        ok = false;
        errorCode = 'IMAGE_RESULT_PARTIAL';
        errorMessage = '图片生成仅部分成功，结果数量少于请求数';
      } else {
        throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '完成状态与结果数量不一致');
      }
    } else {
      if (raw.result_urls.length === 1) {
        outcome = 'completed';
        ok = true;
      } else {
        throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '视频类完成结果数量必须恰好为1');
      }
    }
  } else if (raw.status === 'completed_partial' && !raw.error_code) {
    if (raw.result_urls.length > 0 && raw.result_urls.length < expectedN) {
      outcome = 'completed_partial';
      ok = false;
      errorCode = 'IMAGE_RESULT_PARTIAL';
      errorMessage = '图片生成仅部分成功，结果数量少于请求数';
    } else {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '部分完成状态与结果数量不符');
    }
  } else if (raw.status === 'completed_local_save_failed' && raw.ok === false) {
    if ((raw.error_code === 'ON_RESULT_FAILED' || raw.error_code === 'HOOK_ON_RESULT_FAILED') && raw.result_urls.length > 0) {
      outcome = 'completed_local_save_failed';
      ok = false;
      errorCode = 'COMPLETED_LOCAL_SAVE_FAILED';
      errorMessage = '远端生成已成功但本地持久化失败；任务与结果已保留，严禁二次提交';
    } else {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '本地保存失败组合参数矛盾');
    }
  } else if (raw.status === 'completed_locally_cancelled' && raw.ok === false) {
    if (raw.error_code === 'CANCELLED_AFTER_SUBMIT' && raw.result_urls.length > 0) {
      outcome = 'completed_locally_cancelled';
      ok = false;
      errorCode = 'CANCELLED_AFTER_SUBMIT';
      errorMessage = '远端已受理或已完成但本地已取消；结果已保留，不代表撤销上游计费';
    } else {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '本地取消组合参数矛盾');
    }
  } else if (raw.ok === false && (raw.status === 'submission_unknown' || (raw.status === null && raw.error_code === 'SUBMISSION_OUTCOME_UNKNOWN'))) {
    if (raw.error_code === 'SUBMISSION_OUTCOME_UNKNOWN' && raw.result_urls.length === 0) {
      outcome = 'submission_unknown';
      ok = false;
      errorCode = 'SUBMISSION_OUTCOME_UNKNOWN';
      errorMessage = '提交结果未知（网络中断或服务端未确定响应）；严禁自动重提，需人工核对';
    } else {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '未知提交组合参数矛盾');
    }
  } else if (raw.ok === false && ['unknown_timeout', 'unknown_cancelled', 'unknown_poll_error', 'unknown_result_missing'].includes(raw.status)) {
    if (expected.kind !== 'image' && (!raw.task_id || typeof raw.task_id !== 'string')) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '轮询对账状态缺少有效任务ID');
    }
    outcome = 'needs_reconciliation';
    ok = false;
    if (raw.status === 'unknown_timeout') {
      errorCode = 'POLL_TIMEOUT';
      errorMessage = '轮询超时；远端任务ID已保留，严禁自动重提，需人工核对状态';
    } else if (raw.status === 'unknown_cancelled') {
      errorCode = 'CANCELLED_DURING_POLL';
      errorMessage = '轮询期间取消；远端任务ID已保留，严禁自动重提，需核对远端执行状态';
    } else if (raw.status === 'unknown_result_missing') {
      errorCode = 'VIDEO_RESULT_EMPTY';
      errorMessage = '远端任务成功但未返回有效结果地址；任务ID已保留，需人工核对';
    } else {
      errorCode = 'POLL_FAILED_WITH_TASK_ID';
      errorMessage = '轮询过程发生异常；远端任务ID已保留，严禁自动重提，需人工核对';
    }
  } else if (raw.ok === false && (raw.status === 'failed')) {
    const allowedRemoteFailCodes = new Set(['IMAGE_REMOTE_FAILED', 'REMOTE_TASK_FAILED', 'MEDIA_REJECTED', 'CONTENT_REJECTED']);
    if (raw.error_code && allowedRemoteFailCodes.has(raw.error_code) && raw.result_urls.length === 0) {
      outcome = 'remote_failed';
      ok = false;
      errorCode = 'REMOTE_FAILED';
      errorMessage = '远端任务明确执行失败或被内容策略拒绝';
    } else {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '远端失败组合参数矛盾');
    }
  } else if (raw.ok === false && raw.status === 'cancelled' && raw.error_code === 'REMOTE_TASK_CANCELLED') {
    if (raw.result_urls.length === 0) {
      outcome = 'remote_cancelled';
      ok = false;
      errorCode = 'REMOTE_CANCELLED';
      errorMessage = '远端任务已被明确取消';
    } else {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '远端取消组合参数矛盾');
    }
  } else if (raw.ok === false && raw.status == null && raw.task_id === null && raw.result_urls.length === 0 && raw.error_code && Object.hasOwn(NOT_SUBMITTED_ERROR_CODES, raw.error_code)) {
    if (expected.taskId) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '已有任务ID不可判定为未提交');
    }
    outcome = 'not_submitted';
    ok = false;
    errorCode = raw.error_code;
    errorMessage = NOT_SUBMITTED_ERROR_CODES[raw.error_code];
  } else if (raw.ok === false && raw.status == null && raw.task_id === null && raw.result_urls.length === 0 && raw.error_code && Object.hasOwn(REJECTED_ERROR_CODES, raw.error_code)) {
    if (expected.taskId) {
      throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '已有任务ID不可判定为未准入拒绝');
    }
    outcome = 'rejected';
    ok = false;
    errorCode = raw.error_code;
    errorMessage = REJECTED_ERROR_CODES[raw.error_code];
  } else {
    throw new MediaEngineGuardError('MEDIA_ENGINE_RESULT_INVALID', '媒体引擎结果状态或错误码组合非法');
  }

  // 4. Construct deeply frozen normalized response
  const normalized = {
    outcome,
    ok,
    taskId: (raw.task_id !== undefined && raw.task_id !== null) ? raw.task_id : null,
    requestedModel: expected.model,
    kind: expected.kind,
    resultUrls: [...raw.result_urls],
    billingParams: Object.assign({}, expected.billingParams),
    errorCode,
    errorMessage,
    costCoverage: 'unknown',
    amount: null,
    modelIdentityEvidence: 'unknown',
  };

  return deepFreeze(normalized);
}

module.exports = {
  guardPtVideoResult,
  MediaEngineGuardError,
};
