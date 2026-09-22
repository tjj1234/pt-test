"use strict";
/**
 * A6 · Mock Panel / Tool Registry（不接 DSH、不改基座）
 */
const panelContract = require("../contracts/panel-registration.json");
const toolContract = require("../contracts/tool-registration.json");

const DEFAULT_PANEL = Object.freeze({
  id: "powertokens-attribution",
  businessLine: "attribution",
  template: "saas_token_marketplace",
  version: "1.0.0-a6",
  requiredPermissions: ["attribution:read"],
  tabs: ["overview", "creatives", "users", "product", "health"],
  dataSource: "workflow",
});

const DEFAULT_TOOL = Object.freeze({
  name: "attribution.query",
  type: "workflow",
  version: "1.0.0-a6",
  description: "查询指定时间范围内的归因漏斗和素材表现",
  inputSchema: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string", format: "date" },
      to: { type: "string", format: "date" },
      platform: { type: "string", enum: ["google", "meta", "x"] },
      country: { type: "string" },
    },
  },
  outputType: "data",
  riskLevel: "read",
  requiredPermissions: ["attribution:read"],
  requiredCredentials: ["attribution-data:read"],
});

function createMockRegistry() {
  const panels = new Map();
  const tools = new Map();

  return {
    kind: "mock",
    registerPanel(registration) {
      const id = registration && registration.id;
      if (!id) throw new Error("panel.id 必填");
      if (registration.dataSource !== "workflow") {
        throw Object.assign(new Error("Panel dataSource 必须为 workflow"), {
          code: "BAD_DATASOURCE",
        });
      }
      if (panels.has(id)) throw Object.assign(new Error("panel 已注册"), { code: "DUP_PANEL" });
      panels.set(id, { ...registration, registeredAt: new Date().toISOString() });
      return panels.get(id);
    },
    registerTool(registration) {
      const name = registration && registration.name;
      if (!name) throw new Error("tool.name 必填");
      if (registration.riskLevel !== "read") {
        throw Object.assign(new Error("attribution.query riskLevel 必须 read"), {
          code: "BAD_RISK",
        });
      }
      if (tools.has(name)) throw Object.assign(new Error("tool 已注册"), { code: "DUP_TOOL" });
      tools.set(name, { ...registration, registeredAt: new Date().toISOString() });
      return tools.get(name);
    },
    getPanel(id) {
      return panels.get(id) || null;
    },
    getTool(name) {
      return tools.get(name) || null;
    },
    listPanels() {
      return [...panels.values()];
    },
    listTools() {
      return [...tools.values()];
    },
    registerAttributionDefaults() {
      const panel = this.registerPanel({ ...DEFAULT_PANEL });
      const tool = this.registerTool({ ...DEFAULT_TOOL });
      return {
        panel,
        tool,
        panelContractId: panelContract.$id,
        toolContractId: toolContract.$id,
        dshConnected: false,
        shellModified: false,
      };
    },
  };
}

module.exports = { createMockRegistry, DEFAULT_PANEL, DEFAULT_TOOL };
