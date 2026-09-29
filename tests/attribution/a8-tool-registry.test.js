"use strict";
/**
 * A8 验收：
 * - attribution.query 经真实 shell registerTool 注册
 * - Viewer（无 attribution:read）调用被真实 checkPermission 拦住
 * - Analyst（有 attribution:read）调用成功，拿到 workflow 结果
 */
const path = require("node:path");
const crypto = require("node:crypto");
const dbmod = require("../../shell/db.cjs");
const {
  createAttributionRegistry,
  callAttributionQuery,
  ATTRIBUTION_READ,
} = require("../../business/attribution/registry");
const {
  registerTool,
  listToolsForWorkspace,
  validateToolCall,
  executeTool,
} = require("../../shell/tools/registry.cjs");
const { ROLE_PERMISSIONS, ROLES } = require("../../shell/permissions/index.cjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function uuid() {
  return crypto.randomUUID();
}

async function seedUsers(dataDir) {
  const migrationsDir = path.join(__dirname, "../../shell/db-migrations");
  const { db, close } = await dbmod.open({ dataDir });
  await dbmod.migrate(db, migrationsDir);

  const tenantId = uuid();
  const viewerId = uuid();
  const analystId = uuid();
  const suffix = Date.now().toString(36);

  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
    tenantId,
    "a8-tenant-" + suffix,
  ]);
  await db.query(
    `INSERT INTO users (id, tenant_id, username, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [viewerId, tenantId, "a8_viewer_" + suffix, null, "scrypt$1$1$1$00$00", "viewer"]
  );
  await db.query(
    `INSERT INTO users (id, tenant_id, username, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [analystId, tenantId, "a8_analyst_" + suffix, null, "scrypt$1$1$1$00$00", "analyst"]
  );

  await close();
  return { tenantId, viewerId, analystId, suffix };
}

async function cleanupUsers(dataDir, ids) {
  try {
    const { db, close } = await dbmod.open({ dataDir });
    await db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      [ids.viewerId, ids.analystId],
    ]);
    await db.query("DELETE FROM tenants WHERE id = $1::uuid", [ids.tenantId]);
    await close();
  } catch {
    /* best-effort */
  }
}

async function run() {
  // shell/ 本工作树未装 pglite；复用 analytics 已有副本（与 shell/db.cjs 探测顺序一致）
  if (!process.env.PT_PGLITE_PATH) {
    const cand = path.join(
      __dirname,
      "../../analytics/node_modules/@electric-sql/pglite/dist/index.cjs"
    );
    process.env.PT_PGLITE_PATH = cand;
  }

  const dataDir = path.join(__dirname, "../../db");
  const ids = await seedUsers(dataDir);

  try {
    const registry = createAttributionRegistry({
      shellTools: { registerTool, listToolsForWorkspace, validateToolCall, executeTool },
    });
    const defs = registry.registerAttributionDefaults();
    assert(defs.toolRegistry === "shell", "tool registry is shell");
    assert(defs.panelRegistry === "mock", "panel stays mock");
    assert(defs.tool.name === "attribution.query", "tool name");
    assert(
      defs.tool.requiredPermissions.includes(ATTRIBUTION_READ),
      "requires attribution:read"
    );
    assert(
      ROLE_PERMISSIONS[ROLES.ANALYST].includes(ATTRIBUTION_READ),
      "analyst granted attribution:read"
    );
    assert(
      !ROLE_PERMISSIONS[ROLES.VIEWER].includes(ATTRIBUTION_READ),
      "viewer must NOT have attribution:read"
    );

    const args = { from: "2026-09-01", to: "2026-09-30" };
    const viewerCtx = {
      tenantId: ids.tenantId,
      workspaceId: "ws_a8",
      userId: ids.viewerId,
    };
    const analystCtx = {
      tenantId: ids.tenantId,
      workspaceId: "ws_a8",
      userId: ids.analystId,
    };

    // 真实 validateToolCall → checkPermission
    const viewerOk = await validateToolCall("attribution.query", args, {
      userId: ids.viewerId,
      tenantId: ids.tenantId,
    });
    assert(viewerOk === false, "viewer validateToolCall must be false");

    let denied = null;
    try {
      await callAttributionQuery(viewerCtx, args, {
        shellTools: { registerTool, validateToolCall, executeTool },
        workflows: {
          queryFunnelPanel: async () => ({ should: "not-reach" }),
        },
      });
    } catch (err) {
      denied = err;
    }
    assert(denied && denied.code === "PERMISSION_DENIED", "viewer PERMISSION_DENIED");

    const analystOk = await validateToolCall("attribution.query", args, {
      userId: ids.analystId,
      tenantId: ids.tenantId,
    });
    assert(analystOk === true, "analyst validateToolCall must be true");

    const expectedPanel = {
      groups: [{ date: "total", visits: 3, signups: 1 }],
      roi_by_entity: [{ entity_id: "ad_1", roi: 1.5 }],
      _via: "a8-test",
    };
    const result = await callAttributionQuery(analystCtx, args, {
      shellTools: { registerTool, validateToolCall, executeTool },
      workflows: {
        queryFunnelPanel: async (ctx, q) => {
          assert(ctx.userId === ids.analystId, "workflow gets analyst");
          assert(q.from === args.from, "args forwarded");
          return expectedPanel;
        },
      },
    });
    assert(
      JSON.stringify(result) === JSON.stringify(expectedPanel),
      "analyst gets workflow result"
    );

    const listed = await listToolsForWorkspace("ws_a8", {
      userId: ids.analystId,
      tenantId: ids.tenantId,
    });
    assert(
      listed.some((t) => t.name === "attribution.query"),
      "analyst lists attribution.query"
    );
    const listedViewer = await listToolsForWorkspace("ws_a8", {
      userId: ids.viewerId,
      tenantId: ids.tenantId,
    });
    assert(
      !listedViewer.some((t) => t.name === "attribution.query"),
      "viewer does not list attribution.query"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          toolRegistry: defs.toolRegistry,
          panelRegistry: defs.panelRegistry,
          viewerDenied: denied.code,
          analystResult: result._via,
          attributionReadOnAnalyst: ROLE_PERMISSIONS[ROLES.ANALYST].includes(ATTRIBUTION_READ),
          attributionReadOnViewer: ROLE_PERMISSIONS[ROLES.VIEWER].includes(ATTRIBUTION_READ),
        },
        null,
        2
      )
    );
  } finally {
    await cleanupUsers(dataDir, ids);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
