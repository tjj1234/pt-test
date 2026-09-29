"use strict";
/**
 * A8 · 业务线权限授予（不改 shell 文件）
 *
 * 基座 B4 的 ROLE_PERMISSIONS 只有 tool.use / workspace.* 等通用权，
 * 尚未内置 attribution:read（见 BASE-CONTRACT-GAP BG-02）。
 * 真实 checkPermission() 读的是进程内 ROLE_PERMISSIONS，因此业务线在
 * 注册工具时把 attribution:read 挂到 owner/admin/analyst（不含 viewer），
 * 让「Viewer 被拦 / 有权限角色放行」能走通真实 checkPermission 路径。
 */
const ATTRIBUTION_READ = "attribution:read";

function loadPermissionsModule(override) {
  if (override) return override;
  return require("../../../shell/permissions/index.cjs");
}

/**
 * 确保 attribution:read 已授予可读写分析角色；Viewer 明确不授予。
 * @returns {{ permission: string, grantedTo: string[] }}
 */
function ensureAttributionReadGranted(opts = {}) {
  const mod = loadPermissionsModule(opts.permissionsModule);
  const { ROLE_PERMISSIONS, ROLES, PERMISSIONS } = mod;
  if (!ROLE_PERMISSIONS || !ROLES) {
    throw Object.assign(new Error("shell permissions 模块缺少 ROLE_PERMISSIONS/ROLES"), {
      code: "PERMISSIONS_MODULE_INVALID",
    });
  }

  if (PERMISSIONS && PERMISSIONS.ATTRIBUTION_READ == null) {
    PERMISSIONS.ATTRIBUTION_READ = ATTRIBUTION_READ;
  }

  const grantRoles = opts.grantRoles || [ROLES.OWNER, ROLES.ADMIN, ROLES.ANALYST];
  for (const role of grantRoles) {
    const list = ROLE_PERMISSIONS[role];
    if (!Array.isArray(list)) continue;
    if (!list.includes(ATTRIBUTION_READ)) list.push(ATTRIBUTION_READ);
  }

  const viewerList = ROLE_PERMISSIONS[ROLES.VIEWER];
  if (Array.isArray(viewerList)) {
    const idx = viewerList.indexOf(ATTRIBUTION_READ);
    if (idx >= 0) viewerList.splice(idx, 1);
  }

  return { permission: ATTRIBUTION_READ, grantedTo: [...grantRoles] };
}

module.exports = {
  ATTRIBUTION_READ,
  ensureAttributionReadGranted,
};
