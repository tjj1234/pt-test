'use strict';

/**
 * shell/candidates/questions-20261103/index.cjs
 * 原生提问和审批交互候选
 * 基线: f4a3d39e9454a13f37d39ec84d01ae0b625162d0
 *
 * 复用 @deepseek-ai/dsh-user-questions 结构，在宿主层增加:
 * - Run 绑定（runId 权威来源）
 * - tenantId/userId 隔离
 * - 一次消费（已消费不可重复）
 * - 超时后拒绝迟到答案
 * - Run 取消批量 reject
 * - 内容安全检测（凭据关键词）
 * - 审批精确绑定（approvalTarget 快照哈希）
 */

const crypto = require('crypto');

const SENSITIVE_PATTERNS = /password\s*=|token\s*=|secret\s*=|api[_-]?key\s*=|BEGIN\s+PRIVATE/i;
const MAX_TIMEOUT_MS = 300_000;
const MAX_QUESTION_LEN = 2000;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.tenantId
 * @param {string} opts.userId
 */
function createQuestionManager({ runId, tenantId, userId } = {}) {
  if (!runId || !tenantId || !userId) {
    throw Object.assign(new Error('runId, tenantId, userId are required'), { code: 'CONFIG_INVALID' });
  }

  // Map<questionId, { resolve, reject, meta, timer, consumed }>
  const pending = new Map();
  let cancelled = false;
  let cancelReason = null;

  /**
   * 发出提问，返回 Promise（等待回答）
   */
  function askQuestion(questionId, { type, question, options, approvalTarget, timeoutMs } = {}) {
    if (cancelled) {
      return Promise.reject(Object.assign(new Error('Run is cancelled'), { code: 'QUESTION_CANCELLED', reason: cancelReason }));
    }
    if (typeof questionId !== 'string' || !questionId.trim()) {
      return Promise.reject(Object.assign(new Error('questionId required'), { code: 'CONFIG_INVALID' }));
    }
    if (typeof question !== 'string' || question.length === 0) {
      return Promise.reject(Object.assign(new Error('question text required'), { code: 'CONFIG_INVALID' }));
    }
    if (question.length > MAX_QUESTION_LEN) {
      return Promise.reject(Object.assign(new Error('question text too long'), { code: 'CONFIG_INVALID' }));
    }
    // 内容安全：检测凭据关键词
    if (SENSITIVE_PATTERNS.test(question)) {
      return Promise.reject(Object.assign(new Error('question contains sensitive content'), { code: 'SENSITIVE_CONTENT' }));
    }
    if (!['clarification', 'approval'].includes(type)) {
      return Promise.reject(Object.assign(new Error('type must be clarification or approval'), { code: 'CONFIG_INVALID' }));
    }
    if (type === 'approval' && (!approvalTarget || approvalTarget.displayedToUser !== true)) {
      return Promise.reject(Object.assign(new Error('approval requires approvalTarget.displayedToUser=true'), { code: 'CONFIG_INVALID' }));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.reject(Object.assign(new Error(`timeoutMs must be 0 < x <= ${MAX_TIMEOUT_MS}`), { code: 'CONFIG_INVALID' }));
    }

    // 幂等：已有未消费的同 questionId Promise → 返回同一 Promise
    if (pending.has(questionId)) {
      const existing = pending.get(questionId);
      if (!existing.consumed) return existing.promise;
      // 已消费的 questionId 不可重用
      return Promise.reject(Object.assign(new Error('questionId already answered'), { code: 'ALREADY_ANSWERED' }));
    }

    let resolveExternal, rejectExternal;
    const promise = new Promise((res, rej) => { resolveExternal = res; rejectExternal = rej; });

    const approvalPayloadHash = approvalTarget
      ? sha256(JSON.stringify(approvalTarget.operationPayload ?? null))
      : null;

    const timer = setTimeout(() => {
      if (pending.has(questionId) && !pending.get(questionId).consumed) {
        pending.get(questionId).consumed = true;
        rejectExternal(Object.assign(new Error('Question timed out'), { code: 'QUESTION_TIMEOUT', questionId }));
      }
    }, timeoutMs);

    pending.set(questionId, {
      promise,
      resolve: resolveExternal,
      reject: rejectExternal,
      timer,
      consumed: false,
      meta: { runId, tenantId, userId, type, question, options, approvalTarget, approvalPayloadHash },
    });

    return promise;
  }

  /**
   * 提交回答
   */
  function submitAnswer(questionId, answer, { respondentUserId, respondentTenantId } = {}) {
    if (!pending.has(questionId)) {
      return { ok: false, code: 'QUESTION_NOT_FOUND' };
    }
    const entry = pending.get(questionId);
    if (entry.consumed) {
      return { ok: false, code: 'ALREADY_ANSWERED' };
    }
    // 权限检查
    if (entry.meta.tenantId !== respondentTenantId) {
      return { ok: false, code: 'UNAUTHORIZED_RESPONDENT', detail: 'tenantId mismatch' };
    }
    if (entry.meta.userId !== respondentUserId && entry.meta.type !== 'clarification') {
      // clarification 允许同 tenant 任意用户回答；approval 要求同 userId
      return { ok: false, code: 'UNAUTHORIZED_RESPONDENT', detail: 'userId mismatch for approval' };
    }
    // 选项验证
    if (Array.isArray(entry.meta.options) && entry.meta.options.length > 0) {
      if (!entry.meta.options.includes(answer)) {
        return { ok: false, code: 'INVALID_ANSWER', detail: `answer must be one of: ${entry.meta.options.join(', ')}` };
      }
    }
    clearTimeout(entry.timer);
    entry.consumed = true;
    const result = { questionId, answer, answeredAt: Date.now(), respondentUserId, consumed: true };
    entry.resolve(result);
    return { ok: true, ...result };
  }

  /**
   * Run 取消时批量 reject 所有待答提问
   */
  function cancelPendingQuestions(targetRunId, reason = 'RUN_CANCELLED') {
    if (targetRunId !== runId) return { cancelledCount: 0 };
    cancelled = true;
    cancelReason = reason;
    let count = 0;
    for (const [qid, entry] of pending) {
      if (!entry.consumed) {
        clearTimeout(entry.timer);
        entry.consumed = true;
        entry.reject(Object.assign(new Error(reason), { code: 'QUESTION_CANCELLED', questionId: qid, reason }));
        count++;
      }
    }
    return { cancelledCount: count, reason };
  }

  /**
   * 查询待回答提问
   */
  function getPendingQuestions(targetRunId) {
    if (targetRunId !== runId) return [];
    const result = [];
    for (const [qid, entry] of pending) {
      if (!entry.consumed) {
        result.push({ questionId: qid, type: entry.meta.type, question: entry.meta.question });
      }
    }
    return result;
  }

  return { askQuestion, submitAnswer, cancelPendingQuestions, getPendingQuestions };
}

module.exports = { createQuestionManager };
