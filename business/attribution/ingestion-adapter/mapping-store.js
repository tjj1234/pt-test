"use strict";
/**
 * A17 · 工作区级事件映射配置存储
 */
const fs = require("node:fs");
const path = require("node:path");
const { EVENT_NAMES } = require("../contracts/invariants");

const ALLOWED_TARGETS = new Set([...EVENT_NAMES, "ignore"]);

function createEventMappingStore(opts = {}) {
  const root =
    opts.storageDir ||
    process.env.PT_EVENT_MAPPING_DIR ||
    path.join(__dirname, "..", "..", "..", "analytics", "data", "event-mappings");
  const memory = new Map();

  function filePath(workspaceId) {
    fs.mkdirSync(root, { recursive: true });
    const safe = String(workspaceId).replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(root, safe + ".json");
  }

  function load(workspaceId) {
    if (!workspaceId) throw Object.assign(new Error("workspaceId 必填"), { code: "WORKSPACE_REQUIRED" });
    if (memory.has(workspaceId)) return structuredClone(memory.get(workspaceId));
    const p = filePath(workspaceId);
    if (fs.existsSync(p)) {
      try {
        const row = JSON.parse(fs.readFileSync(p, "utf8"));
        memory.set(workspaceId, row);
        return structuredClone(row);
      } catch {
        /* fallthrough */
      }
    }
    return {
      workspaceId,
      mappings: {},
      updatedAt: null,
      updatedBy: null,
    };
  }

  function save(row) {
    const normalized = {
      workspaceId: row.workspaceId,
      mappings: { ...(row.mappings || {}) },
      updatedAt: row.updatedAt || new Date().toISOString(),
      updatedBy: row.updatedBy == null ? null : String(row.updatedBy),
    };
    for (const [k, v] of Object.entries(normalized.mappings)) {
      if (!ALLOWED_TARGETS.has(v)) {
        throw Object.assign(new Error(`非法映射目标: ${k}→${v}`), { code: "BAD_MAPPING_TARGET" });
      }
    }
    memory.set(normalized.workspaceId, normalized);
    fs.writeFileSync(filePath(normalized.workspaceId), JSON.stringify(normalized, null, 2));
    return structuredClone(normalized);
  }

  function putMappings(workspaceId, mappings, updatedBy) {
    const current = load(workspaceId);
    const nextMaps = { ...(current.mappings || {}) };
    for (const [k, v] of Object.entries(mappings || {})) {
      if (v === null || v === undefined) delete nextMaps[k];
      else nextMaps[k] = v;
    }
    return save({
      workspaceId,
      mappings: nextMaps,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy || null,
    });
  }

  function resolve(workspaceId, rawName) {
    const cfg = load(workspaceId);
    const key = String(rawName || "");
    if (Object.prototype.hasOwnProperty.call(cfg.mappings, key)) {
      return { target: cfg.mappings[key], configured: true };
    }
    // 已是白名单原名 → 直通
    if (EVENT_NAMES.includes(key)) {
      return { target: key, configured: false, passthrough: true };
    }
    return { target: null, configured: false };
  }

  return { load, save, putMappings, resolve, root, ALLOWED_TARGETS };
}

module.exports = { createEventMappingStore, ALLOWED_TARGETS: new Set([...EVENT_NAMES, "ignore"]) };
