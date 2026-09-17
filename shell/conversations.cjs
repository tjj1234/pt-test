"use strict";
/**
 * conversations.cjs —— 多对话窗口的持久化（对话窗口化改造）
 * ============================================================================
 * 相对旧版（1 用户 = 1 条、user_id 唯一、messages 只存 {role,text}）的变化：
 *   · 1 用户 = 多对话：一行一个对话（id / user_id / title / messages / created_at /
 *     updated_at），不再有 user_id 唯一约束；
 *   · 消息结构升级为 {role, text, ts}（ts = ISO8601 时间戳字符串）；
 *   · 标题：新建时「新对话」，保存消息时若标题还是默认值，自动取首条用户消息前 15 字；
 *   · 旧数据迁移：initConversations() 启动时一次性「补 ts + 生成 title」，不清空（幂等）。
 *
 * 安全铁律：messages 只存 user/assistant 消息文本，明文 PT key 绝不进这张表
 *   （key 只在 api_keys 表里以 AES-256-GCM 密文存在）。
 *
 * 对外接口（server.cjs 会调）：
 *   const conv = await initConversations(db);
 *   await conv.list(userId)                    // -> [{id,title,preview,msgCount,created_at,updated_at}] 按 updated_at 倒序
 *   await conv.create(userId)                  // -> {id,title,messages:[],created_at,updated_at}
 *   await conv.get(userId, id)                 // -> {id,title,messages,...} | null（无权限/不存在返回 null）
 *   await conv.rename(userId, id, title)       // -> {ok:true,title} | {ok:false,notFound|error}
 *   await conv.remove(userId, id)              // -> {ok:true} | {ok:false,notFound}
 *   await conv.saveMessages(userId, id, msgs)  // 覆盖写消息 + 自动标题 + 刷新 updated_at
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

  /** 时间戳统一转 ISO 字符串，避免 PGlite 返回 Date 对象导致的序列化差异。 */
  const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));

  /** 把文本压成单行、去首尾空白。 */
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  /** 标题展示：空 /「新对话」都显示为「新对话」。 */
  const displayTitle = (t) => {
    const s = clean(t);
    return s && s !== "新对话" ? s : "新对话";
  };

  /** 标题自动生成：取首条用户消息前 15 字。 */
  const autoTitle = (msgs) => {
    const firstUser = msgs.find((m) => m && m.role === "user" && m.text);
    return firstUser ? clean(firstUser.text).slice(0, 15) : "新对话";
  };

  /* --------------------------------------------------------------------------
   * 一次性迁移旧数据（幂等）：把旧单对话里的 messages 补 ts、并按首条用户消息生成 title。
   * 只更新「确实需要迁移」的行，跑完后下次启动是 no-op。
   * ------------------------------------------------------------------------ */
  async function backfillLegacy() {
    const r = await db.query("SELECT id, title, messages, updated_at FROM conversations");
    for (const row of r.rows) {
      let msgs = normalize(row.messages);
      const fallbackTs = iso(row.updated_at) || new Date().toISOString();
      let changed = false;
      msgs = msgs.map((m) => {
        if (m && typeof m === "object" && m.role && m.text != null && !m.ts) {
          changed = true;
          return Object.assign({}, m, { ts: fallbackTs });
        }
        return m;
      });
      let title = row.title == null ? "" : String(row.title);
      if (clean(title) === "" || clean(title) === "新对话") {
        const gen = autoTitle(msgs);
        if (gen !== "新对话") { title = gen; changed = true; }
      }
      if (changed) {
        await db.query(
          "UPDATE conversations SET messages = $1::jsonb, title = $2 WHERE id = $3",
          [JSON.stringify(msgs), title, row.id]
        );
      }
    }
  }

  /** 列表：按最近更新时间倒序；带预览（最后一条消息前 40 字）与消息数。 */
  async function list(userId) {
    const r = await db.query(
      "SELECT id, title, messages, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, created_at DESC",
      [userId]
    );
    return r.rows.map((row) => {
      const msgs = normalize(row.messages);
      let preview = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].text) { preview = clean(msgs[i].text); break; }
      }
      return {
        id: row.id,
        title: displayTitle(row.title),
        preview: preview.slice(0, 40),
        msgCount: msgs.length,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      };
    });
  }

  /** 新建一个空对话，返回它的行。 */
  async function create(userId) {
    const r = await db.query(
      `INSERT INTO conversations (user_id, title, messages, created_at, updated_at)
       VALUES ($1, $2, '[]'::jsonb, now(), now())
       RETURNING id, title, created_at, updated_at`,
      [userId, "新对话"]
    );
    const row = r.rows[0];
    return {
      id: row.id,
      title: displayTitle(row.title),
      messages: [],
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  /** 读某用户某对话的完整历史；无权限/不存在返回 null。 */
  async function get(userId, id) {
    const r = await db.query(
      "SELECT id, title, messages, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      title: displayTitle(row.title),
      messages: normalize(row.messages),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  /** 重命名（标题去首尾空白、压单行、最长 80 字）。 */
  async function rename(userId, id, title) {
    const t = clean(title).slice(0, 80);
    if (!t) return { ok: false, error: "标题不能为空" };
    const chk = await db.query("SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!chk.rows.length) return { ok: false, notFound: true };
    await db.query("UPDATE conversations SET title = $1 WHERE id = $2 AND user_id = $3", [t, id, userId]);
    return { ok: true, title: t };
  }

  /** 删除对话（只删属于该用户的）。 */
  async function remove(userId, id) {
    const chk = await db.query("SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!chk.rows.length) return { ok: false, notFound: true };
    await db.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
    return { ok: true };
  }

  /**
   * 覆盖写某对话的消息，并刷新 updated_at。
   * 标题仍是默认值（空 /「新对话」）时，自动取首条用户消息前 15 字（手动改过的标题不覆盖）。
   */
  async function saveMessages(userId, id, messages) {
    const arr = Array.isArray(messages) ? messages : [];
    const cur = await db.query("SELECT title FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!cur.rows.length) return { ok: false, notFound: true };
    let title = cur.rows[0].title == null ? "" : String(cur.rows[0].title);
    if (clean(title) === "" || clean(title) === "新对话") {
      title = autoTitle(arr);
    }
    await db.query(
      "UPDATE conversations SET messages = $1::jsonb, title = $2, updated_at = now() WHERE id = $3 AND user_id = $4",
      [JSON.stringify(arr), title, id, userId]
    );
    return { ok: true, title: displayTitle(title) };
  }

  await backfillLegacy();

  return { list, create, get, rename, remove, saveMessages };
}

module.exports = { initConversations };
