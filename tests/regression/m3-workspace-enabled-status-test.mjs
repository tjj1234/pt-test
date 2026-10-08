"use strict";
/**
 * tests/regression/m3-workspace-enabled-status-test.mjs — M3 工作区业务线启用状态查询验收
 * ============================================================================
 * 验证基座层启用状态逻辑：
 *   ① firstConnectedAt 为空 → features.attributionEnabled = false（首次导入前）
 *   ② firstConnectedAt 非空 → features.attributionEnabled = true（首次导入完成后）
 *   ③ queryBusinessWorkspace 用正确的 HMAC token 调业务线只读接口（mock 校验 token 不匹配则 403）
 *   ④ 状态翻转：同一个 workspace 在 mock 里 firstConnectedAt 从空变有值，启用状态随之变化
 * 红线：全程只经 HTTP 调业务线接口，不 import business/attribution/ 模块、不读其数据库表。
 * ============================================================================
 */
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  computeAnalyticsToken,
  queryBusinessWorkspace,
  normalizeEnabledStatus,
} from "../../shell/workspace-enabled-status.cjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};

async function main() {
  console.log("🧪 M3 工作区业务线启用状态查询验收");

  // ① 归一化：首次导入前（firstConnectedAt 为空）
  const before = normalizeEnabledStatus({ ok: true, workspace: { workspaceId: "ws_x", firstConnectedAt: null, updatedAt: null } });
  ok("firstConnectedAt 为空 → attributionEnabled=false", before.features.attributionEnabled === false, JSON.stringify(before));
  ok("空态 workspaceId 正确透传", before.workspaceId === "ws_x");

  // ② 归一化：首次导入后（firstConnectedAt 非空）
  const ts = "2026-10-08T00:00:00.000Z";
  const after = normalizeEnabledStatus({ ok: true, workspace: { workspaceId: "ws_x", firstConnectedAt: ts, updatedAt: ts } });
  ok("firstConnectedAt 非空 → attributionEnabled=true", after.features.attributionEnabled === true);
  ok("非空态 firstConnectedAt 透传", after.firstConnectedAt === ts);

  // 归一化也接受 JSON 字符串（queryBusinessWorkspace 返回的就是字符串 body）
  const fromStr = normalizeEnabledStatus(JSON.stringify({ ok: true, workspace: { workspaceId: "ws_x", firstConnectedAt: ts, updatedAt: ts } }));
  ok("接受 JSON 字符串输入", fromStr.features.attributionEnabled === true);

  // ③④ 端到端：mock 业务线只读接口，校验 token + 状态翻转
  const INTERNAL_KEY = "test-internal-key";
  const tenantId = crypto.randomUUID();
  // 关键：用「独立计算」的期望 token，而不是复用 computeAnalyticsToken，
  // 这样能真正验证模块内部算出的 HMAC 与约定一致。
  const expectedToken = crypto.createHmac("sha256", INTERNAL_KEY).update(tenantId).digest("hex");
  ok("computeAnalyticsToken 与约定一致", computeAnalyticsToken(INTERNAL_KEY, tenantId) === expectedToken);

  let mockFirstConnected = null; // 首次导入前
  const mockServer = http.createServer((req, res) => {
    if (req.url !== "/api/business/attribution/import/workspace") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }));
    }
    if (req.headers.authorization !== "Bearer " + expectedToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "invalid token" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      workspace: { workspaceId: "ws_" + tenantId, firstConnectedAt: mockFirstConnected, updatedAt: mockFirstConnected },
    }));
  });
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  const dashPort = mockServer.address().port;

  // 首次导入前
  const rawBefore = await queryBusinessWorkspace({ internalKey: INTERNAL_KEY, dashPort, tenantId });
  ok("mock 首次导入前返回 200", rawBefore.statusCode === 200, "got " + rawBefore.statusCode);
  const statusBefore = normalizeEnabledStatus(rawBefore.body);
  ok("首次导入前 attributionEnabled=false", statusBefore.features.attributionEnabled === false, JSON.stringify(statusBefore));
  ok("首次导入前 workspaceId 正确", statusBefore.workspaceId === "ws_" + tenantId);

  // 模拟首次导入完成：firstConnectedAt 从空变有值
  mockFirstConnected = ts;
  const rawAfter = await queryBusinessWorkspace({ internalKey: INTERNAL_KEY, dashPort, tenantId });
  const statusAfter = normalizeEnabledStatus(rawAfter.body);
  ok("首次导入后 attributionEnabled=true", statusAfter.features.attributionEnabled === true);
  ok("首次导入后 firstConnectedAt 非空", !!statusAfter.firstConnectedAt);

  // 错误 token 应被业务线拒绝（403），基座层应把非 200 暴露出来
  const wrongTokenReq = await new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: dashPort, path: "/api/business/attribution/import/workspace", method: "GET",
      headers: { host: "127.0.0.1:" + dashPort, authorization: "Bearer " + crypto.createHmac("sha256", "wrong-key").update(tenantId).digest("hex") },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(0));
    req.end();
  });
  ok("错误 token 被业务线拒绝（403）", wrongTokenReq === 403, "got " + wrongTokenReq);

  await new Promise((r) => mockServer.close(r));

  console.log(`\n==== M3 工作区业务线启用状态查询验收：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试失败:", err && err.stack ? err.stack : err);
  process.exit(1);
});
