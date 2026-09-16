"use strict";
/**
 * conversations.cjs —— 对话历史持久化（P1 硬化 #5）
 * ============================================================================
 * 把 server-v2.cjs 里「内存 Map 存多轮对话」改成「按 user_id 落库」，
 * 进程重启后同一用户继续对话仍保留上下文（1 用户 = 1 条，user_id 唯一，
 * 覆盖更新，天然按用户隔离、互不可见）。
 *
 * 安全铁律：messages 只存 user/assistant 消息文本（{role, text}），
 *   明文 PT key 绝不进对话历史（key 只在 api_keys 表里以 AES 密文存在）。
 *
 * 对外接口（server-v3.cjs 会调）：
 *   const conv = await initConversations(db);
 *   const messages = await conv.load(userId);   // -> [{role, text}, ...]，无记录返回 []
 *   await conv.save(userId, messages);          // 覆盖写（按 user_id 隔离）
 * ============================================================================
 */
async function initConversations(db) {
  if (!db) throw new Error("initConversations 需要 db（PGlite 实例）");

  /** 兼容 PGlite 对 JSONB 列的不同返回形态（可能是已解析数组，也可能是字符串）。 */
  function normalize(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
      } catch (e) { return []; }
    }
    return [];
  }

  /** 读某用户的对话历史；无记录返回空数组。 */
  async function load(userId) {
    const r = await db.query("SELECT messages FROM conversations WHERE user_id = $1", [userId]);
    if (!r.rows.length) return [];
    return normalize(r.rows[0].messages);
  }

  /** 覆盖写某用户的对话历史（幂等：user_id 唯一，ON CONFLICT 更新）。 */
  async function save(userId, messages) {
    const arr = Array.isArray(messages) ? messages : [];
    const json = JSON.stringify(arr);
    await db.query(
      `INSERT INTO conversations (user_id, messages, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id)
       DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
      [userId, json]
    );
  }

  return { load, save };
}

module.exports = { initConversations };
