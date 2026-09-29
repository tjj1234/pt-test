"use strict";
/**
 * db-pg.cjs —— 真实 PostgreSQL 适配层（node-postgres / pg）
 * ============================================================================
 * 目标：把业务壳的数据库从 PGlite（PG 的 WASM 单文件版）切到真实 PostgreSQL，
 *       但对外接口尽量不变，这样 server / auth / keys / conversations 上层代码
 *       几乎零改动。
 *
 * 对外接口对齐 PGlite（db.cjs 的 open() 返回同样的形状）：
 *   const { db, close } = await openPg();
 *   db.query(text, params)            -> Promise<{ rows: [...] }>
 *   db.exec(sql)                      -> Promise<...>   （简单查询协议，可跑多语句 DDL）
 *   db.transaction(async (tx) => { await tx.query(...) })
 *                                     -> 自动 BEGIN / COMMIT / ROLLBACK
 *   close()                           -> 关闭连接池
 *
 * 连接配置（全部环境变量，无 DSN 时也能用 HOST/PORT/... 兜底）：
 *   PT_PG_DSN                完整连接串，优先级最高
 *                           （例：postgres://user:pass@host:5432/db?sslmode=require）
 *   PT_PG_HOST              主机（默认 127.0.0.1）
 *   PT_PG_PORT              端口（默认 5432）
 *   PT_PG_USER / PT_PG_USERNAME   用户名（默认 postgres）
 *   PT_PG_PASSWORD          密码（默认空）
 *   PT_PG_DATABASE / PT_PG_DB     库名（默认 northstar）
 *   PT_PG_SSL                TLS 开关：require=强制TLS且校验证书（安全默认）；
 *                           no-verify=强制TLS但不校验证书（自签/内网）；
 *                           不设/off/0=false=不启 TLS（本机/内网明文）。
 *   PT_PG_POOL_MAX          连接池上限（默认 10）
 *   PT_PG_CONNECT_TIMEOUT_MS 连接超时毫秒（默认 5000）
 *   PT_PG_LIB               pg 包入口覆盖（lib/index.js 绝对路径，找不到依赖时用）
 *
 * 注意：本机若无 PostgreSQL 服务，openPg() 会在启动时对连接池做一次 SELECT 1
 *       探活，连不上会抛出清晰错误（由 server.cjs 的 main().catch 兜底打印）。
 * ============================================================================
 */
const path = require("path");

/** 是否配置了 PG（读 DSN 或 HOST/DATABASE/USER 任一即视为「要用 PG」）。 */
function pgConfigured(env) {
  const e = env || process.env;
  return !!(e.PT_PG_DSN || e.PT_PG_HOST || e.PT_PG_DATABASE || e.PT_PG_DB || e.PT_PG_USER);
}

/**
 * 解析 pg 包入口。按顺序尝试：
 *   ① PT_PG_LIB 环境变量（绝对路径，或相对 cwd）；
 *   ② 标准 require("pg")（shell/node_modules 或祖先 node_modules 里装过 pg）；
 *   ③ 本仓库已知安装点（pt-test/analytics/node_modules/pg）。
 */
function resolvePg() {
  if (process.env.PT_PG_LIB) {
    const p = process.env.PT_PG_LIB;
    try { return require(path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)); } catch (e) { /* 继续 */ }
  }
  try { return require("pg"); } catch (e) { /* 继续 */ }
  const cands = [
    path.join(__dirname, "..", "analytics", "node_modules", "pg"),
    path.join(__dirname, "..", "node_modules", "pg"),
    path.join(__dirname, "node_modules", "pg"),
  ];
  for (const c of cands) {
    try { return require(c); } catch (e) { /* 继续 */ }
  }
  throw new Error(
    "找不到 pg（node-postgres）。请二选一：\n" +
    "  ① 在 shell 目录执行：npm install pg\n" +
    "  ② 设 PT_PG_LIB 指向 pg 的 lib/index.js 绝对路径"
  );
}

/**
 * 组装 node-postgres 的连接配置。DSN 优先；否则用 HOST/PORT/USER/PASSWORD/DATABASE 兜底。
 */
function buildConfig(env) {
  const e = env || process.env;
  const cfg = {};

  const dsn = String(e.PT_PG_DSN || "").trim();
  if (dsn) {
    cfg.connectionString = dsn;
  } else {
    cfg.host = e.PT_PG_HOST || "127.0.0.1";
    cfg.port = Number(e.PT_PG_PORT || 5432);
    cfg.user = e.PT_PG_USER || e.PT_PG_USERNAME || "postgres";
    if (e.PT_PG_PASSWORD != null) cfg.password = String(e.PT_PG_PASSWORD);
    cfg.database = e.PT_PG_DATABASE || e.PT_PG_DB || "northstar";
  }

  // TLS：require = 强制 TLS 且校验证书；no-verify = 强制 TLS 不校验证书（自签/内网）
  const ssl = String(e.PT_PG_SSL || "").trim().toLowerCase();
  if (ssl === "no-verify") {
    cfg.ssl = { rejectUnauthorized: false };
  } else if (ssl && ssl !== "0" && ssl !== "false" && ssl !== "off" && ssl !== "disable") {
    cfg.ssl = { rejectUnauthorized: true };
  }

  cfg.max = Number(e.PT_PG_POOL_MAX || 10);
  cfg.connectionTimeoutMillis = Number(e.PT_PG_CONNECT_TIMEOUT_MS || 5000);
  return cfg;
}

/** 打开连接池，返回 { db, close }，形状与 PGlite 的 open() 完全一致。 */
async function openPg(env) {
  const pg = resolvePg();
  const { Pool } = pg;
  const cfg = buildConfig(env);

  const pool = new Pool(cfg);
  // 空闲连接报错不能变成未捕获异常（否则进程直接崩）
  pool.on("error", (err) => {
    console.error("[db-pg] 连接池空闲连接错误：", err && err.message ? err.message : String(err));
  });

  // 启动探活：连不上立刻抛错，让 server.cjs 的 main().catch 给出清晰中文提示。
  await pool.query("SELECT 1");

  /** 参数化查询：返回 { rows }（与 PGlite 的 db.query 返回形状一致）。 */
  const query = (text, params) => pool.query(text, params);

  /**
   * 执行裸 SQL（多为迁移 DDL）。不带参数 → node-postgres 走「简单查询协议」，
   * 一条字符串里可以包含多条以分号分隔的语句（真实 PG 语义，比本地拆分更稳）。
   */
  const exec = (sql) => pool.query(sql);

  /** 事务包装：tx 暴露 .query / .exec，异常自动 ROLLBACK，正常 COMMIT。 */
  async function transaction(cb) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        query: (text, params) => client.query(text, params),
        exec: (sql) => client.query(sql),
      };
      const result = await cb(tx);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (e2) { /* ROLLBACK 失败忽略 */ }
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    db: { query, exec, transaction, adapter: "pg" },
    close: async () => { await pool.end(); },
  };
}

module.exports = { openPg, pgConfigured, buildConfig, resolvePg };
