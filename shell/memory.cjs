"use strict";
/**
 * memory.cjs —— 跨对话轻量记忆 + 所选模型（形态 B 功能扩展）
 * ============================================================================
 * 只做 user_memory 表的读写，不做身份 / 会话，避免越界。
 *
 * 内部保留键约定：以 "$" 开头的 key 是「内部键」，不出现在用户记忆列表、
 * 也不注入到 DSH 任务文本（例如 "$model" 存所选模型）。
 *
 * 对外接口（server.cjs 会调）：
 *   const mem = await initMemory(db);
 *   await mem.list(userId)              // -> [{key, value, updated_at}]（不含内部键）
 *   await mem.set(userId, key, value)   // 写 / 覆盖
 *   await mem.del(userId, key)          // 删
 *   await mem.memoryLines(userId)       // -> ["key=value", ...]（供注入任务）
 *   await mem.getModel(userId)          // -> string|null（所选模型）
 *   await mem.setModel(userId, model)   // 存所选模型
 * ============================================================================
 */
async function initMemory(db) {
  if (!db) throw new Error("initMemory 需要 db（PGlite 实例）");

  const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
  const isInternal = (k) => String(k || "").startsWith("$");

  /** 读该用户全部用户记忆（排除内部保留键）。 */
  async function list(userId) {
    const r = await db.query(
      "SELECT key, value, updated_at FROM user_memory WHERE user_id = $1 ORDER BY updated_at DESC",
      [userId]
    );
    return r.rows
      .filter((row) => !isInternal(row.key))
      .map((row) => ({ key: row.key, value: row.value, updated_at: iso(row.updated_at) }));
  }

  /** 写 / 覆盖一条记忆（key 去首尾空白，长度限制）。 */
  async function set(userId, key, value) {
    const k = String(key || "").trim();
    const v = String(value == null ? "" : value);
    if (!k) return { ok: false, error: "记忆名不能为空" };
    if (k.length > 80) return { ok: false, error: "记忆名太长（≤80 字）" };
    if (v.length > 2000) return { ok: false, error: "记忆内容太长（≤2000 字）" };
    await db.query(
      `INSERT INTO user_memory (user_id, key, value, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, k, v]
    );
    return { ok: true, key: k, value: v };
  }

  /** 删除一条记忆。 */
  async function del(userId, key) {
    const k = String(key || "").trim();
    await db.query("DELETE FROM user_memory WHERE user_id = $1 AND key = $2", [userId, k]);
    return { ok: true };
  }

  /** 拼成 "key=value" 行数组（供注入 DSH 任务开头），排除内部键。 */
  async function memoryLines(userId) {
    const items = await list(userId);
    return items.map((m) => m.key + "=" + m.value);
  }

  /** 读所选模型（内部键 $model）。 */
  async function getModel(userId) {
    const r = await db.query("SELECT value FROM user_memory WHERE user_id = $1 AND key = '$model'", [userId]);
    return r.rows.length ? r.rows[0].value : null;
  }

  /** 存所选模型（内部键 $model）。 */
  async function setModel(userId, model) {
    const m = String(model || "").trim();
    if (!m) return { ok: false, error: "模型不能为空" };
    await db.query(
      `INSERT INTO user_memory (user_id, key, value, updated_at) VALUES ($1, '$model', $2, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, m]
    );
    return { ok: true, model: m };
  }

  return { list, set, del, memoryLines, getModel, setModel };
}

module.exports = { initMemory };
