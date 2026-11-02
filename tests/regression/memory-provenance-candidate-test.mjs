/**
 * tests/regression/memory-provenance-candidate-test.mjs
 *
 * 单元回归测试：记忆来源、确认与范围策略候选 (Memory Provenance & Scoping)
 *
 * 验证维度：
 * 1. normalizeMemoryRecord 字段校验、保留内部键拒绝、内容超限门禁
 * 2. 三类来源分类：推断不能自授权确认，宿主外部授权有效
 * 3. 错误信息安全约束：错误描述严禁携带记忆具体正文 (value)
 * 4. 会话与多租户/用户隔离：对话范围记忆绝不外泄给不同会话
 * 5. selectRecallableMemories 稳定排序与字符预算硬限截断
 * 6. 来源失效 (invalidateMemorySources) 与快照过期 (stale) 触发
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeMemoryRecord,
  selectRecallableMemories,
  invalidateMemorySources,
  PROVENANCE_KINDS,
  MEMORY_SCOPES,
  LIMITS,
} = require('../../shell/memory/provenance-candidate.cjs');

const SHA_VALID = 'f'.repeat(64);
const OWNER_ALICE = { tenantId: 'tenant-acme', userId: 'user-alice' };
const OWNER_BOB = { tenantId: 'tenant-acme', userId: 'user-bob' };
const OWNER_OTHER_TENANT = { tenantId: 'tenant-other', userId: 'user-alice' };

test('Memory Provenance - normalizeMemoryRecord 基础门禁与保留键拒绝', () => {
  // 1. 保留内部键 (以 $ 开头) 严禁作为常规记忆写入
  assert.throws(
    () => normalizeMemoryRecord({
      owner: OWNER_ALICE,
      key: '$model',
      value: 'gpt-4o',
      scope: 'user',
      provenance: { kind: 'user-verbatim-statement' },
    }),
    { code: 'MEMORY_KEY_RESERVED' }
  );

  // 2. 空 Key 或超长 Key / Value
  assert.throws(
    () => normalizeMemoryRecord({
      owner: OWNER_ALICE,
      key: '   ',
      value: 'val',
      scope: 'user',
      provenance: { kind: 'user-verbatim-statement' },
    }),
    { code: 'MEMORY_KEY_EMPTY' }
  );

  const longKey = 'k'.repeat(81);
  assert.throws(
    () => normalizeMemoryRecord({
      owner: OWNER_ALICE,
      key: longKey,
      value: 'val',
      scope: 'user',
      provenance: { kind: 'user-verbatim-statement' },
    }),
    { code: 'MEMORY_KEY_TOO_LONG' }
  );

  const longValue = 'v'.repeat(2001);
  assert.throws(
    () => normalizeMemoryRecord({
      owner: OWNER_ALICE,
      key: 'validKey',
      value: longValue,
      scope: 'user',
      provenance: { kind: 'user-verbatim-statement' },
    }),
    { code: 'MEMORY_VALUE_TOO_LONG' }
  );

  // 3. 错误信息安全性：验证抛出的错误绝不暴露记忆正文
  const sensitiveSecret = 'SUPER_CONFIDENTIAL_PASSWORD_12345';
  try {
    normalizeMemoryRecord({
      owner: OWNER_ALICE,
      key: '$internalSecret',
      value: sensitiveSecret,
      scope: 'user',
      provenance: { kind: 'user-verbatim-statement' },
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.equal(err.message.includes(sensitiveSecret), false, 'Error message must not leak memory value');
  }
});

test('Memory Provenance - 三类来源分类与推断不可自授权确认', () => {
  // 1. 用户明确确认 (user-explicit-confirmation): confirmed 默认为 true
  const confRecord = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'preferredLanguage',
    value: 'zh-CN',
    scope: 'user',
    provenance: { kind: 'user-explicit-confirmation' },
  });
  assert.equal(confRecord.confirmed, true);
  assert.equal(confRecord.confirmedBy, 'user-alice');

  // 2. 用户原话 (user-verbatim-statement): 默认为直接陈述
  const verbatimRecord = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'dietaryHabit',
    value: 'Vegetarian',
    scope: 'user',
    provenance: { kind: 'user-verbatim-statement' },
  });
  assert.equal(verbatimRecord.confirmed, true);
  assert.equal(verbatimRecord.confirmedBy, 'user-statement');

  // 3. 模型推断 (model-inference): 默认 confirmed 必为 false
  const inferRecord = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'inferredTopic',
    value: 'Frontend Development',
    scope: 'user',
    provenance: { kind: 'model-inference' },
  });
  assert.equal(inferRecord.confirmed, false);
  assert.equal(inferRecord.confirmedAt, null);

  // 4. 严防模型/Prompt 自报 confirmed: true（无宿主外部授权时必须抛错阻断）
  assert.throws(
    () => normalizeMemoryRecord({
      owner: OWNER_ALICE,
      key: 'inferredTopic',
      value: 'Frontend Development',
      scope: 'user',
      confirmed: true, // 试图自报确认
      provenance: { kind: 'model-inference' },
    }),
    { code: 'MEMORY_UNVERIFIED_INFERENCE_CONFIRMATION_FORBIDDEN' }
  );

  // 5. 宿主提供可信外部凭据时，模型推断方可确认为已确认事实
  const validHostConf = normalizeMemoryRecord(
    {
      owner: OWNER_ALICE,
      key: 'inferredTopic',
      value: 'Frontend Development',
      scope: 'user',
      confirmed: true,
      provenance: { kind: 'model-inference' },
    },
    {
      hostAssertion: {
        confirmedBy: 'user-alice-via-ui-modal',
        confirmedAt: '2026-11-01T01:00:00.000Z',
      },
    }
  );
  assert.equal(validHostConf.confirmed, true);
  assert.equal(validHostConf.confirmedBy, 'user-alice-via-ui-modal');
  assert.equal(validHostConf.confirmedAt, '2026-11-01T01:00:00.000Z');
});

test('Memory Provenance - 对话级别与多租户/用户严格隔离', () => {
  // 会话 101 的对话专属记忆
  const convMem101 = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'tempGoal',
    value: 'Analyze Q3 report in session 101',
    scope: 'conversation',
    conversationId: 'conv-101',
    provenance: { kind: 'user-verbatim-statement' },
  });

  // 用户全局记忆
  const userGlobalMem = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'nickname',
    value: 'Ali',
    scope: 'user',
    provenance: { kind: 'user-explicit-confirmation' },
  });

  // 场景 A: 在会话 101 中召回，既能获取全局记忆，也能获取 conv-101 的记忆
  const res101 = selectRecallableMemories({
    queryContext: {
      tenantId: 'tenant-acme',
      userId: 'user-alice',
      conversationId: 'conv-101',
    },
    memories: [convMem101, userGlobalMem],
  });
  assert.equal(res101.returnedCount, 2);

  // 场景 B: 切换到会话 202，conv-101 的对话记忆严禁泄漏！
  const res202 = selectRecallableMemories({
    queryContext: {
      tenantId: 'tenant-acme',
      userId: 'user-alice',
      conversationId: 'conv-202',
    },
    memories: [convMem101, userGlobalMem],
  });
  assert.equal(res202.returnedCount, 1);
  assert.equal(res202.memories[0].key, 'nickname');
  // 审计记录中明确包含 REJECTED_CONVERSATION_MISMATCH
  const convAudit = res202.audit.find((a) => a.key === 'tempGoal' && a.status === 'REJECTED_CONVERSATION_MISMATCH');
  assert.ok(convAudit);

  // 场景 C: 跨用户查询（Bob 查 Alice 的记忆）-> 彻底排除
  const resBob = selectRecallableMemories({
    queryContext: {
      tenantId: 'tenant-acme',
      userId: 'user-bob',
      conversationId: 'conv-101',
    },
    memories: [convMem101, userGlobalMem],
  });
  assert.equal(resBob.returnedCount, 0);
  assert.equal(resBob.audit[0].status, 'REJECTED_CROSS_USER');

  // 场景 D: 跨租户查询 -> 彻底排除
  const resOtherTenant = selectRecallableMemories({
    queryContext: {
      tenantId: 'tenant-other',
      userId: 'user-alice',
      conversationId: 'conv-101',
    },
    memories: [convMem101, userGlobalMem],
  });
  assert.equal(resOtherTenant.returnedCount, 0);
  assert.equal(resOtherTenant.audit[0].status, 'REJECTED_CROSS_TENANT');
});

test('Memory Provenance - 来源失效与快照过期 (Stale Snapshot Detection)', () => {
  const memFromDoc = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'projectDeadline',
    value: '2026-12-31',
    scope: 'user',
    revision: 2,
    provenance: { kind: 'user-verbatim-statement' },
    source: {
      kind: 'document',
      id: 'roadmap.docx',
      hash: SHA_VALID,
      version: 1,
    },
  });

  // 1. 来源文件正常存活
  const liveSources = new Map([
    ['roadmap.docx', { id: 'roadmap.docx', hash: SHA_VALID, version: 1 }],
  ]);
  const resLive = selectRecallableMemories({
    queryContext: { tenantId: 'tenant-acme', userId: 'user-alice' },
    memories: [memFromDoc],
    options: { trustedSources: liveSources },
  });
  assert.equal(resLive.returnedCount, 1);

  // 2. 来源文件被删除 (isDeleted: true)
  const deletedSources = new Map([
    ['roadmap.docx', { id: 'roadmap.docx', isDeleted: true }],
  ]);
  const resDeleted = selectRecallableMemories({
    queryContext: { tenantId: 'tenant-acme', userId: 'user-alice' },
    memories: [memFromDoc],
    options: { trustedSources: deletedSources },
  });
  assert.equal(resDeleted.returnedCount, 0);
  assert.equal(resDeleted.audit[0].status, 'REJECTED_SOURCE_DELETED');

  // 3. 记忆已被显式撤回 (revoked: true)
  const revokedMem = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'revokedInfo',
    value: 'Obsolete information',
    scope: 'user',
    revoked: true,
    provenance: { kind: 'user-verbatim-statement' },
  });
  const resRevoked = selectRecallableMemories({
    queryContext: { tenantId: 'tenant-acme', userId: 'user-alice' },
    memories: [revokedMem],
  });
  assert.equal(resRevoked.returnedCount, 0);
  assert.equal(resRevoked.audit[0].status, 'REJECTED_REVOKED');

  // 4. 快照过期比对：客户端持有的 snapshotRevision 为 1，而当前最新为 2
  const resStale = selectRecallableMemories({
    queryContext: {
      tenantId: 'tenant-acme',
      userId: 'user-alice',
      snapshotRevision: 1, // 客户端旧快照
    },
    memories: [memFromDoc], // revision 是 2
  });
  assert.equal(resStale.stale, true);
  assert.equal(resStale.snapshotRevision, 2);
});

test('Memory Provenance - 确定性排序与字符预算截断', () => {
  const mem1 = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'alphaKey',
    value: 'First item value',
    scope: 'user',
    updatedAt: '2026-11-01T01:00:00.000Z',
    provenance: { kind: 'user-verbatim-statement' },
  });

  const mem2 = normalizeMemoryRecord({
    owner: OWNER_ALICE,
    key: 'betaKey',
    value: 'Second item value with longer description',
    scope: 'user',
    updatedAt: '2026-11-01T02:00:00.000Z', // 较新
    provenance: { kind: 'user-verbatim-statement' },
  });

  // 较新的 mem2 应该排在前面
  const res = selectRecallableMemories({
    queryContext: { tenantId: 'tenant-acme', userId: 'user-alice' },
    memories: [mem1, mem2],
  });
  assert.equal(res.returnedCount, 2);
  assert.equal(res.memories[0].key, 'betaKey');
  assert.equal(res.memories[1].key, 'alphaKey');

  // 字符预算测试：设置极小预算，只容纳第一条
  const resSmallBudget = selectRecallableMemories({
    queryContext: { tenantId: 'tenant-acme', userId: 'user-alice' },
    memories: [mem1, mem2],
    options: { maxChars: 60 },
  });
  assert.equal(resSmallBudget.returnedCount, 1);
  assert.equal(resSmallBudget.memories[0].key, 'betaKey');
  assert.ok(resSmallBudget.includedChars <= 60);
});
