"use strict";
/**
 * tests/regression/m1-tool-wiring-test.mjs — M1 工具接线 + 用户隔离验收
 * ============================================================================
 * 用真实临时 PGlite + 两个 tenant（各一个 admin 用户）验证 M1 验收标准：
 *   ② 两个不同 workspace 各自触发 demo 工具（get_current_time）都能拿到正确结果
 *   ③ 查各自的调用日志互相看不到对方的记录（隔离红线）
 * 同时校验 listToolsForWorkspace（GET /api/tools 底层）按权限过滤。
 * ============================================================================
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { open, migrate } from "../../shell/db.cjs";
import { setDb, PERMISSIONS } from "../../shell/permissions/index.cjs";
import { initToolCalls } from "../../shell/tool-calls.cjs";
import { registerTool, setToolCallLogger, listToolsForWorkspace, executeTool } from "../../shell/tools/registry.cjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};

async function main() {
  console.log("🧪 M1 工具接线 + 用户隔离验收");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-tool-wiring-"));
  const { db, close } = await open({ dataDir });
  const migrationsDir = path.resolve(__dirname, "../../shell/db-migrations");
  await migrate(db, migrationsDir);

  // 两个 tenant，各建一个 admin 用户（admin 拥有 TOOL_USE，才能触发 demo 工具）
  async function makeTenant(username) {
    const t = await db.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [username]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      "INSERT INTO users (tenant_id, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [tenantId, username, null, "scrypt$test$not-used", "admin"]
    );
    return { tenantId, userId: u.rows[0].id, workspaceId: "ws_" + tenantId };
  }

  const A = await makeTenant("tenant-a");
  const B = await makeTenant("tenant-b");

  setDb(db);
  const toolCalls = await initToolCalls(db);
  setToolCallLogger(toolCalls);

  registerTool({
    name: "get_current_time",
    type: "utility",
    version: "1.0.0",
    description: "返回当前精确时间（ISO 8601）。M1 demo。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputType: "data",
    riskLevel: "read",
    requiredPermissions: [PERMISSIONS.TOOL_USE],
    execute: async () => ({ now: new Date().toISOString() }),
  });

  // ② 两个不同 workspace 各自触发 demo 工具，都能拿到正确结果
  const rA = await executeTool("get_current_time", {}, { userId: A.userId, tenantId: A.tenantId, workspaceId: A.workspaceId });
  const rB = await executeTool("get_current_time", {}, { userId: B.userId, tenantId: B.tenantId, workspaceId: B.workspaceId });
  ok("workspace A 触发成功且返回时间", rA.success === true && !!rA.result && !!rA.result.now, JSON.stringify(rA));
  ok("workspace B 触发成功且返回时间", rB.success === true && !!rB.result && !!rB.result.now, JSON.stringify(rB));

  // 清单按权限过滤（两个 admin 都能看到 demo 工具）
  const listA = await listToolsForWorkspace(A.workspaceId, { userId: A.userId, tenantId: A.tenantId });
  const listB = await listToolsForWorkspace(B.workspaceId, { userId: B.userId, tenantId: B.tenantId });
  ok("workspace A 清单含 get_current_time", listA.some((t) => t.name === "get_current_time"));
  ok("workspace B 清单含 get_current_time", listB.some((t) => t.name === "get_current_time"));

  // ③ 隔离红线：各自的调用日志互不可见
  const callsA = await toolCalls.list({ tenantId: A.tenantId, workspaceId: A.workspaceId, range: "today" });
  const callsB = await toolCalls.list({ tenantId: B.tenantId, workspaceId: B.workspaceId, range: "today" });
  ok("workspace A 看到 1 条日志", callsA.length === 1, "got " + callsA.length);
  ok("workspace B 看到 1 条日志", callsB.length === 1, "got " + callsB.length);
  ok("A 的日志全部属于 A", callsA.every((c) => c.workspaceId === A.workspaceId && c.tenantId === A.tenantId));
  ok("B 的日志全部属于 B", callsB.every((c) => c.workspaceId === B.workspaceId && c.tenantId === B.tenantId));
  ok("A 与 B 的日志 id 不重合（互不可见）", callsA.every((c) => !callsB.some((d) => d.id === c.id)));
  ok("日志终态为 completed", callsA[0].status === "completed" && callsB[0].status === "completed");
  ok("日志 toolName 正确", callsA[0].toolName === "get_current_time" && callsB[0].toolName === "get_current_time");

  // 双条件过滤：用 A 的 tenant 查 B 的 workspace → 0 条
  const cross = await toolCalls.list({ tenantId: A.tenantId, workspaceId: B.workspaceId, range: "today" });
  ok("tenant/workspace 不匹配时查不到（0 条）", cross.length === 0, "got " + cross.length);

  await close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结果 */ }

  console.log(`\n==== M1 工具接线 + 隔离验收：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试失败:", err && err.stack ? err.stack : err);
  process.exit(1);
});
