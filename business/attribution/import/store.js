"use strict";
/**
 * A9/A22 · 导入任务 PostgreSQL 仓储；上传文件仍保存在受控本地目录。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createImportStore(opts = {}) {
  const pool = opts.pool;
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("createImportStore 需要 PostgreSQL pool（connect）");
  }
  const root =
    opts.storageDir ||
    process.env.PT_IMPORT_STORAGE_DIR ||
    path.join(__dirname, "..", "..", "..", "analytics", "data", "imports");

  function ensureDir(tenantId) {
    const dir = path.join(root, tenantId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function withTenant(tenantId, fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function decodeJob(row) {
    if (!row) return null;
    return typeof row.job === "string" ? JSON.parse(row.job) : row.job;
  }

  return {
    root,
    async createJob(row) {
      return withTenant(row.tenantId, async (client) => {
        const result = await client.query(
          `INSERT INTO attribution_import_jobs
             (import_id, tenant_id, workspace_id, created_at, updated_at, job)
           VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
           RETURNING job`,
          [
            row.importId,
            row.tenantId,
            row.workspaceId,
            row.createdAt,
            row.updatedAt,
            JSON.stringify(row),
          ]
        );
        return decodeJob(result.rows[0]);
      });
    },
    async getJob(tenantId, importId) {
      return withTenant(tenantId, async (client) => {
        const result = await client.query(
          `SELECT job FROM attribution_import_jobs
           WHERE tenant_id = $1::uuid AND import_id::text = $2`,
          [tenantId, importId]
        );
        return decodeJob(result.rows[0]);
      });
    },
    async updateJob(tenantId, importId, patch) {
      return withTenant(tenantId, async (client) => {
        const updatedAt = new Date().toISOString();
        const result = await client.query(
          `UPDATE attribution_import_jobs
           SET job = job || $3::jsonb || jsonb_build_object('updatedAt', $4::text),
               updated_at = $4::timestamptz
           WHERE tenant_id = $1::uuid AND import_id = $2::uuid
           RETURNING job`,
          [tenantId, importId, JSON.stringify(patch || {}), updatedAt]
        );
        return decodeJob(result.rows[0]);
      });
    },
    async listJobs(tenantId, limit = 50) {
      return withTenant(tenantId, async (client) => {
        const result = await client.query(
          `SELECT job FROM attribution_import_jobs
           WHERE tenant_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT $2`,
          [tenantId, Math.max(0, Number(limit) || 0)]
        );
        return result.rows.map(decodeJob);
      });
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
