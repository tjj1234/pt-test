"use strict";
/**
 * A8 · 归因 Registry 生产入口
 * - Tool：基座 shell/tools/registry.cjs（真实 registerTool + checkPermission）
 * - Panel：基座无 Panel Registry，继续用 mock 内存表 / 反代（明确不做）
 */
const { createMockRegistry, DEFAULT_PANEL, DEFAULT_TOOL } = require("./mock");
const {
  attributionToolDefinition,
  toShellPermissionContext,
  registerAttributionQueryTool,
  callAttributionQuery,
} = require("./tool");
const { PERMISSIONS } = require("../../../shell/permissions/index.cjs");
const ATTRIBUTION_READ = PERMISSIONS.ATTRIBUTION_READ;
const trackingQualityAudit = require("../skills/tracking-quality-audit");

/**
 * 生产路径：工具走 shell；面板仍 mock（无基座 Panel Registry 可接）。
 */
function createAttributionRegistry(opts = {}) {
  const panelRegistry = opts.panelRegistry || createMockRegistry();

  function registerAttributionDefaults() {
    const toolReg = registerAttributionQueryTool(opts);
    let panel = null;
    try {
      panel = panelRegistry.registerPanel({ ...DEFAULT_PANEL, version: "1.0.0-a8" });
    } catch (err) {
      if (err && err.code === "DUP_PANEL") {
        panel = panelRegistry.getPanel(DEFAULT_PANEL.id);
      } else {
        throw err;
      }
    }
    return {
      panel,
      tool: toolReg.tool,
      grant: toolReg.grant,
      panelRegistry: "mock",
      toolRegistry: "shell",
      dshConnected: false,
      shellModified: false,
      panelContractNote:
        "基座无 Panel Registry；面板继续反代，不在 A8 范围",
    };
  }

  return {
    kind: "shell-tools+mock-panels",
    panelRegistry,
    registerAttributionDefaults,
    registerAttributionQueryTool: () => registerAttributionQueryTool(opts),
    callQuery: (ctx, args, extra) =>
      callAttributionQuery(ctx, args, { ...opts, ...extra }),
    toShellPermissionContext,
  };
}

module.exports = {
  ...trackingQualityAudit,
  createAttributionRegistry,
  createMockRegistry,
  DEFAULT_PANEL,
  DEFAULT_TOOL,
  attributionToolDefinition,
  toShellPermissionContext,
  registerAttributionQueryTool,
  callAttributionQuery,
  ATTRIBUTION_READ,
};
