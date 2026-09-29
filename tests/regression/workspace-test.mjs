"use strict";

/**
 * tests/regression/workspace-test.mjs - Workspace 契约测试
 * ============================================================================
 * 测试新建租户自动分配 workspace 记录；超配额能正确触发 suspend 状态。
 * ============================================================================
 */

import { createWorkspace, getWorkspaceQuota, suspendWorkspaceForQuota, updateWorkspaceUsage } from "../../shell/workspace/index.cjs";

async function main() {
  console.log("🧪 开始 Workspace 契约测试");

  const testWorkspaceId = "test-workspace-" + Date.now();

  // 1. 创建工作区
  console.log(`  创建工作区: ${testWorkspaceId}`);
  const workspace = createWorkspace(testWorkspaceId, "test-tenant");
  if (!workspace || workspace.id !== testWorkspaceId) {
    console.error("❌ 工作区创建失败");
    process.exit(1);
  }
  console.log("  ✅ 工作区创建成功");

  // 2. 获取工作区配额
  const quota = getWorkspaceQuota(testWorkspaceId);
  if (!quota || quota.status !== "active") {
    console.error("❌ 未找到工作区配额或状态不正确");
    process.exit(1);
  }
  console.log(`  ✅ 工作区配额: ${quota.quota.storageBytes} bytes`);

  // 3. 更新使用量（未超配额）
  const normalUsage = quota.quota.storageBytes / 2;
  const updated = updateWorkspaceUsage(testWorkspaceId, normalUsage);
  if (!updated) {
    console.error("❌ 更新使用量失败");
    process.exit(1);
  }
  const quotaAfterNormal = getWorkspaceQuota(testWorkspaceId);
  if (quotaAfterNormal.usage.storageBytes !== normalUsage) {
    console.error("❌ 使用量未正确更新");
    process.exit(1);
  }
  console.log("  ✅ 正常使用量更新成功");

  // 4. 更新使用量（超配额）
  const exceededUsage = quota.quota.storageBytes + 1;
  const exceededUpdated = updateWorkspaceUsage(testWorkspaceId, exceededUsage);
  if (!exceededUpdated) {
    console.error("❌ 超配额更新使用量失败");
    process.exit(1);
  }
  const quotaAfterExceeded = getWorkspaceQuota(testWorkspaceId);
  if (quotaAfterExceeded.status !== "suspended") {
    console.error("❌ 超配额未触发 suspend 状态");
    process.exit(1);
  }
  console.log("  ✅ 超配额触发 suspend 状态成功");

  // 5. 手动暂停工作区
  const manualSuspended = suspendWorkspaceForQuota(testWorkspaceId, "manual_test");
  if (!manualSuspended) {
    console.error("❌ 手动暂停工作区失败");
    process.exit(1);
  }
  const quotaAfterManual = getWorkspaceQuota(testWorkspaceId);
  if (quotaAfterManual.suspendReason !== "manual_test") {
    console.error("❌ 手动暂停原因未正确记录");
    process.exit(1);
  }
  console.log("  ✅ 手动暂停工作区成功");

  console.log("🎉 Workspace 契约测试全部通过");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("❌ 测试失败:", err.message);
    process.exit(1);
  });
}