/**
 * 交付版 · 真依赖接线
 * ============================================================================
 * 后端把 6 个依赖做成参数注入，此前全部是「内存实现」（无真库可用）。
 * 本文件把它们全部换成**真查库**：
 *
 *   verifyAnalyticsToken  → analytics_tokens 表（SHA-256 反查）
 *   resolveEndpoint       → webhook_endpoints 表
 *   loadAuditLogs         → ss_gtm_debug_logs 表（事务 + set_config + 显式 WHERE 双保险）
 *   loadConfigFindings    → gtm_config_findings 表
 *   enqueue               → 内存队列 → ingest worker → **真写 pt_events**
 *   resolveWorkspaceId    → 由 token 派生的租户映射到广告库 workspace_id
 *
 * 设计要点：
 *   · 两张鉴权表（token / 端点）**故意不加 RLS** —— 校验时还不知道租户，
 *     正是要靠 token/secret 反查出租户。它们只存哈希，不存明文。
 *   · 带 tenant_id 的三张业务表走**双保险**：事务内 set_config + 显式 WHERE。
 * ============================================================================
 */
"use strict";

const { sha256Hex } = require("./db.cjs");

// ---------------------------------------------------------------------------
// ① verifyAnalyticsToken：只读分析 token 反查
// ---------------------------------------------------------------------------

/**
 * @param {object} pool pg 兼容连接池
 * @returns {(token: string) => Promise<{tenant_id:string, scopes:string[], expires_at:number|null}|null>}
 */
function createTokenVerifier(pool) {
  return async function verifyAnalyticsToken(token) {
    if (typeof token !== "string" || token.length === 0) return null;
    const hash = sha256Hex(token);
    const res = await pool.query(
      `SELECT tenant_id::text AS tenant_id, scopes, expires_at, status
         FROM analytics_tokens
        WHERE token_hash = $1`,
      [hash]
    );
    const row = res.rows[0];
    if (!row) return null;              // 未知 token / 读写 key 混用 → 路由层 403
    if (row.status !== "active") return null;

    let expiresAt = null;
    if (row.expires_at !== null && row.expires_at !== undefined) {
      const d = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
      if (!Number.isNaN(d.getTime())) expiresAt = d.getTime();
    }

    // 异步更新 last_used_at（失败不影响鉴权）
    pool
      .query(`UPDATE analytics_tokens SET last_used_at = now() WHERE token_hash = $1`, [hash])
      .catch(() => {});

    return {
      tenant_id: row.tenant_id,
      scopes: Array.isArray(row.scopes) ? row.scopes : ["analytics:read"],
      expires_at: expiresAt,
    };
  };
}

// ---------------------------------------------------------------------------
// ② resolveEndpoint：webhook 端点反查
// ---------------------------------------------------------------------------

function createEndpointResolver(pool) {
  return async function resolveEndpoint(webhookId) {
    if (typeof webhookId !== "string" || webhookId.length === 0) return null;
    const res = await pool.query(
      `SELECT webhook_id, tenant_id::text AS tenant_id, secret_hash, status
         FROM webhook_endpoints
        WHERE webhook_id = $1`,
      [webhookId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      webhook_id: row.webhook_id,
      tenant_id: row.tenant_id,
      secret_hash: row.secret_hash,
      status: row.status,
    };
  };
}

// ---------------------------------------------------------------------------
// ③ loadAuditLogs：SS-GTM Debug 日志（事务 + 双保险）
// ---------------------------------------------------------------------------

/**
 * 事务内：BEGIN → set_config('app.current_tenant_id') → 显式 WHERE tenant_id。
 * 两层都要，缺一层都不算数（RLS 可能因角色问题失效，显式 WHERE 兜底；
 * 显式 WHERE 若哪天被误删，RLS 还在）。
 */
function createAuditLogLoader(pool) {
  return async function loadAuditLogs(tenantId, window) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

      const params = [tenantId];
      let sql =
        `SELECT tenant_id::text AS tenant_id, event_name, event_id, timestamp::bigint AS timestamp,
                transport, event_source, x_pt_source, user_agent, ip_override
           FROM ss_gtm_debug_logs
          WHERE tenant_id = $1::uuid`;
      if (window && typeof window.from === "number") {
        params.push(window.from);
        sql += ` AND timestamp >= $${params.length}::bigint`;
      }
      if (window && typeof window.to === "number") {
        params.push(window.to);
        sql += ` AND timestamp <= $${params.length}::bigint`;
      }
      sql += ` ORDER BY timestamp ASC`;

      const res = await client.query(sql, params);
      await client.query("COMMIT");

      return res.rows.map((r) => {
        const entry = { event_name: r.event_name };
        if (r.event_id !== null && r.event_id !== undefined) entry.event_id = String(r.event_id);
        // timestamp 可能是 string（bigint）或 number，统一成 number
        if (r.timestamp !== null && r.timestamp !== undefined) entry.timestamp = Number(r.timestamp);
        if (r.tenant_id) entry.tenant_id = r.tenant_id;
        if (r.transport) entry.transport = r.transport;
        if (r.event_source) entry.event_source = r.event_source;
        if (r.x_pt_source) entry.x_pt_source = r.x_pt_source;
        if (r.user_agent) entry.user_agent = r.user_agent;
        if (r.ip_override) entry.ip_override = r.ip_override;
        return entry;
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

// ---------------------------------------------------------------------------
// ④ loadConfigFindings：GTM 静态配置审计发现
// ---------------------------------------------------------------------------

function createConfigFindingsLoader(pool) {
  return async function loadConfigFindings(tenantId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const res = await client.query(
        `SELECT check_name, detail, severity
           FROM gtm_config_findings
          WHERE tenant_id = $1::uuid AND is_active = true
          ORDER BY finding_id`,
        [tenantId]
      );
      await client.query("COMMIT");
      return res.rows.map((r) => ({
        check: r.check_name,
        detail: r.detail,
        severity: r.severity,
      }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

// ---------------------------------------------------------------------------
// ⑤ 打点链路：webhook → 内存队列 → ingest worker → 真写 pt_events
// ---------------------------------------------------------------------------

/**
 * @param {object} pool
 * @param {object} ingestMod 编译产物 collect/ingest.js
 * @param {(msg:string)=>void} log
 */
function createCollectWiring(pool, ingestMod, log) {
  const { wrapCollectQueue } = require("../backend/collect/deps.cjs");
  const queue = wrapCollectQueue(
    ingestMod.createInMemoryIngestQueue(),
    pool,
    log,
    createWorkspaceResolver(pool)
  );
  const controller = new AbortController();

  const workerPromise = ingestMod
    .createIngestWorker({
      pool,
      dequeue: queue.dequeue,
      ack: queue.ack,
      moveToDlq: queue.moveToDlq,
      maxAttempts: 5,
      pollIntervalMs: 300,
      signal: controller.signal,
      logger: {
        info: () => {},
        warn: (m) => log("  [ingest warn] " + m),
        error: (m) => log("  [ingest error] " + m),
      },
    })
    .run()
    .catch((e) => {
      log("  [ingest worker 退出] " + (e && e.message ? e.message : e));
    });

  return {
    enqueue: queue.enqueue,
    pendingCount: () => queue.pendingCount(),
    deadCount: () => queue.deadCount(),
    async stop() {
      controller.abort();
      try {
        await workerPromise;
      } catch {
        /* 退出时的异常无需上抛 */
      }
    },
    /** 等队列排空（启动自检 / 优雅关闭用） */
    async drain(timeoutMs = 5000) {
      const t0 = Date.now();
      while (queue.pendingCount() > 0 && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return queue.pendingCount() === 0;
    },
  };
}

// ---------------------------------------------------------------------------
// ⑥ resolveWorkspaceId：租户 → 广告库 workspace_id
// ---------------------------------------------------------------------------
//
// 说明：pt_events 用 tenant_id（UUID），ad_* 用 workspace_id（TEXT）。
// 交付版按「一租户一工作区」约定：workspace_id = 固定映射表里的值。
// 真实环境若一个租户多工作区，应改为按平台/账户参数解析 —— 这是明确的待决项。

function createWorkspaceResolver(pool) {
  return async function resolveWorkspaceId(tenantId) {
    try {
      const res = await pool.query(
        `SELECT workspace_id FROM tenant_workspaces WHERE tenant_id = $1::uuid LIMIT 1`,
        [tenantId]
      );
      if (res.rows[0]) return res.rows[0].workspace_id;
    } catch {
      /* 表不存在 / 查询失败 → 按「未知租户」处理，返回 null */
    }
    // P1 修复：未知租户（表里查不到）返回 null，绝不回落演示工作区 ws_powertokens_main。
    // 此前 return fallback 会把随机租户的广告侧查询（ad_performance_daily 等）错误指向演示
    // 工作区，导致 data_freshness.ads_synced_through 泄漏演示租户的广告数据水位日期。
    return null;
  };
}

// ---------------------------------------------------------------------------
// ⑦ 种子辅助：写入审计日志与配置发现（seed 用）
// ---------------------------------------------------------------------------

async function insertAuditLogs(pool, tenantId, logs) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    for (const l of logs) {
      await client.query(
        `INSERT INTO ss_gtm_debug_logs
           (tenant_id, event_name, event_id, timestamp, transport, event_source, x_pt_source, user_agent)
         VALUES ($1::uuid,$2,$3,$4::bigint,$5,$6,$7,$8)`,
        [
          tenantId,
          l.event_name,
          l.event_id === undefined ? null : l.event_id,
          String(l.timestamp),
          l.transport || null,
          l.event_source || null,
          l.x_pt_source || null,
          l.user_agent || null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function insertConfigFindings(pool, tenantId, findings) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    for (const f of findings) {
      await client.query(
        `INSERT INTO gtm_config_findings (tenant_id, check_name, detail, severity)
         VALUES ($1::uuid,$2,$3,$4)`,
        [tenantId, f.check, f.detail, f.severity]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function insertAnalyticsToken(pool, tenantId, plaintextToken, label, scopes) {
  await pool.query(
    `INSERT INTO analytics_tokens (token_hash, tenant_id, label, scopes)
     VALUES ($1,$2::uuid,$3,$4)
     ON CONFLICT (token_hash) DO NOTHING`,
    [sha256Hex(plaintextToken), tenantId, label || null, scopes || ["analytics:read"]]
  );
}

async function insertWebhookEndpoint(pool, tenantId, webhookId, plaintextSecret, label) {
  await pool.query(
    `INSERT INTO webhook_endpoints (webhook_id, tenant_id, secret_hash, label)
     VALUES ($1,$2::uuid,$3,$4)
     ON CONFLICT (webhook_id) DO NOTHING`,
    [webhookId, tenantId, sha256Hex(plaintextSecret), label || null]
  );
}

module.exports = {
  createTokenVerifier,
  createEndpointResolver,
  createAuditLogLoader,
  createConfigFindingsLoader,
  createCollectWiring,
  createWorkspaceResolver,
  insertAuditLogs,
  insertConfigFindings,
  insertAnalyticsToken,
  insertWebhookEndpoint,
};
