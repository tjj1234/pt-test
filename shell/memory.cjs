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
 *   await mem.memoryLines(userId)       // -> 有界的 ["key=value", ...]（供注入任务）
 *   await mem.memorySnapshot(userId)    // -> lines 与预算/遗漏摘要
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
      "SELECT key, value, updated_at FROM user_memory WHERE user_id = $1 ORDER BY updated_at DESC, key ASC",
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

  /**
   * 按最近更新时间取整条记忆，避免超限时把最新的大条目直接挡在后续短条目前。
   * 上限按最终注入文本的 JS UTF-16 code unit 计，包含每行前缀和行间换行。
   */
  async function memorySnapshot(userId, opts = {}) {
    const rawBudget = opts?.maxChars;
    const requested = Number(rawBudget);
    const maxChars = Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : rawBudget === 0 ? 0 : 4000;
    const lines = [];
    let includedChars = 0;
    let totalCount = 0;
    const consume = (items) => {
      for (const item of items) {
        if (isInternal(item.key)) continue;
        const line = item.key + "=" + item.value;
        // server.cjs formats these as "  · " + line and joins them with "\n".
        const injectedChars = 4 + line.length + (lines.length > 0 ? 1 : 0);
        if (includedChars + injectedChars <= maxChars) {
          lines.push(line);
          includedChars += injectedChars;
        }
      }
    };

    if (typeof db.transaction === "function") {
      // Keep page reads and the summary count on one stable view while avoiding
      // materializing every key/value row in the application process.
      await db.transaction(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const count = await tx.query(
          "SELECT COUNT(*) AS total_count FROM user_memory WHERE user_id = $1 AND LEFT(key, 1) <> '$'",
          [userId]
        );
        totalCount = Number(count.rows[0]?.total_count || 0);

        const pageSize = 64;
        let offset = 0;
        while (true) {
          // No later record can fit once the remaining space is smaller than
          // the shortest possible formatted line (empty key, value, and '=').
          const minimumNextLine = 4 + 1 + (lines.length > 0 ? 1 : 0);
          if (maxChars - includedChars < minimumNextLine) break;

          const page = await tx.query(
            "SELECT key, value, updated_at FROM user_memory WHERE user_id = $1 ORDER BY updated_at DESC, key ASC LIMIT $2 OFFSET $3",
            [userId, pageSize, offset]
          );
          if (page.rows.length === 0) break;
          offset += page.rows.length;
          consume(page.rows);
          if (page.rows.length < pageSize) break;
        }
      });
    } else {
      // Keep compatibility with lightweight query-only adapters used by older
      // callers; production PGlite/PostgreSQL adapters use the paged path above.
      const items = await list(userId);
      totalCount = items.length;
      consume(items);
    }

    return {
      lines,
      maxChars,
      includedChars,
      totalCount,
      omittedCount: totalCount - lines.length,
    };
  }

  /** 兼容现有调用者；默认最终注入文本最多 4000 个 UTF-16 code unit。 */
  async function memoryLines(userId, opts) {
    return (await memorySnapshot(userId, opts)).lines;
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

  return { list, set, del, memoryLines, memorySnapshot, getModel, setModel };
}

module.exports = { initMemory };
