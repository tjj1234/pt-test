"use strict";

const { fingerprint } = require("../contracts/phase1.cjs");

const ALLOWED_TOOLS = new Set([
  "media.route",
  "ga.query",
  "attribution.query",
  "attribution.quality",
  "tracking_quality_audit",
  "csv.analyze",
]);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function error(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }

function createHostToolHandler({ registry, context, mediaHandler, csvHandler }) {
  if (!registry || typeof registry.listToolsForWorkspace !== "function" || typeof registry.validateToolCall !== "function" || typeof registry.executeTool !== "function") throw new TypeError("A complete host tool registry is required");
  if (!context || typeof context.userId !== "string" || typeof context.tenantId !== "string" || typeof context.workspaceId !== "string") throw new TypeError("Trusted user, tenant and workspace context are required");
  const trustedContext = Object.freeze({ userId: context.userId, tenantId: context.tenantId, workspaceId: context.workspaceId });
  if (mediaHandler && typeof mediaHandler.handle !== "function") throw new TypeError("mediaHandler.handle must be a function");
  if (csvHandler && typeof csvHandler.handle !== "function") throw new TypeError("csvHandler.handle must be a function");

  async function handle(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw error("TOOL_REQUEST_INVALID", "Tool request is invalid");
    const { name } = request;
    if (typeof name !== "string" || !ALLOWED_TOOLS.has(name)) throw error("TOOL_NOT_ALLOWED", "Tool is not available through the host RPC");
    if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) throw error("TOOL_REQUEST_INVALID", "Tool request ID is invalid");
    if (name === "media.route" && !mediaHandler) throw error("RUN_REQUIRED", "media.route requires a durable Run");
    if (name === "csv.analyze" && !csvHandler) throw error("RUN_REQUIRED", "csv.analyze requires a durable Run");

    let args;
    try { fingerprint(request.args); args = structuredClone(request.args); }
    catch { throw error("TOOL_INPUT_INVALID", "Tool arguments must be bounded JSON"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw error("TOOL_INPUT_INVALID", "Tool arguments must be an object");

    // Resolve exposure using the caller's trusted RBAC context before schema
    // validation. This distinguishes denied tools from malformed arguments and
    // ensures an RPC cannot self-assign user/tenant/workspace identity.
    const visible = await registry.listToolsForWorkspace(trustedContext.workspaceId, trustedContext);
    const definition = visible.find((tool) => tool.name === name);
    if (!definition) throw error("TOOL_PERMISSION_DENIED", "Tool permission denied", 403);
    const properties = definition.inputSchema && definition.inputSchema.properties;
    if (!properties || Object.keys(args).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) {
      throw error("TOOL_INPUT_INVALID", "Tool arguments contain unsupported fields");
    }
    let valid;
    try { valid = await registry.validateToolCall(name, args, trustedContext); }
    catch { throw error("TOOL_INPUT_INVALID", "Tool arguments failed schema validation"); }
    if (!valid) throw error("TOOL_INPUT_INVALID", "Tool arguments failed schema validation");

    if (name === "media.route") {
      return mediaHandler.handle({ requestId: request.requestId, name, args, signal: request.signal });
    }
    if (name === "csv.analyze") {
      return csvHandler.handle({ requestId: request.requestId, name, args, signal: request.signal });
    }
    const executed = await registry.executeTool(name, args, trustedContext);
    if (!executed || executed.success !== true) throw error("TOOL_EXECUTION_FAILED", "Tool did not return a successful execution result", 502);
    return executed.result;
  }

  return {
    handle,
    async drain() { if (mediaHandler && typeof mediaHandler.drain === "function") await mediaHandler.drain(); },
  };
}

module.exports = { ALLOWED_TOOLS, createHostToolHandler };
