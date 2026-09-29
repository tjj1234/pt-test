"use strict";
/**
 * A2 · SQL Repository（复用现有 pool；禁止 new Pool / 第二套连接）
 * A13 后表启用 FORCE RLS：读写须在事务内 set_config('app.current_tenant_id', …)。
 */
const fs = require("node:fs");
const path = require("node:path");
const { assertContext } = require("./mock");

const SCHEMA_PATH = path.join(__dirname, "..", "schema", "a2_raw_dlq.sql");

async function withTenant(pool, tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function createSqlPersistence(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("createSqlPersistence 需要现有 pool（query + connect），禁止自建连接");
  }

  return {
    kind: "sql",
    async ensureSchema() {
      const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
      await pool.query(sql);
      return true;
    },
    async insertRawEvent(row) {
      assertContext({ tenantId: row.tenantId, workspaceId: row.workspaceId });
      return withTenant(pool, row.tenantId, async (client) => {
        try {
          const r = await client.query(
            `INSERT INTO attribution_raw_events
               (tenant_id, workspace_id, event_id, webhook_id, raw_event, parse_status, request_id, received_at)
             VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb, $6, $7, COALESCE($8::timestamptz, now()))
             ON CONFLICT (tenant_id, event_id) WHERE event_id IS NOT NULL
             DO NOTHING
             RETURNING id`,
            [
              row.tenantId,
              row.workspaceId,
              row.eventId || null,
              row.webhookId || null,
              JSON.stringify(row.rawEvent),
              row.parseStatus || "received",
              row.requestId || null,
              row.receivedAt || null,
            ]
          );
          if (r.rows[0]) return { id: r.rows[0].id, inserted: true };
          return { id: null, inserted: false };
        } catch (err) {
          if (row.eventId) {
            const ex = await client.query(
              `SELECT id FROM attribution_raw_events
                WHERE tenant_id = $1::uuid AND event_id = $2::uuid LIMIT 1`,
              [row.tenantId, row.eventId]
            );
            if (ex.rows[0]) return { id: ex.rows[0].id, inserted: false };
          }
          const r2 = await client.query(
            `INSERT INTO attribution_raw_events
               (tenant_id, workspace_id, event_id, webhook_id, raw_event, parse_status, request_id)
             VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb, $6, $7)
             RETURNING id`,
            [
              row.tenantId,
              row.workspaceId,
              row.eventId || null,
              row.webhookId || null,
              JSON.stringify(row.rawEvent),
              row.parseStatus || "received",
              row.requestId || null,
            ]
          );
          return { id: r2.rows[0].id, inserted: true };
        }
      });
    },
    async insertDlq(row) {
      assertContext({ tenantId: row.tenantId, workspaceId: row.workspaceId });
      return withTenant(pool, row.tenantId, async (client) => {
        const r = await client.query(
          `INSERT INTO attribution_event_dlq
             (tenant_id, workspace_id, event_id, webhook_id, reason, error_class, raw_event, envelope, attempts)
           VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
           RETURNING id`,
          [
            row.tenantId,
            row.workspaceId,
            row.eventId || null,
            row.webhookId || null,
            row.reason,
            row.errorClass || "permanent",
            JSON.stringify(row.rawEvent || {}),
            row.envelope ? JSON.stringify(row.envelope) : null,
            row.attempts || 0,
          ]
        );
        return { id: r.rows[0].id, inserted: true };
      });
    },
    async listDlq(ctx, opts = {}) {
      assertContext(ctx);
      const limit = Math.min(Number(opts.limit) || 50, 200);
      const openOnly = opts.openOnly !== false;
      return withTenant(pool, ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
                  event_id::text AS "eventId", webhook_id AS "webhookId",
                  reason, error_class AS "errorClass", raw_event AS "rawEvent",
                  attempts, created_at AS "createdAt", resolved_at AS "resolvedAt", resolution
             FROM attribution_event_dlq
            WHERE tenant_id = $1::uuid
              AND ($2::boolean = false OR resolved_at IS NULL)
            ORDER BY created_at DESC
            LIMIT $3`,
          [ctx.tenantId, openOnly, limit]
        );
        return r.rows;
      });
    },
    async getRawEvent(ctx, eventId) {
      assertContext(ctx);
      return withTenant(pool, ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
                  event_id::text AS "eventId", raw_event AS "rawEvent",
                  parse_status AS "parseStatus", received_at AS "receivedAt"
             FROM attribution_raw_events
            WHERE tenant_id = $1::uuid AND event_id = $2::uuid
            LIMIT 1`,
          [ctx.tenantId, eventId]
        );
        return r.rows[0] || null;
      });
    },
    async listRawEvents(ctx, opts = {}) {
      assertContext(ctx);
      const limit = Math.min(Number(opts.limit) || 50, 200);
      return withTenant(pool, ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
                  event_id::text AS "eventId", raw_event AS "rawEvent",
                  parse_status AS "parseStatus", received_at AS "receivedAt"
             FROM attribution_raw_events
            WHERE tenant_id = $1::uuid
            ORDER BY received_at DESC
            LIMIT $2`,
          [ctx.tenantId, limit]
        );
        return r.rows;
      });
    },
  };
}

module.exports = { createSqlPersistence, SCHEMA_PATH, withTenant };
