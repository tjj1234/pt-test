"use strict";
/**
 * A11 · Collect 队列持久化接线（一行接入点）
 *
 * 不修改 collect/ingest.js。由 analytics/lib/deps.cjs createCollectWiring 调用：
 *   const queue = wrapCollectQueue(ingestMod.createInMemoryIngestQueue(), pool, log, resolveWorkspace);
 */
const path = require("node:path");
const {
  wrapIngestQueueWithPersistence,
} = require("../../../business/attribution/persistence/collect-hooks");
const { createSqlPersistence } = require("../../../business/attribution/persistence/sql");

/**
 * @param {object} queue  createInMemoryIngestQueue() 返回值
 * @param {object} pool   现有 analytics pool
 * @param {(msg:string)=>void} [log]
 * @param {(tenantId:string)=>Promise<string|null>} [resolveWorkspace]
 */
function wrapCollectQueue(queue, pool, log, resolveWorkspace) {
  const persistence = createSqlPersistence(pool);
  // 注意：这里不再调用 persistence.ensureSchema()。运行时这个 pool 已经
  // SET ROLE 到 pt_app（见 analytics/lib/db.cjs），pt_app 只有 DML 权限、
  // 没有 CREATE，在这里补建表必然失败——之前这个失败被 .catch() 悄悄吞掉，
  // 导致 attribution_raw_events 表实际从未建成、collect 写入一直 503。
  // 建表已经挪到 db.cjs 的超级用户迁移阶段（a2_raw_dlq.sql），这里不用再管。
  const resolve =
    typeof resolveWorkspace === "function"
      ? resolveWorkspace
      : async () => null;
  return wrapIngestQueueWithPersistence(queue, persistence, { resolveWorkspace: resolve });
}

module.exports = {
  wrapCollectQueue,
  SCHEMA_HINT: path.join(__dirname, "../../../business/attribution/schema/a2_raw_dlq.sql"),
};
