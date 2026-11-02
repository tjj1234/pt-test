'use strict';

/**
 * 记忆来源、确认与范围策略候选 (Memory Provenance & Scoping Candidate)
 *
 * 核心架构原则：
 * 1. 最小纯数据策略层：normalizeMemoryRecord / selectRecallableMemories / invalidateMemorySources。
 *    无 DB、无 UI、无网络请求，输入不变，纯函数确定性执行。
 * 2. 三类记忆来源严格区分 (Provenance Classification)：
 *    - 'user-explicit-confirmation': 用户显式确认（由宿主鉴权通道触发）
 *    - 'user-verbatim-statement': 用户原话（高信任，默认可信但区分原话）
 *    - 'model-inference': 模型推断（默认 confirmed: false，严禁推断默认变成事实）
 *    - 严禁通过 Prompt/内容文字假造授权；所有确认动作必须来自宿主的可信调用。
 * 3. 严格范围与多租户/用户隔离：
 *    - scope: 'user'（用户全局跨对话）或 'conversation'（单对话专用）。
 *    - 对话级别记忆严禁跨对话泄漏；跨用户、跨租户严禁访问。
 * 4. 来源溯源与生命周期失效 (Provenance & Invalidation)：
 *    - 记录源身份 (source.id, source.kind, source.hash, source.version)。
 *    - 源删除、修订或记忆撤销 (revoked: true) 后，生成确定性 revision 接缝，
 *      供宿主安全取消 Run 及清理热会话（不越权执行 DB 事务或真实取消）。
 * 5. 安全防御与预算硬限：
 *    - 数量硬限 (maxMemories ≤ 100) 与字符硬限 (maxChars ≤ 20,000，默认 4,000)。
 *    - 稳定排序：updatedAt 降序，key 升序。
 *    - 错误信息绝不打印记忆正文内容 (value)，防敏感信息泄漏。
 */

const { createHash } = require('node:crypto');

// 允许的来源枚举
const PROVENANCE_KINDS = Object.freeze([
  'user-explicit-confirmation',
  'user-verbatim-statement',
  'model-inference',
]);

// 允许的范围枚举
const MEMORY_SCOPES = Object.freeze(['user', 'conversation']);

// 允许的源载体类型
const SOURCE_KINDS = Object.freeze(['message', 'document', 'system-import', 'tool-result']);

const LIMITS = Object.freeze({
  MAX_KEY_CHARS: 80,
  MAX_VALUE_CHARS: 2000,
  MAX_RECALL_MEMORIES: 100,
  DEFAULT_RECALL_MEMORIES: 20,
  MAX_RECALL_CHARS: 20000,
  DEFAULT_RECALL_CHARS: 4000,
});

const REGEX = Object.freeze({
  TENANT_ID: /^[a-zA-Z0-9_-]{1,128}$/,
  USER_ID: /^[a-zA-Z0-9_.@-]{1,128}$/,
  CONVERSATION_ID: /^[a-zA-Z0-9_.-]{1,128}$/,
  SHA256_HEX: /^[0-9a-f]{64}$/i,
});

function fail(code, message) {
  // 安全约束：错误信息严禁携带记忆具体内容
  const err = new Error(message || 'Memory provenance operation failed');
  err.code = code;
  return err;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isValidIsoTimestamp(ts) {
  if (typeof ts !== 'string') return false;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) && ts.length >= 19;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

/**
 * 计算记忆记录的修订签名 (Revision Signature)
 */
function computeRevisionSignature(record) {
  const hasher = createHash('sha256');
  hasher.update(`REV:${record.revision}:${record.owner.tenantId}:${record.owner.userId}\n`);
  hasher.update(`SCOPE:${record.scope}:${record.conversationId || 'none'}\n`);
  hasher.update(`KEY:${record.key}:VAL_SHA:${sha256(record.value)}\n`);
  hasher.update(`PROV:${record.provenance.kind}:CONF:${record.confirmed}:REVOKED:${record.revoked}\n`);
  if (record.source) {
    hasher.update(`SRC:${record.source.kind}:${record.source.id}:${record.source.hash}:${record.source.version}\n`);
  }
  return hasher.digest('hex');
}

/**
 * 规范化与门禁校验单条记忆记录 (normalizeMemoryRecord)
 *
 * @param {object} raw - 原始记忆输入
 * @param {object} [options] - 选项与宿主外部授权上下文
 * @param {object} [options.hostAssertion] - 宿主提供的可信确认操作 { confirmedBy: string, confirmedAt: string }
 * @returns {Readonly<object>} 不可变的规范化记忆记录
 */
function normalizeMemoryRecord(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('MEMORY_RECORD_INVALID', 'Memory record must be a non-null object');
  }

  // 1. 所有权校验 (owner)
  const owner = raw.owner;
  if (!owner || typeof owner !== 'object') {
    throw fail('MEMORY_OWNER_INVALID', 'Memory record must contain an owner object');
  }
  if (typeof owner.tenantId !== 'string' || !REGEX.TENANT_ID.test(owner.tenantId.trim())) {
    throw fail('MEMORY_TENANT_INVALID', 'Invalid owner tenantId format');
  }
  if (typeof owner.userId !== 'string' || !REGEX.USER_ID.test(owner.userId.trim())) {
    throw fail('MEMORY_USER_INVALID', 'Invalid owner userId format');
  }

  const tenantId = owner.tenantId.trim();
  const userId = owner.userId.trim();

  // 2. 记忆 Key 校验
  if (typeof raw.key !== 'string') {
    throw fail('MEMORY_KEY_INVALID', 'Memory key must be a string');
  }
  const key = raw.key.trim();
  if (key.length === 0) {
    throw fail('MEMORY_KEY_EMPTY', 'Memory key cannot be empty');
  }
  if (key.startsWith('$')) {
    throw fail('MEMORY_KEY_RESERVED', 'Keys starting with "$" are reserved for internal runtime state');
  }
  if (key.length > LIMITS.MAX_KEY_CHARS) {
    throw fail('MEMORY_KEY_TOO_LONG', `Memory key exceeds limit of ${LIMITS.MAX_KEY_CHARS} characters`);
  }

  // 3. 记忆 Value 校验
  if (typeof raw.value !== 'string') {
    throw fail('MEMORY_VALUE_INVALID', 'Memory value must be a string');
  }
  const value = raw.value;
  if (value.length > LIMITS.MAX_VALUE_CHARS) {
    throw fail('MEMORY_VALUE_TOO_LONG', `Memory value exceeds limit of ${LIMITS.MAX_VALUE_CHARS} characters`);
  }

  // 4. 范围校验 (scope: user | conversation)
  if (typeof raw.scope !== 'string' || !MEMORY_SCOPES.includes(raw.scope)) {
    throw fail('MEMORY_SCOPE_INVALID', `Memory scope must be one of: ${MEMORY_SCOPES.join(', ')}`);
  }
  const scope = raw.scope;
  let conversationId = null;
  if (scope === 'conversation') {
    if (typeof raw.conversationId !== 'string' || !REGEX.CONVERSATION_ID.test(raw.conversationId.trim())) {
      throw fail('MEMORY_CONVERSATION_ID_REQUIRED', 'Conversation scoped memory requires valid conversationId');
    }
    conversationId = raw.conversationId.trim();
  }

  // 5. 来源溯源校验 (provenance)
  const prov = raw.provenance;
  if (!prov || typeof prov !== 'object') {
    throw fail('MEMORY_PROVENANCE_REQUIRED', 'Memory record requires provenance classification');
  }
  if (!PROVENANCE_KINDS.includes(prov.kind)) {
    throw fail('MEMORY_PROVENANCE_KIND_INVALID', `Provenance kind must be one of: ${PROVENANCE_KINDS.join(', ')}`);
  }

  // 6. 源对象校验 (source: message/document reference)
  let source = null;
  if (raw.source !== undefined && raw.source !== null) {
    if (typeof raw.source !== 'object') {
      throw fail('MEMORY_SOURCE_INVALID', 'Memory source must be an object');
    }
    if (!SOURCE_KINDS.includes(raw.source.kind)) {
      throw fail('MEMORY_SOURCE_KIND_INVALID', `Memory source kind must be one of: ${SOURCE_KINDS.join(', ')}`);
    }
    if (typeof raw.source.id !== 'string' || raw.source.id.trim().length === 0) {
      throw fail('MEMORY_SOURCE_ID_INVALID', 'Memory source requires non-empty id');
    }
    const sourceHash = raw.source.hash ? String(raw.source.hash).trim().toLowerCase() : null;
    if (sourceHash && !REGEX.SHA256_HEX.test(sourceHash)) {
      throw fail('MEMORY_SOURCE_HASH_INVALID', 'Memory source hash must be a valid 64-char hex SHA-256');
    }
    const sourceVersion = raw.source.version !== undefined ? Number(raw.source.version) : 1;
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
      throw fail('MEMORY_SOURCE_VERSION_INVALID', 'Memory source version must be a positive integer');
    }

    source = {
      kind: raw.source.kind,
      id: raw.source.id.trim(),
      hash: sourceHash,
      version: sourceVersion,
      observedAt: isValidIsoTimestamp(raw.source.observedAt) ? raw.source.observedAt : new Date().toISOString(),
    };
  }

  // 7. 确认状态 (confirmed) 严格控制
  // 铁律：模型推断 (model-inference) 默认绝对不能是已确认事实！
  // 必须由宿主通过外部可信上下文显式确认（如 options.hostAssertion）
  let confirmed = false;
  if (prov.kind === 'user-explicit-confirmation') {
    confirmed = true;
  } else if (prov.kind === 'user-verbatim-statement') {
    // 用户原话默认作为直接陈述记录，confirmed 默认为 true
    confirmed = raw.confirmed !== false;
  } else if (prov.kind === 'model-inference') {
    // 模型推断：即使 raw.confirmed 试图自报为 true，也必须被拒绝，除非有宿主外部凭据证明
    if (raw.confirmed === true && (!options.hostAssertion || !options.hostAssertion.confirmedBy)) {
      throw fail(
        'MEMORY_UNVERIFIED_INFERENCE_CONFIRMATION_FORBIDDEN',
        'Model inference cannot self-authorize confirmation without host external assertion'
      );
    }
    confirmed = Boolean(options.hostAssertion?.confirmedBy && raw.confirmed !== false);
  }

  // 8. 撤回状态 (revoked) 与修订版本 (revision)
  const revoked = Boolean(raw.revoked);
  const revision = Number.isSafeInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1;

  const nowIso = new Date().toISOString();
  const createdAt = isValidIsoTimestamp(raw.createdAt) ? raw.createdAt : nowIso;
  const updatedAt = isValidIsoTimestamp(raw.updatedAt) ? raw.updatedAt : nowIso;

  const intermediate = {
    schemaVersion: 1,
    memoryId: typeof raw.memoryId === 'string' && raw.memoryId.trim() ? raw.memoryId.trim() : sha256(`${tenantId}:${userId}:${key}`).slice(0, 32),
    owner: {
      tenantId,
      userId,
    },
    key,
    value,
    scope,
    conversationId,
    provenance: {
      kind: prov.kind,
      recordedBy: typeof prov.recordedBy === 'string' ? prov.recordedBy.trim() : 'system',
      note: typeof prov.note === 'string' ? prov.note.slice(0, 256) : null,
    },
    source,
    confirmed,
    confirmedAt: confirmed ? (options.hostAssertion?.confirmedAt || (prov.kind === 'user-explicit-confirmation' ? updatedAt : null)) : null,
    confirmedBy: confirmed ? (options.hostAssertion?.confirmedBy || (prov.kind === 'user-explicit-confirmation' ? userId : 'user-statement')) : null,
    revoked,
    revision,
    createdAt,
    updatedAt,
  };

  const revisionSignature = computeRevisionSignature(intermediate);
  intermediate.revisionSignature = revisionSignature;

  return deepFreeze(intermediate);
}

/**
 * 校验记忆来源是否依然存活有效 (invalidateMemorySources)
 *
 * @param {object} params
 * @param {object} params.memoryRecord - 规范化的记忆对象
 * @param {object} [params.targetSource] - 当前最新的可信源状态 { id, hash, version, isDeleted }
 * @param {string} [params.reason] - 显式失效说明
 * @returns {{ valid: boolean, reason?: string, revisionTrigger?: boolean }}
 */
function invalidateMemorySources({ memoryRecord, targetSource, reason } = {}) {
  if (!memoryRecord || typeof memoryRecord !== 'object') {
    return { valid: false, reason: 'MEMORY_RECORD_INVALID', revisionTrigger: false };
  }

  // 1. 若记忆已被撤销
  if (memoryRecord.revoked === true) {
    return { valid: false, reason: 'MEMORY_REVOKED', revisionTrigger: true };
  }

  // 2. 若存在显式失效原因
  if (reason) {
    return { valid: false, reason, revisionTrigger: true };
  }

  // 3. 若记忆绑定了具体源 (source)，与当前最新源状态比对
  if (memoryRecord.source && targetSource) {
    if (targetSource.id && targetSource.id !== memoryRecord.source.id) {
      return { valid: false, reason: 'SOURCE_ID_MISMATCH', revisionTrigger: true };
    }
    if (targetSource.isDeleted === true) {
      return { valid: false, reason: 'SOURCE_DELETED', revisionTrigger: true };
    }
    if (targetSource.hash && memoryRecord.source.hash &&
        targetSource.hash.toLowerCase() !== memoryRecord.source.hash.toLowerCase()) {
      return { valid: false, reason: 'SOURCE_HASH_MODIFIED', revisionTrigger: true };
    }
    if (targetSource.version !== undefined && memoryRecord.source.version !== undefined &&
        targetSource.version !== memoryRecord.source.version) {
      return { valid: false, reason: 'SOURCE_VERSION_OUTDATED', revisionTrigger: true };
    }
  }

  return { valid: true };
}

/**
 * 跨会话与多租户隔离的安全记忆召回 (selectRecallableMemories)
 *
 * @param {object} params
 * @param {object} params.queryContext - 查询调用方上下文
 * @param {string} params.queryContext.tenantId - 认证的租户
 * @param {string} params.queryContext.userId - 认证的用户
 * @param {string} [params.queryContext.conversationId] - 当前活跃会话标识
 * @param {number} [params.queryContext.snapshotRevision] - 客户端已持有的快照 revision（用于检测过期）
 * @param {boolean} [params.queryContext.allowUnconfirmed=false] - 是否允许包含未确认的模型推断
 * @param {Array<object>} params.memories - 候选记忆列表
 * @param {object} [params.options] - 配额与预算选项
 * @param {number} [params.options.maxMemories] - 最大召回条数
 * @param {number} [params.options.maxChars] - 最大注入字符预算 (UTF-16 code units)
 * @param {Map<string, object>} [params.options.trustedSources] - 外部存活源清单
 * @returns {object} { queryContext, totalEligible, returnedCount, includedChars, snapshotRevision, stale, memories }
 */
function selectRecallableMemories({
  queryContext,
  memories,
  options = {},
} = {}) {
  // 1. 查询上下文基础校验
  if (!queryContext || typeof queryContext !== 'object') {
    throw fail('MEMORY_RECALL_CONTEXT_INVALID', 'queryContext is required');
  }
  if (typeof queryContext.tenantId !== 'string' || !REGEX.TENANT_ID.test(queryContext.tenantId.trim())) {
    throw fail('MEMORY_QUERY_TENANT_INVALID', 'Valid tenantId is required in queryContext');
  }
  if (typeof queryContext.userId !== 'string' || !REGEX.USER_ID.test(queryContext.userId.trim())) {
    throw fail('MEMORY_QUERY_USER_INVALID', 'Valid userId is required in queryContext');
  }

  const queryTenantId = queryContext.tenantId.trim();
  const queryUserId = queryContext.userId.trim();
  const queryConversationId = typeof queryContext.conversationId === 'string' && queryContext.conversationId.trim()
    ? queryContext.conversationId.trim()
    : null;
  const allowUnconfirmed = Boolean(queryContext.allowUnconfirmed);

  if (!Array.isArray(memories)) {
    throw fail('MEMORY_LIST_INVALID', 'Memories must be an array');
  }

  // 2. 预算解析
  const maxMemories = Math.min(
    Math.max(1, Number.isSafeInteger(options.maxMemories) ? options.maxMemories : LIMITS.DEFAULT_RECALL_MEMORIES),
    LIMITS.MAX_RECALL_MEMORIES
  );
  const maxChars = Math.min(
    Math.max(1, Number.isSafeInteger(options.maxChars) ? options.maxChars : LIMITS.DEFAULT_RECALL_CHARS),
    LIMITS.MAX_RECALL_CHARS
  );

  const trustedSources = options.trustedSources instanceof Map ? options.trustedSources : null;

  const eligible = [];
  const audit = [];
  let latestRevision = 0;

  // 3. 逐条执行安全过滤与隔离门禁
  for (const m of memories) {
    if (!m || typeof m !== 'object') continue;

    // 门禁 A: 租户强隔离
    if (m.owner?.tenantId !== queryTenantId) {
      audit.push({ key: m.key, status: 'REJECTED_CROSS_TENANT' });
      continue;
    }

    // 门禁 B: 用户强隔离
    if (m.owner?.userId !== queryUserId) {
      audit.push({ key: m.key, status: 'REJECTED_CROSS_USER' });
      continue;
    }

    // 属于当前租户与用户的记忆，其 revision 纳入版本水位线统计
    if (Number.isSafeInteger(m.revision) && m.revision > latestRevision) {
      latestRevision = m.revision;
    }

    // 门禁 C: 对话级别隔离 (Conversation Scoping)
    // 若记忆属于某个具体对话，且当前会话与之不匹配，严禁泄漏！
    if (m.scope === 'conversation') {
      if (!queryConversationId || m.conversationId !== queryConversationId) {
        audit.push({ key: m.key, status: 'REJECTED_CONVERSATION_MISMATCH' });
        continue;
      }
    }

    // 门禁 D: 撤回过滤
    if (m.revoked === true) {
      audit.push({ key: m.key, status: 'REJECTED_REVOKED' });
      continue;
    }

    // 门禁 E: 未确认过滤
    if (!m.confirmed && !allowUnconfirmed) {
      audit.push({ key: m.key, status: 'REJECTED_UNCONFIRMED_INFERENCE' });
      continue;
    }

    // 门禁 F: 存活源生命周期校验
    if (trustedSources && m.source?.id) {
      const liveSource = trustedSources.get(m.source.id);
      if (liveSource) {
        const inv = invalidateMemorySources({ memoryRecord: m, targetSource: liveSource });
        if (!inv.valid) {
          audit.push({ key: m.key, status: `REJECTED_${inv.reason}` });
          continue;
        }
      }
    }

    eligible.push(m);
  }

  // 4. 确定性稳定排序：按 updatedAt 降序，相同时按 key 升序
  eligible.sort((a, b) => {
    const timeA = new Date(a.updatedAt).getTime();
    const timeB = new Date(b.updatedAt).getTime();
    if (timeB !== timeA) return timeB - timeA;
    return a.key.localeCompare(b.key);
  });

  // 5. 字符预算截断（按注入形式 key=value 测算）
  const selected = [];
  let includedChars = 0;

  for (const m of eligible) {
    if (selected.length >= maxMemories) break;

    // 模拟注入文本格式: "  · key=value\n"
    const lineChars = 4 + m.key.length + 1 + m.value.length + (selected.length > 0 ? 1 : 0);
    if (includedChars + lineChars > maxChars) {
      // 无法完整容纳当前条目，终止加入
      continue;
    }

    selected.push(m);
    includedChars += lineChars;
  }

  // 6. 快照过期比对 (Stale Snapshot Detection)
  const clientSnapshotRevision = Number.isSafeInteger(queryContext.snapshotRevision)
    ? queryContext.snapshotRevision
    : null;
  const isStale = clientSnapshotRevision !== null && clientSnapshotRevision < latestRevision;

  return {
    schemaVersion: 1,
    queryContext: {
      tenantId: queryTenantId,
      userId: queryUserId,
      conversationId: queryConversationId,
    },
    totalEligible: eligible.length,
    returnedCount: selected.length,
    includedChars,
    budgetMaxChars: maxChars,
    snapshotRevision: latestRevision,
    stale: isStale,
    audit,
    memories: selected,
  };
}

module.exports = {
  normalizeMemoryRecord,
  selectRecallableMemories,
  invalidateMemorySources,
  PROVENANCE_KINDS,
  MEMORY_SCOPES,
  SOURCE_KINDS,
  LIMITS,
};
