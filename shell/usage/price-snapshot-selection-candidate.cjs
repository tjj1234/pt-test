'use strict';
const { types: { isProxy } } = require('node:util');
/**
 * shell/usage/price-snapshot-selection-candidate.cjs
 * ============================================================================
 * F3 文本定价快照选择候选模块 (Text Price Snapshot Selection Candidate)
 * 契约规范：docs/refactor/GEMINI-F3-PRICE-SNAPSHOT-SELECTION-PACKAGE-20261027.md
 *
 * 职责：
 *   作为 F3 文本用量官方价格评估的纯函数前置选择门禁。
 *   从版本化价格记录中，根据指定调用时刻与模型 ID 确定【唯一】适用的价格快照。
 *   仅当指定调用时刻恰好落入唯一有效快照 [effectiveFrom, effectiveUntil) 时，
 *   返回深冻结的快照副本；任何缺失、异常、冲突或重叠均 fail-closed 返回 unknown。
 *
 * 核心安全与工程约束：
 *   1. 纯函数设计：零外部依赖，绝对不访问网络、时钟 (Date.now())、文件系统或数据库。
 *   2. 严格 Fail-Closed：无匹配、重叠版本、未来抓取时间、字段缺失或非法均拒绝，
 *      绝不猜测最近价格，绝不擅自将未定义字段填 0。
 *   3. 零费率与非零费率均必须来自显式字段（允许显式 0，拒绝缺失/undefined/null）。
 *   4. 防御对象陷阱：阻断 getter、setter、Proxy 抛错、循环引用与原型篡改。
 *   5. 资源硬上限：限制快照数组长度与字段字符串长度，超限立即拒绝。
 *   6. 错误脱敏：所有错误码稳定规范，错误信息绝不回显路径、模型名或用户数据。
 *   7. 输入不可变与深冻结：原入参完全不修改，返回深冻结副本。
 * ============================================================================
 */

const OFFICIAL_PRICE_SOURCE = 'https://powertokens.ai/pricing';
const OFFICIAL_CURRENCY = 'USD';

/**
 * 资源硬上限配置 (不可突破)
 */
const HARD_LIMITS = Object.freeze({
  maxSnapshots: 1_000,
  maxStringLength: 1_000,
});

/**
 * 稳定原因码 / 错误码枚举
 */
const REASON_CODES = Object.freeze({
  EXACT_MATCH: 'EXACT_MATCH',
  NO_MATCH: 'NO_MATCHING_SNAPSHOT',
  OVERLAPPING_SNAPSHOTS: 'OVERLAPPING_SNAPSHOTS',
  FUTURE_CAPTURED_AT: 'FUTURE_CAPTURED_AT',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  INVALID_EFFECTIVE_RANGE: 'INVALID_EFFECTIVE_RANGE',
  INVALID_SOURCE_URL: 'INVALID_SOURCE_URL',
  INVALID_CURRENCY: 'INVALID_CURRENCY',
  INVALID_MODEL: 'INVALID_MODEL',
  MISSING_FIELD: 'MISSING_REQUIRED_FIELD',
  NON_FINITE_PRICE: 'NON_FINITE_PRICE',
  NEGATIVE_PRICE: 'NEGATIVE_PRICE',
  MISSING_CACHE_DIMENSION: 'MISSING_CACHE_DIMENSION',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  GETTER_PROHIBITED: 'GETTER_PROHIBITED',
  PROXY_TRAP_ERROR: 'PROXY_TRAP_ERROR',
  PROTOTYPE_POLLUTION: 'PROTOTYPE_POLLUTION',
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE',
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
});

const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 严格 UTC 时间戳：Z 或 +00:00，最多毫秒精度；日历字段另行反查。
const UTC_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|\+00:00)$/;

/**
 * 创建脱敏异常：绝不回显路径、模型名或用户数据
 */
function createDesensitizedError(reasonCode, message) {
  const err = new TypeError(`[PRICE_SNAPSHOT] ${reasonCode}: ${message}`);
  err.code = reasonCode;
  return err;
}

/**
 * 严格无歧义 UTC 时间戳解析
 * 若为非 UTC 格式、非法日期或非有限毫秒数，一律返回 null
 */
function parseUnambiguousUtc(str) {
  if (typeof str !== 'string' || str.length > HARD_LIMITS.maxStringLength) {
    return null;
  }
  const match = UTC_DATE_REGEX.exec(str);
  if (!match) {
    return null;
  }
  const ms = Date.parse(str);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  const parts = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  if (parts.some((value, index) => value !== Number(match[index + 1]))) return null;
  return ms;
}

/**
 * 递归深度冻结对象与数组
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * 安全探查对象属性描述符，阻断 getter、setter、Proxy 抛错与原型篡改
 */
function inspectPlainObjectProperties(obj, seenSet) {
  if (isProxy(obj)) return { ok: false, reasonCode: REASON_CODES.PROXY_TRAP_ERROR };
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reasonCode: REASON_CODES.INVALID_ARGUMENTS };
  }

  if (seenSet.has(obj)) {
    return { ok: false, reasonCode: REASON_CODES.CIRCULAR_REFERENCE };
  }
  seenSet.add(obj);

  let proto;
  try {
    proto = Object.getPrototypeOf(obj);
  } catch {
    return { ok: false, reasonCode: REASON_CODES.PROXY_TRAP_ERROR };
  }

  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reasonCode: REASON_CODES.PROTOTYPE_POLLUTION };
  }

  let keys;
  try {
    keys = Reflect.ownKeys(obj);
  } catch {
    return { ok: false, reasonCode: REASON_CODES.PROXY_TRAP_ERROR };
  }
  if (keys.length > 16) return { ok: false, reasonCode: REASON_CODES.RESOURCE_LIMIT_EXCEEDED };

  const descriptors = {};
  for (const key of keys) {
    if (typeof key === 'symbol') {
      return { ok: false, reasonCode: REASON_CODES.INVALID_ARGUMENTS };
    }
    if (DANGEROUS_PROTO_KEYS.has(key)) {
      return { ok: false, reasonCode: REASON_CODES.PROTOTYPE_POLLUTION };
    }

    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      return { ok: false, reasonCode: REASON_CODES.PROXY_TRAP_ERROR };
    }

    if (!desc) {
      return { ok: false, reasonCode: REASON_CODES.INVALID_ARGUMENTS };
    }

    if (desc.get || desc.set) {
      return { ok: false, reasonCode: REASON_CODES.GETTER_PROHIBITED };
    }

    descriptors[key] = desc;
  }

  return { ok: true, descriptors };
}

/**
 * 纯函数选择器：从快照列表中选择唯一适用的官方文本定价快照
 *
 * @param {object} params
 * @param {unknown[]} params.snapshots 快照数组
 * @param {string} params.model 目标模型完全一致标识符
 * @param {string} params.requestedAt 纯 UTC 请求发生时刻
 * @param {object} [options] 可选配置项
 * @param {boolean} [options.throwOnError=false] 若为 true，在无法匹配或异常时抛出脱敏异常
 * @returns {{ snapshot: Readonly<object>|null, coverage: 'selected'|'unknown', reasonCode: string }}
 */
function selectTextPriceSnapshot(params, options = {}) {
  const optionsInspect = inspectPlainObjectProperties(options, new Set());
  const throwOnError = optionsInspect.ok && optionsInspect.descriptors.throwOnError?.value === true;

  function fail(reasonCode, message = 'Failed to select text price snapshot') {
    if (throwOnError) {
      throw createDesensitizedError(reasonCode, message);
    }
    return Object.freeze({
      snapshot: null,
      coverage: 'unknown',
      reasonCode,
    });
  }

  // 1. 入参根对象安全检查
  if (!optionsInspect.ok) return fail(optionsInspect.reasonCode);
  if (isProxy(params)) return fail(REASON_CODES.PROXY_TRAP_ERROR);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return fail(REASON_CODES.INVALID_ARGUMENTS, 'Selection parameters must be a non-null plain object');
  }

  const rootSeen = new Set();
  const rootInspect = inspectPlainObjectProperties(params, rootSeen);
  if (!rootInspect.ok) {
    return fail(rootInspect.reasonCode, 'Root parameters failed safety inspection');
  }

  const rootDesc = rootInspect.descriptors;
  if (Object.keys(rootDesc).some(key => !['snapshots', 'model', 'requestedAt'].includes(key))) {
    return fail(REASON_CODES.INVALID_ARGUMENTS);
  }

  // 2. requestedAt 校验 (纯无歧义 UTC)
  if (!rootDesc.requestedAt || typeof rootDesc.requestedAt.value !== 'string') {
    return fail(REASON_CODES.INVALID_TIMESTAMP, 'Invocation requestedAt timestamp must be a string');
  }
  const requestedAtStr = rootDesc.requestedAt.value;
  const requestedAtMs = parseUnambiguousUtc(requestedAtStr);
  if (requestedAtMs === null) {
    return fail(REASON_CODES.INVALID_TIMESTAMP, 'Invocation requestedAt timestamp must be an unambiguous UTC string');
  }

  // 3. model 校验
  if (!rootDesc.model || typeof rootDesc.model.value !== 'string') {
    return fail(REASON_CODES.INVALID_MODEL, 'Target model identifier must be a non-empty string');
  }
  const targetModel = rootDesc.model.value;
  if (!targetModel || targetModel.trim() !== targetModel || /[\x00-\x1f\x7f]/.test(targetModel) || targetModel.length > HARD_LIMITS.maxStringLength) {
    return fail(REASON_CODES.INVALID_MODEL, 'Target model identifier cannot be empty or exceed length limit');
  }

  // 4. snapshots 数组校验
  if (isProxy(rootDesc.snapshots?.value)) return fail(REASON_CODES.PROXY_TRAP_ERROR);
  if (!rootDesc.snapshots || !Array.isArray(rootDesc.snapshots.value)) {
    return fail(REASON_CODES.INVALID_ARGUMENTS, 'Snapshots collection must be an array');
  }
  const rawSnapshots = rootDesc.snapshots.value;

  // 数组自身原型与 getter 检查
  let arrayProto;
  try {
    arrayProto = Object.getPrototypeOf(rawSnapshots);
  } catch {
    return fail(REASON_CODES.PROXY_TRAP_ERROR, 'Array prototype inspection trapped');
  }
  if (arrayProto !== Array.prototype) {
    return fail(REASON_CODES.PROTOTYPE_POLLUTION, 'Snapshots array has custom prototype');
  }

  if (rawSnapshots.length > HARD_LIMITS.maxSnapshots) {
    return fail(REASON_CODES.RESOURCE_LIMIT_EXCEEDED, 'Snapshots count exceeds maximum limit');
  }
  if (Reflect.ownKeys(rawSnapshots).some(key => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= rawSnapshots.length))) {
    return fail(REASON_CODES.INVALID_ARGUMENTS);
  }

  // 5. 遍历并结构性检查快照项
  const matchingCandidates = [];
  const snapshotSeen = new Set();

  for (let i = 0; i < rawSnapshots.length; i++) {
    let itemDesc;
    try {
      itemDesc = Object.getOwnPropertyDescriptor(rawSnapshots, String(i));
    } catch {
      return fail(REASON_CODES.PROXY_TRAP_ERROR, 'Snapshots array index inspection trapped');
    }
    if (!itemDesc) {
      return fail(REASON_CODES.INVALID_ARGUMENTS, 'Snapshot item descriptor missing');
    }
    if (itemDesc.get || itemDesc.set) {
      return fail(REASON_CODES.GETTER_PROHIBITED, 'Accessor property detected in snapshots array');
    }

    const item = itemDesc.value;
    const itemInspect = inspectPlainObjectProperties(item, snapshotSeen);
    if (!itemInspect.ok) {
      return fail(itemInspect.reasonCode, 'Snapshot item failed safety inspection');
    }

    const desc = itemInspect.descriptors;
    const allowedFields = ['sourceUrl', 'version', 'capturedAt', 'effectiveFrom', 'effectiveUntil',
      'currency', 'model', 'inputUsdPerMillion', 'outputUsdPerMillion',
      'cacheReadUsdPerMillion', 'cacheWriteUsdPerMillion'];
    if (Object.keys(desc).some(key => !allowedFields.includes(key))) return fail(REASON_CODES.INVALID_ARGUMENTS);

    // 模型 ID 完全相等匹配 (严格大小写与完全相等，绝不猜测)
    if (!desc.model || typeof desc.model.value !== 'string') {
      continue;
    }
    if (desc.model.value !== targetModel) {
      continue;
    }

    // 针对目标模型的快照，进行严格字段模式与类型校验
    // 来源检查
    if (!desc.sourceUrl || desc.sourceUrl.value !== OFFICIAL_PRICE_SOURCE) {
      return fail(REASON_CODES.INVALID_SOURCE_URL, 'Snapshot sourceUrl must be official pricing source');
    }

    // 币种检查
    if (!desc.currency || desc.currency.value !== OFFICIAL_CURRENCY) {
      return fail(REASON_CODES.INVALID_CURRENCY, 'Snapshot currency must be USD');
    }

    // 版本检查
    if (!desc.version || typeof desc.version.value !== 'string' || !desc.version.value.trim()) {
      return fail(REASON_CODES.MISSING_FIELD, 'Snapshot version must be a non-empty string');
    }
    if (desc.version.value.length > HARD_LIMITS.maxStringLength) {
      return fail(REASON_CODES.RESOURCE_LIMIT_EXCEEDED, 'Snapshot version length exceeds limit');
    }

    // capturedAt 检查 (无歧义 UTC)
    if (!desc.capturedAt || typeof desc.capturedAt.value !== 'string') {
      return fail(REASON_CODES.INVALID_TIMESTAMP, 'Snapshot capturedAt must be a string');
    }
    const capturedAtMs = parseUnambiguousUtc(desc.capturedAt.value);
    if (capturedAtMs === null) {
      return fail(REASON_CODES.INVALID_TIMESTAMP, 'Snapshot capturedAt must be an unambiguous UTC string');
    }

    // effectiveFrom 检查 (无歧义 UTC)
    if (!desc.effectiveFrom || typeof desc.effectiveFrom.value !== 'string') {
      return fail(REASON_CODES.INVALID_TIMESTAMP, 'Snapshot effectiveFrom must be a string');
    }
    const effectiveFromMs = parseUnambiguousUtc(desc.effectiveFrom.value);
    if (effectiveFromMs === null) {
      return fail(REASON_CODES.INVALID_TIMESTAMP, 'Snapshot effectiveFrom must be an unambiguous UTC string');
    }

    // effectiveUntil 检查 (无歧义 UTC 或 null)
    let effectiveUntilMs = Infinity;
    let effectiveUntilVal = null;
    if (desc.effectiveUntil) {
      effectiveUntilVal = desc.effectiveUntil.value;
      if (effectiveUntilVal !== null) {
        if (typeof effectiveUntilVal !== 'string') {
          return fail(REASON_CODES.INVALID_TIMESTAMP, 'Snapshot effectiveUntil must be a string or null');
        }
        effectiveUntilMs = parseUnambiguousUtc(effectiveUntilVal);
        if (effectiveUntilMs === null) {
          return fail(REASON_CODES.INVALID_TIMESTAMP, 'Snapshot effectiveUntil must be an unambiguous UTC string');
        }
        if (effectiveUntilMs <= effectiveFromMs) {
          return fail(REASON_CODES.INVALID_EFFECTIVE_RANGE, 'Snapshot effectiveUntil must be strictly after effectiveFrom');
        }
      }
    } else {
      return fail(REASON_CODES.MISSING_FIELD, 'Snapshot effectiveUntil field is required (string or null)');
    }

    // 价格维度显式性与有限性检查
    const priceFields = [
      'inputUsdPerMillion',
      'outputUsdPerMillion',
      'cacheReadUsdPerMillion',
      'cacheWriteUsdPerMillion',
    ];

    let priceValidationError = null;
    for (const f of priceFields) {
      const isCache = f.startsWith('cache');
      if (!desc[f] || desc[f].value === undefined || desc[f].value === null) {
        priceValidationError = {
          code: isCache ? REASON_CODES.MISSING_CACHE_DIMENSION : REASON_CODES.MISSING_FIELD,
          msg: `Pricing field "${f}" is required`,
        };
        break;
      }
      const val = desc[f].value;
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        priceValidationError = {
          code: REASON_CODES.NON_FINITE_PRICE,
          msg: `Pricing field "${f}" must be a finite number`,
        };
        break;
      }
      if (val < 0) {
        priceValidationError = {
          code: REASON_CODES.NEGATIVE_PRICE,
          msg: `Pricing field "${f}" cannot be negative`,
        };
        break;
      }
    }

    if (priceValidationError) {
      return fail(priceValidationError.code, priceValidationError.msg);
    }

    // 检查调用时刻是否落入半开区间 [effectiveFrom, effectiveUntil)
    if (requestedAtMs >= effectiveFromMs && requestedAtMs < effectiveUntilMs) {
      // 检查未来抓取时间 (相对于本次请求时刻 requestedAt)
      if (capturedAtMs > requestedAtMs) {
        return fail(REASON_CODES.FUTURE_CAPTURED_AT, 'Snapshot capturedAt cannot be in the future relative to requested invocation time');
      }

      matchingCandidates.push({
        sourceUrl: desc.sourceUrl.value,
        version: desc.version.value,
        capturedAt: desc.capturedAt.value,
        effectiveFrom: desc.effectiveFrom.value,
        effectiveUntil: effectiveUntilVal,
        currency: desc.currency.value,
        model: desc.model.value,
        inputUsdPerMillion: desc.inputUsdPerMillion.value,
        outputUsdPerMillion: desc.outputUsdPerMillion.value,
        cacheReadUsdPerMillion: desc.cacheReadUsdPerMillion.value,
        cacheWriteUsdPerMillion: desc.cacheWriteUsdPerMillion.value,
      });
    }
  }

  // 6. 确定唯一性匹配
  if (matchingCandidates.length === 0) {
    return fail(REASON_CODES.NO_MATCH, 'No matching price snapshot found for the requested timestamp');
  }

  if (matchingCandidates.length > 1) {
    return fail(REASON_CODES.OVERLAPPING_SNAPSHOTS, 'Multiple overlapping price snapshots matched the requested timestamp');
  }

  // 7. 唯一有效匹配，返回深冻结副本
  const matched = matchingCandidates[0];
  return Object.freeze({
    snapshot: deepFreeze(matched),
    coverage: 'selected',
    reasonCode: REASON_CODES.EXACT_MATCH,
  });
}

module.exports = {
  selectTextPriceSnapshot,
  OFFICIAL_PRICE_SOURCE,
  OFFICIAL_CURRENCY,
  HARD_LIMITS,
  REASON_CODES,
  parseUnambiguousUtc,
};
