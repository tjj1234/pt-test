"use strict";

/**
 * shell/workspace/index.cjs - Workspace 隔离与配额（最小版）
 * ============================================================================
 * 实现 createWorkspace()/getWorkspaceQuota()/suspendWorkspaceForQuota()。
 * 配额策略：5GB 存储、30/45/60/90 天回收节奏。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");

// 配额默认值
const DEFAULT_QUOTA = {
  storageBytes: 5 * 1024 * 1024 * 1024, // 5GB
  retentionDays: {
    tier1: 30, // 普通数据
    tier2: 45, // 重要数据
    tier3: 60, // 关键数据
    tier4: 90, // 归档数据
  },
};

// 工作区状态
const WORKSPACE_STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
};

// 工作区存储目录（与 db/、logs/ 同级）
const RUNTIME_DIR = path.join(__dirname, "..", "..", "runtime");
const WORKSPACES_DIR = path.join(RUNTIME_DIR, "workspaces");

// 确保工作区目录存在
function ensureWorkspacesDir() {
  if (!fs.existsSync(WORKSPACES_DIR)) {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * 创建工作区
 * @param {string} workspaceId - 工作区ID
 * @param {string} tenantId - 租户ID
 * @param {Object} [options] - 选项
 * @param {Object} [options.quota] - 自定义配额
 * @returns {Object} 工作区信息
 */
function createWorkspace(workspaceId, tenantId, options = {}) {
  ensureWorkspacesDir();

  const workspacePath = path.join(WORKSPACES_DIR, workspaceId);
  if (fs.existsSync(workspacePath)) {
    // 如果目录已存在，读取现有的 metadata
    const metadataPath = path.join(workspacePath, "metadata.json");
    if (fs.existsSync(metadataPath)) {
      const metadata = fs.readFileSync(metadataPath, "utf8");
      return JSON.parse(metadata);
    }
    // 如果目录存在但 metadata 不存在，抛错
    throw new Error(`工作区目录存在但元数据缺失: ${workspaceId}`);
  }

  const quota = options.quota || DEFAULT_QUOTA;
  const workspaceInfo = {
    id: workspaceId,
    tenantId: tenantId,
    status: WORKSPACE_STATUS.ACTIVE,
    createdAt: new Date().toISOString(),
    quota,
    usage: {
      storageBytes: 0,
      lastAccessed: new Date().toISOString(),
    },
  };

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "metadata.json"),
    JSON.stringify(workspaceInfo, null, 2),
    "utf8"
  );

  return workspaceInfo;
}

/**
 * 获取工作区配额
 * @param {string} workspaceId - 工作区ID
 * @returns {Object|null} 工作区信息或 null
 */
function getWorkspaceQuota(workspaceId) {
  const metadataPath = path.join(WORKSPACES_DIR, workspaceId, "metadata.json");
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  const metadata = fs.readFileSync(metadataPath, "utf8");
  return JSON.parse(metadata);
}

/**
 * 因配额问题暂停工作区
 * @param {string} workspaceId - 工作区ID
 * @param {string} reason - 暂停原因
 * @returns {boolean} 是否成功
 */
function suspendWorkspaceForQuota(workspaceId, reason = "quota_exceeded") {
  const workspaceInfo = getWorkspaceQuota(workspaceId);
  if (!workspaceInfo) {
    return false;
  }

  workspaceInfo.status = WORKSPACE_STATUS.SUSPENDED;
  workspaceInfo.suspendedAt = new Date().toISOString();
  workspaceInfo.suspendReason = reason;

  const metadataPath = path.join(WORKSPACES_DIR, workspaceId, "metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(workspaceInfo, null, 2), "utf8");

  return true;
}

/**
 * 更新工作区使用量
 * @param {string} workspaceId - 工作区ID
 * @param {number} storageBytes - 存储使用量（字节）
 * @returns {boolean} 是否成功
 */
function updateWorkspaceUsage(workspaceId, storageBytes) {
  const workspaceInfo = getWorkspaceQuota(workspaceId);
  if (!workspaceInfo) {
    return false;
  }

  workspaceInfo.usage.storageBytes = storageBytes;
  workspaceInfo.usage.lastAccessed = new Date().toISOString();

  // 检查是否超出配额
  if (storageBytes > workspaceInfo.quota.storageBytes) {
    workspaceInfo.status = WORKSPACE_STATUS.SUSPENDED;
    workspaceInfo.suspendedAt = new Date().toISOString();
    workspaceInfo.suspendReason = "storage_quota_exceeded";
  }

  const metadataPath = path.join(WORKSPACES_DIR, workspaceId, "metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(workspaceInfo, null, 2), "utf8");

  return true;
}

module.exports = {
  createWorkspace,
  getWorkspaceQuota,
  suspendWorkspaceForQuota,
  updateWorkspaceUsage,
  DEFAULT_QUOTA,
  WORKSPACE_STATUS,
};