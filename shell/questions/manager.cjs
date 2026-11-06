'use strict';

/**
 * shell/candidates/questions-20261103/index.cjs
 * 原生提问和审批交互候选 (M1 Revision 3: 2026-11-05)
 * 基线: fb250a9329d5be0a36b5c000a463f644c7a61949
 *
 * M1 核心原则与安全门禁 (遵循 20261105 M1-R2 统一复审清单)：
 * 1. 取消与落盘原子顺序 (F12, F17, F19)：
 *    - 权威 Run 取消状态必须持久化；落盘前/中/后取消，或延迟 savePending 均受 Run 状态强门禁约束；
 *    - 取消生效后绝对不可新建可答 pending，新管理器重开亦受持久取消约束。
 * 2. 持久终态重开与幂等 (F07, F20, F21)：
 *    - 相同 Run 重开同 ID 同参 askQuestion，若已终态 (answered) 立即返回既有答复；
 *    - 若已 cancelled/expired 立即稳定拒绝；若处于 pending 严格复用原 deadline，不重新等待或续期。
 * 3. 严格 Schema 与单选/多选约束 (F05, F18)：
 *    - multiSelect: false 严禁接受多个选项；非空选项唯一性核验；
 *    - detail/header/options/multiSelect 严禁强制隐式类型转换，非法类型与越界长度直接报错。
 * 4. 权威仓储原子 CAS 门禁 (F17, F19)：
 *    - 条件更新时在存储底层原子校验 status=pending、tenantId、userId、deadline > now 以及 Run 未取消；
 *    - 杜绝慢仓储跨 deadline、并发竞争或取消穿透；错误细节不回显原始存储异常。
 * 5. 审批执行接缝完全关闭 (F06, F15, F16)：
 *    - approval 提问直接返回 APPROVAL_SEAM_PENDING_SPEC，绝不签发 Token。
 */

const crypto = require('node:crypto');

const SENSITIVE_PATTERNS = /password\s*=|token\s*=|secret\s*=|api[_-]?key\s*=|BEGIN\s+PRIVATE/i;
const MAX_TIMEOUT_MS = 300_000;
const MAX_QUESTION_LEN = 2000;
const MAX_DETAIL_LEN = 2000;
const MAX_HEADER_LEN = 100;
const MAX_OPTIONS_COUNT = 20;
const MAX_OPTION_LEN = 200;

function sha256(str) {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

function deepCloneAndFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    const arr = obj.map(item => deepCloneAndFreeze(item));
    return Object.freeze(arr);
  }
  const cloned = {};
  for (const [key, value] of Object.entries(obj)) {
    cloned[key] = deepCloneAndFreeze(value);
  }
  return Object.freeze(cloned);
}

/**
 * RFC 8785 风格规范化 JSON 序列化 (严格拒绝非法类型，禁止隐式类型转换)
 */
function canonicalizeJson(value) {
  if (value === undefined) {
    throw new TypeError('Cannot canonicalize undefined value');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Cannot canonicalize type: ${typeof value}`);
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Non-finite number in canonicalizeJson');
      return String(value);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalizeJson(value[k])).join(',') + '}';
}

/**
 * 完整规范化 Preimage 计算 (严格比对原生类型，不经隐式 String/Boolean 提升)
 */
function computeCanonicalSignature({
  runId,
  tenantId,
  userId,
  callId,
  type,
  question,
  detail,
  header,
  options,
  multiSelect,
  timeoutMs,
  target,
}) {
  const preimage = {
    schemaVersion: '2026-11-04.1',
    auth: {
      tenantId: tenantId,
      userId: userId,
    },
    context: {
      runId: runId,
      callId: callId ? callId : null,
      operationType: type || 'clarification',
    },
    question: {
      question: question,
      detail: detail !== undefined ? detail : null,
      header: header !== undefined ? header : null,
      timeoutMs: timeoutMs,
    },
    payload: {
      options: Array.isArray(options) ? options : [],
      multiSelect: multiSelect,
    },
    target: target ? target : null,
  };
  return sha256(canonicalizeJson(preimage));
}

/**
 * 显式内存权威仓储实现 (包含 Run 持久化状态与全约束 CAS 事务模拟)
 */
function createInMemoryAuthorityStore() {
  const records = new Map();
  const runs = new Map(); // key -> { status: 'active' | 'cancelled', cancelledAt, reason, tenantId, runId }
  let failWrites = false;

  return {
    async isRunCancelled(runId, tenantId) {
      if (!runId) return { cancelled: false };
      const key = tenantId ? `${tenantId}:${runId}` : runId;
      const run = runs.get(key);
      if (run && run.status === 'cancelled') {
        return { cancelled: true, reason: run.reason };
      }
      return { cancelled: false };
    },
    async cancelRun(runId, tenantIdOrReason, reasonOrUndefined) {
      if (failWrites) throw new Error('Database cancel failed');
      let tenantId = null;
      let reason = 'Run cancelled';
      if (typeof reasonOrUndefined === 'string') {
        tenantId = tenantIdOrReason;
        reason = reasonOrUndefined;
      } else if (typeof tenantIdOrReason === 'string') {
        reason = tenantIdOrReason;
      }

      const key = tenantId ? `${tenantId}:${runId}` : runId;
      runs.set(key, { status: 'cancelled', cancelledAt: Date.now(), reason, tenantId, runId });

      for (const [id, r] of records.entries()) {
        const matchTenant = tenantId ? r.tenantId === tenantId : true;
        if (r.runId === runId && matchTenant && r.status === 'pending') {
          r.status = 'cancelled';
          r.cancelReason = reason;
          r.cancelledAt = Date.now();
        }
      }
    },
    async get(id) {
      const rec = records.get(id);
      return rec ? JSON.parse(JSON.stringify(rec)) : null;
    },
    async savePending(record) {
      if (failWrites) throw new Error('Database write failed');

      // 原子门禁 1：检查所属 Run 是否已被权威取消！
      const key = record.tenantId ? `${record.tenantId}:${record.runId}` : record.runId;
      const run = runs.get(key);
      if (run && run.status === 'cancelled') {
        // 如果 Run 已被取消，绝对不可插入 pending 记录！
        const cancelledRecord = {
          ...record,
          status: 'cancelled',
          cancelReason: run.reason,
          cancelledAt: run.cancelledAt,
        };
        records.set(record.id, JSON.parse(JSON.stringify(cancelledRecord)));
        throw Object.assign(new Error(`Run "${record.runId}" is already cancelled`), {
          code: 'QUESTION_CANCELLED',
          runId: record.runId,
        });
      }

      if (records.has(record.id)) {
        const existing = records.get(record.id);
        if (existing.signature !== record.signature) {
          throw Object.assign(new Error(`[ID_CONFLICT] questionId "${record.id}" already exists with different parameters`), {
            code: 'ID_CONFLICT',
            questionId: record.id,
          });
        }
        return JSON.parse(JSON.stringify(existing));
      }

      records.set(record.id, JSON.parse(JSON.stringify(record)));
      return JSON.parse(JSON.stringify(record));
    },
    async updateStatusIfPending(id, nextStatus, updates = {}, constraints = {}) {
      if (failWrites) throw new Error('Database update failed');
      const existing = records.get(id);
      if (!existing) return { ok: false, code: 'QUESTION_NOT_FOUND' };

      // 存储级原子约束核验 (CAS)
      if (existing.status !== 'pending') {
        return { ok: false, code: 'ALREADY_FINALIZED', currentStatus: existing.status };
      }
      if (constraints.tenantId && existing.tenantId !== constraints.tenantId) {
        return { ok: false, code: 'UNAUTHORIZED_SCOPE', detail: 'Tenant mismatch' };
      }
      if (constraints.runId && existing.runId !== constraints.runId) {
        return { ok: false, code: 'UNAUTHORIZED_SCOPE', detail: 'Run mismatch' };
      }
      if (constraints.userId && existing.userId !== constraints.userId) {
        return { ok: false, code: 'UNAUTHORIZED_RESPONDENT', detail: 'User mismatch' };
      }

      const runKey = existing.tenantId ? `${existing.tenantId}:${existing.runId}` : existing.runId;
      const run = runs.get(runKey);
      if (run && run.status === 'cancelled') {
        return { ok: false, code: 'QUESTION_CANCELLED', detail: 'Run was cancelled' };
      }

      // 事务锁内权威物理时间判定 (支持测试注入或权威时钟)
      const lockTime = typeof constraints.getAuthoritativeNow === 'function'
        ? constraints.getAuthoritativeNow()
        : Date.now();

      if (nextStatus === 'answered') {
        if (lockTime >= existing.deadline) {
          existing.status = 'expired';
          existing.expiredAt = lockTime;
          existing.updatedAt = lockTime;
          return { ok: false, code: 'QUESTION_TIMEOUT', detail: 'Deadline expired prior to lock acquisition' };
        }
      } else if (nextStatus === 'expired') {
        if (lockTime < existing.deadline) {
          return { ok: false, code: 'NOT_YET_EXPIRED', detail: 'Deadline has not yet been reached' };
        }
      }

      const updated = {
        ...existing,
        ...updates,
        status: nextStatus,
        updatedAt: lockTime,
      };
      records.set(id, updated);
      return { ok: true, record: JSON.parse(JSON.stringify(updated)) };
    },
    __setFailWrites(fail) {
      failWrites = fail;
    },
  };
}

/**
 * 校验提问输入 Schema (严格类型与边界核验)
 */
function validateQuestionInput({ questionId, type, question, detail, header, options, multiSelect, timeoutMs, callId }) {
  if (typeof questionId !== 'string' || !questionId.trim()) {
    throw Object.assign(new Error('questionId required'), { code: 'CONFIG_INVALID' });
  }
  if (typeof question !== 'string' || question.length === 0) {
    throw Object.assign(new Error('question text required'), { code: 'CONFIG_INVALID' });
  }
  if (question.length > MAX_QUESTION_LEN) {
    throw Object.assign(new Error('question text too long'), { code: 'CONFIG_INVALID' });
  }
  if (SENSITIVE_PATTERNS.test(question)) {
    throw Object.assign(new Error('question contains sensitive content'), { code: 'SENSITIVE_CONTENT' });
  }
  if (!['clarification', 'approval'].includes(type)) {
    throw Object.assign(new Error('type must be clarification or approval'), { code: 'CONFIG_INVALID' });
  }

  // 严格核验 detail 类型与长度
  if (detail !== undefined && detail !== null) {
    if (typeof detail !== 'string' || detail.length > MAX_DETAIL_LEN) {
      throw Object.assign(new Error('detail must be a string within length limit'), { code: 'CONFIG_INVALID' });
    }
  }

  // 严格核验 header 类型与长度
  if (header !== undefined && header !== null) {
    if (typeof header !== 'string' || header.length > MAX_HEADER_LEN) {
      throw Object.assign(new Error('header must be a string within length limit'), { code: 'CONFIG_INVALID' });
    }
  }

  // 严格核验 multiSelect 类型 (严禁隐式类型提升)
  if (multiSelect !== undefined && multiSelect !== null) {
    if (typeof multiSelect !== 'boolean') {
      throw Object.assign(new Error('multiSelect must be a boolean'), { code: 'CONFIG_INVALID' });
    }
  }

  // 严格核验 timeoutMs 类型与范围
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw Object.assign(new Error(`timeoutMs must be an integer 0 < x <= ${MAX_TIMEOUT_MS}`), { code: 'CONFIG_INVALID' });
  }

  // 严格核验 callId 类型
  if (callId !== undefined && callId !== null) {
    if (typeof callId !== 'string') {
      throw Object.assign(new Error('callId must be a string'), { code: 'CONFIG_INVALID' });
    }
  }

  // 严格核验 options 数组内容与唯一性
  let sanitizedOptions = null;
  if (options !== undefined && options !== null) {
    if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS_COUNT) {
      throw Object.assign(new Error(`options must be an array of length 1..${MAX_OPTIONS_COUNT}`), { code: 'CONFIG_INVALID' });
    }
    const seen = new Set();
    sanitizedOptions = [];
    for (const opt of options) {
      let label = '';
      if (typeof opt === 'string') {
        label = opt;
      } else if (opt && typeof opt === 'object' && typeof opt.label === 'string') {
        label = opt.label;
      } else {
        throw Object.assign(new Error('option must be a string or { label: string }'), { code: 'CONFIG_INVALID' });
      }
      if (!label || label.length > MAX_OPTION_LEN) {
        throw Object.assign(new Error('option label invalid or exceeds length'), { code: 'CONFIG_INVALID' });
      }
      if (seen.has(label)) {
        throw Object.assign(new Error(`duplicate option label: "${label}"`), { code: 'CONFIG_INVALID' });
      }
      seen.add(label);
      sanitizedOptions.push(label);
    }
  }

  return {
    sanitizedOptions: sanitizedOptions ? deepCloneAndFreeze(sanitizedOptions) : null,
  };
}

/**
 * 创建提问管理器与原生 Provider 宿主适配器
 */
function createQuestionManager({ runId, tenantId, userId, store } = {}) {
  if (typeof runId !== 'string' || !runId.trim() ||
      typeof tenantId !== 'string' || !tenantId.trim() ||
      typeof userId !== 'string' || !userId.trim()) {
    throw Object.assign(new Error('runId, tenantId, userId must be non-empty strings'), { code: 'CONFIG_INVALID' });
  }
  if (!store || typeof store.savePending !== 'function' || typeof store.get !== 'function') {
    throw Object.assign(new Error('Authority store is required; in-memory fallback is disabled in production'), {
      code: 'STORE_REQUIRED',
    });
  }

  const authorityStore = store;
  const activePending = new Map();

  let cancelled = false;
  let cancelReason = null;

  /**
   * 发起提问 (同步返回 Promise，具备 Preimage 幂等、持久终态秒回与原子落盘)
   */
  function askQuestion(questionId, {
    type = 'clarification',
    question,
    detail = null,
    header = null,
    callId = null,
    options,
    approvalTarget,
    timeoutMs = 30000,
    multiSelect = false,
  } = {}) {
    // 1. 内存态与存储级 Run 取消强门禁
    if (cancelled) {
      return Promise.reject(Object.assign(new Error('Run is cancelled'), { code: 'QUESTION_CANCELLED', reason: cancelReason }));
    }

    // 2. 严格 Schema 校验
    let sanitizedOptions;
    try {
      const validated = validateQuestionInput({
        questionId,
        type,
        question,
        detail,
        header,
        options,
        multiSelect,
        timeoutMs,
        callId,
      });
      sanitizedOptions = validated.sanitizedOptions;
    } catch (err) {
      return Promise.reject(err);
    }

    if (type === 'approval') {
      return Promise.reject(Object.assign(new Error('Approval execution seam is pending specification review and closed in M1 slice'), {
        code: 'APPROVAL_SEAM_PENDING_SPEC',
      }));
    }

    const safeTarget = approvalTarget ? deepCloneAndFreeze(approvalTarget) : null;

    // 3. 完备规范化 Preimage 签名计算 (不含隐式提升)
    const signature = computeCanonicalSignature({
      runId,
      tenantId,
      userId,
      callId: callId || null,
      type,
      question,
      detail: detail || null,
      header: header || null,
      options: sanitizedOptions,
      multiSelect: Boolean(multiSelect),
      timeoutMs,
      target: safeTarget,
    });

    // 4. 同一实例活跃待决池检查 (同参幂等返回相同 Promise 引用，异参冲突返回 ID_CONFLICT)
    if (activePending.has(questionId)) {
      const active = activePending.get(questionId);
      if (active.signature !== signature) {
        return Promise.reject(Object.assign(new Error(`[ID_CONFLICT] questionId "${questionId}" is already registered with different parameters`), {
          code: 'ID_CONFLICT',
          questionId,
        }));
      }
      return active.promise;
    }

    // 5. 创建待决 Promise 并同步注册到 activePending
    let resolveExternal, rejectExternal;
    const promise = new Promise((res, rej) => {
      resolveExternal = res;
      rejectExternal = rej;
    });

    const now = Date.now();
    const deadline = now + timeoutMs;
    const record = {
      id: questionId,
      runId,
      tenantId,
      userId,
      callId: callId || null,
      type,
      question,
      detail: detail || null,
      header: header || null,
      options: sanitizedOptions,
      approvalTarget: safeTarget,
      multiSelect: Boolean(multiSelect),
      timeoutMs,
      createdAt: now,
      deadline,
      signature,
      status: 'pending',
    };

    // Production waiters follow the persisted authority, including writes made
    // by another worker. A local timer never invents a terminal state.
    let timer = null, poll = null, finished = false, cycling = false;
    const clearTimer = () => { clearTimeout(timer); clearTimeout(poll); timer = poll = null; };
    const finish = (value, error) => {
      if (finished) return;
      finished = true; clearTimer();
      if (activePending.get(questionId) === pendingEntry) activePending.delete(questionId);
      if (error) rejectExternal(error); else resolveExternal(value);
    };
    const settle = stored => {
      if (!stored || stored.status === 'pending') return false;
      if (stored.status === 'answered') finish(deepCloneAndFreeze({questionId,answer:stored.answer,status:'answered',answeredAt:stored.answeredAt,respondentUserId:stored.respondentUserId,consumed:true,approvalToken:null}));
      else finish(null,Object.assign(new Error(stored.status === 'expired' ? 'Question timed out' : 'Question cancelled'),{code:stored.status === 'expired' ? 'QUESTION_TIMEOUT' : 'QUESTION_CANCELLED',questionId}));
      return true;
    };
    const storageError = () => Object.assign(new Error('Question authority is unavailable'),{code:'STORE_UNAVAILABLE',questionId});
    const schedule = () => {
      if (finished) return;
      clearTimer();
      timer=setTimeout(reconcile,Math.max(1,pendingEntry.deadline-Date.now()));
      if (Number.isSafeInteger(authorityStore.pollIntervalMs) && authorityStore.pollIntervalMs >= 1) poll=setTimeout(reconcile,Math.min(authorityStore.pollIntervalMs,1000));
    };
    async function reconcile() {
      if (finished || cycling) return;
      cycling=true; clearTimer();
      try {
        let stored=await authorityStore.get(questionId);
        if (!stored) throw storageError();
        if (!settle(stored) && Date.now() >= stored.deadline) {
          const changed=await authorityStore.updateStatusIfPending(questionId,'expired',{}, {runId,tenantId,userId});
          stored=changed.record || await authorityStore.get(questionId);
          if (!stored) throw storageError();
          settle(stored);
        }
        if (!finished) { pendingEntry.deadline=stored.deadline; schedule(); }
      } catch { finish(null,storageError()); }
      finally { cycling=false; }
    }
    const persistPromise=Promise.resolve().then(async()=>{
      if (typeof authorityStore.isRunCancelled === 'function') {
        const check=await authorityStore.isRunCancelled(runId,tenantId);
        if (check?.cancelled) throw Object.assign(new Error('Run is cancelled'),{code:'QUESTION_CANCELLED'});
      }
      return authorityStore.savePending(record);
    });
    const pendingEntry={promise,persistPromise,resolve:value=>finish(value),reject:error=>finish(null,error),clearTimer,deadline,signature,meta:record,settle};
    activePending.set(questionId,pendingEntry);
    persistPromise.then(stored=>{
      if (finished) return;
      if (!stored || stored.signature !== signature) {
        finish(null,Object.assign(new Error('Persisted question conflicts with request'),{code:stored?'ID_CONFLICT':'STORE_UNAVAILABLE',questionId}));return;
      }
      pendingEntry.meta=stored;pendingEntry.deadline=stored.deadline;
      if (!settle(stored)) schedule();
    }).catch(error=>finish(null,['QUESTION_CANCELLED','ID_CONFLICT'].includes(error?.code)?error:storageError()));

    return promise;
  }

  /**
   * 提交答复 (包含单选/多选严格约束与仓储原子 CAS)
   */
  async function submitAnswer(questionId, answer, { respondentUserId, respondentTenantId } = {}) {
    if (cancelled) {
      return { ok: false, code: 'QUESTION_CANCELLED', detail: 'Run is cancelled' };
    }

    // 答复身份强门禁 (F10)
    if (typeof respondentTenantId !== 'string' || !respondentTenantId.trim() ||
        typeof respondentUserId !== 'string' || !respondentUserId.trim()) {
      return {
        ok: false,
        code: 'IDENTITY_REQUIRED',
        detail: 'Authenticated respondentTenantId and respondentUserId are required',
      };
    }

    // 若当前实例有未决的初始落盘，等待其完成以确保权威落盘一致性
    if (activePending.has(questionId)) {
      try {
        await activePending.get(questionId).persistPromise;
      } catch (err) {
        if (err && (err.code === 'QUESTION_CANCELLED' || err.message?.includes('cancelled'))) {
          return { ok: false, code: 'QUESTION_CANCELLED', detail: 'Run or question was cancelled' };
        }
        return { ok: false, code: 'STORE_UNAVAILABLE', detail: `Storage failure: ${err.message}` };
      }
    }

    // 仅从权威仓储读取
    const stored = await authorityStore.get(questionId);
    if (!stored) {
      return { ok: false, code: 'QUESTION_NOT_FOUND', detail: 'Question not found in authority store' };
    }

    // 管理器 Run 范围与租户核验 (杜绝跨 Run 窜答)
    if (stored.runId !== runId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_SCOPE',
        detail: `Question belongs to run "${stored.runId}", not active manager run "${runId}"`,
      };
    }
    if (stored.tenantId !== tenantId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_SCOPE',
        detail: 'Question belongs to another tenant',
      };
    }
    if (stored.userId !== userId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_SCOPE',
        detail: `Question belongs to user "${stored.userId}", not active manager user "${userId}"`,
      };
    }

    // 答复者身份核验 (与问题目标租户和用户一致)
    if (stored.tenantId !== respondentTenantId || stored.userId !== respondentUserId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_RESPONDENT',
        detail: 'Respondent identity does not match authorized recipient',
      };
    }

    if (stored.status !== 'pending') {
      if (stored.status === 'cancelled') {
        return { ok: false, code: 'QUESTION_CANCELLED', detail: 'Question was cancelled' };
      }
      if (stored.status === 'expired') {
        return { ok: false, code: 'QUESTION_TIMEOUT', detail: 'Question timed out' };
      }
      return { ok: false, code: 'ALREADY_FINALIZED', detail: `Question is already finalized with status: ${stored.status}` };
    }

    // 答案规范化与单多选约束
    if (answer === null || answer === undefined) {
      return { ok: false, code: 'INVALID_ANSWER', detail: 'Answer cannot be null or undefined' };
    }

    let selectedOptions = [];
    let customText = undefined;

    if (typeof answer === 'string') {
      selectedOptions = [answer];
    } else if (answer && typeof answer === 'object') {
      if (answer.selected !== undefined) {
        if (!Array.isArray(answer.selected)) {
          return { ok: false, code: 'INVALID_ANSWER', detail: 'selected must be an array' };
        }
        for (const s of answer.selected) {
          if (typeof s !== 'string') {
            return { ok: false, code: 'INVALID_ANSWER', detail: 'selected options must be strings' };
          }
          selectedOptions.push(s);
        }
      }
      if (answer.custom !== undefined) {
        if (typeof answer.custom !== 'string' || answer.custom.length > MAX_DETAIL_LEN) {
          return { ok: false, code: 'INVALID_ANSWER', detail: 'custom answer must be a string within limit' };
        }
        customText = answer.custom;
      }
    } else {
      return { ok: false, code: 'INVALID_ANSWER', detail: 'Invalid answer structure' };
    }

    // 单选/多选约束核心门禁
    const isMulti = Boolean(stored.multiSelect);
    if (!isMulti && selectedOptions.length > 1) {
      return {
        ok: false,
        code: 'INVALID_ANSWER',
        detail: `Multiple options (${selectedOptions.length}) selected for single-select question`,
      };
    }

    if (Array.isArray(stored.options) && stored.options.length > 0) {
      // 必须在允许的选项列表中
      for (const sel of selectedOptions) {
        if (!stored.options.includes(sel)) {
          return {
            ok: false,
            code: 'INVALID_ANSWER',
            detail: `Selected option "${sel}" is not in allowed options: ${stored.options.join(', ')}`,
          };
        }
      }
      // 单选且无有效选项和自定义文本时拒绝空提交
      if (!isMulti && selectedOptions.length === 0 && (customText === undefined || customText === '')) {
        return { ok: false, code: 'INVALID_ANSWER', detail: 'Single-select question requires an answer' };
      }
    }

    // 权威仓储原子 CAS 状态更新 (绑定全部门禁条件与事务锁内物理时间判定)
    const updateRes = await authorityStore.updateStatusIfPending(questionId, 'answered', {
      answer: deepCloneAndFreeze(answer),
      selectedOptions: deepCloneAndFreeze(selectedOptions),
      customText,
      answeredAt: Date.now(),
      respondentUserId,
      respondentTenantId,
    }, {
      runId,
      tenantId: respondentTenantId,
      userId: respondentUserId,
      now: Date.now(),
    });

    if (!updateRes.ok) {
      if (updateRes.code === 'QUESTION_TIMEOUT') {
        if (activePending.has(questionId)) {
          const entry = activePending.get(questionId);
          if (entry.clearTimer) entry.clearTimer();
          activePending.delete(questionId);
          entry.reject(Object.assign(new Error('Question timed out'), { code: 'QUESTION_TIMEOUT', questionId }));
        }
      }
      return {
        ok: false,
        code: updateRes.code || 'ALREADY_FINALIZED',
        detail: updateRes.detail || 'Atomic CAS update failed constraint check',
      };
    }

    // 唤醒内存挂起的 Promise
    if (activePending.has(questionId)) {
      const entry = activePending.get(questionId);
      if (entry.clearTimer) entry.clearTimer();
      activePending.delete(questionId);

      entry.resolve(deepCloneAndFreeze({
        questionId,
        answer,
        status: 'answered',
        answeredAt: updateRes.record?.answeredAt || Date.now(),
        respondentUserId,
        consumed: true,
        approvalToken: null,
      }));
    }

    return {
      ok: true,
      questionId,
      status: 'answered',
      answer: deepCloneAndFreeze(answer),
      approvalToken: null,
    };
  }

  async function verifyApprovalToken() {
    return {
      ok: false,
      code: 'APPROVAL_SEAM_CLOSED',
      detail: 'Approval execution seam is pending specification review and closed in M1 slice',
    };
  }

  async function cancelRun(reason = 'Run cancelled by user or system') {
    cancelled = true;
    cancelReason = reason;

    let failure;
    try { await authorityStore.cancelRun(runId,tenantId,reason); }
    catch (error) { failure=error; }
    for (const [qid,entry] of [...activePending.entries()]) {
      try {
        if (failure) throw failure;
        const stored=await authorityStore.get(qid);
        if (!entry.settle(stored)) entry.reject(Object.assign(new Error('Question authority is unavailable'),{code:'STORE_UNAVAILABLE'}));
      } catch { entry.reject(Object.assign(new Error('Question authority is unavailable'),{code:'STORE_UNAVAILABLE'})); }
    }
    activePending.clear();
    if (failure) throw failure;
    return {ok:true,cancelled:true};
  }

  const nativeProvider = {
    async ask(request) {
      if (!request || !Array.isArray(request.questions) || request.questions.length === 0) {
        throw new Error('request.questions array is required');
      }

      let onAbort = null;
      if (request.signal) {
        if (request.signal.aborted) {
          throw Object.assign(new Error('Question tool call aborted'), { code: 'QUESTION_CANCELLED' });
        }
        onAbort = () => {
          cancelRun('Aborted by tool call signal').catch(() => {});
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const askPromises = request.questions.map(item => {
          return askQuestion(item.id, {
            type: item.intent?.kind === 'plan-review' ? 'approval' : 'clarification',
            question: item.question,
            detail: item.detail,
            header: item.header,
            options: item.options ? item.options.map(o => (typeof o === 'string' ? o : o.label)) : undefined,
            multiSelect: Boolean(item.multiSelect),
            timeoutMs: 60000,
          }).then(res => {
            return {
              id: item.id,
              selected: Array.isArray(res.answer?.selected)
                ? res.answer.selected
                : (typeof res.answer === 'string' ? [res.answer] : []),
              custom: res.answer?.custom || (typeof res.answer === 'string' && !item.options ? res.answer : undefined),
            };
          });
        });

        const answers = await Promise.all(askPromises);
        return { answers };
      } finally {
        if (request.signal && onAbort) {
          request.signal.removeEventListener('abort', onAbort);
        }
      }
    },
  };

  return {
    askQuestion,
    submitAnswer,
    verifyApprovalToken,
    cancelRun,
    nativeProvider,
    authorityStore,
  };
}

module.exports = {
  validateQuestionInput,
  createQuestionManager,
  computeCanonicalSignature,
  createInMemoryAuthorityStore,
  canonicalizeJson,
  sha256,
};
