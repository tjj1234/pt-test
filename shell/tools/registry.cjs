"use strict";

/**
 * shell/tools/registry.cjs - Tool Registry 实现
 * ============================================================================
 * 参考 business/attribution/contracts/tool-registration.json 的接口期望。
 * 实现 registerTool()/listToolsForWorkspace()/validateToolCall()/executeTool()。
 * 每个工具必须声明 requiredPermissions。
 * ============================================================================
 */

const { checkPermission, PERMISSIONS, ROLE_PERMISSIONS, ROLES } = require("../permissions/index.cjs");

// 工具存储（内存中，后续可持久化）
const tools = new Map();

// 工具执行函数映射：toolName -> executeFn(args, context)。executeTool() 按此分发真实执行。
const toolExecutors = new Map();

// 调用日志（可选注入）。server.cjs 启动时用 tool-calls.cjs 的 initToolCalls(db) 注入，
// 注入后 executeTool() 会在真实执行前后各写一条；未注入则静默跳过（兼容既有测试）。
let toolCallLogger = null;

/** 注入调用日志模块：形如 { start(entry)->{id}, finish(id, entry) }。 */
function setToolCallLogger(logger) {
  toolCallLogger = logger || null;
}

/** 生成参数/结果的简短摘要（截断到 500 字符，避免超大对象撑爆日志）。 */
function summarize(value) {
  if (value == null) return "";
  let s;
  try { s = typeof value === "string" ? value : JSON.stringify(value); }
  catch (e) { s = String(value); }
  s = String(s || "");
  return s.length > 500 ? s.slice(0, 500) + "…" : s;
}

/**
 * 注册工具
 * @param {Object} toolDefinition - 工具定义
 * @param {string} toolDefinition.name - 工具名称
 * @param {string} toolDefinition.type - 工具类型
 * @param {string} toolDefinition.version - 版本
 * @param {string} toolDefinition.description - 描述
 * @param {Object} toolDefinition.inputSchema - 输入模式
 * @param {string} toolDefinition.outputType - 输出类型
 * @param {string} toolDefinition.riskLevel - 风险级别
 * @param {string[]} toolDefinition.requiredPermissions - 所需权限
 * @param {string[]} [toolDefinition.requiredCredentials] - 所需凭证
 * @returns {boolean} 是否注册成功
 */
function registerTool(toolDefinition) {
  const {
    name,
    type,
    version,
    description,
    inputSchema,
    outputType,
    riskLevel,
    requiredPermissions,
    requiredCredentials = [],
    execute = null,
  } = toolDefinition;

  // 基本验证
  if (!name || !type || !version || !description || !inputSchema || !outputType || !riskLevel || !requiredPermissions) {
    throw new Error("工具定义缺少必要字段");
  }

  if (!Array.isArray(requiredPermissions)) {
    throw new Error("requiredPermissions 必须是数组");
  }

  // B11：工具声明的 requiredPermissions 如果基座权限模型里还没有，
  // 自动登记为默认权限（owner/admin 可用）。业务线需要更宽范围时，
  // 应在工具注册后显式修改 ROLE_PERMISSIONS 或联系基座调整。
  for (const permission of requiredPermissions) {
    if (typeof permission !== "string" || !permission) continue;
    if (!Object.values(PERMISSIONS).includes(permission)) {
      PERMISSIONS[permission.toUpperCase().replace(/[^A-Z0-9]/g, "_")] = permission;
      for (const role of [ROLES.OWNER, ROLES.ADMIN]) {
        const list = ROLE_PERMISSIONS[role];
        if (Array.isArray(list) && !list.includes(permission)) list.push(permission);
      }
    }
  }

  // 存储工具
  tools.set(name, {
    name,
    type,
    version,
    description,
    inputSchema,
    outputType,
    riskLevel,
    requiredPermissions,
    requiredCredentials,
  });

  // 若定义里直接带了执行函数，一并登记为 executor（等同于单独调 registerToolExecutor）。
  if (typeof execute === "function") {
    toolExecutors.set(name, execute);
  }

  return true;
}

/**
 * 注册工具的真实执行函数（供 executeTool 按工具名分发）。
 * @param {string} toolName - 工具名称
 * @param {Function} executeFn - 执行函数：async (args, context) => 任意可序列化结果
 * @returns {boolean} 是否注册成功
 */
function registerToolExecutor(toolName, executeFn) {
  if (!toolName || typeof executeFn !== "function") {
    throw new Error("registerToolExecutor 需要有效的 toolName 和 executeFn");
  }
  if (!tools.has(toolName)) {
    throw new Error(`工具尚未注册，无法绑定执行函数: ${toolName}`);
  }
  toolExecutors.set(toolName, executeFn);
  return true;
}

/**
 * 获取工作区可用的工具列表
 * @param {string} workspaceId - 工作区ID
 * @param {Object} context - 权限上下文
 * @returns {Promise<Object[]>} 工具列表
 */
async function listToolsForWorkspace(workspaceId, context) {
  const availableTools = [];

  for (const tool of tools.values()) {
    // 检查权限
    let hasPermission = true;
    for (const permission of tool.requiredPermissions) {
      if (!(await checkPermission(context, permission))) {
        hasPermission = false;
        break;
      }
    }

    if (hasPermission) {
      availableTools.push({
        name: tool.name,
        type: tool.type,
        version: tool.version,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputType: tool.outputType,
        riskLevel: tool.riskLevel,
      });
    }
  }

  return availableTools;
}

/**
 * 验证工具调用
 * @param {string} toolName - 工具名称
 * @param {Object} arguments - 调用参数
 * @param {Object} context - 权限上下文
 * @returns {Promise<boolean>} 是否验证通过
 */
async function validateToolCall(toolName, args, context) {
  const tool = tools.get(toolName);
  if (!tool) {
    throw new Error(`工具未找到: ${toolName}`);
  }

  // 权限检查
  for (const permission of tool.requiredPermissions) {
    if (!(await checkPermission(context, permission))) {
      return false;
    }
  }

  // TODO: 输入参数验证（根据 inputSchema）
  // B2: 暂不实现完整 JSON Schema 验证，仅检查必要字段存在性

  return true;
}

/**
 * 执行工具
 * @param {string} toolName - 工具名称
 * @param {Object} arguments - 调用参数
 * @param {Object} context - 执行上下文
 * @returns {Promise<Object>} 执行结果
 */
async function executeTool(toolName, args, context) {
  const isValid = await validateToolCall(toolName, args, context);
  if (!isValid) {
    throw new Error(`工具调用验证失败: ${toolName}`);
  }

  const executor = toolExecutors.get(toolName);
  const ctx = context || {};
  const startedAt = Date.now();

  // 执行前日志（真实执行前后各写一条）
  let logId = null;
  if (toolCallLogger) {
    try {
      const started = await toolCallLogger.start({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        toolName,
        inputSummary: summarize(args),
      });
      logId = started && started.id;
    } catch (e) {
      // 日志写入失败不应阻断工具执行（审计失败可观测，但不影响业务）。
    }
  }

  let resultValue = null;
  let status = "completed";
  let outputSummary = "";

  try {
    if (typeof executor === "function") {
      resultValue = await executor(args, ctx);
      outputSummary = summarize(resultValue);
    } else {
      // 未注册执行函数：返回空结果，不再返回硬编码的“模拟执行成功”字符串。
      status = "skipped";
      outputSummary = "";
    }
  } catch (err) {
    status = "failed";
    outputSummary = summarize(err && err.message ? err.message : err);
    if (logId != null && toolCallLogger) {
      try { await toolCallLogger.finish(logId, { outputSummary, durationMs: Date.now() - startedAt, tokenCount: 0, status }); } catch (e) {}
    }
    throw err;
  }

  if (logId != null && toolCallLogger) {
    try { await toolCallLogger.finish(logId, { outputSummary, durationMs: Date.now() - startedAt, tokenCount: 0, status }); } catch (e) {}
  }

  return {
    success: true,
    result: resultValue,
    metadata: {
      toolName,
      executedAt: new Date().toISOString(),
      executed: typeof executor === "function",
    },
  };
}

module.exports = {
  registerTool,
  registerToolExecutor,
  setToolCallLogger,
  listToolsForWorkspace,
  validateToolCall,
  executeTool,
};