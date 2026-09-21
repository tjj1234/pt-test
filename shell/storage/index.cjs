"use strict";
/**
 * storage/index.cjs —— 存储薄适配（Slice 1：抽接缝，不重写 SQL）
 * ============================================================================
 * 把现有 db/auth/conversations/keys/memory 包成统一入口 createStorage()。
 *
 * 铁律（本切片不改动任何 SQL / 迁移 / 业务行为）：
 *   · 复用 auth.cjs 打开的同一个 db（auth.db），不另开连接；
 *   · 仓储方法签名与现有模块完全一致，只是显式命名 + 断言契约；
 *   · 业务代码以后只拿 createStorage() 返回的 repositories，不直接碰 db.query。
 *
 * 已知接缝隐患（见 README.md）：
 *   shell/conversations.cjs 是「旧版单对话」，真正运行时用的是
 *   conv/conversations.cjs（多对话版）。本文件显式引用 conv/ 里的权威版，
 *   并把它作为 Slice 1 首个子任务要收口的点。
 * ============================================================================
 */
const { assertAdapter, assertRepository } = require("./contract.cjs");

async function createStorage(opts = {}) {
  const { initAuth } = require("../auth.cjs");
  const keysMod = require("../keys.cjs");
  // 权威版多对话仓储（conversations-v2.cjs：含 setArchived/search；shell/conversations.cjs 是旧单对话版，勿用）
  const convMod = require("../../conv/conversations-v2.cjs");
  const memoryMod = require("../../conv/memory.cjs");

  // ① auth 打开同一个 db + 跑迁移 + 种默认管理员（沿用现有行为，一行未改）
  const auth = await initAuth({
    dataDir: opts.dataDir,
    migrationsDir: opts.migrationsDir,
    sessionTtlMs: opts.sessionTtlMs,
    defaultAdmin: opts.defaultAdmin,
  });

  // ② StorageAdapter：包住 auth.db（PGlite/PG 已由 db.cjs 抽象成同一形状）
  const db = auth.db;
  const adapter = assertAdapter({
    query: (sql, params) => db.query(sql, params),
    transaction: (cb) => db.transaction(cb),
    close: async () => { await auth.close(); },
  });

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
    close: adapter.close,
  };
}

module.exports = { createStorage };
