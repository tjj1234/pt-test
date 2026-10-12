"use strict";
const { EVENT_NAMES } = require("../contracts/invariants");
const { isUuid } = require("../contracts/validate");
const DAY = 86400000;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function qualityWindow(args = {}, now = Date.now()) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !["from", "to"].includes(k))) fail("BAD_RANGE", "只支持 from/to；租户和工作区由鉴权派生");
  const parse = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("BAD_RANGE", "日期必须为 YYYY-MM-DD");
    const ms = Date.parse(value + "T00:00:00Z");
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) fail("BAD_RANGE", "日期无效");
    return ms;
  };
  const today = Math.floor(now / DAY) * DAY;
  const from = args.from === undefined ? today - 6 * DAY : parse(args.from);
  const to = args.to === undefined ? today + DAY : parse(args.to) + DAY;
  if (to <= from || to - from > 31 * DAY) fail("BAD_RANGE", "分析窗口必须为 1–31 天");
  return { from, to, label: new Date(from).toISOString().slice(0, 10) + " ~ " + new Date(to - DAY).toISOString().slice(0, 10) + " UTC" };
}
const pct = n => n === null ? "未评估" : (n * 100).toFixed(1) + "%";
function buildQualityReport(events, logs, window, generatedAt) {
  const counts = Object.fromEntries(events.map(r => [r.event_name, Number(r.total)]));
  const total = events.reduce((s, r) => s + Number(r.total), 0);
  const covered = EVENT_NAMES.filter(name => counts[name] > 0);
  const identityTotal = events.reduce((s, r) => s + Number(r.identity_total), 0);
  const identityPresent = events.reduce((s, r) => s + Number(r.identity_present), 0);
  const coverage = total ? covered.length / EVENT_NAMES.length : null;
  const identityRate = identityTotal ? identityPresent / identityTotal : null;
  const logTotal = Number(logs.total), logValid = Number(logs.valid_ids), dup = Number(logs.duplicate_extra);
  const repeatRate = logValid ? dup / logValid : null;
  const rows = [], suggestions = [];
  function issue(severity, problem, impact, advice) { rows.push([severity, problem, impact, advice]); suggestions.push("[" + severity + "] " + advice); }
  if (!total) issue("高", "分析窗口内没有归因事件", "无法判断埋点质量，暂不评分", "核对 sGTM webhook URL、secret、事件映射和入队落库，触发一次真实业务操作后重跑");
  else if (covered.length < EVENT_NAMES.length) issue("中", "窗口内未观测到：" + EVENT_NAMES.filter(n => !covered.includes(n)).join("、"), "事件类型覆盖不足；未观测到不等于埋点未配置", "逐项触发六类业务操作，检查 sGTM 设置中的原始事件名映射及归因事件明细");
  if (identityTotal > identityPresent) issue("高", `${identityTotal - identityPresent}/${identityTotal} 条登录后业务事件缺少 user_id`, "注册、Key、调用或充值无法稳定关联到用户", "在 signup/key_created/model_call/recharge/auto_recharge_toggle 的生产端补充稳定 user_id；重试保留原值");
  if (dup) issue("中", `sGTM 日志中有 ${dup} 条有效 event_id 重复记录`, "重复上报或重试；归因数据库会去重，日志重复不等于收入重复", "不同真实操作使用不同 UUID，同一操作重试复用 UUID，并核对容器是否重复触发");
  if (!logValid) issue("中", "缺少可计算重复率的 sGTM Debug 日志", "去重后的归因事件不能反推上游重复率", "导入当前租户当前窗口的 sGTM Debug 日志；原始事件接入不自动填充 Debug 日志表");
  if (logTotal > logValid) issue("中", `${logTotal - logValid}/${logTotal} 条 sGTM 日志缺少有效 UUID`, "这些记录无法纳入按 ID 计算的重复率", "在事件产生时生成 UUID，并在重试及 sGTM 转发中保持不变");
  const score = coverage === null ? null : Math.round(100 * (identityRate === null ? coverage : 0.6 * coverage + 0.4 * identityRate));
  if (!suggestions.length) suggestions.push("当前已评估指标未发现问题；继续验证真实业务操作、跨域链路及上游日志，不把本评分作为完整审计通过。");
  return {
    schemaVersion: "report.v1", outputType: "report", title: "埋点质量分析 · 真实归因数据",
    meta: window.label + ` · 归因事件 ${total} 条 · sGTM 日志 ${logTotal} 条`,
    score: { value: score, label: score === null ? "无归因样本，暂不评分" : "仅评估事件类型覆盖与登录后事件的用户标识完整性" },
    stats: [["归因事件数", total], ["窗口内已观测事件类型", `${covered.length} / ${EVENT_NAMES.length}`], ["关键事件类型覆盖率", pct(coverage)], ["登录后事件 user_id 完整率", pct(identityRate)], ["sGTM 日志有效 ID 重复率", pct(repeatRate)], ["sGTM 日志有效 ID 率", pct(logTotal ? logValid / logTotal : null)], ["跨域事件丢失率", "未评估：缺少两端可对账样本"], ["整体参数合规率", "未评估：v1 仅检查 user_id"]],
    table: { title: "问题清单", head: ["严重度", "问题", "影响", "建议"], rows }, suggestions,
    evidence: { generatedAt, window: { from: window.from, toExclusive: window.to }, eventCounts: counts, identityTotal, identityPresent, logTotal, logValid, duplicateExtra: dup,
      scoreMethod: "有登录后样本：100×(0.6×六类事件类型覆盖率+0.4×user_id完整率)；无登录后样本：100×覆盖率；无归因样本：null",
      sources: ["pt_events：已落库、已去重的归因事件（包含实时接入及事件 CSV 导入，无法区分）", "ss_gtm_debug_logs：已导入的日志；不保证上游全量覆盖"],
      limitations: ["类型覆盖率不是事件数量丢失率；默认六事件模板，窗口内可能没有发生某类业务", "重复率分母为日志中有效 UUID 记录数，按 event_id 忽略 UUID 大小写计重复；可能包括合法重试", "无 GA4 查询；不依赖 GA 授权，也不推断跨域丢失", "规则生成建议，没有调用大模型"] },
  };
}
function createQualityService({ pool, now = Date.now }) {
  return async (ctx, args = {}) => {
    if (!isUuid(ctx?.tenantId) || !ctx.workspaceId) fail("CONTEXT_REQUIRED", "需要可信租户与工作区上下文");
    if (!pool) fail("QUALITY_SOURCE_UNAVAILABLE", "真实归因数据库未接线");
    const window = qualityWindow(args, now());
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ctx.tenantId]);
      const params = [ctx.tenantId, window.from, window.to];
      const events = await client.query(`SELECT event_name, count(*)::int AS total,
        count(*) FILTER (WHERE event_name <> 'visit')::int AS identity_total,
        count(*) FILTER (WHERE event_name <> 'visit' AND NULLIF(trim(user_id),'') IS NOT NULL)::int AS identity_present
        FROM pt_events WHERE tenant_id=$1::uuid AND timestamp >= $2::bigint AND timestamp < $3::bigint GROUP BY event_name`, params);
      const logs = await client.query(`SELECT count(*)::int AS total, count(valid_id)::int AS valid_ids,
        (count(valid_id)-count(DISTINCT valid_id))::int AS duplicate_extra FROM (
          SELECT CASE WHEN event_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN lower(event_id) END AS valid_id
          FROM ss_gtm_debug_logs WHERE tenant_id=$1::uuid AND timestamp >= $2::bigint AND timestamp < $3::bigint
        ) AS logs`, params);
      await client.query("COMMIT");
      return buildQualityReport(events.rows, logs.rows[0], window, new Date(now()).toISOString());
    } catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; }
    finally { client.release(); }
  };
}
module.exports = { createQualityService, qualityWindow, buildQualityReport };
