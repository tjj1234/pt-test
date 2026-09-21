"use strict";
/**
 * storage/contract.cjs —— 存储契约（Slice 1：只定义接缝形状，不重写实现）
 * ============================================================================
 * 业务代码 / 仓储层只能依赖这里的契约，不直接依赖 db.query / db.transaction。
 * 契约分两层：
 *   ① StorageAdapter —— 底层存储适配器（PGlite 与 PostgreSQL 各自实现同一形状）
 *   ② Repository    —— 领域仓储（业务 Service 的唯一入口）
 *
 * 本文件不实现任何 SQL；它只是「形状声明 + 运行时自检断言」。
 * ============================================================================
 */

/**
 * StorageAdapter 契约：任何存储后端都必须暴露这三个能力。
 * 形状与 PGlite 0.5.8 的 db 实例对齐（PGlite 自身有 query / transaction / close）。
 */
const STORAGE_ADAPTER = {
  query: "function(sql, params) -> Promise<{ rows: Array }>",
  transaction: "function(callback) -> Promise",   // callback 收到 tx（含 query），异常自动回滚
  close: "function() -> Promise",
};

/**
 * Repository 契约：方法签名与现有模块一一对应（不新造签名，只做显式声明）。
 * 未来 PG Adapter 必须实现「核心 Repository 在同一接口下的行为一致」。
 */
const REPOSITORIES = {
  auth: {
    register: "({username,email,password}) -> {ok,user,tenant} | {ok:false,code,error}",
    login: "({username,password}) -> {ok,token,user,tenant,expiresAt} | {ok:false,error}",
    getSession: "(token) -> {user,tenant} | null",
    logout: "(token) -> boolean",
    ensureDefaultAdmin: "(username,password) -> {ok,created}",
  },
  conversations: {
    list: "(userId) -> [{id,title,preview,msgCount,created_at,updated_at}]",
    create: "(userId) -> {id,title,messages,created_at,updated_at}",
    get: "(userId,id) -> {id,title,messages,...} | null",
    rename: "(userId,id,title) -> {ok,title} | {ok:false,notFound|error}",
    remove: "(userId,id) -> {ok} | {ok:false,notFound}",
    saveMessages: "(userId,id,msgs) -> {ok,title} | {ok:false,notFound}",
    setArchived: "(userId,id,archived) -> {ok,archived} | {ok:false,notFound}",
    search: "(userId,q) -> [{id,title,preview,msgCount,archived,...}]",
  },
  keys: {
    encryptApiKey: "(userId,plaintext) -> {ok,key_last4} | {ok:false,code,error}",
    decryptApiKey: "(userId) -> string | null",
    getKeyMeta: "(userId) -> {key_last4,created_at,updated_at} | null",
  },
  memory: {
    list: "(userId) -> [{key,value,updated_at}]",
    set: "(userId,key,value) -> {ok,key,value} | {ok:false,error}",
    del: "(userId,key) -> {ok}",
    memoryLines: "(userId) -> [string]",
    getModel: "(userId) -> string | null",
    setModel: "(userId,model) -> {ok,model} | {ok:false,error}",
  },
};

/** 校验对象满足 StorageAdapter 契约（query/transaction/close 必须是函数）。 */
function assertAdapter(adapter) {
  for (const k of ["query", "transaction", "close"]) {
    if (!adapter || typeof adapter[k] !== "function") {
      throw new Error("StorageAdapter 缺少方法：" + k);
    }
  }
  return adapter;
}

/** 校验仓储对象满足 Repository 契约（按需传入方法名列表）。 */
function assertRepository(repo, methods) {
  for (const m of methods) {
    if (!repo || typeof repo[m] !== "function") {
      throw new Error("Repository 缺少方法：" + m);
    }
  }
  return repo;
}

module.exports = { STORAGE_ADAPTER, REPOSITORIES, assertAdapter, assertRepository };
