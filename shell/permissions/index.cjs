"use strict";

/**
 * shell/permissions/index.cjs - RBAC 权限检查入口
 * ============================================================================
 * 实现 checkPermission() 入口，对接 logging.cjs 审计。
 * 真实权限检查，基于用户角色。
 * ============================================================================
 */

const log = require("../logging.cjs");
const path = require("path");
const { open } = require("../db.cjs");

// 权限定义
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

// 角色定义（最小集）
const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  ANALYST: "analyst",
  VIEWER: "viewer",
};

// 角色权限映射
const ROLE_PERMISSIONS = {
  [ROLES.OWNER]: [
    PERMISSIONS.TOOL_USE,
    PERMISSIONS.TOOL_REGISTER,
    PERMISSIONS.TOOL_MANAGE,
    PERMISSIONS.WORKSPACE_CREATE,
    PERMISSIONS.WORKSPACE_MANAGE,
    PERMISSIONS.WORKSPACE_DELETE,
    PERMISSIONS.SYSTEM_ADMIN,
  ],
  [ROLES.ADMIN]: [
    PERMISSIONS.TOOL_USE,
    PERMISSIONS.TOOL_REGISTER,
    PERMISSIONS.TOOL_MANAGE,
    PERMISSIONS.WORKSPACE_CREATE,
    PERMISSIONS.WORKSPACE_MANAGE,
    PERMISSIONS.WORKSPACE_DELETE,
  ],
  [ROLES.ANALYST]: [
    PERMISSIONS.TOOL_USE,
    PERMISSIONS.WORKSPACE_CREATE,
    PERMISSIONS.WORKSPACE_MANAGE,
  ],
  [ROLES.VIEWER]: [
    PERMISSIONS.WORKSPACE_CREATE,
  ],
};

// 默认角色权限映射（用于初始化）
const DEFAULT_ROLES = [
  {
    name: ROLES.OWNER,
    permissions: [
      PERMISSIONS.TOOL_USE,
      PERMISSIONS.TOOL_REGISTER,
      PERMISSIONS.TOOL_MANAGE,
      PERMISSIONS.WORKSPACE_CREATE,
      PERMISSIONS.WORKSPACE_MANAGE,
      PERMISSIONS.WORKSPACE_DELETE,
      PERMISSIONS.SYSTEM_ADMIN,
    ]
  },
  {
    name: ROLES.ADMIN,
    permissions: [
      PERMISSIONS.TOOL_USE,
      PERMISSIONS.TOOL_REGISTER,
      PERMISSIONS.TOOL_MANAGE,
      PERMISSIONS.WORKSPACE_CREATE,
      PERMISSIONS.WORKSPACE_MANAGE,
      PERMISSIONS.WORKSPACE_DELETE,
    ]
  },
  {
    name: ROLES.ANALYST,
    permissions: [
      PERMISSIONS.TOOL_USE,
      PERMISSIONS.WORKSPACE_CREATE,
      PERMISSIONS.WORKSPACE_MANAGE,
    ]
  },
  {
    name: ROLES.VIEWER,
    permissions: [
      PERMISSIONS.WORKSPACE_CREATE,
    ]
  }
];

// 数据库连接池（单例）
let dbPool = null;

async function getDb() {
  if (!dbPool) {
    const dataDir = path.join(__dirname, "..", "..", "db");
    dbPool = await open({ dataDir });
  }
  return dbPool.db;
}

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

  const userRole = await getUserRole(userId, tenantId);
  const hasPermission = ROLE_PERMISSIONS[userRole]?.includes(permission) || false;

  // 审计日志记录
  await log.info("permission_check", {
    userId,
    tenantId,
    permission,
    userRole,
    result: hasPermission,
  });

  return hasPermission;
}

/**
 * 获取用户角色
 * @param {string} userId - 用户ID
 * @param {string} tenantId - 租户ID
 * @returns {Promise<string>} 用户角色
 */
async function getUserRole(userId, tenantId) {
  const db = await getDb();
  const result = await db.query(
    "SELECT role FROM users WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId]
  );
  
  if (result.rows.length === 0) {
    return ROLES.VIEWER; // 默认角色
  }
  
  const role = result.rows[0].role;
  
  // B4-fix: 历史角色名兼容 ("member" -> "viewer")
  if (role === "member") {
    return ROLES.VIEWER;
  }
  
  return role || ROLES.VIEWER;
}

/**
 * 创建新角色（持久化到数据库）
 * @param {string} roleName - 角色名称
 * @param {string[]} permissions - 权限列表
 * @returns {Promise<void>}
 */
async function createRole(roleName, permissions = []) {
  const db = await getDb();
  
  // 检查角色是否已存在
  const existing = await db.query(
    "SELECT 1 FROM roles WHERE name = $1",
    [roleName]
  );
  
  if (existing.rows.length > 0) {
    throw new Error(`角色已存在: ${roleName}`);
  }
  
  // 创建角色
  await db.query(
    "INSERT INTO roles (name, permissions, created_at) VALUES ($1, $2, now())",
    [roleName, JSON.stringify(permissions)]
  );
  
  await log.info("role_create", {
    roleName,
    permissions,
  });
}

/**
 * 初始化默认角色（如果不存在）
 * @returns {Promise<void>}
 */
async function initializeDefaultRoles() {
  const db = await getDb();
  
  for (const roleDef of DEFAULT_ROLES) {
    try {
      await createRole(roleDef.name, roleDef.permissions);
    } catch (e) {
      // 如果角色已存在，继续下一个
      if (e.message.startsWith('角色已存在')) {
        continue;
      }
      throw e;
    }
  }
}

/**
 * 分配角色给用户
 * @param {string} userId - 用户ID
 * @param {string} tenantId - 租户ID
 * @param {string} roleName - 角色名称
 * @returns {Promise<void>}
 */
async function assignRoleToUser(userId, tenantId, roleName) {
  const db = await getDb();
  
  // 验证角色是否存在
  const roleExists = await db.query(
    "SELECT 1 FROM roles WHERE name = $1",
    [roleName]
  );
  
  if (roleExists.rows.length === 0) {
    throw new Error(`角色不存在: ${roleName}`);
  }
  
  // 更新用户角色
  await db.query(
    "UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3",
    [roleName, userId, tenantId]
  );
  
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
  initializeDefaultRoles,
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
};