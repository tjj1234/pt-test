"use strict";
/**
 * db.cjs —— 业务壳自己的数据库（PGlite 0.5.8，真 PostgreSQL 编译成 WASM）
 * ============================================================================
 * 只做两件事：
 *   ① 找到 PGlite 的入口（shell 自己的 node_modules，安装后即用）
 *   ② 打开库（dataDir 落盘，重启不丢）+ 按文件名顺序跑 db-migrations\*.sql
 *
 * 身份 / 会话 / 密码哈希逻辑在 auth.cjs，不在这里，避免越界。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");

/** 找到 PGlite 的 CommonJS 入口（dist/index.cjs 的绝对路径）。 */
function resolvePgliteEntry() {
  // 允许显式指定，方便容器 / 特殊环境里换自己的 node_modules
  if (process.env.PT_PGLITE_PATH && fs.existsSync(process.env.PT_PGLITE_PATH)) {
    return process.env.PT_PGLITE_PATH;
  }
  const cands = [
    // ① shell 自己的 node_modules（npm install 后即存在，最干净）
    path.join(__dirname, "node_modules", "@electric-sql", "pglite", "dist", "index.cjs"),
    // ② repo 根下的 node_modules（monorepo / 统一安装的场景）
    path.join(__dirname, "..", "node_modules", "@electric-sql", "pglite", "dist", "index.cjs"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;

  // ③ 兜底：用 require.resolve 让 Node 自己按 package.json 的 exports/main 找
  try {
    return require.resolve("@electric-sql/pglite/dist/index.cjs");
  } catch (e) { /* 找不到就落到下面的清晰报错 */ }

  return null;
}

/** 打开（或创建）PGlite 库，dataDir 落盘 = 重启不丢。 */
async function open({ dataDir }) {
  const entry = resolvePgliteEntry();
  if (!entry) {
    throw new Error(
      "找不到 @electric-sql/pglite。请先在本目录（shell）执行：npm install\n" +
      "或二选一：① 设 PT_PGLITE_PATH 指向 dist/index.cjs；② 执行 npm install @electric-sql/pglite@0.5.8"
    );
  }
  const { PGlite } = require(entry);
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;
  return { db, close: async () => { await db.close(); } };
}

/**
 * 按文件名顺序执行 migrationsDir 下的 .sql，幂等：
 *   - 用 schema_migrations 表记录已应用的文件名，重复启动自动跳过；
 *   - SQL 里再叠加 CREATE ... IF NOT EXISTS 双保险。
 */
async function migrate(db, migrationsDir) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id          SERIAL PRIMARY KEY,
       name        TEXT NOT NULL UNIQUE,
       applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  let files = [];
  if (fs.existsSync(migrationsDir)) {
    files = fs.readdirSync(migrationsDir)
      .filter((f) => f.toLowerCase().endsWith(".sql"))
      .sort();
  }
  for (const f of files) {
    const done = await db.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (done.rows.length) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    await db.exec(sql);
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
  }
  return files.length;
}

module.exports = { resolvePgliteEntry, open, migrate };
