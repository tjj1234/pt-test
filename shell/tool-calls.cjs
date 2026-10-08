"use strict";
/**
 * tool-calls.cjs —— 工具调用日志（M1）
 * ============================================================================
 * 只做 tool_calls 表的读写，不做身份 / 会话 / 权限判断，避免越界。
 *
 * 对外接口（server.cjs 会调）：
 *   const tc = await initToolCalls(db);
 *   const { id } = await tc.start({ tenantId, workspaceId, userId, toolName, inputSummary });
 *   await tc.finish(id, { outputSummary, durationMs, tokenCount, status });
 *   const rows = await tc.list({ tenantId, workspaceId, range }); // range=today|week|month
 *
 * 隔离红线：list() 永远带 workspace_id + tenant_id 过滤，绝不提供跨 workspace 读取。
 * ============================================================================
 */

// range → SQL 时间下界（滚动窗口：today=当天零点起，week=近 7 天，month=近 30 天）。
function rangeLowerBound(range) {
  switch (String(range || "")) {
    case "today":
      return "date_trunc('day', now())";
    case "week":
      return "date_trunc('day', now()) - interval '7 days'";
    case "month":
    default:
      return "date_trunc('day', now()) - interval '30 days'";
  }
}

const toIso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
const strOrNull = (v) => (v == null ? null : String(v));

async function initToolCalls(db) {
  if (!db) throw new Error("initToolCalls 需要 db（PGlite 实例）");

  /** 执行前落库一条 started，返回自增 id（供 finish 回写）。 */
  async function start(entry) {
    const r = await db.query(
      `INSERT INTO tool_calls (tenant_id, workspace_id, user_id, tool_name, input_summary, status)
       VALUES ($1, $2, $3, $4, $5, 'started')
       RETURNING id`,
      [entry.tenantId, entry.workspaceId, entry.userId, entry.toolName, strOrNull(entry.inputSummary)]
    );
    return { id: r.rows[0].id };
  }

  /** 执行后回写同一条记录：补输出摘要 / 耗时 / token / 终态。 */
  async function finish(id, entry) {
    await db.query(
      `UPDATE tool_calls
          SET output_summary = $2, duration_ms = $3, token_count = $4, status = $5
        WHERE id = $1`,
      [id, strOrNull(entry.outputSummary), entry.durationMs == null ? null : Number(entry.durationMs),
       entry.tokenCount == null ? 0 : Number(entry.tokenCount), entry.status || "completed"]
    );
  }

  /** 查当前 workspace 自己的调用日志（安全红线：恒按 workspace + tenant 过滤）。 */
  async function list({ tenantId, workspaceId, range }) {
    const bound = rangeLowerBound(range);
    const r = await db.query(
      `SELECT id, "timestamp", tenant_id, workspace_id, user_id, tool_name,
              input_summary, output_summary, duration_ms, token_count, status
         FROM tool_calls
        WHERE workspace_id = $1 AND tenant_id = $2 AND "timestamp" >= ` + bound + `
        ORDER BY "timestamp" DESC`,
      [workspaceId, tenantId]
    );
    return r.rows.map((row) => ({
      id: row.id,
      timestamp: toIso(row.timestamp),
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      toolName: row.tool_name,
      inputSummary: row.input_summary,
      outputSummary: row.output_summary,
      durationMs: row.duration_ms,
      tokenCount: row.token_count,
      status: row.status,
    }));
  }

  return { start, finish, list };
}

module.exports = { initToolCalls };
