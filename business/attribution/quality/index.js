"use strict";
const { PERMISSIONS } = require("../../../shell/permissions/index.cjs");
const { qualityWindow } = require("./service");
function attributionQualityToolDefinition() {
  return { name: "attribution.quality", type: "skill", version: "1.0.0", outputType: "report", riskLevel: "read",
    description: "只读分析当前租户真实归因事件的六类关键事件覆盖率、user_id完整率及已导入sGTM日志的有效ID重复率；返回评分、问题与规则建议。无数据不评分，跨域丢失未评估。",
    requiredPermissions: [PERMISSIONS.TOOL_USE, PERMISSIONS.ATTRIBUTION_READ],
    inputSchema: { type: "object", additionalProperties: false, properties: { from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "UTC 起始日期，默认最近7天；最多31天" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "UTC 结束日期（含当日）" } } } };
}
function buildAttributionQualityExecutor({ internalKey, dashPort }) {
  const http = require("node:http"), crypto = require("node:crypto");
  return async (args = {}, context) => {
    if (!context?.tenantId || !internalKey) throw new Error("attribution.quality requires trusted tenant context and internalKey");
    qualityWindow(args);
    const query = new URLSearchParams(args).toString();
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: dashPort, path: "/api/attribution/quality" + (query ? "?" + query : ""), headers: { authorization: "Bearer " + crypto.createHmac("sha256", internalKey).update(String(context.tenantId)).digest("hex") } }, res => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", part => { text += part; if (text.length > 1024 * 1024) req.destroy(new Error("QUALITY_RESPONSE_TOO_LARGE")); });
        res.on("error", reject); res.on("end", () => {
          try { const body = JSON.parse(text); if (res.statusCode !== 200) throw Object.assign(new Error(body.error?.message || "QUALITY_QUERY_FAILED"), { code: body.error?.code }); resolve(body); } catch (err) { reject(err); }
        });
      });
      req.on("error", reject); req.setTimeout(15000, () => req.destroy(new Error("QUALITY_QUERY_TIMEOUT")));
    });
  };
}
module.exports = { attributionQualityToolDefinition, buildAttributionQualityExecutor, ...require("./service") };
