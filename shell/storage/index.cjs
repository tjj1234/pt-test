"use strict";
/**
 * storage/index.cjs —— 存储薄适配（Slice 1 + Slice 1.5 收口）
 * ============================================================================
 * 把现有 db/auth/conversations/keys/memory 包成统一入口 createStorage()。
 *
 * Slice 1.5 收口点：
 *   · 统一迁移入口：shell/db-migrations/（完整迁移链），storage.migrate() 幂等重跑；
 *   · conversations 权威实现就是 shell/conversations.cjs（含 setArchived/search）；
 *   · 连接所有权：auth.cjs 打开并拥有 db（ownsDb=false），storage 复用同一连接，
 *     close() 统一走 auth.close()，绝不重复关闭。
 *
 * 铁律（不重写 SQL / 迁移 / 业务行为）：
 *   · 复用 auth.cjs 打开的同一个 db，不另开连接；
 *   · 仓储方法签名与现有模块一致，只显式命名 + 契约断言；
 *   · 业务代码只拿 repositories，不直接碰 db.query。
 * ============================================================================
 */
const path = require("path");
const { assertAdapter, assertRepository } = require("./contract.cjs");
const dbmod = require("../db.cjs");

/** 与 auth/server 共用完整迁移源；旧 storage/migrations 仅保留历史兼容。 */
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "db-migrations");

async function createStorage(opts = {}) {
  const { initAuth } = require("../auth.cjs");
  const keysMod = require("../keys.cjs");
  const convMod = require("../conversations.cjs");   // 权威多对话仓储（原历史 conversations 实现已并入此处）
  const memoryMod = require("../memory.cjs");

  const migrationsDir = opts.migrationsDir || DEFAULT_MIGRATIONS_DIR;

  // ① auth 打开同一个 db + 跑迁移 + 种默认管理员（连接所有权在 auth：ownsDb=false）
  const auth = await initAuth({
    dataDir: opts.dataDir,
    migrationsDir,
    sessionTtlMs: opts.sessionTtlMs,
    defaultAdmin: opts.defaultAdmin,
  });

  // ② StorageAdapter：包住 auth.db（PGlite/PG 已由 db.cjs 抽象成同一形状）
  const db = auth.db;
  // Multiple owners may request shutdown concurrently; auth closes the handle once.
  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = Promise.resolve().then(() => auth.close());
    return closePromise;
  };
  const adapter = assertAdapter({
    query: (sql, params) => db.query(sql, params),
    transaction: (cb) => db.transaction(cb),
    close,  // 唯一 close 所有权，并发／重复调用不重复关闭
  });

  try {
    // ③ 领域仓储：复用同一个 db，签名不变，加契约断言
    const keys = assertRepository(await keysMod.initKeys({ db, masterKeyFile: opts.masterKeyFile }),
      ["encryptApiKey", "decryptApiKey", "getKeyMeta"]);
    const conversations = assertRepository(await convMod.initConversations(db),
      ["list", "create", "get", "rename", "remove", "saveMessages", "setArchived", "search"]);
    const memory = assertRepository(await memoryMod.initMemory(db),
      ["list", "set", "del", "memoryLines", "getModel", "setModel"]);

    return {
      adapter,
      repositories: { auth, conversations, keys, memory },
      db,               // 过渡期：老代码若还引用 db 仍可拿到（目标是逐步去掉）
      ownsDb: false,    // auth 拥有连接；storage 借用，close 委托给 auth.close
      migrate: () => dbmod.migrate(db, migrationsDir),  // 幂等重跑（升级用）
      close: adapter.close,
    };
  } catch (error) {
    // auth owns the connection after opening it; don't leak it when a later
    // repository initializer or its contract assertion fails.
    try { await close(); } catch { /* Preserve the original initialization failure. */ }
    throw error;
  }
}

module.exports = { createStorage, DEFAULT_MIGRATIONS_DIR };
