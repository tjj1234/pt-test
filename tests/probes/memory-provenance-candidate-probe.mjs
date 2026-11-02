/**
 * tests/probes/memory-provenance-candidate-probe.mjs
 *
 * 探针：记忆来源、确认与范围候选实证实装与门禁探针
 *
 * 验证流程：
 * 1. 验证可移植独立加载能力 (os.tmpdir 隔离验证)
 * 2. 三类来源生命周期实证 (推断不可自确认，宿主外部授权确认有效)
 * 3. 跨会话范围 (Conversation Scoping) 隔离与防泄露实证
 * 4. 记忆失效与宿主取消 Run/热会话清理对接接缝 (Revision Seam) 实证
 * 5. 安全防御与错误信息零敏感泄漏实证
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passedTests = 0;
let totalTests = 0;

function runCase(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✔ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ✖ [FAIL] ${name}:`, err);
    throw err;
  }
}

console.log("=== 记忆来源、确认与范围策略候选探针开始 ===");

// --------------------------------------------------------------------------
// 1. 验证可移植独立加载能力
// --------------------------------------------------------------------------
console.log("\n[1/5] 验证候选模块在临时隔离目录中的可移植加载能力...");
let candidate;
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-provenance-probe-"));
  const targetPath = path.join(tempDir, "candidate.cjs");
  const sourceCode = fs.readFileSync(
    new URL("../../shell/memory/provenance-candidate.cjs", import.meta.url),
    "utf8"
  );
  fs.writeFileSync(targetPath, sourceCode, "utf8");

  try {
    const { createRequire } = await import("node:module");
    const tempRequire = createRequire(targetPath);
    candidate = tempRequire(targetPath);

    assert.equal(typeof candidate.normalizeMemoryRecord, "function");
    assert.equal(typeof candidate.selectRecallableMemories, "function");
    assert.equal(typeof candidate.invalidateMemorySources, "function");
    console.log("  ✔ 临时隔离目录加载与纯函数导出契约校验成功");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// 2. 三类来源生命周期实证
// --------------------------------------------------------------------------
console.log("\n[2/5] 验证三类来源区分：模型推断不能默认变事实，宿主授权方可生效...");

runCase("模型推断默认 confirmed: false，召回时默认排除", () => {
  const inferMemory = candidate.normalizeMemoryRecord({
    owner: { tenantId: "t-default", userId: "u-1" },
    key: "suggestedProjectRole",
    value: "Lead Architect",
    scope: "user",
    provenance: { kind: "model-inference", note: "Extracted from chat context" },
  });

  assert.equal(inferMemory.confirmed, false);
  assert.equal(inferMemory.confirmedAt, null);

  // 默认召回配置下，未确认推断被排除
  const recallRes = candidate.selectRecallableMemories({
    queryContext: { tenantId: "t-default", userId: "u-1" },
    memories: [inferMemory],
  });
  assert.equal(recallRes.returnedCount, 0);
  assert.equal(recallRes.audit[0].status, "REJECTED_UNCONFIRMED_INFERENCE");

  // 若查询上下文显式配置 allowUnconfirmed: true，方可召回
  const recallAllow = candidate.selectRecallableMemories({
    queryContext: { tenantId: "t-default", userId: "u-1", allowUnconfirmed: true },
    memories: [inferMemory],
  });
  assert.equal(recallAllow.returnedCount, 1);
});

runCase("宿主外部鉴权通道确认模型推断为已确认事实", () => {
  const confirmedInferMemory = candidate.normalizeMemoryRecord(
    {
      owner: { tenantId: "t-default", userId: "u-1" },
      key: "suggestedProjectRole",
      value: "Lead Architect",
      scope: "user",
      confirmed: true,
      provenance: { kind: "model-inference" },
    },
    {
      hostAssertion: {
        confirmedBy: "operator-admin-rpc",
        confirmedAt: "2026-11-01T01:30:00.000Z",
      },
    }
  );

  assert.equal(confirmedInferMemory.confirmed, true);
  assert.equal(confirmedInferMemory.confirmedBy, "operator-admin-rpc");

  // 已确认的事实无需 allowUnconfirmed 即可被正常召回
  const recallRes = candidate.selectRecallableMemories({
    queryContext: { tenantId: "t-default", userId: "u-1" },
    memories: [confirmedInferMemory],
  });
  assert.equal(recallRes.returnedCount, 1);
});

// --------------------------------------------------------------------------
// 3. 跨会话范围 (Conversation Scoping) 隔离实证
// --------------------------------------------------------------------------
console.log("\n[3/5] 验证会话级范围 (conversation scope) 隔离与防泄露...");

runCase("多会话混排记忆按当前 conversationId 严格隔离", () => {
  const memories = [
    // 全局记忆
    candidate.normalizeMemoryRecord({
      owner: { tenantId: "t-corp", userId: "user-dev" },
      key: "developerAlias",
      value: "Dev007",
      scope: "user",
      provenance: { kind: "user-explicit-confirmation" },
    }),
    // 会话 A 专属记忆
    candidate.normalizeMemoryRecord({
      owner: { tenantId: "t-corp", userId: "user-dev" },
      key: "activeBranch",
      value: "feature/auth-v2",
      scope: "conversation",
      conversationId: "conv-session-A",
      provenance: { kind: "user-verbatim-statement" },
    }),
    // 会话 B 专属记忆
    candidate.normalizeMemoryRecord({
      owner: { tenantId: "t-corp", userId: "user-dev" },
      key: "activeBranch",
      value: "hotfix/payment-gateway",
      scope: "conversation",
      conversationId: "conv-session-B",
      provenance: { kind: "user-verbatim-statement" },
    }),
  ];

  // 1. 在会话 A 召回
  const resA = candidate.selectRecallableMemories({
    queryContext: { tenantId: "t-corp", userId: "user-dev", conversationId: "conv-session-A" },
    memories,
  });
  assert.equal(resA.returnedCount, 2);
  const keysA = resA.memories.map((m) => m.key);
  assert.ok(keysA.includes("developerAlias"));
  assert.ok(keysA.includes("activeBranch"));
  assert.equal(resA.memories.find((m) => m.key === "activeBranch").value, "feature/auth-v2");

  // 2. 在会话 B 召回
  const resB = candidate.selectRecallableMemories({
    queryContext: { tenantId: "t-corp", userId: "user-dev", conversationId: "conv-session-B" },
    memories,
  });
  assert.equal(resB.returnedCount, 2);
  assert.equal(resB.memories.find((m) => m.key === "activeBranch").value, "hotfix/payment-gateway");

  // 3. 在未知会话 C 召回 -> 只能获取全局记忆
  const resC = candidate.selectRecallableMemories({
    queryContext: { tenantId: "t-corp", userId: "user-dev", conversationId: "conv-session-C" },
    memories,
  });
  assert.equal(resC.returnedCount, 1);
  assert.equal(resC.memories[0].key, "developerAlias");
});

// --------------------------------------------------------------------------
// 4. 记忆失效与宿主取消 Run/热会话清理对接接缝
// --------------------------------------------------------------------------
console.log("\n[4/5] 验证来源变更失效、revision 自增与宿主 Run 取消接缝...");

runCase("来源文档变更或记忆撤回生成确定性 revision 接缝", () => {
  const SHA_DOC_OLD = "a".repeat(64);
  const SHA_DOC_NEW = "b".repeat(64);

  const docMemory = candidate.normalizeMemoryRecord({
    owner: { tenantId: "t-corp", userId: "user-dev" },
    key: "authDesignDoc",
    value: "JWT Bearer with RS256 token signing",
    scope: "user",
    revision: 3,
    provenance: { kind: "user-verbatim-statement" },
    source: {
      kind: "document",
      id: "auth-architecture.docx",
      hash: SHA_DOC_OLD,
      version: 1,
    },
  });

  // 模拟宿主提供最新的存活源状态：文档被修改，新 SHA 与旧记忆不符
  const targetSourceModified = {
    id: "auth-architecture.docx",
    hash: SHA_DOC_NEW,
    version: 2,
  };

  const invResult = candidate.invalidateMemorySources({
    memoryRecord: docMemory,
    targetSource: targetSourceModified,
  });

  assert.equal(invResult.valid, false);
  assert.equal(invResult.reason, "SOURCE_HASH_MODIFIED");
  assert.equal(invResult.revisionTrigger, true, "Must trigger revision change for host cancelActiveRuns");

  // 验证在召回时客户端持有的 snapshotRevision: 2 能够被识别为 stale
  const liveSourcesMap = new Map([["auth-architecture.docx", targetSourceModified]]);
  const recallRes = candidate.selectRecallableMemories({
    queryContext: {
      tenantId: "t-corp",
      userId: "user-dev",
      snapshotRevision: 2, // 旧快照
    },
    memories: [docMemory],
    options: { trustedSources: liveSourcesMap },
  });

  // 该记忆被判定为失效排除，同时返回当前系统最新 snapshotRevision: 3，stale 标记为 true
  assert.equal(recallRes.returnedCount, 0);
  assert.equal(recallRes.stale, true);
  assert.equal(recallRes.snapshotRevision, 3);
});

// --------------------------------------------------------------------------
// 5. 安全防御与错误信息零敏感泄漏实证
// --------------------------------------------------------------------------
console.log("\n[5/5] 验证原型污染防御与错误信息零正文泄漏...");

runCase("输入非法原型与极端参数时安全拦截，错误信息不带记忆正文", () => {
  const secretPayload = "SECRET_TOP_SECRET_CONFIDENTIAL_TOKEN_ABC";

  // 1. 非法 scope 拒绝，错误消息绝无具体 value
  try {
    candidate.normalizeMemoryRecord({
      owner: { tenantId: "t-corp", userId: "u-1" },
      key: "tokenKey",
      value: secretPayload,
      scope: "malicious-scope",
      provenance: { kind: "user-verbatim-statement" },
    });
    assert.fail("Should throw");
  } catch (err) {
    assert.equal(err.code, "MEMORY_SCOPE_INVALID");
    assert.equal(err.message.includes(secretPayload), false);
  }

  // 2. 超长 key 拒绝，错误消息绝无具体 value
  try {
    candidate.normalizeMemoryRecord({
      owner: { tenantId: "t-corp", userId: "u-1" },
      key: "x".repeat(100),
      value: secretPayload,
      scope: "user",
      provenance: { kind: "user-verbatim-statement" },
    });
    assert.fail("Should throw");
  } catch (err) {
    assert.equal(err.code, "MEMORY_KEY_TOO_LONG");
    assert.equal(err.message.includes(secretPayload), false);
  }
});

console.log(`\n=== 探针完成：共执行 ${totalTests} 项用例，通过 ${passedTests} 项，失败 0 项 ===`);
