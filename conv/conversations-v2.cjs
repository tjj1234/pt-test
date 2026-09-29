"use strict";
/**
 * conversations-v2.cjs —— 多对话窗口的持久化（对话窗口化改造 + 归档/搜索）
 * ============================================================================
 * 相对 conversations.cjs（v1 对话窗口化）的变化：
 *   · 每行带 archived（0=进行中，1=已归档），list/get/create 都会返回；
 *   · 新增 setArchived(userId, id, archived) —— 归档 / 恢复；
 *   · 新增 search(userId, q) —— 标题 + 消息正文（jsonb::text）模糊搜索。
 *
 * 其余能力与 conversations.cjs 完全一致：
 *   · 1 用户 = 多对话；消息结构 {role, text, ts}（可带 image 图片路径）；
 *   · 标题自动生成 / 手动改名；旧数据启动时幂等迁移。
 *
 * 对外接口（server.cjs 会调）：
 *   await conv.list(userId)                    // -> [{id,title,preview,msgCount,archived,created_at,updated_at}]
 *   await conv.create(userId)
 *   await conv.get(userId, id)
 *   await conv.rename(userId, id, title)
 *   await conv.remove(userId, id)
 *   await conv.saveMessages(userId, id, msgs)
 *   await conv.setArchived(userId, id, archived)
 *   await conv.search(userId, q)
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

  /** 时间戳统一转 ISO 字符串。 */
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

  /** 把一行 SELECT 结果映射为对外结构（带 preview / msgCount / archived）。 */
  function rowToSummary(row) {
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
      archived: !!row.archived,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  /* --------------------------------------------------------------------------
   * 一次性迁移旧数据（幂等）：补 ts + 生成 title。
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

  /** 列表：按最近更新时间倒序。 */
  async function list(userId) {
    const r = await db.query(
      "SELECT id, title, messages, archived, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, created_at DESC",
      [userId]
    );
    return r.rows.map(rowToSummary);
  }

  /** 新建一个空对话，返回它的行。 */
  async function create(userId) {
    const r = await db.query(
      `INSERT INTO conversations (user_id, title, messages, created_at, updated_at)
       VALUES ($1, $2, '[]'::jsonb, now(), now())
       RETURNING id, title, archived, created_at, updated_at`,
      [userId, "新对话"]
    );
    const row = r.rows[0];
    return {
      id: row.id,
      title: displayTitle(row.title),
      messages: [],
      archived: !!row.archived,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  /** 读某用户某对话的完整历史；无权限/不存在返回 null。 */
  async function get(userId, id) {
    const r = await db.query(
      "SELECT id, title, messages, archived, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      title: displayTitle(row.title),
      messages: normalize(row.messages),
      archived: !!row.archived,
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
   * 标题仍是默认值（空 /「新对话」）时，自动取首条用户消息前 15 字。
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

  /** 归档 / 恢复：置 archived = 1/0（只改属于该用户的）。 */
  async function setArchived(userId, id, archived) {
    const chk = await db.query("SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!chk.rows.length) return { ok: false, notFound: true };
    await db.query("UPDATE conversations SET archived = $1 WHERE id = $2 AND user_id = $3", [archived ? 1 : 0, id, userId]);
    return { ok: true, archived: !!archived };
  }

  /** 搜索：标题 + 消息正文（jsonb::text）模糊匹配（ILIKE 不区分大小写）。 */
  async function search(userId, q) {
    const query = String(q || "").trim();
    if (!query) return [];
    const pattern = "%" + query + "%";
    const r = await db.query(
      "SELECT id, title, messages, archived, created_at, updated_at FROM conversations " +
      "WHERE user_id = $1 AND (title ILIKE $2 OR messages::text ILIKE $2) ORDER BY updated_at DESC",
      [userId, pattern]
    );
    return r.rows.map(rowToSummary);
  }

  await backfillLegacy();

  return { list, create, get, rename, remove, saveMessages, setArchived, search };
}

module.exports = { initConversations };
