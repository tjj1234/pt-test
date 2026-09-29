/**
 * tenant-mock-smoke.mjs —— tenant.cjs 重构集成冒烟（Slice 2）
 * ============================================================================
 * 验证 runDshForUser 业务组装 → runtime（mock）委托端到端：
 *   · key 解密三级回退 / NO_USER / NO_TASK / NO_API_KEY / NO_KEY_SOURCE
 *   · dryRun 返回鉴权/workspace 信息
 *   · 冷/热会话（fresh）+ closeDshSession 重置
 * 全程 PT_MOCK_DSH=1（内存 mock，无 DSH 无 LLM）。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

process.env.PT_MOCK_DSH = "1";
const tenant = require("../../shell/tenant.cjs");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
}

// ===== 1. 正常对话（mock 路径）=====
let deltas = [], steps = [];
const r = await tenant.runDshForUser("u-test-1", "你好", {
  tenantId: "t-test-1",
  conversationId: "conv-1",
  decryptApiKey: async () => "stub-key-1234567890",
  model: "deepseek-v4-pro",
  onDelta: (d) => deltas.push(d),
  onStep: (s) => steps.push(s),
});
ok("runDshForUser(mock) ok=true", r.ok === true);
ok("runDshForUser(mock) 文本", r.text === "这是一条回复");
ok("runDshForUser(mock) delta 逐字回调", deltas.join("") === "这是一条回复");
ok("runDshForUser(mock) step 轨迹回调", steps.length === 2 && steps[0].name === "attribution.query");
ok("runDshForUser(mock) 首次 fresh=true", r.fresh === true);
ok("runDshForUser(mock) 含 ms/steps", typeof r.ms === "number" && Array.isArray(r.steps));

// ===== 2. 错误码 =====
ok("NO_USER", (await tenant.runDshForUser("", "x", {})).code === "NO_USER");
ok("NO_TASK", (await tenant.runDshForUser("u2", "", {})).code === "NO_TASK");
ok("NO_API_KEY", (await tenant.runDshForUser("u2", "x", { tenantId: "t2", decryptApiKey: async () => null })).code === tenant.NO_API_KEY_CODE);
ok("NO_KEY_SOURCE", (await tenant.runDshForUser("u2", "x", { tenantId: "t2" })).code === tenant.NO_KEY_SOURCE_CODE);

// ===== 3. dryRun =====
const rDry = await tenant.runDshForUser("u3", "x", { tenantId: "t3", dryRun: true, decryptApiKey: async () => "k-123456" });
ok("dryRun: ok + 鉴权信息", rDry.dryRun === true && rDry.ok === true && typeof rDry.keySha256 === "string" && !!rDry.cwd && rDry.tenantId === "t3");

// ===== 4. 冷/热会话 + closeDshSession =====
const r2 = await tenant.runDshForUser("u-test-1", "再问", { tenantId: "t-test-1", conversationId: "conv-1", decryptApiKey: async () => "stub-key" });
ok("同 conversationId 热会话 fresh=false", r2.fresh === false);
tenant.closeDshSession("conv-1");
const r3 = await tenant.runDshForUser("u-test-1", "三问", { tenantId: "t-test-1", conversationId: "conv-1", decryptApiKey: async () => "stub-key" });
ok("closeDshSession 后冷启动 fresh=true", r3.fresh === true);

// ===== 5. 收尾：closeRuntime 释放 =====
tenant.closeRuntime();
ok("closeRuntime 无异常", true);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
