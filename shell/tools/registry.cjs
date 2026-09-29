"use strict";

/**
 * shell/tools/registry.cjs - Tool Registry 实现
 * ============================================================================
 * 参考 business/attribution/contracts/tool-registration.json 的接口期望。
 * 实现 registerTool()/listToolsForWorkspace()/validateToolCall()/executeTool()。
 * 每个工具必须声明 requiredPermissions。
 * ============================================================================
 */

const { checkPermission } = require("../permissions/index.cjs");

// 工具存储（内存中，后续可持久化）
const tools = new Map();

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
  } = toolDefinition;

  // 基本验证
  if (!name || !type || !version || !description || !inputSchema || !outputType || !riskLevel || !requiredPermissions) {
    throw new Error("工具定义缺少必要字段");
  }

  if (!Array.isArray(requiredPermissions)) {
    throw new Error("requiredPermissions 必须是数组");
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
  // B2: 暂不实现真实执行，仅返回模拟结果
  const isValid = await validateToolCall(toolName, args, context);
  if (!isValid) {
    throw new Error(`工具调用验证失败: ${toolName}`);
  }

  return {
    success: true,
    result: `模拟执行 ${toolName} 成功`,
    metadata: {
      toolName,
      executedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  registerTool,
  listToolsForWorkspace,
  validateToolCall,
  executeTool,
};