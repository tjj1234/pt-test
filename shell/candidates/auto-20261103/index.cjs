'use strict';

/**
 * shell/candidates/auto-20261103/index.cjs
 * 配置化任务模型路由候选
 * 基线: f4a3d39e9454a13f37d39ec84d01ae0b625162d0
 *
 * 约束：
 * - 只接收 eligibilityResults，不自行执行 capabilities/permission 检查
 * - 配置不能授予权限
 * - 后备仅限 pre-dispatch 阶段
 * - 未知付费结果绝不切模型重提
 * - 相同输入必须相同输出（稳定性）
 */

const ALLOWED_TASK_TYPES = ['textChat', 'imageUnderstanding', 'audioUnderstanding', 'videoUnderstanding', 'codeExecution'];
const PAYMENT_ERROR_PATTERNS = /PAYMENT|BILLING|CHARGE|CREDIT|QUOTA_EXHAUSTED/i;

// ---- 验证 ----------------------------------------------------------------

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
    if (!Array.isArray(route.candidates) || route.candidates.length === 0) {
      errors.push(`${prefix}: "candidates" must be a non-empty array`);
    } else {
      const seen = new Set();
      for (const id of route.candidates) {
        if (typeof id !== 'string' || !id.trim()) { errors.push(`${prefix}: candidate id must be non-empty string`); continue; }
        if (seen.has(id)) errors.push(`${prefix}: DUPLICATE_CANDIDATE "${id}"`);
        seen.add(id);
      }
    }
    if (route.fallback !== undefined) {
      if (!Array.isArray(route.fallback)) {
        errors.push(`${prefix}: "fallback" must be an array if present`);
      } else {
        for (const id of route.fallback) {
          if (typeof id !== 'string' || !id.trim()) errors.push(`${prefix}: fallback id must be non-empty string`);
        }
      }
    }
    if (route.pinVersion !== undefined && typeof route.pinVersion !== 'string') {
      errors.push(`${prefix}: "pinVersion" must be a string if present`);
    }
  }
  return errors;
}

// ---- 선택기 ----------------------------------------------------------------

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

  // Build lookup map: taskType -> RouteEntry
  const routeMap = new Map();
  for (const route of config.routes) {
    routeMap.set(route.taskType, route);
  }

  /**
   * 根据配置与资格结果选模型
   * @param {string} taskType
   * @param {Array<{modelId:string, eligible:boolean, reason?:string}>} eligibilityResults
   * @param {{ selection?: {mode:'auto'|'manual', modelId?:string}, dispatchState?: string }} options
   * @returns {{ ok:true, modelId, taskType, mode, source, configVersion } | { ok:false, code, detail }}
   */
  function selectModel(taskType, eligibilityResults, options = {}) {
    const fail = (code, detail) => ({ ok: false, code, detail: detail || null });

    if (typeof taskType !== 'string' || !taskType.trim()) return fail('CONFIG_INVALID', 'taskType must be non-empty string');
    if (!routeMap.has(taskType)) return fail('TASK_NOT_CONFIGURED', `no route for taskType "${taskType}"`);
    if (!Array.isArray(eligibilityResults)) return fail('CONFIG_INVALID', 'eligibilityResults must be an array');

    const route = routeMap.get(taskType);
    const selection = options.selection || { mode: 'auto' };
    const dispatchState = options.dispatchState || 'pre-dispatch';

    // Build eligible set from eligibilityResults (not from config - config cannot grant permission)
    const eligibleSet = new Set();
    for (const r of eligibilityResults) {
      if (r && typeof r.modelId === 'string' && r.eligible === true) {
        // Check for unknown payment result - never switch model on payment issues
        if (r.reason && PAYMENT_ERROR_PATTERNS.test(r.reason)) continue;
        eligibleSet.add(r.modelId);
      }
    }

    // Manual override mode
    if (selection.mode === 'manual') {
      if (typeof selection.modelId !== 'string' || !selection.modelId.trim()) {
        return fail('CONFIG_INVALID', 'manual mode requires modelId');
      }
      // Model must be in config candidates (or fallback)
      const allConfigured = [...route.candidates, ...(route.fallback || [])];
      if (!allConfigured.includes(selection.modelId)) {
        return fail('MANUAL_MODEL_NOT_IN_CONFIG', `"${selection.modelId}" not in config for taskType "${taskType}"`);
      }
      if (!eligibleSet.has(selection.modelId)) {
        return fail('MISSING_ELIGIBLE_MODEL', `manual model "${selection.modelId}" not eligible`);
      }
      return { ok: true, modelId: selection.modelId, taskType, mode: 'manual', source: 'manual', configVersion: config.version };
    }

    // Auto mode: try primary candidates in order (stable, deterministic)
    for (const modelId of route.candidates) {
      if (eligibleSet.has(modelId)) {
        return { ok: true, modelId, taskType, mode: 'auto', source: 'primary', configVersion: config.version };
      }
    }

    // Fallback: only allowed pre-dispatch
    if (route.fallback && route.fallback.length > 0) {
      if (dispatchState === 'dispatched') {
        return fail('FALLBACK_AFTER_DISPATCH', 'cannot switch to fallback after dispatch');
      }
      for (const modelId of route.fallback) {
        if (eligibleSet.has(modelId)) {
          return { ok: true, modelId, taskType, mode: 'auto', source: 'fallback', configVersion: config.version };
        }
      }
    }

    return fail('MISSING_ELIGIBLE_MODEL', `no eligible model for taskType "${taskType}"`);
  }

  return {
    selectModel,
    validateConfig: () => validateRouteConfig(config),
    configVersion: config.version,
  };
}

module.exports = { createTaskRouter, validateRouteConfig };
