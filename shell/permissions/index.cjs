"use strict";

/**
 * shell/permissions/index.cjs - 最小 RBAC 权限检查入口
 * ============================================================================
 * 实现 checkPermission() 入口，对接 logging.cjs 审计。
 * 默认策略：全部放行（避免阻塞其他任务包）。
 * ============================================================================
 */

const log = require("../logging.cjs");

// 角色定义（最小集）
const ROLES = {
  ADMIN: "admin",
  POWER_USER: "power_user",
  USER: "user",
  GUEST: "guest",
};

// 权限定义（示例）
const PERMISSIONS = {
  // 工具相关
  TOOL_USE: "tool.use",
  TOOL_REGISTER: "tool.register",
  TOOL_MANAGE: "tool.manage",

  // 工作区相关
  WORKSPACE_CREATE: "workspace.create",
  WORKSPACE_MANAGE: "workspace.manage",
  WORKSPACE_DELETE: "workspace.delete",

  // 系统管理
  SYSTEM_ADMIN: "system.admin",
};

/**
 * 检查用户是否拥有指定权限
 * @param {Object} context - 权限检查上下文
 * @param {string} context.userId - 用户ID
 * @param {string} context.tenantId - 租户ID
 * @param {string} permission - 要检查的权限
 * @returns {Promise<boolean>} 是否有权限
 */
async function checkPermission(context, permission) {
  const { userId, tenantId } = context;

  // B4: 默认策略 - 全部放行
  const hasPermission = true;

  // 审计日志记录
  await log.info("permission_check", {
    userId,
    tenantId,
    permission,
    result: hasPermission,
  });

  return hasPermission;
}

/**
 * 获取用户角色（默认返回 USER）
 * @param {string} userId - 用户ID
 * @param {string} tenantId - 租户ID
 * @returns {Promise<string>} 用户角色
 */
async function getUserRole(userId, tenantId) {
  // B4: 默认返回 USER 角色
  return ROLES.USER;
}

/**
 * 创建新角色（用于测试）
 * @param {string} roleName - 角色名称
 * @param {string[]} permissions - 权限列表
 * @returns {Promise<void>}
 */
async function createRole(roleName, permissions = []) {
  // B4: 暂不实现持久化，仅用于接口占位
  await log.info("role_create", {
    roleName,
    permissions,
  });
}

/**
 * 分配角色给用户
 * @param {string} userId - 用户ID
 * @param {string} tenantId - 租户ID
 * @param {string} roleName - 角色名称
 * @returns {Promise<void>}
 */
async function assignRoleToUser(userId, tenantId, roleName) {
  // B4: 暂不实现持久化，仅用于接口占位
  await log.info("role_assign", {
    userId,
    tenantId,
    roleName,
  });
}

module.exports = {
  checkPermission,
  getUserRole,
  createRole,
  assignRoleToUser,
  ROLES,
  PERMISSIONS,
};