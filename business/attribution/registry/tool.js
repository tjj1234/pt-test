"use strict";
/**
 * A8 · attribution.query → 基座 shell/tools/registry.cjs#registerTool
 * 权限经真实 validateToolCall → checkPermission；不再走 Mock「恒放行」。
 */
const toolContract = require("../contracts/tool-registration.json");
const { DEFAULT_TOOL } = require("./mock");
const { ensureAttributionReadGranted, ATTRIBUTION_READ } = require("./permissions-grant");

function loadShellToolRegistry(override) {
  if (override) return override;
  return require("../../../shell/tools/registry.cjs");
}

function attributionToolDefinition(overrides = {}) {
  const base =
    (toolContract.examples && toolContract.examples[0]) || DEFAULT_TOOL;
  return {
    ...base,
    ...overrides,
    name: "attribution.query",
    type: "workflow",
    riskLevel: "read",
    requiredPermissions: [ATTRIBUTION_READ],
    version: overrides.version || "1.0.0-a8",
  };
}

/**
 * AttributionContext → shell checkPermission 上下文
 * shell 认 { userId, tenantId }；业务侧常见 actorId / userId。
 */
function toShellPermissionContext(attributionContext) {
  if (!attributionContext || !attributionContext.tenantId) {
    throw Object.assign(new Error("AttributionContext.tenantId 必填"), {
      code: "CONTEXT_REQUIRED",
    });
  }
  const userId =
    attributionContext.userId ||
    attributionContext.actorId ||
    attributionContext.user_id ||
    null;
  if (!userId) {
    throw Object.assign(new Error("AttributionContext.userId/actorId 必填（供 checkPermission）"), {
      code: "CONTEXT_REQUIRED",
    });
  }
  return {
    userId: String(userId),
    tenantId: String(attributionContext.tenantId),
  };
}

/**
 * 用真实 registerTool 注册 attribution.query，并确保 attribution:read 角色映射就绪。
 */
function registerAttributionQueryTool(opts = {}) {
  const grant = ensureAttributionReadGranted({
    permissionsModule: opts.permissionsModule,
    grantRoles: opts.grantRoles,
  });
  const shellTools = loadShellToolRegistry(opts.shellTools);
  if (typeof shellTools.registerTool !== "function") {
    throw Object.assign(new Error("shell registerTool 不可用"), {
      code: "SHELL_REGISTRY_MISSING",
    });
  }
  const tool = attributionToolDefinition(opts.toolOverrides || {});
  shellTools.registerTool(tool);
  return {
    tool,
    grant,
    toolContractId: toolContract.$id,
    registry: "shell",
    shellModified: false,
  };
}

/**
 * 经真实 validateToolCall（内部 checkPermission）后执行查询。
 * deps.workflows.queryFunnelPanel 可选；缺省则退回 shell executeTool 桩。
 */
async function callAttributionQuery(attributionContext, args, opts = {}) {
  if (!attributionContext || !attributionContext.tenantId || !attributionContext.workspaceId) {
    throw Object.assign(new Error("AttributionContext 必填（tenantId + workspaceId）"), {
      code: "CONTEXT_REQUIRED",
    });
  }
  const shellTools = loadShellToolRegistry(opts.shellTools);
  const shellCtx = toShellPermissionContext(attributionContext);
  const toolName = (opts.toolName || "attribution.query");

  if (typeof shellTools.validateToolCall !== "function") {
    throw Object.assign(new Error("shell validateToolCall 不可用"), {
      code: "SHELL_REGISTRY_MISSING",
    });
  }

  const allowed = await shellTools.validateToolCall(toolName, args || {}, shellCtx);
  if (!allowed) {
    throw Object.assign(new Error("权限不足：需要 attribution:read"), {
      code: "PERMISSION_DENIED",
      permission: ATTRIBUTION_READ,
    });
  }

  if (opts.workflows && typeof opts.workflows.queryFunnelPanel === "function") {
    return opts.workflows.queryFunnelPanel(attributionContext, args || {});
  }
  if (typeof shellTools.executeTool === "function") {
    return shellTools.executeTool(toolName, args || {}, shellCtx);
  }
  return { ok: true, tool: toolName, args };
}

module.exports = {
  attributionToolDefinition,
  toShellPermissionContext,
  registerAttributionQueryTool,
  callAttributionQuery,
};
