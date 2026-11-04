'use strict';

/**
 * shell/candidates/questions-20261103/index.cjs
 * 原生提问和审批交互候选 (Revision 20261104)
 * 基线: f4a3d39e9454a13f37d39ec84d01ae0b625162d0
 *
 * 核心安全门禁与约束：
 * - Q-OPTIONS: approval 具备标准批准/拒绝语义选项 (默认 ['YES', 'NO', 'yes', 'no'])，严禁接受任意未经定义的答案
 * - Q-ID-CONFLICT: 同一 questionId 仅允许同参幂等复用，参数不同严禁覆盖或复用旧 Promise，返回 ID_CONFLICT
 * - Q-DEADLINE: 基于绝对 deadline 时间戳严格检查，即便 timer 回调尚未触发，超时后的答复一律拒绝
 * - Q-OPTIONS-MUTATION: 深拷贝并冻结 options 及 approvalTarget 快照，外部数组篡改不影响内部选项校验
 * - 一次性审批消费与权威注册：支持消费原子化与签发状态核查，杜绝未发审批与重放
 */

const crypto = require('crypto');

const SENSITIVE_PATTERNS = /password\s*=|token\s*=|secret\s*=|api[_-]?key\s*=|BEGIN\s+PRIVATE/i;
const MAX_TIMEOUT_MS = 300_000;
const MAX_QUESTION_LEN = 2000;
const DEFAULT_APPROVAL_OPTIONS = ['YES', 'NO', 'yes', 'no'];

function sha256(str) {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

/**
 * 计算提问参数签名，用于判断是否为同参幂等调用
 */
function computeQuestionSignature({ type, question, options, approvalTarget }) {
  const payloadStr = approvalTarget && approvalTarget.operationPayload
    ? JSON.stringify(approvalTarget.operationPayload)
    : '';
  const optsStr = Array.isArray(options) ? options.join('|') : '';
  return sha256(`${type}::${question}::${optsStr}::${payloadStr}`);
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

  // Map<questionId, { resolve, reject, meta, timer, deadline, consumed, signature, approvedToken }>
  const pending = new Map();
  // 已签发的合法批准记账表：Map<questionId, ApprovedRecord>
  const issuedApprovals = new Map();

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

    // Q-OPTIONS / Q-OPTIONS-MUTATION: 确立有效选项列表并深度冻结快照
    let effectiveOptions = null;
    if (Array.isArray(options)) {
      effectiveOptions = Object.freeze([...options]);
    } else if (type === 'approval') {
      // 审批默认具备标准批准/拒绝语义选项
      effectiveOptions = Object.freeze([...DEFAULT_APPROVAL_OPTIONS]);
    }

    const safeApprovalTarget = approvalTarget ? Object.freeze(JSON.parse(JSON.stringify(approvalTarget))) : null;

    const signature = computeQuestionSignature({
      type,
      question,
      options: effectiveOptions,
      approvalTarget: safeApprovalTarget,
    });

    // Q-ID-CONFLICT: 检查是否重复使用同一 questionId
    if (pending.has(questionId)) {
      const existing = pending.get(questionId);
      if (existing.signature !== signature) {
        return Promise.reject(Object.assign(new Error(`questionId "${questionId}" is already registered with different parameters`), {
          code: 'ID_CONFLICT',
          questionId,
        }));
      }
      if (!existing.consumed) {
        return existing.promise;
      }
      return Promise.reject(Object.assign(new Error('questionId already answered'), { code: 'ALREADY_ANSWERED' }));
    }

    let resolveExternal, rejectExternal;
    const promise = new Promise((res, rej) => { resolveExternal = res; rejectExternal = rej; });

    const approvalPayloadHash = safeApprovalTarget
      ? sha256(typeof safeApprovalTarget.operationPayload?.script === 'string'
          ? safeApprovalTarget.operationPayload.script
          : JSON.stringify(safeApprovalTarget.operationPayload ?? null))
      : null;

    const createdAt = Date.now();
    const deadline = createdAt + timeoutMs;

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
      deadline,
      consumed: false,
      signature,
      meta: {
        runId,
        tenantId,
        userId,
        type,
        question,
        options: effectiveOptions,
        approvalTarget: safeApprovalTarget,
        approvalPayloadHash,
      },
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

    // 若已经标记消费（例如 timer 触发已结束），返回 ALREADY_ANSWERED
    if (entry.consumed) {
      return { ok: false, code: 'ALREADY_ANSWERED' };
    }

    // Q-DEADLINE: 基于绝对时间戳检查，若已过截止时间，立即标记超时
    if (Date.now() >= entry.deadline) {
      clearTimeout(entry.timer);
      entry.consumed = true;
      entry.reject(Object.assign(new Error('Question timed out'), { code: 'QUESTION_TIMEOUT', questionId }));
      return { ok: false, code: 'QUESTION_TIMEOUT', detail: 'Answer submitted after deadline' };
    }

    // 权限检查
    if (entry.meta.tenantId !== respondentTenantId) {
      return { ok: false, code: 'UNAUTHORIZED_RESPONDENT', detail: 'tenantId mismatch' };
    }
    if (entry.meta.userId !== respondentUserId && entry.meta.type !== 'clarification') {
      return { ok: false, code: 'UNAUTHORIZED_RESPONDENT', detail: 'userId mismatch for approval' };
    }

    // 选项验证 (Q-OPTIONS)
    if (Array.isArray(entry.meta.options)) {
      if (!entry.meta.options.includes(answer)) {
        return { ok: false, code: 'INVALID_ANSWER', detail: `answer must be one of: ${entry.meta.options.join(', ')}` };
      }
    }

    clearTimeout(entry.timer);
    entry.consumed = true;

    // 若为审批且答复确认，登记可信批准记录
    let approvalToken = null;
    if (entry.meta.type === 'approval') {
      const isApproved = (typeof answer === 'string' && ['yes', 'true', 'approved', 'allow'].includes(answer.toLowerCase())) ||
                         (entry.meta.options && entry.meta.options[0] === answer);
      if (isApproved && entry.meta.approvalTarget) {
        approvalToken = {
          questionId,
          operationType: entry.meta.approvalTarget.operationType,
          operationPayloadHash: entry.meta.approvalPayloadHash,
          runId,
          tenantId,
          approvedAt: Date.now(),
        };
        issuedApprovals.set(questionId, {
          token: approvalToken,
          consumed: false,
        });
      }
    }

    const result = {
      questionId,
      answer,
      answeredAt: Date.now(),
      respondentUserId,
      consumed: true,
      approvalToken,
    };
    entry.resolve(result);
    return { ok: true, ...result };
  }

  /**
   * 原子核查并消费一个已签发的审批 Token（供 isolation 等执行包调用）
   */
  function verifyAndConsumeApproval(token) {
    if (!token || typeof token !== 'object') {
      return { ok: false, code: 'APPROVAL_REQUIRED', detail: 'Missing approval token' };
    }
    const { questionId, operationType, operationPayloadHash } = token;
    if (!questionId || !issuedApprovals.has(questionId)) {
      return { ok: false, code: 'APPROVAL_REQUIRED', detail: 'Approval token was never issued by authority' };
    }
    const record = issuedApprovals.get(questionId);
    if (record.consumed) {
      return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED', detail: 'Approval token has already been consumed' };
    }
    if (record.token.operationType !== operationType) {
      return { ok: false, code: 'APPROVAL_TYPE_MISMATCH', detail: 'Operation type does not match approval' };
    }
    if (record.token.operationPayloadHash !== operationPayloadHash) {
      return { ok: false, code: 'APPROVAL_PAYLOAD_MISMATCH', detail: 'Operation payload hash mismatch' };
    }
    // 原子标记消费
    record.consumed = true;
    return { ok: true, token: record.token };
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

  return {
    askQuestion,
    submitAnswer,
    verifyAndConsumeApproval,
    cancelPendingQuestions,
    getPendingQuestions,
  };
}

module.exports = { createQuestionManager, sha256 };
