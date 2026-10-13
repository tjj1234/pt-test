/**
 * 回归：埋点质量分析报告（tracking-quality-report.v1）在报告抽屉里的渲染
 *
 * 背景：任务包里说的「照着抄一份接上就行」其实是错觉。抽屉外壳 + 渲染器早就有了
 * （report-drawer.js / report-render.js），但渲染器只认 通用 report.v1 的
 * `issues` / `remediation` 别名，而埋点质量报告用的是契约里的 `issuesTable` /
 * `recommendations`。直接把真实输出丢进去，结果是：
 *   - 问题清单、整改建议 整块不渲染（别名对不上）
 *   - 关键指标显示 totalAdapted 这类英文机器名，单位全丢
 *   - 覆盖范围声明 / 局限说明 / 数据来源 / 解读约束 四个契约 required 字段全部静默丢弃
 *   —— 而这几个恰恰是「这份报告没覆盖什么、不能怎么解读」的诚实性字段，丢掉最危险。
 *
 * 本测试不手写假数据走捷径，而是直接 require 业务层真实的 buildTrackingQualityReport
 * 生成报告，再喂给 report-render.js，逐项核对契约字段是否真的出现在 HTML 里。
 * 同时反向守住「通用 report 老结构不能被改坏」——report-render.js 还被
 * ga-connector / quality 三个业务测试引用着。
 *
 * 跑法：node tests/regression/ui-tracking-quality-report-test.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const RENDER = path.resolve(ROOT, "shell/public/report-render.js");
const CONTRACT = path.resolve(ROOT, "business/attribution/contracts/tracking-quality-report.json");
const BUILDER = path.resolve(ROOT, "business/attribution/skills/tracking-quality-audit.js");

const { renderReportHTML, coerceFields, sampleReport, sampleTrackingQualityReport } = require(RENDER);
const { buildTrackingQualityReport } = require(BUILDER);

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
};
const section = (t) => console.log("\n[" + t + "]");

/* ------------------------------------------------------------------ *
 * 造一份能被 buildTrackingQualityReport 校验通过的真实质量统计。
 * 约束（见 tracking-quality-audit.js validateSnapshot）：
 *   totalAdapted = ignored + unmappedEventCount + accepted
 *   accepted     = client_native_unique + adapter_fallback
 *   t.count + t.client_count = accepted
 *   client_native_ratio / ratio 必须与计数一致（4 位小数）
 * ------------------------------------------------------------------ */
const WS = "ws_ui_report_test";
const GENERATED_AT = "2026-10-12T10:30:00.000Z";

function snapshot(over = {}) {
  return Object.assign({
    workspaceId: WS,
    totalAdapted: 1075,          // 30 + 45 + 1000
    ignored: 30,
    unmappedEventCount: 45,
    eventIdQuality: { client_native_unique: 850, adapter_fallback: 150, client_native_ratio: 0.85 },
    timestampFallback: { count: 120, ratio: 0.12, client_count: 880 },
    mappedViaConfig: 900,
    updatedAt: "2026-10-12T10:25:00.000Z",
  }, over);
}

const rep = buildTrackingQualityReport(snapshot(), WS, GENERATED_AT);
const html = renderReportHTML(rep);

/* ====================== [1] 契约字段全覆盖 ====================== */
section("1 契约 required 字段是否真的渲染出来了");
const contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
const required = contract.required;

// 结构元数据：不进正文，只用于路由/校验
// generatedAt 单列：渲染器会把 ISO 格式化成本地时间，不能拿裸 ISO 去比对
const STRUCTURAL = new Set(["outputType", "schemaVersion", "generatedAt"]);
for (const key of required) {
  if (STRUCTURAL.has(key)) continue;
  const raw = rep[key];
  if (raw == null) { ok("契约字段 " + key + " 存在于报告对象", false); continue; }
  // 取该字段里第一个「人能看见的短文本」作为探针
  let probe = null;
  if (key === "issuesTable") probe = String(raw.rows && raw.rows[0] ? raw.rows[0].title : "");
  else if (key === "recommendations") probe = String(raw[0] && raw[0].action ? raw[0].action : "");
  else if (typeof raw === "string") probe = raw;
  else if (Array.isArray(raw) && raw.length) probe = typeof raw[0] === "string" ? raw[0] : String(raw[0].label || raw[0].key || "");
  else if (typeof raw === "object") probe = String(raw.label || raw.title || raw.reason || raw.instruction || raw.kind || raw.window || raw.mode || raw.status || "");
  ok("契约字段 " + key + " 渲染进 HTML", !!probe && html.includes(probe), probe ? "缺 " + probe : "无探针");
}
// 与渲染器同款的时间格式化，用来验证 generatedAt 真的出现在副标题里
const fmtLocal = (s) => {
  const d = new Date(s); const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
};
ok("契约字段 generatedAt 渲染进 HTML（格式化后）", html.includes(fmtLocal(rep.generatedAt)));
ok("schemaVersion 渲染进 HTML", html.includes("tracking-quality-report.v1"));
ok("标题渲染正确", html.includes("埋点质量 AI 分析"));
// 契约没有 meta 字段，副标题由 workspaceId + generatedAt + template 兜底生成
ok("副标题兜底含工作区", html.includes(WS));
ok("副标题兜底含模板", html.includes("saas_token_marketplace"));
ok("副标题兜底含生成时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(html));
ok("没有 [object Object]", !html.includes("[object Object]"));

/* ====================== [2] 评分区块 ====================== */
section("2 评分：状态 / 口径 / 分项扣分");
// accepted=1000；40*45/1045=1.7225，35*150/1000=5.25，25*120/1000=3 → 100-9.9725=90.0275 → 90
// 100 - 1.7225 - 5.25 - 3 = 90.0275 → 90
ok("评分值算对（90）", rep.scoreBar.value === 90, "实际 " + rep.scoreBar.value);
ok("状态枚举为 healthy", rep.scoreBar.status === "healthy");
ok("评分数字出现在 HTML", html.includes(">90<"));
ok("状态徽标文案出现", html.includes("健康"));
ok("状态色映射到绿（healthy）", html.includes("#16a34a"));
ok("评分口径（method）渲染出来", html.includes("评分口径"));
ok("评分口径含算法文本", html.includes("25×时间戳兜底"));
ok("分项：事件映射", html.includes("事件映射"));
ok("分项：客户端事件标识", html.includes("客户端事件标识"));
ok("分项：客户端时间戳", html.includes("客户端时间戳"));
ok("分项权重 40%", html.includes("40%"));
ok("分项扣分 1.7225（4 位小数不被压成 1.7）", html.includes("−1.7225"));
ok("分项扣分 5.25（尾随 0 去掉）", html.includes("−5.25") && !html.includes("−5.2500"));
ok("分项扣分 3（整数不显示小数点）", html.includes("−3<"));
ok("分项命中/样本 45 / 1,045", html.includes("45 / 1,045"));

/* ====================== [3] 关键指标 ====================== */
section("3 关键指标：中文 label / 单位 / 千分位 / 时间格式化");
ok("用中文 label 而不是机器名 key", html.includes("适配尝试总数") && !html.includes(">totalAdapted<"));
ok("已适配事件", html.includes("已适配事件"));
ok("客户端有效 UUID", html.includes("客户端有效 UUID"));
ok("适配层 ID 兜底", html.includes("适配层 ID 兜底"));
ok("经配置映射的已适配事件", html.includes("经配置映射的已适配事件"));
ok("单位「条」没丢", html.includes("1,075 条"));
ok("千分位生效", html.includes("1,000 条") || html.includes("1,075 条"));
ok("统计更新时间被格式化（不是裸 ISO）", !html.includes("2026-10-12T10:25:00.000Z"));
ok("统计更新时间有值", /统计更新时间<\/span>.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(html));

/* ====================== [4] 问题清单 ====================== */
section("4 问题清单：columns 列定义 + 对象行 + evidence");
ok("区块标题是「问题清单」", html.includes("问题清单"));
ok("列头用 label（级别）", html.includes("级别"));
ok("列头用 label（统计依据）", html.includes("统计依据"));
ok("列头用 label（业务影响）", html.includes("业务影响"));
ok("3 个问题都被渲染", html.includes("存在未映射事件，无法进入归因事件白名单")
  && html.includes("部分事件依赖适配层生成 event_id")
  && html.includes("部分事件使用接收时间代替发生时间"));
ok("evidence 取的是 summary 文本", html.includes("45 / 1045 条非忽略事件（4.3%）"));
ok("evidence 第二条", html.includes("150 / 1000 条已适配事件（15.0%）"));
ok("impact 文本", html.includes("会形成归因漏斗缺口"));
ok("high 严重度徽标", html.includes("rpt-sev-high"));
ok("medium 严重度徽标", html.includes("rpt-sev-mid"));
ok("表格行数 = 3", (html.match(/<tr><td>/g) || []).length >= 3);

/* ====================== [5] 整改建议 ====================== */
section("5 整改建议：action 字段 + 优先级徽标 + 验收方法");
ok("区块标题是「整改建议」", html.includes("整改建议"));
ok("建议条数 = 3", (html.match(/class="rpt-suggestion"/g) || []).length === 3,
  "实际 " + (html.match(/class="rpt-suggestion"/g) || []).length);
ok("action 文本读到了（不是空 li）", html.includes("核对业务事件映射"));
ok("优先级 P1 映射成「高」徽标", html.includes(">高</span>"));
ok("优先级 P2 映射成「中」徽标", html.includes(">中</span>"));
ok("verification 验收方法没丢", html.includes("验收："));
ok("验收文本完整", html.includes("历史累计不会自动清零"));

/* ====================== [6] 诚实性区块 ====================== */
section("6 覆盖范围 / 局限 / 数据来源 / 解读约束");
ok("覆盖范围区块存在", html.includes("覆盖范围"));
ok("明确写出「未评估」", html.includes("未评估"));
ok("未评估原因", html.includes("不能判断核心事件覆盖"));
ok("期望事件 visit", html.includes("visit"));
ok("期望事件 recharge", html.includes("recharge"));
ok("期望事件 auto_recharge_toggle", html.includes("auto_recharge_toggle"));
ok("局限说明区块存在", html.includes("局限说明"));
ok("局限 5 条全在", (rep.limitations || []).length === 5 && rep.limitations.every((x) => html.includes(x)));
ok("数据来源区块存在", html.includes("数据来源"));
ok("统计范围翻译成「当前工作区」", html.includes("当前工作区"));
ok("统计窗口", html.includes("累计：自当前进程启动"));
ok("来源补充 client_count（kv 没覆盖的那项）", html.includes("客户端提供时间戳") && html.includes("880 条"));
ok("解读约束区块存在", html.includes("解读约束"));
ok("模式是 backend_rules", html.includes("backend_rules"));
ok("约束指令", html.includes("不补造事件样例"));

/* ====================== [7] 样本不足 ====================== */
section("7 样本不足（insufficient_data）");
const empty = buildTrackingQualityReport(
  snapshot({ totalAdapted: 0, ignored: 0, unmappedEventCount: 0,
    eventIdQuality: { client_native_unique: 0, adapter_fallback: 0, client_native_ratio: null },
    timestampFallback: { count: 0, ratio: null, client_count: 0 },
    mappedViaConfig: 0, updatedAt: null }),
  WS, GENERATED_AT);
const ehtml = renderReportHTML(empty);
ok("评分值为 null", empty.scoreBar.value === null);
ok("状态为 insufficient_data", empty.scoreBar.status === "insufficient_data");
// 直接把评分位的文本抠出来比对，避免依赖文件里破折号的字面写法
const scoreNum = /class="rpt-score-num"[^>]*>([^<]*)</.exec(ehtml);
ok("评分位有内容", !!scoreNum);
ok("评分位显示破折号（U+2014）而不是 0",
  !!scoreNum && scoreNum[1].charCodeAt(0) === 0x2014,
  scoreNum ? "实际 " + JSON.stringify(scoreNum[1]) : "未匹配");
ok("状态徽标「样本不足」", ehtml.includes("样本不足"));
ok("label 文案「样本不足，暂不评分」", ehtml.includes("样本不足，暂不评分"));
ok("分项扣分显示「—」而不是 NaN", !ehtml.includes("NaN") && ehtml.includes("<td>—</td>"));
ok("仍给出 insufficient_data 问题项", ehtml.includes("没有可评估的已适配事件"));
ok("评分口径照常展示", ehtml.includes("评分口径"));

/* ====================== [8] XSS 转义 ====================== */
section("8 XSS：所有动态文本必须转义");
const PAYLOAD = '<img src=x onerror=alert(1)>';
const dirty = buildTrackingQualityReport(snapshot(), WS, GENERATED_AT);
dirty.title = PAYLOAD + "标题";
dirty.scoreBar.label = PAYLOAD + "label";
dirty.scoreBar.method = PAYLOAD + "method";
dirty.scoreBar.components[0].label = PAYLOAD + "comp";
dirty.kv[0].label = PAYLOAD + "kv";
dirty.issuesTable.rows[0].title = PAYLOAD + "issue";
dirty.issuesTable.rows[0].impact = PAYLOAD + "impact";
dirty.issuesTable.rows[0].evidence.summary = PAYLOAD + "summary";
dirty.recommendations[0].action = PAYLOAD + "action";
dirty.recommendations[0].verification = PAYLOAD + "verification";
dirty.coverage.reason = PAYLOAD + "reason";
dirty.coverage.expectedEvents = [PAYLOAD];
dirty.limitations = [PAYLOAD];
dirty.interpretation.instruction = PAYLOAD + "ins";
dirty.source.window = PAYLOAD + "window";
const dhtml = renderReportHTML(dirty);
ok("没有未转义的 <img", !dhtml.includes("<img src=x"));
ok("payload 被转义成 &lt;img", dhtml.includes("&lt;img src=x onerror=alert(1)&gt;"));
// 注入点：title / label / method / comp / kv / issue.title / impact / summary /
//        action / verification / reason / expectedEvents / limitations / instruction / window = 15
ok("转义次数 = 注入次数（15 处全转义）",
  (dhtml.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length === 15,
  "实际 " + (dhtml.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length);
ok("没有残留 onerror=", !/onerror=alert/.test(dhtml.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, "")));

/* ====================== [9] 向后兼容：通用 report.v1 不能被改坏 ====================== */
section("9 向后兼容：通用 report 老结构");
const legacyHtml = renderReportHTML(sampleReport);
ok("旧样本标题照常渲染", legacyHtml.includes("埋点质量 AI 分析 · 体检报告"));
ok("旧样本 meta 优先用它自己的 meta（不被契约兜底覆盖）", legacyHtml.includes("样本事件 1,284,330"));
ok("旧样本评分 72", legacyHtml.includes(">72<"));
ok("旧样本关键指标（数组 kv）", legacyHtml.includes("已配置事件数") && legacyHtml.includes("38 / 52"));
ok("旧样本题为「问题清单」", legacyHtml.includes("问题清单"));
ok("旧样本表格行", legacyHtml.includes("purchase 事件在 Safari 下丢失约 9%"));
ok("旧样本严重度徽标", legacyHtml.includes("rpt-sev-high"));
ok("旧样本建议（字符串数组 + [高] 前缀）", legacyHtml.includes("优先修复 purchase 跨域丢失"));
ok("旧样本不应出现新区块：评分口径", !legacyHtml.includes("评分口径"));
ok("旧样本不应出现新区块：覆盖范围", !legacyHtml.includes("覆盖范围"));
ok("旧样本不应出现新区块：局限说明", !legacyHtml.includes("局限说明"));
ok("旧样本不应出现新区块：数据来源", !legacyHtml.includes("数据来源"));
ok("旧样本不应出现新区块：解读约束", !legacyHtml.includes("解读约束"));

// 直接复刻 ga-connector 测试里那条断言，防止改动击穿别的业务线
const connectorLike = {
  title: "GA4 查询", meta: "m",
  stats: [["汇总 · activeUsers", "已返回行合计 42"]],
  table: { head: ["country", "activeUsers"], rows: [["Japan<script>", "42"]] },
  suggestions: ["[高] 修复跨域"],
};
const clHtml = renderReportHTML(connectorLike);
ok("（connector 口径）普通单元格仍是 <td>42</td>", clHtml.includes("<td>42</td>"));
ok("（connector 口径）单元格内容转义", clHtml.includes("Japan&lt;script&gt;"));
ok("（connector 口径）数组 kv 原样输出", clHtml.includes("已返回行合计 42"));
ok("（connector 口径）严重度不误伤普通单元格", !clHtml.includes("rpt-sev-low"));

// 无列定义的对象行表格：从键推导列（旧行为保留）
const objTable = renderReportHTML({ title: "T", table: [{ a: "1", b: "2" }] });
ok("对象数组表格从键推导列", objTable.includes("<th>a</th>") && objTable.includes("<td>1</td>"));

/* ====================== [10] 抽屉样本与真实输出结构一致 ====================== */
section("10 抽屉预览样本 = 真实契约形状");
const realKeys = Object.keys(rep).sort();
const sampleKeys = Object.keys(sampleTrackingQualityReport).sort();
ok("样本字段集合与真实输出完全一致", JSON.stringify(realKeys) === JSON.stringify(sampleKeys),
  "样本多/少：" + JSON.stringify(sampleKeys.filter((k) => !realKeys.includes(k))
    .concat(realKeys.filter((k) => !sampleKeys.includes(k)))));
ok("样本 schemaVersion 正确", sampleTrackingQualityReport.schemaVersion === "tracking-quality-report.v1");
ok("样本 outputType 正确", sampleTrackingQualityReport.outputType === "report");
ok("样本 template 正确", sampleTrackingQualityReport.template === "saas_token_marketplace");
for (const key of required) {
  ok("样本含契约必填字段 " + key, Object.prototype.hasOwnProperty.call(sampleTrackingQualityReport, key));
}
const sHtml = renderReportHTML(sampleTrackingQualityReport);
ok("样本能渲染出完整区块", sHtml.includes("问题清单") && sHtml.includes("整改建议")
  && sHtml.includes("覆盖范围") && sHtml.includes("局限说明"));
ok("样本评分状态为需关注（橙）", sHtml.includes("需关注") && sHtml.includes("#d97706"));

// coerceFields 别名映射（渲染器与契约的接缝）
const coerced = coerceFields(sampleTrackingQualityReport);
// issuesTable 会被补一个中文标题后包成新对象，所以比对内容而不是对象身份
ok("issuesTable → table 别名生效", coerced.table && coerced.table.rows === sampleTrackingQualityReport.issuesTable.rows);
ok("issuesTable 补上中文标题（不落回「明细」）", coerced.table && coerced.table.title === "问题清单");
ok("recommendations → suggestions 别名生效", coerced.suggestions === sampleTrackingQualityReport.recommendations);
ok("scoreBar → score 别名生效", coerced.score === sampleTrackingQualityReport.scoreBar);
ok("kv → stats 别名生效", coerced.stats === sampleTrackingQualityReport.kv);

/* ====================== 汇总 ====================== */
console.log("\n" + "-".repeat(56));
console.log("PASS " + pass + " / " + (pass + failures.length));
if (failures.length) {
  console.log("FAIL " + failures.length + ":");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("全部通过");
