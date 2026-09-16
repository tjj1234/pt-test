"use strict";
/**
 * 北极星项目 · 数据接入层 · 单元 1.5 Token 最小审计（Server 侧上报 + event_id 完整性）
 *
 * 依据：《北极星开发/1-数据接入/1.5-Token最小审计-fixed.md》
 *   §1.1 审计对象（credit_purchase / balance_recharge / token_consume 三事件强制 Server）
 *   §1.3 判据 → 告警分级（client=高风险 / unknown=中风险 / event_id 缺失·非法=高风险）
 *   §2.2 classifySource（transport > 显式标记 > UA·ip_override 兜底 三层判源）
 *   §4   event_id 完整性检查（缺失 / 非法 → 计入 n_bad_id；重复 → 🟡 提示，不计入）
 *   §5.1 report 六字段（title/meta/score/stats/table/suggestions，对齐 5.1 §3.1 模具）
 *   §5.3 评分两步法：基础分 = 100 × (0.7·server_rate + 0.3·eventid_rate)，
 *        然后 n_client > 0 时 score = min(基础分, 59) 红线封顶（恒 < 60 落红区）
 *   §7   最小子集边界（只读、不采集正文、不存完整 Key、不铺四维）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. 只读旁路：本模块是「纯函数」——只吃输入、产出 report，无任何 DB / 网络写操作；
 *      不写库、不拦事件、不改 pt_events（§7.3）。
 *   2. 不编造指标：所有数值（N / n_server / n_client / n_unknown / n_bad_id / 各率 / 评分）
 *      一律由输入的 SS-GTM 日志逐条算出；时间窗内无三事件数据时输出空态（§5.4），
 *      绝不写 100% / 0 条 等未经验证的数。
 *   3. 不采集正文、不存完整 Key：审计只读事件元数据（event_name / 来源侧 / event_id /
 *      时间戳），本模块根本不接收、不触碰 prompt/completion 正文与完整 API Key（§7.2）。
 *   4. 来源侧只认 SS-GTM 日志：pt_events 宽表无「来源侧」列（§8.1），故来源判定必须由
 *      调用方从 SS-GTM Debug 日志解析后传入；本模块不对 pt_events 做来源推断。
 *
 * 依赖注入（对齐 collect / events 风格，数据源可换）：
 *   - logs：已解析的 SS-GTM Debug 日志逐条记录（调用方从 Preview / Debug API / 容器访问
 *     日志拉取并拍平成 SsGtmLogEntry）。本模块不自己调 SS-GTM API。
 *   - configFindings：可选，GTM 静态容器配置审计（手段二辅助）的发现项，只作建议里的
 *     [中]/[低] 提示、不改变 score（§3.3「不独立定论、不升为高风险」）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIT_EVENT_NAMES = void 0;
exports.classifySource = classifySource;
exports.checkEventId = checkEventId;
exports.aggregateLogs = aggregateLogs;
exports.computeScore = computeScore;
exports.runTokenAudit = runTokenAudit;
const validate_1 = require("../collect/validate");
// ---------------------------------------------------------------------------
// 常量：三审计事件（§1.1 强制 Server 清单）
// ---------------------------------------------------------------------------
/**
 * 本期只审这三个强制 Server 侧事件（§1.1）。
 * 注意：pt_events 的白名单是 recharge / model_call（1.2/1.3），而审计的三事件是
 * SS-GTM 侧的细分事件名（recharge → credit_purchase / balance_recharge 二选一互斥、
 * model_call → token_consume），口径见 §1.1 斜杠语义；审计按三事件各自独立计数。
 */
exports.AUDIT_EVENT_NAMES = [
    "credit_purchase",
    "balance_recharge",
    "token_consume",
];
function isAuditEvent(name) {
    return exports.AUDIT_EVENT_NAMES.includes(name);
}
function normalizeTransport(raw) {
    if (typeof raw !== "string")
        return undefined;
    const s = raw.trim().toLowerCase().replace(/[\s\-_.]+/g, "");
    if (s === "ga4" || s === "googleanalytics" || s === "googleanalytics4") {
        return "GA4";
    }
    if (s === "measurementprotocol" || s === "mp" || s === "mpcollect" || s === "measurement") {
        return "MeasurementProtocol";
    }
    if (s === "custom")
        return "custom";
    return undefined; // 不在 GA4/MP/custom 三态内 → 判源模型外，按无法验证处理
}
/** 取显式来源标记（event_source 优先，其次 x-pt-source），只认 server / client。 */
function markerValue(e) {
    const raw = firstNonEmpty(e.event_source, e.x_pt_source);
    if (!raw)
        return undefined;
    const s = raw.toLowerCase();
    if (s === "server")
        return "server";
    if (s === "client")
        return "client";
    return undefined;
}
/** 服务端库 UA（可被伪造，只作兜底、不作定论，§2.2 ③）。 */
const SERVER_UA_PATTERN = /go-http-client|python-requests|python-urllib|urllib3|aiohttp|httpx|axios|node-fetch|undici|got\b|superagent|request\/|curl\/|wget\/|okhttp|java\/|libwww|postmanruntime|insomnia/i;
/** 浏览器 UA（§2.2 ③）。 */
const BROWSER_UA_PATTERN = /mozilla\/|applewebkit|chrome\/|crios\/|firefox\/|fxios\/|safari\/|edg\/|edga\/|opr\/|opera\/|msie|trident|gecko\/|samsungbrowser|ucbrowser/i;
/** UA 兜底启发式：能判定则返回 server/client，判定不出返回 undefined（不算数、不猜）。 */
function classifyUa(ua) {
    if (SERVER_UA_PATTERN.test(ua))
        return "server";
    if (BROWSER_UA_PATTERN.test(ua))
        return "client";
    return undefined;
}
function firstNonEmpty(...vals) {
    for (const v of vals) {
        if (typeof v === "string" && v.trim().length > 0)
            return v.trim();
    }
    return undefined;
}
function hasValue(v) {
    if (v === undefined || v === null)
        return false;
    if (typeof v === "string")
        return v.trim().length > 0;
    if (typeof v === "number")
        return Number.isFinite(v);
    if (typeof v === "boolean")
        return v === true;
    return true;
}
/**
 * 来源侧判定（§2.2 伪代码落地，补充「缺元数据 → unknown」的降级路径）。
 *
 * 优先级：
 *   ① transport（最强，凭证未泄漏时前端不可伪造）：MP / custom → server；GA4 → client
 *      （浏览器通道，即便自称 event_source=server 也视为前端伪造的「矛盾」信号）。
 *   ② 显式标记：event_source/x-pt-source = server → server；= client → client。
 *   ③ 兜底启发式（只作兜底、不作定论）：ip_override → server；UA 服务端库 → server、
 *      浏览器 → client；UA 判定不出 → unknown。
 *   全部元数据缺失 → unknown（🟡 中风险，不触发红线，§5.3 注）。
 */
function classifySource(e) {
    const transport = normalizeTransport(e.transport);
    // ① transport（最强）
    if (transport === "MeasurementProtocol" || transport === "custom")
        return "server";
    if (transport === "GA4")
        return "client"; // 浏览器通道 → 前端（§2.2 矛盾规则合并在此）
    // ② 显式来源标记（transport 缺失时）
    const marker = markerValue(e);
    if (marker === "server")
        return "server";
    if (marker === "client")
        return "client";
    // ③ ip_override / UA 兜底启发式（只作兜底、不作定论）
    if (hasValue(e.ip_override))
        return "server"; // 只有服务端 MP 才能合法设
    const ua = firstNonEmpty(e.user_agent);
    if (ua) {
        const byUa = classifyUa(ua);
        if (byUa)
            return byUa;
    }
    return "unknown";
}
/** 复用 1.2 的 UUID 校验（8-4-4-4-12），保持口径一致。 */
function checkEventId(eventId) {
    if (eventId === undefined || eventId === null)
        return "missing";
    if (typeof eventId !== "string")
        return "invalid";
    if (eventId.trim() === "")
        return "missing";
    if (!(0, validate_1.isUuid)(eventId))
        return "invalid";
    return "ok";
}
/** 诊断表最大行数（防超大告警撑爆 report；截断显式标注，不静默丢）。 */
const MAX_TABLE_ROWS = 100;
function emptyBreakdown() {
    return { total: 0, server: 0, client: 0, unknown: 0 };
}
function displayEventId(id, status) {
    if (status === "missing")
        return "（缺失）";
    if (status === "invalid")
        return `${String(id ?? "").slice(0, 40)}（非法）`;
    return String(id);
}
/** 客户端判源证据（用于 table 的「问题」列，优先展示最强信号）。 */
function clientEvidence(e) {
    const t = normalizeTransport(e.transport);
    if (t)
        return `transport=${t}`;
    const m = markerValue(e);
    if (m)
        return `event_source=${m}`;
    const ua = firstNonEmpty(e.user_agent);
    if (ua)
        return `UA 兜底（${ua.slice(0, 40)}）`;
    return "来源元数据缺失";
}
function pushFinding(agg, f) {
    if (agg.findings.length >= MAX_TABLE_ROWS) {
        agg.findingsTruncated += 1;
        return;
    }
    agg.findings.push(f);
}
/**
 * 聚合（§5.3 第一步）。
 * - 只保留三事件；逐条 classifySource + checkEventId。
 * - 幂等重复：对「合法 event_id」按 (tenant_id, event_id)（无 tenant 则 event_id）计数，
 *   出现 >1 次即记 n_dup_extra（这是 SS-GTM 原始流里的重复，1.3 的 ON CONFLICT DO NOTHING
 *   会去重；落到 pt_events 后已无重复，故去重信号只能从日志侧取，§4.2）。
 * - 逐条风险写入 findings（client / unknown / bad_id 三类，同一条事件可同时触发来源侧
 *   与 event_id 两条告警，告警按「判据」计数，§6）。
 */
function aggregateLogs(logs) {
    const byEvent = {
        credit_purchase: emptyBreakdown(),
        balance_recharge: emptyBreakdown(),
        token_consume: emptyBreakdown(),
    };
    const agg = {
        N: 0,
        n_server: 0,
        n_client: 0,
        n_unknown: 0,
        n_missing: 0,
        n_invalid: 0,
        n_bad_id: 0,
        n_dup_extra: 0,
        n_dup_ids: 0,
        byEvent,
        findings: [],
        findingsTruncated: 0,
    };
    // ① 先统计合法 event_id 出现次数（幂等重复检查，只对合法 id 有意义）
    const idCount = new Map();
    for (const log of logs) {
        const name = typeof log.event_name === "string" ? log.event_name.trim() : "";
        if (!isAuditEvent(name))
            continue;
        if (checkEventId(log.event_id) === "ok") {
            const id = log.event_id.trim();
            const key = log.tenant_id ? `${log.tenant_id}\u0000${id}` : id;
            idCount.set(key, (idCount.get(key) ?? 0) + 1);
        }
    }
    for (const c of idCount.values()) {
        if (c > 1) {
            agg.n_dup_ids += 1;
            agg.n_dup_extra += c - 1;
        }
    }
    // ② 逐条判源 + event_id 检查 + 记录发现
    for (const log of logs) {
        const name = typeof log.event_name === "string" ? log.event_name.trim() : "";
        if (!isAuditEvent(name))
            continue;
        const source = classifySource(log);
        const idStatus = checkEventId(log.event_id);
        agg.N += 1;
        const b = byEvent[name];
        b.total += 1;
        if (source === "server") {
            agg.n_server += 1;
            b.server += 1;
        }
        else if (source === "client") {
            agg.n_client += 1;
            b.client += 1;
        }
        else {
            agg.n_unknown += 1;
            b.unknown += 1;
        }
        if (idStatus === "missing")
            agg.n_missing += 1;
        else if (idStatus === "invalid")
            agg.n_invalid += 1;
        if (source === "client") {
            pushFinding(agg, {
                eventName: name,
                problem: `纯前端上报（${clientEvidence(log)}）`,
                source: "client",
                severity: "高",
                eventId: displayEventId(log.event_id, idStatus),
                fix: "改 Server（支付/计费成功回调经 Measurement Protocol 上报，带 event_source=server）",
            });
        }
        else if (source === "unknown") {
            pushFinding(agg, {
                eventName: name,
                problem: "来源元数据缺失，无法验证",
                source: "unknown",
                severity: "中",
                eventId: displayEventId(log.event_id, idStatus),
                fix: "镜像 Tag 补转 client_name / event_source",
            });
        }
        if (idStatus === "missing" || idStatus === "invalid") {
            pushFinding(agg, {
                eventName: name,
                problem: idStatus === "missing" ? "event_id 缺失 / 空" : "event_id 非合法 UUID",
                source,
                severity: "高",
                eventId: displayEventId(log.event_id, idStatus),
                fix: "源头补发合法 UUID（契约 §1.1 必填）",
            });
        }
    }
    agg.n_bad_id = agg.n_missing + agg.n_invalid;
    return agg;
}
// ---------------------------------------------------------------------------
// 评分算法（§5.3 第二步「基础分 + 红线封顶」）
// ---------------------------------------------------------------------------
/** 色阶（§5.3 确定阈值）。 */
const COLOR_GREEN = "#16a34a";
const COLOR_YELLOW = "#f59e0b";
const COLOR_RED = "#dc2626";
/** 红线封顶值（= 及格线 60 − 1，§5.3 注）。 */
const RED_LINE_CAP = 59;
function round2(n) {
    return Number(n.toFixed(2));
}
function scoreColor(value) {
    if (value >= 85)
        return COLOR_GREEN;
    if (value >= 60)
        return COLOR_YELLOW;
    return COLOR_RED;
}
function scoreLabel(value, color) {
    const word = color === COLOR_GREEN ? "健康" : color === COLOR_YELLOW ? "良好" : "风险";
    const emoji = color === COLOR_GREEN ? "🟢" : color === COLOR_YELLOW ? "🟡" : "🔴";
    const v = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${emoji} ${word} · ${v}/100`;
}
/**
 * 评分两步法（§5.3，确定式）：
 *   基础分 = 100 × (0.7 × server_rate + 0.3 × eventid_rate)
 *     server_rate  = n_server / N
 *     eventid_rate = (N − n_bad_id) / N
 *   score = 基础分                  （n_client = 0）
 *   score = min(基础分, 59)          （n_client > 0，红线封顶，恒 ≤ 59 < 60 落红区）
 *
 * N ≤ 0 → 返回 null（空态，不评分、不编造）。
 * unknown 只降 server_rate、升中风险告警，不触发红线（§5.3 注）。
 */
function computeScore(agg) {
    if (agg.N <= 0)
        return null;
    const serverRate = agg.n_server / agg.N;
    const eventIdRate = (agg.N - agg.n_bad_id) / agg.N;
    const base = 100 * (0.7 * serverRate + 0.3 * eventIdRate);
    const raw = agg.n_client > 0 ? Math.min(base, RED_LINE_CAP) : base;
    const value = round2(raw);
    const color = scoreColor(value);
    return { label: scoreLabel(value, color), value, color };
}
// ---------------------------------------------------------------------------
// report 组装（§5.1 六字段，对齐 5.1 §3.1 模具）
// ---------------------------------------------------------------------------
function fmtMs(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function pct(numerator, denominator) {
    if (denominator <= 0)
        return "—";
    const v = ((numerator / denominator) * 100).toFixed(2);
    return `${v.replace(/\.?0+$/, "")}%`;
}
function buildMeta(input, agg) {
    const parts = [];
    const w = input.window;
    if (w && w.from !== undefined && w.to !== undefined) {
        parts.push(`时间窗 ${fmtMs(w.from)}~${fmtMs(w.to)} UTC`);
    }
    else {
        parts.push("时间窗 未限定");
    }
    const sources = input.configFindings
        ? "SS-GTM Debug 日志 + GTM 静态配置"
        : "SS-GTM Debug 日志";
    parts.push(`数据源 ${sources}`);
    if (agg.N === 0) {
        parts.push("三事件合计 N=0 条（空态）");
    }
    else {
        const { credit_purchase, balance_recharge, token_consume } = agg.byEvent;
        parts.push(`三事件合计 N=${agg.N} 条（credit_purchase ${credit_purchase.total} + balance_recharge ${balance_recharge.total} + token_consume ${token_consume.total}）`);
    }
    return parts.join(" · ");
}
function buildStats(agg) {
    const high = agg.n_client + agg.n_bad_id; // 🔴 = 前端-only + event_id 缺失/非法（§6）
    const mid = agg.n_unknown; // 🟡 = 来源未知（§6）
    const highParts = [];
    if (agg.n_client > 0)
        highParts.push("前端-only");
    if (agg.n_bad_id > 0)
        highParts.push("event_id 缺失/非法");
    let alert = `${high + mid} 条`;
    if (high > 0)
        alert += `：高风险 ${high}（${highParts.join(" · ")}）`;
    if (mid > 0)
        alert += `${high > 0 ? " · " : "："}中风险 ${mid}（来源未知）`;
    if (high === 0 && mid === 0)
        alert += "（无告警）";
    const stats = [
        ["Server 侧上报通过率", `${pct(agg.n_server, agg.N)}（server ${agg.n_server} / ${agg.N}）`],
        ["event_id 完整性", `${pct(agg.N - agg.n_bad_id, agg.N)}（缺失 ${agg.n_missing} · 非法 ${agg.n_invalid} / ${agg.N}）`],
        ["告警", alert],
    ];
    // 幂等重复率：🟡 健康指标，不并入告警条数（§4.2「只作提示」）
    if (agg.n_dup_extra > 0) {
        stats.push([
            "幂等重复率",
            `${pct(agg.n_dup_extra, agg.N)}（重复 ${agg.n_dup_extra} 次 / 涉及 ${agg.n_dup_ids} 个 event_id）`,
        ]);
    }
    return stats;
}
function buildTable(agg) {
    if (agg.findings.length === 0)
        return undefined; // 无告警 → 省略 table（⚪）
    const head = ["#", "事件", "问题", "来源侧", "严重度", "event_id", "整改"];
    const rows = agg.findings.map((f, i) => [
        String(i + 1),
        f.eventName,
        f.problem,
        f.source,
        f.severity,
        f.eventId,
        f.fix,
    ]);
    const title = agg.findingsTruncated > 0
        ? `🔍 风险诊断（另有 ${agg.findingsTruncated} 条未列出）`
        : "🔍 风险诊断";
    return { title, head, rows };
}
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
function circled(i) {
    return CIRCLED[i] ?? `(${i + 1})`;
}
function severityTag(s) {
    return s === "high" ? "高" : s === "medium" ? "中" : "低";
}
function buildSuggestions(agg, configFindings) {
    const parts = [];
    if (agg.n_client > 0) {
        parts.push(`[高] 三事件出现 ${agg.n_client} 条前端上报，改由服务端经 Measurement Protocol（带 event_source=server）上报`);
    }
    if (agg.n_bad_id > 0) {
        parts.push(`[高] 三事件 event_id 缺失/非法 ${agg.n_bad_id} 条，源头补发合法 UUID（契约 §1.1 必填）`);
    }
    if (agg.n_unknown > 0) {
        parts.push("[中] 镜像 Tag 转发补带 client_name / event_source，消除「无法判定」");
    }
    if (agg.n_dup_extra > 0) {
        parts.push(`[中] event_id 重复 ${agg.n_dup_extra} 次，核查幂等键 (tenant_id, event_id)`);
    }
    // 手段二辅助（§3.3）：配置发现只作提示、不升为高风险、不改 score
    for (const c of configFindings ?? []) {
        parts.push(`[${severityTag(c.severity)}] ${c.check}：${c.detail}`);
    }
    if (agg.n_client === 0 && agg.n_unknown === 0 && agg.n_bad_id === 0 && agg.n_dup_extra === 0) {
        parts.push("[低] 本期无告警，三事件均 Server 上报且 event_id 完整");
    }
    parts.push("[低] 完整四维审计产品化已后置（P2）");
    return parts.map((p, i) => `${circled(i)} ${p}`).join(" · ");
}
/**
 * 运行 Token 最小审计，产出 report（§5.1 六字段，对齐 5.1 §3.1 模具）。
 *
 * 有数据（N > 0）：输出 title/meta/score/stats/table/suggestions 六字段（table 在无告警时
 *   省略，符合模具 ⚪ 可选）。
 * 空态（N = 0）：按 §5.4 兜底——省略 score/table/suggestions，stats 写「暂不可用」，
 *   绝不编造 100% / 0 条。
 */
function runTokenAudit(input) {
    const agg = aggregateLogs(input.logs);
    const report = {
        title: "🔍 Token 最小审计报告",
        meta: buildMeta(input, agg),
    };
    if (agg.N > 0) {
        const score = computeScore(agg);
        if (score)
            report.score = score;
        report.stats = buildStats(agg);
        report.table = buildTable(agg);
        report.suggestions = buildSuggestions(agg, input.configFindings);
    }
    else {
        // 空态（§5.4）：省略 score/table/suggestions，stats 写「暂不可用」
        report.stats = [
            ["校验事件数", "0（时间窗内无 credit_purchase / balance_recharge / token_consume）"],
            ["Server 侧上报通过率", "暂不可用"],
            ["event_id 完整性", "暂不可用"],
        ];
    }
    return report;
}
//# sourceMappingURL=token.js.map