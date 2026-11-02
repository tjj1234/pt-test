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
const { normalizeModelIdentity } = require("./runtime/usage.cjs");
const { estimateBoundTextResponse } = require("./usage/bound-text-estimate.cjs");
function tokenValue(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
}
const TRUSTED_TOTAL_SEMANTICS = "dsh_pi_ai_disjoint_0_1_1_rc_2";
function evidenceUsage(value, trustedTotal = false) {
  const raw = value && typeof value === "object" ? value : {};
  const pick = (camel, snake) => tokenValue(raw[camel] ?? raw[snake]);
  const inputTokens = pick("inputTokens", "input_tokens");
  const outputTokens = pick("outputTokens", "output_tokens");
  const cacheReadTokens = pick("cacheReadTokens", "cache_read_tokens");
  const cacheWriteTokens = pick("cacheWriteTokens", "cache_write_tokens");
  const providedTotal = pick("totalTokens", "total_tokens");
  const componentsKnown = inputTokens != null && outputTokens != null
    && cacheReadTokens != null && cacheWriteTokens != null;
  let componentTotal = null;
  if (componentsKnown) {
    const sum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (!Number.isSafeInteger(sum)) {
      throw Object.assign(new TypeError("token component total exceeds the safe integer range"), { code: "USAGE_EVIDENCE_INVALID" });
    }
    componentTotal = sum;
  }
  if (providedTotal != null && componentTotal != null && providedTotal !== componentTotal) {
    throw Object.assign(new TypeError("totalTokens conflicts with complete token components"), { code: "USAGE_EVIDENCE_INVALID" });
  }
  const totalTokens = providedTotal ?? componentTotal;
  const known = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some((item) => item != null);
  const coverage = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((item) => item != null)
    ? "complete" : (known ? "partial" : "unknown");
  const totalSemantics = totalTokens == null ? "unknown"
    : (trustedTotal && coverage === "complete" ? TRUSTED_TOTAL_SEMANTICS
      : (providedTotal != null && coverage !== "complete" ? "upstream_reported_unclassified" : "unknown"));
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, coverage, totalSemantics };
}

async function initToolCalls(db) {
  if (!db) throw new Error("initToolCalls 需要 db（PGlite 实例）");

  /** 执行前落库一条 started，返回自增 id（供 finish 回写）。 */
  async function start(entry) {
    const r = await db.query(
      `INSERT INTO tool_calls (tenant_id, workspace_id, user_id, tool_name, input_summary, category, model_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'started')
       RETURNING id`,
      [entry.tenantId, entry.workspaceId, entry.userId, entry.toolName, strOrNull(entry.inputSummary),
       strOrNull(entry.category), strOrNull(entry.modelName)]
    );
    return { id: r.rows[0].id };
  }

  /** 执行后回写同一条记录：补输出摘要 / 耗时 / token / 终态 / 模型名（media 类工具执行后才知模型）。 */
  async function finish(id, entry) {
    await db.query(
      `UPDATE tool_calls
          SET output_summary = $2, duration_ms = $3, token_count = $4, status = $5,
              model_name = COALESCE($6, model_name)
        WHERE id = $1`,
      [id, strOrNull(entry.outputSummary), entry.durationMs == null ? null : Number(entry.durationMs),
       entry.tokenCount == null ? null : Number(entry.tokenCount), entry.status || "completed",
       strOrNull(entry.modelName)]
    );
  }

  /** 查当前 workspace 自己的调用日志（安全红线：恒按 workspace + tenant 过滤）。 */
  async function list({ tenantId, workspaceId, range }) {
    const bound = rangeLowerBound(range);
    const r = await db.query(
      `SELECT id, "timestamp", tenant_id, workspace_id, user_id, tool_name,
              input_summary, output_summary, duration_ms, token_count, status,
              category, model_name
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
      category: row.category,
      modelName: row.model_name,
    }));
  }

  /** 主对话轮次 token 用量：落一条 chat_usage（与 tool_calls 子工具调用分开）。 */
  async function logUsage(entry) {
    const evidence = entry && entry.usageEvidence;
    if (evidence != null) {
      if (!evidence || typeof evidence !== "object" || !Array.isArray(evidence.responses)) {
        throw Object.assign(new TypeError("usageEvidence.responses must be an array"), { code: "USAGE_EVIDENCE_INVALID" });
      }
      const seen = new Set();
      const rows = evidence.responses.map((response) => {
        const responseSeq = response && response.responseSeq;
        if (!Number.isSafeInteger(responseSeq) || responseSeq < 0 || seen.has(responseSeq)) {
          throw Object.assign(new TypeError("usageEvidence responseSeq must be unique non-negative integers"), { code: "USAGE_EVIDENCE_INVALID" });
        }
        seen.add(responseSeq);
        return { responseSeq, usage: evidenceUsage(response.usage, evidence.totalSemantics === TRUSTED_TOTAL_SEMANTICS) };
      });
      if (!rows.length) return { inserted: 0, duplicate: 0, observedResponses: 0 };
      if (entry.runId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(entry.runId))) {
        throw Object.assign(new TypeError("runId must be a UUID"), { code: "USAGE_EVIDENCE_INVALID" });
      }
      return db.transaction(async (tx) => {
        if (entry.runId != null) {
          const owner = await tx.query("SELECT 1 FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 AND workspace_id=$4", [entry.runId, entry.userId, entry.tenantId, entry.workspaceId]);
          if (!owner.rows.length) throw Object.assign(new Error("Run usage identity does not match its owner"), { code: "RUN_USAGE_IDENTITY_MISMATCH" });
        }
        let inserted = 0;
        for (const row of rows) {
          const usage = row.usage;
          const result = entry.runId == null
            ? await tx.query(
                `INSERT INTO chat_usage (tenant_id,workspace_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,run_id,response_seq,cache_read_tokens,cache_write_tokens,coverage,total_semantics)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12) RETURNING id`,
                [entry.tenantId, entry.workspaceId, entry.userId, strOrNull(entry.model), usage.inputTokens, usage.outputTokens, usage.totalTokens, row.responseSeq, usage.cacheReadTokens, usage.cacheWriteTokens, usage.coverage, usage.totalSemantics],
              )
            : await tx.query(
                `INSERT INTO chat_usage (tenant_id,workspace_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,run_id,response_seq,cache_read_tokens,cache_write_tokens,coverage,total_semantics)
                 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
                   FROM agent_runs r WHERE r.run_id=$8 AND r.user_id=$3 AND r.tenant_id=$1 AND r.workspace_id=$2
                 ON CONFLICT DO NOTHING RETURNING id`,
                [entry.tenantId, entry.workspaceId, entry.userId, strOrNull(entry.model), usage.inputTokens, usage.outputTokens, usage.totalTokens, entry.runId, row.responseSeq, usage.cacheReadTokens, usage.cacheWriteTokens, usage.coverage, usage.totalSemantics],
              );
          if (result.rows.length) {
            inserted++;
          } else {
            const existing = (await tx.query(
              `SELECT tenant_id,workspace_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,cache_read_tokens,cache_write_tokens,coverage,total_semantics
                 FROM chat_usage WHERE run_id=$1 AND response_seq=$2 FOR UPDATE`,
              [entry.runId, row.responseSeq],
            )).rows[0];
            const sameNumber = (left, right) => left == null ? right == null : right != null && Number(left) === Number(right);
            const sameText = (left, right) => left == null ? right == null : String(left) === String(right);
            const isSameEvidence = existing
              && String(existing.tenant_id).toLowerCase() === String(entry.tenantId).toLowerCase()
              && String(existing.user_id).toLowerCase() === String(entry.userId).toLowerCase()
              && String(existing.workspace_id) === String(entry.workspaceId)
              && sameText(existing.model, strOrNull(entry.model))
              && sameNumber(existing.prompt_tokens, usage.inputTokens)
              && sameNumber(existing.completion_tokens, usage.outputTokens)
              && sameNumber(existing.total_tokens, usage.totalTokens)
              && sameNumber(existing.cache_read_tokens, usage.cacheReadTokens)
              && sameNumber(existing.cache_write_tokens, usage.cacheWriteTokens)
              && existing.coverage === usage.coverage
              && existing.total_semantics === usage.totalSemantics;
            if (!isSameEvidence) {
              throw Object.assign(new Error("Conflicting usage evidence for Run response sequence"), { code: "USAGE_EVIDENCE_CONFLICT" });
            }
          }
        }
        return { inserted, duplicate: rows.length - inserted, observedResponses: rows.length };
      });
    }
    // Backward-compatible legacy entry: callers without response evidence may
    // still write one row, but absent/invalid token values stay NULL.
    const legacy = entry.usage && typeof entry.usage === "object" ? entry.usage : entry;
    const usage = evidenceUsage({
      inputTokens: legacy.inputTokens ?? entry.inputTokens ?? entry.promptTokens ?? legacy.prompt_tokens,
      outputTokens: legacy.outputTokens ?? entry.outputTokens ?? entry.completionTokens ?? legacy.completion_tokens,
      cacheReadTokens: legacy.cacheReadTokens ?? legacy.cache_read_tokens,
      cacheWriteTokens: legacy.cacheWriteTokens ?? legacy.cache_write_tokens,
       totalTokens: legacy.totalTokens ?? entry.totalTokens ?? legacy.total_tokens,
    });
    await db.query(
      `INSERT INTO chat_usage (tenant_id, workspace_id, user_id, model, prompt_tokens, completion_tokens, total_tokens, coverage, total_semantics)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.tenantId, entry.workspaceId, entry.userId, strOrNull(entry.model), usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.coverage, usage.totalSemantics]
    );
    return { inserted: 1, duplicate: 0, observedResponses: 1 };
  }

  /** Per-response evidence for one owned Run; absence of price stays unknown. */
  async function usageByRun({ tenantId, workspaceId, userId, runId, after = -1, limit = 100 }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(runId || "")) ||
        !Number.isSafeInteger(after) || after < -1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw Object.assign(new TypeError("Invalid Run usage cursor"), { code: "USAGE_QUERY_INVALID" });
    }
    const page = await db.query(
      `SELECT u.response_seq,u.model,u.prompt_tokens,u.completion_tokens,u.cache_read_tokens,u.cache_write_tokens,
              u.total_tokens,u.coverage,u.total_semantics,u.cost_amount,u.cost_currency,u.cost_coverage,u."timestamp"
         FROM chat_usage u JOIN agent_runs r ON r.run_id=u.run_id
        WHERE r.run_id=$1 AND r.user_id=$2 AND r.tenant_id=$3 AND r.workspace_id=$4
          AND u.user_id=$2 AND u.tenant_id=$3 AND u.workspace_id=$4
          AND u.response_seq>$5
        ORDER BY u.response_seq LIMIT $6`,
      [runId, userId, tenantId, workspaceId, after, limit + 1],
    );
    const identityEvents = await db.query(
      `SELECT e.event FROM agent_run_events e JOIN agent_runs r ON r.run_id=e.run_id
        WHERE r.run_id=$1 AND r.user_id=$2 AND r.tenant_id=$3 AND r.workspace_id=$4
          AND e.event->>'type'='state' AND e.event->'payload'->>'action'='model_identity_evidence'
        ORDER BY e.seq DESC LIMIT 1`,
      [runId, userId, tenantId, workspaceId],
    );
    const rawIdentity = identityEvents.rows[0]?.event?.payload;
    const identityBySeq = new Map(normalizeModelIdentity(rawIdentity).responses.map((response) => [response.responseSeq, response]));
    const intentEvents = await db.query(
      `SELECT e.event FROM agent_run_events e JOIN agent_runs r ON r.run_id=e.run_id
        WHERE r.run_id=$1 AND r.user_id=$2 AND r.tenant_id=$3 AND r.workspace_id=$4
          AND e.event->>'type'='state' AND e.event->'payload'->>'action'='model_request_intent'
        ORDER BY e.seq LIMIT 101`, [runId, userId, tenantId, workspaceId],
    );
    const intents = intentEvents.rows.map(row => row.event.payload);
    const coordinateCounts = new Map();
    for (const identity of identityBySeq.values()) {
      const key = `${identity.turn}:${identity.step}`;
      coordinateCounts.set(key, (coordinateCounts.get(key) || 0) + 1);
    }
    const rows = page.rows.slice(0, limit);
    const count = (value) => value == null ? null : tokenValue(value);
    return {
      responses: rows.map((row) => {
        const identity = identityBySeq.get(count(row.response_seq));
        const estimate = estimateBoundTextResponse({ selectedModel: row.model,
          totalSemantics: row.total_semantics, identity,
          intents: coordinateCounts.get(`${identity?.turn}:${identity?.step}`) === 1 ? intents : [],
          usage: { inputTokens: count(row.prompt_tokens), outputTokens: count(row.completion_tokens),
            cacheReadTokens: count(row.cache_read_tokens), cacheWriteTokens: count(row.cache_write_tokens) },
        });
        return {
        responseSeq: count(row.response_seq), selectedModel: row.model || null,
        providerReportedModel: identityBySeq.get(count(row.response_seq))?.providerReportedModelId || null,
        modelIdentityEvidence: identityBySeq.get(count(row.response_seq))?.providerReportedModelId
          ? "provider_response_model" : "unknown",
        inputTokens: count(row.prompt_tokens), outputTokens: count(row.completion_tokens),
        cacheReadTokens: count(row.cache_read_tokens), cacheWriteTokens: count(row.cache_write_tokens),
        totalTokens: count(row.total_tokens), coverage: row.coverage || "unknown",
        totalSemantics: row.total_semantics || "unknown", cost: estimate.amount, costCoverage: estimate.coverage,
        costCurrency: estimate.currency, costReasonCode: estimate.reasonCode || null,
        costBasis: estimate.pricingBasis || null,
        priceVersion: estimate.priceVersion || null, priceCatalogId: estimate.catalogId || null,
        priceCapturedAt: estimate.priceCapturedAt || null, priceSourceUrl: estimate.priceSourceUrl || null,
        attemptId: estimate.attemptId || null, requestedAt: estimate.requestedAt || null,
        observedAt: toIso(row.timestamp),
      }; }),
      nextCursor: rows.length ? count(rows.at(-1).response_seq) : after,
      hasMore: page.rows.length > limit,
    };
  }

  /** Complete one Run's bounded response ledger, failing instead of silently truncating. */
  async function allUsageByRun(identity, { maxRows = 5000, pageSize = 500 } = {}) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 5000 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
      throw Object.assign(new TypeError("Invalid Run usage export limit"), { code: "USAGE_QUERY_INVALID" });
    }
    const responses = [];
    let after = -1;
    while (true) {
      const page = await usageByRun({ ...identity, after, limit: Math.min(pageSize, maxRows - responses.length) });
      responses.push(...page.responses);
      if (!page.hasMore) return responses;
      if (responses.length >= maxRows || page.nextCursor <= after) {
        throw Object.assign(new RangeError("Run usage export exceeds limit"), { code: "RUN_USAGE_EXPORT_LIMIT" });
      }
      after = page.nextCursor;
    }
  }

  /** 用量聚合：今日 / 本月 / 按模型（模型分布按所选 range）。 */
  async function usageSummary({ tenantId, workspaceId, range }) {
    const todayBound = "date_trunc('day', now())";
    const monthBound = "date_trunc('month', now())";
    const rangeBound = rangeLowerBound(range);
    const trustedTotalsComplete = `BOOL_AND(total_semantics='${TRUSTED_TOTAL_SEMANTICS}' AND total_tokens IS NOT NULL)`;
    const safeAggregateRange = `SUM(total_tokens) BETWEEN 0 AND 9007199254740991`;
    const safeTotal = `CASE WHEN COUNT(*)>0
          AND ${trustedTotalsComplete}
          AND ${safeAggregateRange} THEN SUM(total_tokens) END`;
    const totalSemantics = `CASE WHEN COUNT(*)=0 THEN 'unavailable'
          WHEN BOOL_AND(total_semantics='${TRUSTED_TOTAL_SEMANTICS}' AND total_tokens IS NOT NULL) THEN '${TRUSTED_TOTAL_SEMANTICS}'
          WHEN BOOL_AND(total_semantics='legacy_unclassified') THEN 'legacy_unclassified'
          WHEN BOOL_AND(total_semantics='upstream_reported_unclassified') THEN 'upstream_reported_unclassified'
          WHEN BOOL_AND(total_semantics='unknown') THEN 'unknown'
          ELSE 'mixed' END`;
    const summaryCoverage = `CASE WHEN COUNT(*)=0 THEN 'unavailable'
          WHEN BOOL_AND(total_semantics='unknown' AND coverage='unknown') THEN 'unknown'
          WHEN NOT (${trustedTotalsComplete} AND ${safeAggregateRange}) THEN 'partial'
          WHEN BOOL_AND(coverage='complete') THEN 'complete'
          WHEN BOOL_OR(coverage<>'unknown') THEN 'partial' ELSE 'unknown' END`;

    const [today, month, byModel] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS count,
                CASE WHEN COUNT(*)=COUNT(prompt_tokens) THEN SUM(prompt_tokens) END AS prompt_tokens,
                CASE WHEN COUNT(*)=COUNT(completion_tokens) THEN SUM(completion_tokens) END AS completion_tokens,
                ${safeTotal} AS total_tokens,
                ${totalSemantics} AS total_semantics,
                ${summaryCoverage} AS coverage
           FROM chat_usage
          WHERE workspace_id = $1 AND tenant_id = $2 AND "timestamp" >= ` + todayBound,
        [workspaceId, tenantId]
      ),
      db.query(
        `SELECT COUNT(*) AS count,
                CASE WHEN COUNT(*)=COUNT(prompt_tokens) THEN SUM(prompt_tokens) END AS prompt_tokens,
                CASE WHEN COUNT(*)=COUNT(completion_tokens) THEN SUM(completion_tokens) END AS completion_tokens,
                ${safeTotal} AS total_tokens,
                ${totalSemantics} AS total_semantics,
                ${summaryCoverage} AS coverage
           FROM chat_usage
          WHERE workspace_id = $1 AND tenant_id = $2 AND "timestamp" >= ` + monthBound,
        [workspaceId, tenantId]
      ),
      db.query(
        `SELECT COALESCE(model, '未标注') AS model,
                COUNT(*) AS calls,
                CASE WHEN COUNT(*)=COUNT(prompt_tokens) THEN SUM(prompt_tokens) END AS prompt_tokens,
                CASE WHEN COUNT(*)=COUNT(completion_tokens) THEN SUM(completion_tokens) END AS completion_tokens,
                ${safeTotal} AS total_tokens,
                ${totalSemantics} AS total_semantics,
                ${summaryCoverage} AS coverage
           FROM chat_usage
          WHERE workspace_id = $1 AND tenant_id = $2 AND "timestamp" >= ` + rangeBound + `
          GROUP BY model
          ORDER BY total_tokens DESC NULLS LAST`,
        [workspaceId, tenantId]
      ),
    ]);

    const numericOrNull = (value) => {
      if (value == null) return null;
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 0 ? number : null;
    };
    const pick = (row) => row && row.rows && row.rows[0]
      ? {
          promptTokens: numericOrNull(row.rows[0].prompt_tokens),
          completionTokens: numericOrNull(row.rows[0].completion_tokens),
          totalTokens: numericOrNull(row.rows[0].total_tokens),
          totalSemantics: row.rows[0].total_semantics || "unknown",
          count: Number(row.rows[0].count) || 0,
          coverage: row.rows[0].coverage || "unknown",
          cost: null,
          costCoverage: "unknown",
        }
      : { promptTokens: null, completionTokens: null, totalTokens: null, totalSemantics: "unavailable", count: 0, coverage: "unavailable", cost: null, costCoverage: "unknown" };

    return {
      today: pick(today),
      month: pick(month),
      byModel: (byModel.rows || []).map((row) => ({
        model: row.model,
        calls: Number(row.calls) || 0,
        promptTokens: numericOrNull(row.prompt_tokens),
        completionTokens: numericOrNull(row.completion_tokens),
        totalTokens: numericOrNull(row.total_tokens),
        totalSemantics: row.total_semantics || "unknown",
        coverage: row.coverage || "unknown",
        cost: null,
        costCoverage: "unknown",
      })),
    };
  }

  return { start, finish, list, logUsage, usageSummary, usageByRun, allUsageByRun };
}

module.exports = { initToolCalls };
