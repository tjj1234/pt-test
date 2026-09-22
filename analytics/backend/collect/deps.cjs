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
  persistence.ensureSchema().catch((err) => {
    if (typeof log === "function") {
      log("  [collect persist] ensureSchema: " + (err && err.message ? err.message : err));
    }
  });
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
