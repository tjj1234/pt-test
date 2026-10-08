"use strict";
const { PERMISSIONS } = require("../../../shell/permissions/index.cjs");
const { toShellPermissionContext } = require("../registry/tool");
const { EVENT_NAMES } = require("../contracts/invariants");
const reportSchema = require("../contracts/tracking-quality-report.json");
const NAME = "tracking_quality_audit";
const TEMPLATE = "saas_token_marketplace";
const INPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { template: { type: "string", enum: [TEMPLATE], default: TEMPLATE } },
});
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function shellRegistry(opts) { return opts.shellTools || require("../../../shell/tools/registry.cjs"); }
function trackingQualityAuditToolDefinition(overrides = {}) {
  return {
    name: NAME, type: "skill", version: overrides.version || "1.0.0",
    description: "埋点质量 AI 分析：只读审计当前工作区的真实事件适配统计，按 Token 业务模板返回评分、问题列表与整改建议。无数据不评高分，不生成或启用数据面板。",
    inputSchema: INPUT_SCHEMA, outputType: "report", riskLevel: "read",
    requiredPermissions: [PERMISSIONS.TOOL_USE, PERMISSIONS.ATTRIBUTION_READ],
    requiredCredentials: [],
  };
}
function validateArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("BAD_ARGS", "参数必须是对象");
  if (Object.keys(args).some(k => k !== "template")) fail("BAD_ARGS", "仅支持 template 参数；工作区和质量数据必须来自可信上下文");
  if (args.template !== undefined && args.template !== TEMPLATE) fail("UNSUPPORTED_TEMPLATE", "本期仅支持 saas_token_marketplace");
}
function validateSnapshot(stats, workspaceId) {
  if (!stats || stats.workspaceId !== workspaceId) fail("QUALITY_SCOPE_MISMATCH", "质量统计不属于当前工作区");
  const q = stats.eventIdQuality, t = stats.timestampFallback;
  if (!q || !t) fail("BAD_QUALITY_SNAPSHOT", "质量统计缺少 eventIdQuality 或 timestampFallback");
  const counts = [stats.totalAdapted, stats.ignored, stats.unmappedEventCount, stats.mappedViaConfig, q.client_native_unique, q.adapter_fallback, t.count, t.client_count];
  if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) fail("BAD_QUALITY_SNAPSHOT", "质量统计计数必须是非负整数");
  const accepted = q.client_native_unique + q.adapter_fallback;
  if (stats.totalAdapted !== stats.ignored + stats.unmappedEventCount + accepted || t.count + t.client_count !== accepted || stats.mappedViaConfig > accepted) fail("BAD_QUALITY_SNAPSHOT", "质量统计计数不一致，不能生成评分");
  if (stats.updatedAt !== null && (typeof stats.updatedAt !== "string" || !Number.isFinite(Date.parse(stats.updatedAt)))) fail("BAD_QUALITY_SNAPSHOT", "质量统计更新时间无效");
  for (const ratio of [q.client_native_ratio, t.ratio]) {
    if (ratio !== null && (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) fail("BAD_QUALITY_SNAPSHOT", "质量统计比例无效");
  }
  const expectedNative = accepted ? Number((q.client_native_unique / accepted).toFixed(4)) : null;
  const expectedTimestamp = accepted ? Number((t.count / accepted).toFixed(4)) : null;
  if (q.client_native_ratio !== expectedNative || t.ratio !== expectedTimestamp) fail("BAD_QUALITY_SNAPSHOT", "质量统计比例与计数不一致");
  return accepted;
}
const pct = ratio => (ratio * 100).toFixed(1) + "%";
const round = n => Number(n.toFixed(4));

/** Pure report projection. No event writes, panel registration, workspace activation or model arithmetic. */
function buildTrackingQualityReport(snapshot, workspaceId, generatedAt = new Date().toISOString()) {
  const accepted = validateSnapshot(snapshot, workspaceId);
  const stats = JSON.parse(JSON.stringify(snapshot));
  const q = stats.eventIdQuality, t = stats.timestampFallback;
  const considered = accepted + stats.unmappedEventCount;
  const rates = {
    unmapped: considered ? stats.unmappedEventCount / considered : null,
    eventIdFallback: accepted ? q.adapter_fallback / accepted : null,
    timestampFallback: accepted ? t.count / accepted : null,
  };
  const assessable = accepted > 0;
  const components = [
    { key: "event_mapping", label: "事件映射", weight: 40, numerator: stats.unmappedEventCount, denominator: considered, deduction: assessable ? round(40 * rates.unmapped) : null },
    { key: "event_id", label: "客户端事件标识", weight: 35, numerator: q.adapter_fallback, denominator: accepted, deduction: assessable ? round(35 * rates.eventIdFallback) : null },
    { key: "timestamp", label: "客户端时间戳", weight: 25, numerator: t.count, denominator: accepted, deduction: assessable ? round(25 * rates.timestampFallback) : null },
  ];
  const value = assessable ? Math.round(100 - components.reduce((n, c) => n + c.deduction, 0)) : null;
  const issues = [], recommendations = [];
  function issue(id, severity, title, evidence, impact, action, verification) {
    issues.push({ id, severity, title, evidence, impact });
    recommendations.push({ issueId: id, priority: severity === "high" ? "P1" : "P2", action, verification });
  }
  if (stats.unmappedEventCount) issue("unmapped_events", "high", "存在未映射事件，无法进入归因事件白名单",
    { metric: "unmappedEventCount", count: stats.unmappedEventCount, denominator: considered, ratio: round(rates.unmapped), summary: stats.unmappedEventCount + " / " + considered + " 条非忽略事件（" + pct(rates.unmapped) + "）" },
    "若未映射事件属于注册、API Key 创建、模型调用或充值，会形成归因漏斗缺口；当前汇总不能判断具体事件名称。",
    "在 U6 核对业务事件映射：visit、signup、key_created、model_call、recharge、auto_recharge_toggle；非业务噪声可明确标为 ignore，不能把所有未知事件强映射为 visit。",
    "逐项触发真实业务操作，确认适配返回对应标准事件；后续新请求不再增加 unmappedEventCount。历史累计不会自动清零。");
  if (q.adapter_fallback) issue("fallback_event_id", "high", "部分事件依赖适配层生成 event_id",
    { metric: "eventIdQuality.adapter_fallback", count: q.adapter_fallback, denominator: accepted, ratio: round(rates.eventIdFallback), summary: q.adapter_fallback + " / " + accepted + " 条已适配事件（" + pct(rates.eventIdFallback) + "）" },
    "确定性兜底会依赖原始字段指纹。重试时字段变化可能产生新 ID，不同真实操作指纹相同可能合并；这不是已证实的重复计数。",
    "在真实操作创建时生成有效 UUID：signup、key_created、model_call、recharge 分别使用各自事件 ID；同一操作的重试复用同一 ID，不能用 user_id 或 API Key 代替事件 ID。",
    "用一个充值或模型调用事件重放，确认 event_id 保持不变；两次不同操作应使用不同 UUID；后续事件应增加 client_native_unique 而非 adapter_fallback。");
  if (t.count) issue("fallback_timestamp", "medium", "部分事件使用接收时间代替发生时间",
    { metric: "timestampFallback.count", count: t.count, denominator: accepted, ratio: round(rates.timestampFallback), summary: t.count + " / " + accepted + " 条已适配事件（" + pct(rates.timestampFallback) + "）" },
    "延迟上报或重试的充值、模型调用可能被记到接收日，影响业务时序和按日归因；当前统计无法测量实际延迟。",
    "由事件生产端发送真实发生时间的 Unix 毫秒值。充值用成功确认时间、模型调用用实际调用时间；重试保留原发生时间，避免发送秒值、空值或格式化日期字符串。",
    "触发并延迟重发同一事件，确认 timestamp 保持原发生时间；后续事件应增加 client_count 而非 timestampFallback.count。");
  if (!assessable) issue("insufficient_data", "high", "没有可评估的已适配事件",
    { metric: "adaptedEventCount", count: accepted, denominator: stats.totalAdapted, ratio: stats.totalAdapted ? 0 : null, summary: "已适配事件 0 条；评分未生成" },
    "没有样本不能证明埋点正常；仅忽略或未映射的请求也不能证明事件标识和时间戳质量。",
    "在当前工作区触发注册 → 创建 API Key → 模型调用 → 充值的真实操作，并确认接入了该工作区的事件适配入口；不需要启用整条业务流或新建数据面板。",
    "U6 的 totalAdapted 与 client_native_unique/adapter_fallback 出现真实增量，再重新运行本能力。");
  recommendations.sort((a, b) => a.priority.localeCompare(b.priority));
  if (assessable && issues.length === 0) recommendations.push({ issueId: null, priority: "P2", action: "已观测的映射、事件 ID 来源与时间戳来源没有异常；继续抽样验证六类核心事件的业务字段与重放行为。", verification: "逐项触发核心操作并核对事件明细；汇总评分 100 不等于完整审计通过。" });
  return {
    schemaVersion: "tracking-quality-report.v1", outputType: "report", title: "埋点质量 AI 分析", template: TEMPLATE,
    workspaceId, generatedAt,
    scoreBar: { value, max: 100, status: !assessable ? "insufficient_data" : value >= 90 ? "healthy" : value >= 70 ? "attention" : "high_risk", label: !assessable ? "样本不足，暂不评分" : "已观测事件适配质量", method: "100 - 40×未映射/非忽略事件 - 35×ID兜底/已适配事件 - 25×时间戳兜底/已适配事件；仅在存在已适配事件时评分。", components },
    kv: [
      { key: "totalAdapted", label: "适配尝试总数", value: stats.totalAdapted, unit: "条" },
      { key: "adaptedEventCount", label: "已适配事件", value: accepted, unit: "条" },
      { key: "ignored", label: "配置为忽略", value: stats.ignored, unit: "条" },
      { key: "unmappedEventCount", label: "未映射事件", value: stats.unmappedEventCount, unit: "条" },
      { key: "client_native_unique", label: "客户端有效 UUID", value: q.client_native_unique, unit: "条" },
      { key: "adapter_fallback", label: "适配层 ID 兜底", value: q.adapter_fallback, unit: "条" },
      { key: "timestampFallback", label: "时间戳兜底", value: t.count, unit: "条" },
      { key: "mappedViaConfig", label: "经配置映射的已适配事件", value: stats.mappedViaConfig, unit: "条" },
      { key: "updatedAt", label: "统计更新时间", value: stats.updatedAt, unit: null },
    ],
    issuesTable: { columns: [{ key: "severity", label: "级别" }, { key: "title", label: "问题" }, { key: "evidence", label: "统计依据" }, { key: "impact", label: "业务影响" }], rows: issues },
    recommendations,
    source: { kind: "ingestion-quality-stats", scope: "workspace", window: "累计：自当前进程启动或该工作区统计重置以来", snapshot: stats },
    coverage: { status: "not_assessed", expectedEvents: [...EVENT_NAMES], reason: "snapshot 无按事件名计数或事件明细，不能判断核心事件覆盖、字段完整性或业务时序。" },
    limitations: ["本期仅审计 saas_token_marketplace 的适配质量，不是通用四维审计。", "ignored 是配置行为，不作为丢失错误扣分；需人工确认是否误忽略业务事件。", "client_native_unique 仅代表有效 UUID 来源，不证明真实唯一性或端到端去重。", "适配计数不是 Collect 成功入库数，重放、连接测试也可能增加计数。", "时间戳非兜底不等于时间准确，秒/毫秒混用或时钟偏差仍需明细验证。"],
    interpretation: { mode: "backend_rules", instruction: "评分与证据由后端计算；Agent 仅按本报告转述，不补造事件样例、缺失事件、收入损失或审计通过结论。" },
  };
}

async function callTrackingQualityAudit(context, args = {}, opts = {}) {
  validateArgs(args);
  const shellContext = toShellPermissionContext(context);
  if (typeof context.workspaceId !== "string" || !context.workspaceId) fail("CONTEXT_REQUIRED", "可信 context.workspaceId 必填");
  const registry = shellRegistry(opts);
  if (typeof registry.validateToolCall !== "function") fail("SHELL_REGISTRY_MISSING", "shell validateToolCall 不可用");
  if (!(await registry.validateToolCall(NAME, args, shellContext))) fail("PERMISSION_DENIED", "需要 tool.use 和 attribution:read 权限");
  if (typeof opts.resolveWorkspaceId !== "function") fail("WORKSPACE_RESOLVER_REQUIRED", "需要可信 tenant → workspace 解析器，不能依赖客户端参数");
  const workspaceId = await opts.resolveWorkspaceId(shellContext.tenantId);
  if (typeof workspaceId !== "string" || !workspaceId) fail("NO_WORKSPACE", "当前租户没有可用工作区");
  if (context.workspaceId !== workspaceId && context.workspaceId !== "ws_" + shellContext.tenantId) fail("WORKSPACE_MISMATCH", "上下文工作区与租户映射不一致");
  let snapshot;
  if (opts.adapter && typeof opts.adapter.getQualityStats === "function") snapshot = await opts.adapter.getQualityStats(workspaceId);
  else if (opts.qualityStats && typeof opts.qualityStats.snapshot === "function") snapshot = await opts.qualityStats.snapshot(workspaceId);
  else fail("QUALITY_SOURCE_REQUIRED", "需要 U6 正在使用的 adapter/qualityStats 实例；禁止新建空统计冒充真实数据");
  return buildTrackingQualityReport(snapshot, workspaceId, opts.now ? new Date(opts.now()).toISOString() : new Date().toISOString());
}
function registerTrackingQualityAuditTool(opts = {}) {
  const registry = shellRegistry(opts);
  if (typeof registry.registerTool !== "function") fail("SHELL_REGISTRY_MISSING", "shell registerTool 不可用");
  const definition = trackingQualityAuditToolDefinition(opts.toolOverrides);
  registry.registerTool({ ...definition, execute: (args, context) => callTrackingQualityAudit(context, args, opts) });
  return { tool: definition, outputSchema: reportSchema, registry: "shell", shellModified: false };
}
module.exports = { trackingQualityAuditToolDefinition, registerTrackingQualityAuditTool, callTrackingQualityAudit, buildTrackingQualityReport };
