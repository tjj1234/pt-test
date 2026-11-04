'use strict';

/**
 * shell/candidates/auto-20261103/index.cjs
 * 配置化任务模型路由候选 (Revision 20261104: R1-R6)
 * 基线: f4a3d39e9454a13f37d39ec84d01ae0b625162d0
 *
 * 核心安全门禁与约束：
 * - R1: 显式区分调用前资格拒绝与执行结果未知。遇到 UNKNOWN_PAYMENT_RESULT 或 PAYMENT_UNKNOWN 立即终止并返回 UNKNOWN_PAYMENT_RESULT，严禁跳过或 fallback
 * - R2: 在任何选择分支之前执行统一 dispatchState 检查，dispatched 状态下禁止重新选择（无论 primary、fallback 还是 manual）
 * - R3: 严格校验枚举。dispatchState 仅限 'pre-dispatch' | 'dispatched'；selection.mode 仅限 'auto' | 'manual'，非法显式输入返回 CONFIG_INVALID
 * - R4: 全路由候选去重，禁止 fallback 自身重复以及 fallback 与 candidates 交集重复，违者返回 DUPLICATE_CANDIDATE
 * - R5: pinVersion 校验：必须为非空非全空白字符串，拒绝空/空白 pin
 * - R6: 配置快照深度隔离（Object.freeze + 深拷贝），外部对象突变不影响 router.configVersion 与选择结果
 */

const ALLOWED_TASK_TYPES = ['textChat', 'imageUnderstanding', 'audioUnderstanding', 'videoUnderstanding', 'codeExecution'];
const ALLOWED_DISPATCH_STATES = new Set(['pre-dispatch', 'dispatched']);
const ALLOWED_SELECTION_MODES = new Set(['auto', 'manual']);
const UNKNOWN_PAYMENT_PATTERNS = /PAYMENT_UNKNOWN|UNKNOWN_PAYMENT_RESULT/i;

/**
 * 验证路由配置 schema，返回错误列表（空数组表示合法）
 * @param {object} config
 * @returns {string[]}
 */
function validateRouteConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    errors.push('CONFIG_INVALID: root must be an object');
    return errors;
  }
  if (typeof config.version !== 'string' || !config.version.trim()) {
    errors.push('CONFIG_INVALID: missing or empty "version" field');
  }
  if (!Array.isArray(config.routes)) {
    errors.push('CONFIG_INVALID: "routes" must be an array');
    return errors;
  }
  const seenTaskTypes = new Set();
  for (let i = 0; i < config.routes.length; i++) {
    const route = config.routes[i];
    const prefix = `routes[${i}]`;
    if (!route || typeof route !== 'object') { errors.push(`${prefix}: must be an object`); continue; }
    if (typeof route.taskType !== 'string' || !route.taskType.trim()) {
      errors.push(`${prefix}: missing "taskType"`);
    } else {
      if (seenTaskTypes.has(route.taskType)) errors.push(`${prefix}: duplicate taskType "${route.taskType}" (CONFIG_INVALID)`);
      seenTaskTypes.add(route.taskType);
    }

    const allRouteCandidates = new Set();

    if (!Array.isArray(route.candidates) || route.candidates.length === 0) {
      errors.push(`${prefix}: "candidates" must be a non-empty array`);
    } else {
      const seenCandidates = new Set();
      for (const id of route.candidates) {
        if (typeof id !== 'string' || !id.trim()) { errors.push(`${prefix}: candidate id must be non-empty string`); continue; }
        if (seenCandidates.has(id)) errors.push(`${prefix}: DUPLICATE_CANDIDATE "${id}"`);
        seenCandidates.add(id);
        allRouteCandidates.add(id);
      }
    }

    if (route.fallback !== undefined) {
      if (!Array.isArray(route.fallback)) {
        errors.push(`${prefix}: "fallback" must be an array if present`);
      } else {
        const seenFallback = new Set();
        for (const id of route.fallback) {
          if (typeof id !== 'string' || !id.trim()) {
            errors.push(`${prefix}: fallback id must be non-empty string`);
            continue;
          }
          if (seenFallback.has(id)) {
            errors.push(`${prefix}: DUPLICATE_CANDIDATE in fallback "${id}"`);
          }
          if (allRouteCandidates.has(id)) {
            errors.push(`${prefix}: DUPLICATE_CANDIDATE between primary and fallback "${id}"`);
          }
          seenFallback.add(id);
        }
      }
    }

    if (route.pinVersion !== undefined) {
      if (typeof route.pinVersion !== 'string' || !route.pinVersion.trim()) {
        errors.push(`${prefix}: "pinVersion" must be a non-empty string if present (CONFIG_INVALID)`);
      }
    }
  }
  return errors;
}

/**
 * 创建任务路由器
 * @param {object} config - RouteConfig
 * @returns {{ selectModel, validateConfig, configVersion }}
 */
function createTaskRouter(config) {
  const configErrors = validateRouteConfig(config);
  if (configErrors.length > 0) {
    throw Object.assign(new Error('Route config invalid: ' + configErrors[0]), {
      code: 'CONFIG_INVALID',
      errors: configErrors,
    });
  }

  // R6: 深拷贝防御外部突变
  const frozenConfig = JSON.parse(JSON.stringify(config));
  const boundVersion = frozenConfig.version;

  // Build lookup map: taskType -> RouteEntry
  const routeMap = new Map();
  for (const route of frozenConfig.routes) {
    routeMap.set(route.taskType, route);
  }

  /**
   * 根据配置与资格结果选模型
   * @param {string} taskType
   * @param {Array<{modelId:string, eligible:boolean, reason?:string}>} eligibilityResults
   * @param {{ selection?: {mode:'auto'|'manual', modelId?:string}, dispatchState?: string }} options
   * @returns {{ ok:true, modelId, taskType, mode, source, configVersion, pinVersion? } | { ok:false, code, detail }}
   */
  function selectModel(taskType, eligibilityResults, options = {}) {
    const fail = (code, detail) => ({ ok: false, code, detail: detail || null });

    if (typeof taskType !== 'string' || !taskType.trim()) return fail('CONFIG_INVALID', 'taskType must be non-empty string');
    if (!routeMap.has(taskType)) return fail('TASK_NOT_CONFIGURED', `no route for taskType "${taskType}"`);
    if (!Array.isArray(eligibilityResults)) return fail('CONFIG_INVALID', 'eligibilityResults must be an array');

    const route = routeMap.get(taskType);

    // R3: 校验 dispatchState 枚举
    const dispatchState = options.dispatchState || 'pre-dispatch';
    if (!ALLOWED_DISPATCH_STATES.has(dispatchState)) {
      return fail('CONFIG_INVALID', `invalid dispatchState "${dispatchState}"`);
    }

    // R3: 校验 selection.mode 枚举
    const selection = options.selection || { mode: 'auto' };
    if (!ALLOWED_SELECTION_MODES.has(selection.mode)) {
      return fail('CONFIG_INVALID', `invalid selection.mode "${selection.mode}"`);
    }

    // R1: 检查是否存在未知执行/付费结果
    for (const r of eligibilityResults) {
      if (r && r.reason && UNKNOWN_PAYMENT_PATTERNS.test(r.reason)) {
        return fail('UNKNOWN_PAYMENT_RESULT', `unknown payment or execution result for model "${r.modelId}", halting selection`);
      }
    }

    // R2: 统一状态门禁。已已发送（dispatched）状态下严禁改选或重选模型
    if (dispatchState === 'dispatched') {
      return fail('FALLBACK_AFTER_DISPATCH', 'cannot reselect or change model after dispatch has occurred');
    }

    // 仅收集 eligible === true 且无未知付费风险的模型
    const eligibleSet = new Set();
    for (const r of eligibilityResults) {
      if (r && typeof r.modelId === 'string' && r.eligible === true) {
        eligibleSet.add(r.modelId);
      }
    }

    // Manual override mode
    if (selection.mode === 'manual') {
      if (typeof selection.modelId !== 'string' || !selection.modelId.trim()) {
        return fail('CONFIG_INVALID', 'manual mode requires modelId');
      }
      const allConfigured = [...route.candidates, ...(route.fallback || [])];
      if (!allConfigured.includes(selection.modelId)) {
        return fail('MANUAL_MODEL_NOT_IN_CONFIG', `"${selection.modelId}" not in config for taskType "${taskType}"`);
      }
      if (!eligibleSet.has(selection.modelId)) {
        return fail('MISSING_ELIGIBLE_MODEL', `manual model "${selection.modelId}" not eligible`);
      }
      const res = { ok: true, modelId: selection.modelId, taskType, mode: 'manual', source: 'manual', configVersion: boundVersion };
      if (route.pinVersion) res.pinVersion = route.pinVersion;
      return res;
    }

    // Auto mode: primary candidates
    for (const modelId of route.candidates) {
      if (eligibleSet.has(modelId)) {
        const res = { ok: true, modelId, taskType, mode: 'auto', source: 'primary', configVersion: boundVersion };
        if (route.pinVersion) res.pinVersion = route.pinVersion;
        return res;
      }
    }

    // Fallback: only allowed pre-dispatch
    if (route.fallback && route.fallback.length > 0) {
      for (const modelId of route.fallback) {
        if (eligibleSet.has(modelId)) {
          const res = { ok: true, modelId, taskType, mode: 'auto', source: 'fallback', configVersion: boundVersion };
          if (route.pinVersion) res.pinVersion = route.pinVersion;
          return res;
        }
      }
    }

    return fail('MISSING_ELIGIBLE_MODEL', `no eligible model for taskType "${taskType}"`);
  }

  return {
    selectModel,
    validateConfig: () => validateRouteConfig(frozenConfig),
    configVersion: boundVersion,
  };
}

module.exports = { createTaskRouter, validateRouteConfig };
