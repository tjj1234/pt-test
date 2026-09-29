"use strict";
/**
 * A9 · 导入任务内存仓储（同进程；文件落盘到受控目录）
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createImportStore(opts = {}) {
  const root =
    opts.storageDir ||
    process.env.PT_IMPORT_STORAGE_DIR ||
    path.join(__dirname, "..", "..", "..", "analytics", "data", "imports");
  const jobs = new Map();

  function ensureDir(tenantId) {
    const dir = path.join(root, tenantId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    root,
    createJob(row) {
      jobs.set(row.importId, { ...row });
      return jobs.get(row.importId);
    },
    getJob(tenantId, importId) {
      const j = jobs.get(importId);
      if (!j || j.tenantId !== tenantId) return null;
      return j;
    },
    updateJob(tenantId, importId, patch) {
      const j = this.getJob(tenantId, importId);
      if (!j) return null;
      Object.assign(j, patch, { updatedAt: new Date().toISOString() });
      return j;
    },
    listJobs(tenantId, limit = 50) {
      return [...jobs.values()]
        .filter((j) => j.tenantId === tenantId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },
    saveFile(tenantId, sourceFileId, buffer, ext) {
      const dir = ensureDir(tenantId);
      const abs = path.join(dir, sourceFileId + (ext.startsWith(".") ? ext : "." + ext));
      fs.writeFileSync(abs, buffer);
      return abs;
    },
    readFile(tenantId, sourceFileId) {
      const dir = path.join(root, tenantId);
      for (const ext of [".csv", ".xlsx", ".xls", ".bin"]) {
        const abs = path.join(dir, sourceFileId + ext);
        if (fs.existsSync(abs)) return { abs, buffer: fs.readFileSync(abs) };
      }
      return null;
    },
    newIds() {
      return {
        importId: crypto.randomUUID(),
        sourceFileId: crypto.randomUUID(),
      };
    },
  };
}

module.exports = { createImportStore };
