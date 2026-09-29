"use strict";

/**
 * tests/regression/workspace-idempotent-test.mjs - Workspace 幂等性测试
 * ============================================================================
 * 测试 createWorkspace() 重复调用不会崩溃，而是返回现有记录。
 * ============================================================================
 */

import { createWorkspace, getWorkspaceQuota, suspendWorkspaceForQuota, updateWorkspaceUsage } from "../../shell/workspace/index.cjs";

async function main() {
  console.log("🧪 开始 Workspace 幂等性测试");

  const testWorkspaceId = "test-workspace-idempotent-" + Date.now();
  const testTenantId = "test-tenant-" + Date.now();

  // 1. 首次创建工作区
  console.log(`  首次创建工作区: ${testWorkspaceId}`);
  const workspace1 = createWorkspace(testWorkspaceId, testTenantId);
  if (!workspace1 || workspace1.id !== testWorkspaceId || workspace1.tenantId !== testTenantId) {
    console.error("❌ 首次工作区创建失败");
    process.exit(1);
  }
  console.log("  ✅ 首次工作区创建成功");

  // 2. 重复创建同一工作区（应该返回现有记录，而不是抛错）
  console.log(`  重复创建工作区: ${testWorkspaceId}`);
  const workspace2 = createWorkspace(testWorkspaceId, testTenantId);
  if (!workspace2 || workspace2.id !== testWorkspaceId || workspace2.tenantId !== testTenantId) {
    console.error("❌ 重复创建工作区失败，应该返回现有记录");
    process.exit(1);
  }
  if (workspace1.createdAt !== workspace2.createdAt) {
    console.error("❌ 重复创建返回的记录与原记录不一致");
    process.exit(1);
  }
  console.log("  ✅ 重复创建返回现有记录，未崩溃");

  // 3. 验证获取工作区配额
  const quota = getWorkspaceQuota(testWorkspaceId);
  if (!quota || quota.status !== "active" || quota.tenantId !== testTenantId) {
    console.error("❌ 未找到工作区配额或状态/tenantId不正确");
    process.exit(1);
  }
  console.log(`  ✅ 工作区配额: ${quota.quota.storageBytes} bytes, tenantId: ${quota.tenantId}`);

  console.log("🎉 Workspace 幂等性测试全部通过");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("❌ 测试失败:", err.message);
    process.exit(1);
  });
}