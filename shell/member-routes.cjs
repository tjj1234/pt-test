"use strict";
// HTTP adapter only: role definitions, role lookup and assignment stay in permissions.
const permissions = require("./permissions/index.cjs");

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}
async function bodyOf(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (e) { throw Object.assign(new Error("请求体必须是 JSON"), { status: 400 }); }
}

async function handleMemberRoutes(req, res, auth, me) {
  const p = new URL(req.url, "http://localhost").pathname;
  const match = p.match(/^\/api\/members\/([^/]+)\/role$/);
  if (p !== "/api/members" && p !== "/api/roles" && !match) return false;
  if (!me || !me.user || !me.tenant) return reply(res, 401, { ok: false, error: "请先登录" });
  const method = (req.method || "GET").toUpperCase();
  if ((!match && method !== "GET") || (match && method !== "PUT")) {
    res.setHeader("Allow", match ? "PUT" : "GET");
    return reply(res, 405, { ok: false, error: "请求方法不支持" });
  }
  const tenantId = me.tenant.id;
  const currentRole = await permissions.getUserRole(me.user.id, tenantId);
  const canManage = currentRole === permissions.ROLES.ADMIN || currentRole === permissions.ROLES.OWNER;
  if (p === "/api/roles") {
    return reply(res, 200, { ok: true, roles: Object.entries(permissions.ROLE_PERMISSIONS).map(([name, grants]) => ({ name, permissions: grants })) });
  }
  if (p === "/api/members") {
    const result = await auth.db.query("SELECT id, username, email, role FROM users WHERE tenant_id = $1 ORDER BY username, id", [tenantId]);
    return reply(res, 200, { ok: true, currentUserId: me.user.id, currentRole, canManage, members: result.rows.map(u => ({ ...u, role: u.role === "member" || !u.role ? permissions.ROLES.VIEWER : u.role })) });
  }
  if (!canManage) return reply(res, 403, { ok: false, error: "仅管理员或所有者可修改成员角色" });
  let userId, body;
  try {
    userId = decodeURIComponent(match[1]);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return reply(res, 400, { ok: false, error: "成员 ID 无效" });
    body = await bodyOf(req);
  } catch (e) { return reply(res, e.status || 400, { ok: false, error: e.status ? e.message : "成员 ID 无效" }); }
  if (!body || Array.isArray(body) || typeof body.role !== "string" || !Object.hasOwn(permissions.ROLE_PERMISSIONS, body.role)) return reply(res, 400, { ok: false, error: "请选择有效角色" });
  if (userId === me.user.id) return reply(res, 409, { ok: false, error: "不能修改自己的角色，请由另一位管理员操作" });
  const target = await auth.db.query("SELECT id FROM users WHERE id = $1 AND tenant_id = $2", [userId, tenantId]);
  if (!target.rows.length) return reply(res, 404, { ok: false, error: "当前团队中没有该成员" });
  const targetRole = await permissions.getUserRole(userId, tenantId);
  if (currentRole !== permissions.ROLES.OWNER && (body.role === permissions.ROLES.OWNER || targetRole === permissions.ROLES.OWNER)) return reply(res, 403, { ok: false, error: "只有所有者可分配或修改所有者角色" });
  await permissions.assignRoleToUser(userId, tenantId, body.role);
  const role = await permissions.getUserRole(userId, tenantId);
  return reply(res, 200, { ok: true, member: { id: userId, role } });
}
module.exports = { handleMemberRoutes };
