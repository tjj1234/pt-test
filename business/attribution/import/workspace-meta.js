"use strict";
/**
 * A16 · 工作区级归因元数据（firstConnectedAt 等）
 * 与单次 AdImportJob 分开存；首次成功导入写入后不再变。
 */
const fs = require("node:fs");
const path = require("node:path");

function createWorkspaceMetaStore(opts = {}) {
  const root =
    opts.storageDir ||
    process.env.PT_IMPORT_STORAGE_DIR ||
    path.join(__dirname, "..", "..", "..", "analytics", "data", "imports");
  const memory = new Map();

  function metaPath(workspaceId) {
    const dir = path.join(root, "_workspaces");
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(workspaceId).replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(dir, safe + ".json");
  }

  function load(workspaceId) {
    if (memory.has(workspaceId)) return { ...memory.get(workspaceId) };
    const p = metaPath(workspaceId);
    if (fs.existsSync(p)) {
      try {
        const row = JSON.parse(fs.readFileSync(p, "utf8"));
        memory.set(workspaceId, row);
        return { ...row };
      } catch {
        /* fallthrough */
      }
    }
    return { workspaceId, firstConnectedAt: null, updatedAt: null };
  }

  function save(row) {
    memory.set(row.workspaceId, { ...row });
    fs.writeFileSync(metaPath(row.workspaceId), JSON.stringify(row, null, 2));
    return { ...row };
  }

  /**
   * 首次导入成功时打点；已有 firstConnectedAt 则原样返回。
   */
  function markFirstConnected(workspaceId, atIso) {
    const row = load(workspaceId);
    if (row.firstConnectedAt) return row;
    const now = atIso || new Date().toISOString();
    return save({
      workspaceId,
      firstConnectedAt: now,
      updatedAt: now,
    });
  }

  return { load, save, markFirstConnected, root };
}

module.exports = { createWorkspaceMetaStore };
