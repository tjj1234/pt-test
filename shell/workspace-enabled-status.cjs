"use strict";
/**
 * 工作区业务线启用状态查询（M3）
 * ============================================================================
 * 基座层只读接口的后端逻辑。唯一权威信号是业务线 A16 落地的 firstConnectedAt，
 * 由既有只读接口 GET /api/business/attribution/import/workspace 提供：
 *   { ok: true, workspace: { workspaceId, firstConnectedAt, updatedAt } }
 *
 * 红线（同 M1）：
 *   - 不直接 import business/attribution/ 下任何模块；
 *   - 不直接读业务线的数据库表；
 *   - 不改 business/attribution/ 下任何文件。
 * 这里只通过 HTTP 调用业务线既有只读接口，再归一化成可扩展的启用状态形状。
 * ============================================================================
 */
const http = require("node:http");
const crypto = require("node:crypto");

/**
 * 计算租户的 HMAC 分析 token。
 * 与 shell 反代（/api/analytics /api/attribution /api/business）及 auth.cjs 的规则一致：
 *   sha256(tenantId) with key = PT_DASH_INTERNAL_KEY
 */
function computeAnalyticsToken(internalKey, tenantId) {
  return crypto.createHmac("sha256", internalKey).update(String(tenantId)).digest("hex");
}

/**
 * 内部调用业务线只读接口 GET /api/business/attribution/import/workspace。
 * 返回原始结果 { statusCode, body }，不在此处做业务解释，方便调用方与测试注入。
 */
function queryBusinessWorkspace({ internalKey, dashPort, tenantId, host = "127.0.0.1", timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const path = "/api/business/attribution/import/workspace";
    const token = computeAnalyticsToken(internalKey, tenantId);
    const req = http.request({
      host,
      port: dashPort,
      path,
      method: "GET",
      headers: {
        host: host + ":" + dashPort,
        authorization: "Bearer " + token,
        accept: "application/json",
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("business workspace query timeout"), { code: "TIMEOUT" })));
    req.end();
  });
}

/**
 * 内部调用业务线只读接口 GET /api/business/ga-connector/status，返回 { statusCode, body }。
 * 与 queryBusinessWorkspace 同一套 HMAC 鉴权 + HTTP 直连模式，不 import 业务线模块、不读业务库。
 */
function queryGaConnectorStatus({ internalKey, dashPort, tenantId, host = "127.0.0.1", timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const path = "/api/business/ga-connector/status";
    const token = computeAnalyticsToken(internalKey, tenantId);
    const req = http.request({
      host,
      port: dashPort,
      path,
      method: "GET",
      headers: {
        host: host + ":" + dashPort,
        authorization: "Bearer " + token,
        accept: "application/json",
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("ga connector status query timeout"), { code: "TIMEOUT" })));
    req.end();
  });
}

/**
 * 把业务线返回体归一化为可扩展的「业务线启用状态」。
 * 输入：{ ok, workspace: { workspaceId, firstConnectedAt, updatedAt } }（或 JSON 字符串）
 * 输出：
 *   {
 *     workspaceId,
 *     features: { attributionEnabled: bool },   // 扩展点：以后新增业务线就往 features 里加 key
 *     firstConnectedAt,                          // 透传，便于前端/调试
 *     updatedAt,
 *   }
 * 语义（已与业务线确认）：firstConnectedAt 非空 = 已启用广告归因分析。
 */
function normalizeEnabledStatus(raw) {
  let payload = raw;
  if (typeof raw === "string") {
    try { payload = JSON.parse(raw); } catch (e) { payload = null; }
  }
  const workspace = payload && payload.workspace ? payload.workspace : null;
  const workspaceId = workspace && workspace.workspaceId ? workspace.workspaceId : null;
  const firstConnectedAt = workspace && workspace.firstConnectedAt ? workspace.firstConnectedAt : null;
  const updatedAt = workspace && workspace.updatedAt ? workspace.updatedAt : null;
  return {
    workspaceId,
    features: {
      attributionEnabled: Boolean(firstConnectedAt),
    },
    firstConnectedAt,
    updatedAt,
  };
}

module.exports = { computeAnalyticsToken, queryBusinessWorkspace, normalizeEnabledStatus, queryGaConnectorStatus };
