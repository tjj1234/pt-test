"use strict";
/* ============================================================================
 * report-render.js —— report 类型（outputType:"report"）的「通用」渲染器（纯函数层）
 * --------------------------------------------------------------------------
 * 职责：把任意 Skill 返回的 report 结构渲染成 HTML 片段。组件与具体 Skill 解耦，
 *       Skill-1/2/3/4 只要返回 outputType:"report" 这套结构，都复用本渲染器。
 *
 * 设计规范（对齐 analytics/backend/glue/validate.js 的 OUTPUT_MOLDS.report）：
 *   required: title, meta
 *   optional: score, stats, table, suggestions
 * 同时兼容用户口语化别名：scoreBar→score, kv→stats, issues→table, remediation→suggestions。
 *
 * 安全铁律：所有动态文本一律 escapeHtml；颜色只接受合法色值（safeColor），否则兜底灰。
 *   report 数据来自 Skill 输出（不可信），绝不允许注入。
 *
 * 本文件纯函数、无 DOM 依赖，可在浏览器（挂 window.ReportRender）与 Node（module.exports）
 * 下双重运行，便于自动化验收。抽屉外壳在 report-drawer.js（仅浏览器）。
 * ========================================================================== */

(function (root) {

  /* ----------------------------- 工具 ----------------------------- */

  function escapeHtml(v) {
    if (v == null) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 只接受合法色值，防 style 属性注入；非法值兜底灰
  function safeColor(c) {
    if (typeof c === "string") {
      if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
      if (/^[a-z]+$/i.test(c)) return c; // 命名色（red/green…）也放行
    }
    return "#71717a";
  }

  function clampScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, n));
  }

  function fmtScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  // 高/中/低 → 徽标样式（内联，避免依赖 analytics 前端的色阶变量）
  function severityClass(sev) {
    const s = String(sev == null ? "" : sev).trim();
    if (s === "高" || s === "high" || s === "HIGH") return "rpt-sev rpt-sev-high";
    if (s === "中" || s === "mid" || s === "medium" || s === "MID") return "rpt-sev rpt-sev-mid";
    if (s === "低" || s === "low" || s === "LOW") return "rpt-sev rpt-sev-low";
    return "";
  }
  function severityInline(sev) {
    const s = String(sev == null ? "" : sev).trim();
    if (s === "高" || s === "high" || s === "HIGH") return "background:#fdecec;color:#dc2626";
    if (s === "中" || s === "mid" || s === "medium" || s === "MID") return "background:#fef3e2;color:#d97706";
    if (s === "低" || s === "low" || s === "LOW") return "background:#f4f4f5;color:#71717a";
    return "";
  }

  /* ------------------- 归一化：兼容多种包裹形式 ------------------- */

  function normalizeReport(input) {
    if (!input || typeof input !== "object") return null;
    if (typeof input.title === "string") return input;            // 直接就是 report
    if (input.report && typeof input.report === "object") return input.report; // {report, ...}
    return null;
  }

  // 把 scoreBar/kv/issues/remediation 别名归一到规范字段
  function coerceFields(r) {
    const out = Object.assign({}, r);
    if (out.score == null && r.scoreBar != null) out.score = r.scoreBar;
    if (out.stats == null && r.kv != null) out.stats = r.kv;
    if (out.table == null && r.issues != null) out.table = r.issues;
    if (out.suggestions == null && r.remediation != null) out.suggestions = r.remediation;
    return out;
  }

  /* --------------------------- 各区块渲染 --------------------------- */

  function renderScore(score) {
    // 兼容：纯数字 / {value,color,label} / {score,color,label}
    let v = null, color = null, label = "";
    if (typeof score === "number") v = score;
    else if (score && typeof score === "object") {
      v = (score.value != null) ? score.value : score.score;
      color = score.color || null;
      label = score.label || score.desc || "";
    }
    if (v == null || !Number.isFinite(Number(v))) {
      return '<div class="rpt-block">' +
        '<div class="rpt-subtitle">综合评分</div>' +
        '<div class="rpt-score-empty">评分暂不可用</div></div>';
    }
    const num = Number(v);
    const col = safeColor(color || "#71717a");
    const pct = clampScore(num);
    return '<div class="rpt-block">' +
      '<div class="rpt-subtitle">综合评分</div>' +
      '<div class="rpt-score-row">' +
        '<div class="rpt-score-num" style="color:' + col + '">' + fmtScore(num) + '</div>' +
        '<div class="rpt-score-body">' +
          '<div class="rpt-score-bar"><div class="rpt-score-bar-fill" style="width:' + pct + '%;background:' + col + '"></div></div>' +
          (label ? '<div class="rpt-score-label">' + escapeHtml(label) + '</div>' : '') +
        '</div>' +
      '</div></div>';
  }

  function normalizeKv(stats) {
    // 支持：[[k,v]] / [{key,value}|{label,value}] / {k:v}
    const out = [];
    if (Array.isArray(stats)) {
      for (const item of stats) {
        if (Array.isArray(item) && item.length >= 2) out.push([String(item[0]), item[1]]);
        else if (item && typeof item === "object" && !Array.isArray(item)) {
          const k = item.key != null ? item.key : item.label;
          const v = item.value != null ? item.value : item.val;
          if (k != null) out.push([String(k), v]);
        }
      }
    } else if (stats && typeof stats === "object") {
      for (const k of Object.keys(stats)) out.push([k, stats[k]]);
    }
    return out;
  }

  function renderKv(stats) {
    const rows = normalizeKv(stats);
    const body = rows.length
      ? rows.map(([k, v]) =>
          '<div class="rpt-kv-row"><span class="rpt-kv-k">' + escapeHtml(k) + '</span>' +
          '<span class="rpt-kv-v">' + escapeHtml(v == null ? "" : v) + '</span></div>'
        ).join("")
      : '<div class="rpt-muted">暂无可展示的关键指标</div>';
    return '<div class="rpt-block"><div class="rpt-subtitle">关键指标</div>' +
      '<div class="rpt-kv">' + body + '</div></div>';
  }

  function normalizeTable(table) {
    // 支持：{head,rows} / {title,columns,data} / [ {obj}, ... ]（从键推导列）
    let title = "", head = [], rows = [];
    if (!table) return null;
    if (Array.isArray(table)) {
      if (table.length && typeof table[0] === "object" && !Array.isArray(table[0])) {
        head = Object.keys(table[0]);
        rows = table.map((o) => head.map((h) => o[h]));
        title = "明细";
      }
      return { title, head, rows };
    }
    if (typeof table === "object") {
      title = table.title || table.caption || "明细";
      if (Array.isArray(table.head)) head = table.head;
      else if (Array.isArray(table.columns)) head = table.columns;
      if (Array.isArray(table.rows)) rows = table.rows;
      else if (Array.isArray(table.data)) rows = table.data;
      else if (Array.isArray(table.items)) rows = table.items;
    }
    return { title, head, rows };
  }

  function renderTable(table) {
    const t = normalizeTable(table);
    if (!t || !Array.isArray(t.rows) || !t.rows.length) {
      return '<div class="rpt-block"><div class="rpt-subtitle">问题清单</div>' +
        '<div class="rpt-no-alert">✅ 暂无问题项</div></div>';
    }
    const head = Array.isArray(t.head) ? t.head : [];
    let sevIdx = -1;
    head.forEach((h, i) => {
      const s = String(h).trim().toLowerCase();
      if (s === "严重度" || s === "severity" || s === "level" || s === "级别") sevIdx = i;
    });

    const thead = head.length
      ? '<thead><tr>' + head.map((h) => '<th>' + escapeHtml(h) + '</th>').join("") + '</tr></thead>'
      : '';

    const tbody = '<tbody>' + t.rows.map((row) => {
      const cells = (Array.isArray(row) ? row : []).map((cell, ci) => {
        const text = String(cell == null ? "" : cell);
        let cls = "";
        if (sevIdx >= 0 && ci === sevIdx) cls = severityClass(text);
        else if (sevIdx < 0) cls = severityClass(text); // 无明确严重度列时按内容猜
        if (cls) {
          const inline = sevIdx >= 0 ? severityInline(text) : severityInline(text);
          return '<td><span class="' + cls + '" style="' + inline + '">' + escapeHtml(text) + '</span></td>';
        }
        return '<td>' + escapeHtml(text) + '</td>';
      }).join('');
      return '<tr>' + cells + '</tr>';
    }).join('') + '</tbody>';

    return '<div class="rpt-block"><div class="rpt-subtitle">' + escapeHtml(t.title || "问题清单") + '</div>' +
      '<div class="rpt-table-wrap"><table class="rpt-table">' + thead + tbody + '</table></div></div>';
  }

  function normalizeSuggestions(s) {
    // 支持：string（按 · 或换行拆分）/ string[] / {items:[...]} / [{text,priority}]
    let arr = [];
    if (typeof s === "string") {
      arr = s.split(/[\n·•]|(?:\r\n)/).map((x) => x.trim()).filter(Boolean);
    } else if (Array.isArray(s)) {
      arr = s.map((x) => {
        if (typeof x === "string") return { text: x };
        if (x && typeof x === "object") return { text: x.text != null ? x.text : x.tip, priority: x.priority != null ? x.priority : x.severity };
        return { text: String(x) };
      }).filter((x) => x.text);
    } else if (s && Array.isArray(s.items)) {
      arr = s.items.map((x) => ({ text: x.text != null ? x.text : x, priority: x.priority }));
    }
    return arr;
  }

  function renderSuggestion(item) {
    const m = /\[(高|中|低|high|mid|low|HIGH|MID|LOW)\]/i.exec(item.text || "");
    let badge = "", text = item.text || "";
    if (m) {
      const sev = m[1];
      badge = '<span class="' + severityClass(sev) + '" style="' + severityInline(sev) + '">' + escapeHtml(sev) + '</span>';
      text = text.replace(m[0], "").replace(/^\s*[-–—]?\s*/, "");
    } else if (item.priority) {
      badge = '<span class="' + severityClass(item.priority) + '" style="' + severityInline(item.priority) + '">' + escapeHtml(item.priority) + '</span>';
    }
    return '<li class="rpt-suggestion">' + badge + '<span>' + escapeHtml(text) + '</span></li>';
  }

  function renderSuggestions(s) {
    const items = normalizeSuggestions(s);
    if (!items.length) return '';
    return '<div class="rpt-block"><div class="rpt-subtitle">整改建议</div>' +
      '<ul class="rpt-suggestions">' + items.map(renderSuggestion).join('') + '</ul></div>';
  }

  /* --------------------------- 总渲染入口 --------------------------- */

  // 返回 report 主体 HTML（不含抽屉外壳）。纯函数，可单测。
  function renderReportHTML(input) {
    const r = coerceFields(normalizeReport(input) || {});
    const title = (r.title != null) ? String(r.title) : "未命名报告";
    const meta = (r.meta != null) ? String(r.meta) : "";
    const schema = (r.schemaVersion != null) ? String(r.schemaVersion) : "";

    const parts = [];
    parts.push('<div class="rpt-head">');
    parts.push('<h2 class="rpt-title">' + escapeHtml(title) + '</h2>');
    if (meta) parts.push('<p class="rpt-meta">' + escapeHtml(meta) + '</p>');
    if (schema) parts.push('<div class="rpt-schema">schema: ' + escapeHtml(schema) + '</div>');
    parts.push('</div>');

    if (r.score != null) parts.push(renderScore(r.score));
    if (r.stats != null) parts.push(renderKv(r.stats));
    if (r.table != null) parts.push(renderTable(r.table));
    if (r.suggestions != null) parts.push(renderSuggestions(r.suggestions));

    return parts.join('');
  }

  /* --------------------------- 代表性样本 --------------------------- */
  // Skill-2（埋点质量 AI 分析）的真实输出结构样本，用于演示与验收。
  // 注意：仅作「形状」示例，组件本身不依赖任何具体 Skill。
  const sampleReport = {
    schemaVersion: "report.v1",
    outputType: "report",
    title: "埋点质量 AI 分析 · 体检报告",
    meta: "站点 powertokens.ai · 分析窗口 2026-09-01 ~ 2026-09-30 · 样本事件 1,284,330",
    score: { value: 72, color: "#d97706", label: "中等：核心转化链路基本打通，但跨域事件丢失偏高" },
    stats: [
      ["已配置事件数", "38 / 52"],
      ["关键事件覆盖率", "73%"],
      ["跨域事件丢失率", "11.4%"],
      ["参数合规率", "88%"],
      ["重复事件率", "2.1%"],
    ],
    table: {
      title: "问题清单（按严重度排序）",
      head: ["严重度", "问题", "影响", "建议"],
      rows: [
        ["高", "purchase 事件在 Safari 下丢失约 9%", "收入归因偏低，影响 ROI 判断", "排查 ITP/第三方 Cookie 拦截，改用 server-side 回传"],
        ["高", "sign_up 事件未带 user_id", "无法做用户级归因", "在注册成功回调补齐 user_id"],
        ["中", "page_view 参数 gclid 缺失率 22%", "付费搜索归因断裂", "广告落地页统一注入 gclid"],
        ["中", "add_to_cart 在 SPA 路由切换时重复上报", "漏斗虚高", "加幂等去重（session + event_id）"],
        ["低", "部分自定义事件命名不规范", "看板维度混乱", "对齐事件命名规范 v2"],
      ],
    },
    suggestions: [
      "[高] 优先修复 purchase 跨域丢失，预计可追回 6~8% 归因收入",
      "[高] sign_up 补齐 user_id，解锁用户级 LTV 分析",
      "[中] 落地页统一注入 gclid，修复付费搜索归因",
      "[中] add_to_cart 加幂等去重",
      "[低] 梳理事件命名规范并做 lint 校验",
    ],
  };

  const api = { renderReportHTML, normalizeReport, coerceFields, sampleReport, escapeHtml, safeColor };

  // 浏览器：挂全局；Node：导出
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReportRender = api;

})(typeof window !== "undefined" ? window : null);
