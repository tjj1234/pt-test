"use strict";
/**
 * panel-share.cjs —— 归因面板分享（只读 + 整面板）
 * ============================================================================
 * 职责：panel_shares 表的读写（创建 / 列表 / 撤销 / 校验），不做身份 / 会话，避免越界。
 *
 * 对外接口（server.cjs 会调）：
 *   const ps = await initPanelShares(db);
 *   await ps.create(ownerUserId, expiresInHours?)   // -> share 行（含 id/token/url/active…）
 *   await ps.list(ownerUserId)                      // -> share[]（含 active/revoked/expired）
 *   await ps.revoke(ownerUserId, id)                // -> { ok } 或 { ok:false, notFound:true }
 *   await ps.verify(idOrToken)                      // -> { valid, reason, share }（touch last_accessed_at）
 *   await ps.check(idOrToken)                       // -> 同上（不 touch，供只读代理高频调用）
 *
 * 只读语义：分享链接只给「整面板的只读访问」；本模块不提供任何写面板的入口。
 * ============================================================================
 */
const crypto = require("crypto");

async function initPanelShares(db) {
  if (!db) throw new Error("initPanelShares 需要 db（PGlite 实例）");

  const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
  const ms = (v) => (v instanceof Date ? v.getTime() : (v == null ? null : new Date(v).getTime()));

  /** 计算「已撤销 / 已过期 / 有效」三态（供列表与校验用）。 */
  function statusOf(row) {
    const revoked = row.revoked_at != null;
    const expiresMs = ms(row.expires_at);
    const expired = expiresMs != null && expiresMs <= Date.now();
    return { revoked, expired, active: !revoked && !expired };
  }

  function rowToShare(row) {
    const st = statusOf(row);
    return {
      id: row.id,
      token: row.token,
      url: "/panel/share/" + row.token,
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      revoked_at: iso(row.revoked_at),
      last_accessed_at: iso(row.last_accessed_at),
      active: st.active,
      revoked: st.revoked,
      expired: st.expired,
    };
  }

  const COLS = "id, token, created_at, expires_at, revoked_at, last_accessed_at";

  /** 创建分享：token 用 192 位随机 hex；expiresInHours 为空 → 永久（expires_at = NULL）。 */
  async function create(ownerUserId, expiresInHours) {
    const token = crypto.randomBytes(24).toString("hex");
    let expiresAt = null;
    if (expiresInHours != null && Number(expiresInHours) > 0) {
      expiresAt = new Date(Date.now() + Number(expiresInHours) * 3600000);
    }
    const r = await db.query(
      `INSERT INTO panel_shares (owner_user_id, token, expires_at) VALUES ($1, $2, $3)
       RETURNING ${COLS}`,
      [ownerUserId, token, expiresAt]
    );
    return rowToShare(r.rows[0]);
  }

  /** 列出 owner 的全部分享（含失效态），按创建时间倒序。 */
  async function list(ownerUserId) {
    const r = await db.query(
      `SELECT ${COLS} FROM panel_shares WHERE owner_user_id = $1 ORDER BY created_at DESC`,
      [ownerUserId]
    );
    return r.rows.map(rowToShare);
  }

  /** 撤销：只改属于该 owner 的、且尚未撤销的分享。 */
  async function revoke(ownerUserId, id) {
    const chk = await db.query(
      "SELECT 1 FROM panel_shares WHERE id = $1 AND owner_user_id = $2", [id, ownerUserId]
    );
    if (!chk.rows.length) return { ok: false, notFound: true };
    await db.query(
      "UPDATE panel_shares SET revoked_at = now() WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL",
      [id, ownerUserId]
    );
    return { ok: true };
  }

  /** 按 token 或 id 找分享行（token 优先，其次 id）。 */
  async function findByTokenOrId(idOrToken) {
    const q = String(idOrToken || "").trim();
    if (!q) return null;
    const byToken = await db.query(`SELECT ${COLS} FROM panel_shares WHERE token = $1`, [q]);
    if (byToken.rows.length) return byToken.rows[0];
    const byId = await db.query(`SELECT ${COLS} FROM panel_shares WHERE id::text = $1`, [q]);
    return byId.rows.length ? byId.rows[0] : null;
  }

  /** 校验有效性：不存在 → not_found；已撤销 → revoked；已过期 → expired；否则 valid。 */
  async function verify(idOrToken, opts = {}) {
    const row = await findByTokenOrId(idOrToken);
    if (!row) return { valid: false, reason: "not_found", share: null };
    const st = statusOf(row);
    if (st.revoked) return { valid: false, reason: "revoked", share: rowToShare(row) };
    if (st.expired) return { valid: false, reason: "expired", share: rowToShare(row) };
    if (opts.touch !== false) {
      try { await db.query("UPDATE panel_shares SET last_accessed_at = now() WHERE id = $1", [row.id]); }
      catch (e) { /* touch 失败不影响校验结果 */ }
    }
    return { valid: true, reason: null, share: rowToShare(row) };
  }

  /** 只读校验（不写 last_accessed_at），供分享只读代理每个请求调用。 */
  async function check(idOrToken) {
    return verify(idOrToken, { touch: false });
  }

  return { create, list, revoke, verify, check };
}

module.exports = { initPanelShares };
