"use strict";

/**
 * tests/regression/tool-registry-test.mjs - Tool Registry 契约测试
 * ============================================================================
 * 测试归因业务线的 tool-registration.json 能原样注册进去且通过校验。
 * ============================================================================
 */

import { registerTool, listToolsForWorkspace, validateToolCall, executeTool } from "../../shell/tools/registry.cjs";
import { CONTRACTS } from "../../business/attribution/contracts/validate.js";

async function main() {
  console.log("🧪 开始 Tool Registry 契约测试");

  // 1. 注册工具
  const exampleTool = CONTRACTS.toolRegistration.examples[0];
  console.log(`  注册工具: ${exampleTool.name}`);
  const registered = registerTool(exampleTool);
  if (!registered) {
    console.error("❌ 工具注册失败");
    process.exit(1);
  }
  console.log("  ✅ 工具注册成功");

  // 2. 列出工具
  const context = { userId: "test-user", tenantId: "test-tenant" };
  const tools = await listToolsForWorkspace("test-workspace", context);
  if (tools.length === 0) {
    console.error("❌ 未找到已注册的工具");
    process.exit(1);
  }
  console.log(`  ✅ 找到 ${tools.length} 个工具`);

  // 3. 验证工具调用
  const args = { from: "2026-09-01", to: "2026-09-30" };
  const isValid = await validateToolCall(exampleTool.name, args, context);
  if (!isValid) {
    console.error("❌ 工具调用验证失败");
    process.exit(1);
  }
  console.log("  ✅ 工具调用验证成功");

  // 4. 执行工具
  const result = await executeTool(exampleTool.name, args, context);
  if (!result.success) {
    console.error("❌ 工具执行失败");
    process.exit(1);
  }
  console.log("  ✅ 工具执行成功");

  console.log("🎉 Tool Registry 契约测试全部通过");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("❌ 测试失败:", err.message);
    process.exit(1);
  });
}