"use strict";
// 账户授权（非 GA）路由（M7 后端）。
// 契约见 shell/public/settings.js M7 区块：
//   GET    /api/auth-accounts      -> { ok:true, accounts:[{id,tenantId,accountType,status,scope,updatedAt}] }
//   DELETE /api/auth-accounts/:id  -> { ok:true, deleted:<id> }（解除授权）
// 隔离红线：所有查询/删除按 me.tenant.id 过滤；DELETE 再校验 id + tenant_id 归属。

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toAccount(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountType: row.account_type,
    status: row.status,
    scope: row.scope,
    updatedAt: row.updated_at,
  };
}

async function handleAuthAccountsRoutes(req, res, auth, me) {
  const p = new URL(req.url, "http://localhost").pathname;
  const del = p.match(/^\/api\/auth-accounts\/([^/]+)$/);
  if (p !== "/api/auth-accounts" && !del) return false;

  if (!me || !me.user || !me.tenant) return reply(res, 401, { ok: false, error: "请先登录" });
  const tenantId = me.tenant.id;
  const method = (req.method || "GET").toUpperCase();

  if (p === "/api/auth-accounts") {
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      return reply(res, 405, { ok: false, error: "请求方法不支持" });
    }
    const result = await auth.db.query(
      "SELECT id, tenant_id, account_type, status, scope, updated_at FROM auth_accounts WHERE tenant_id = $1 ORDER BY updated_at DESC, id",
      [tenantId]
    );
    return reply(res, 200, { ok: true, accounts: result.rows.map(toAccount) });
  }

  if (method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return reply(res, 405, { ok: false, error: "请求方法不支持" });
  }
  const id = decodeURIComponent(del[1]);
  if (!UUID_RE.test(id)) return reply(res, 400, { ok: false, error: "授权账户 ID 无效" });
  const target = await auth.db.query("SELECT id FROM auth_accounts WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!target.rows.length) return reply(res, 404, { ok: false, error: "未找到该授权账户" });
  await auth.db.query("DELETE FROM auth_accounts WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  return reply(res, 200, { ok: true, deleted: id });
}

module.exports = { handleAuthAccountsRoutes };
