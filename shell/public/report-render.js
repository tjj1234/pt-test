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

  /* ------------------- tracking-quality-report.v1 专用 -------------------
   * 埋点质量报告（Skill-2）的字段名与通用 report 不同，且有一批契约强制要求
   * 「必须展示给用户」的诚实性字段（覆盖范围声明、局限、解读约束）。下面这些
   * 工具函数与区块渲染器只做「取值 + 转义」，不引入任何新语义。
   * ------------------------------------------------------------------- */

  // scoreBar.status 枚举 → 颜色 + 中文文案
  const STATUS_MAP = {
    insufficient_data: { color: "#71717a", text: "样本不足" },
    healthy: { color: "#16a34a", text: "健康" },
    attention: { color: "#d97706", text: "需关注" },
    high_risk: { color: "#dc2626", text: "高风险" },
  };

  // 扣分保留契约允许的 4 位小数，再去掉无意义的尾随 0（1.7225 保留 / 5.2500 → 5.25 / 3.0000 → 3）
  // 注意不能复用 fmtScore：它会统一压成 1 位小数，把 1.7225 显示成 1.7，扣分明细就失真了。
  function trimNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return String(Number(v.toFixed(4)));
  }

  // 千分位：固定 en-US，保证浏览器 / Node / 测试三处输出一致
  function fmtNum(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      return Number.isInteger(v) ? v.toLocaleString("en-US") : String(v);
    }
    return String(v == null ? "" : v);
  }

  // ISO → "YYYY-MM-DD HH:mm"（本地时区，手写避免依赖 ICU）
  function fmtDateTime(s) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 单元格取值：标量原样；对象按 summary → text → label → value 逐级取，兜底 JSON。
  // 埋点质量报告的 evidence 是 {metric,count,denominator,ratio,summary}，要的是 summary。
  function cellText(v) {
    if (v == null) return "";
    if (typeof v !== "object") return String(v);
    if (typeof v.summary === "string") return v.summary;
    if (typeof v.text === "string") return v.text;
    if (typeof v.label === "string") return v.label;
    if (v.value !== undefined && v.value !== null) return cellText(v.value);
    try { return JSON.stringify(v); } catch (_) { return ""; }
  }

  // P1 / P2 → 高 / 中 / 低，复用 severityClass 的三档色
  function sevOfPriority(p) {
    const s = String(p == null ? "" : p).trim();
    if (s === "P1") return "高";
    if (s === "P2") return "中";
    if (s === "P3") return "低";
    return s;
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

  // 把 scoreBar/kv/issuesTable/recommendations 等别名归一到规范字段
  function coerceFields(r) {
    const out = Object.assign({}, r);
    if (out.score == null && r.scoreBar != null) out.score = r.scoreBar;
    if (out.stats == null && r.kv != null) out.stats = r.kv;
    if (out.table == null && r.issues != null) out.table = r.issues;
    // tracking-quality-report.v1 用 issuesTable（自带 columns 列定义）。
    // 它不带 title，补一个中文标题，否则会落回通用默认值「明细」。
    if (out.table == null && r.issuesTable != null) {
      out.table = (r.issuesTable && typeof r.issuesTable === "object" &&
        !r.issuesTable.title && !r.issuesTable.caption)
        ? Object.assign({ title: "问题清单" }, r.issuesTable)
        : r.issuesTable;
    }
    if (out.suggestions == null && r.remediation != null) out.suggestions = r.remediation;
    if (out.suggestions == null && r.recommendations != null) out.suggestions = r.recommendations;
    return out;
  }

  /* --------------------------- 各区块渲染 --------------------------- */

  // 评分分项明细：埋点质量报告必须让用户看到「分是怎么扣的」，不能只给一个总分
  function renderScoreComponents(components) {
    const body = components.map((c) => {
      const ratio = Number.isFinite(Number(c.denominator))
        ? (fmtNum(c.numerator) + " / " + fmtNum(c.denominator))
        : "—";
      const ded = (c.deduction == null || !Number.isFinite(Number(c.deduction)))
        ? "—" : "−" + trimNum(c.deduction);
      return '<tr>' +
        '<td>' + escapeHtml(c.label != null ? c.label : c.key) + '</td>' +
        '<td>' + escapeHtml(c.weight == null ? "" : c.weight + "%") + '</td>' +
        '<td>' + escapeHtml(ratio) + '</td>' +
        '<td>' + escapeHtml(ded) + '</td>' +
      '</tr>';
    }).join("");
    return '<div class="rpt-comp"><table class="rpt-comp-table">' +
      '<thead><tr><th>评分项</th><th>权重</th><th>命中 / 样本</th><th>扣分</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
  }

  function renderScore(score) {
    // 兼容：纯数字 / {value,color,label} / {score,color,label}
    // 扩展（tracking-quality-report.v1）：{value,max,status,label,method,components}
    let v = null, color = null, label = "", max = 100, status = "", method = "", components = null;
    if (typeof score === "number") v = score;
    else if (score && typeof score === "object") {
      v = (score.value != null) ? score.value : score.score;
      color = score.color || null;
      label = score.label || score.desc || "";
      if (Number.isFinite(Number(score.max)) && Number(score.max) > 0) max = Number(score.max);
      status = score.status || "";
      method = score.method || "";
      components = Array.isArray(score.components) && score.components.length ? score.components : null;
    }
    // status 优先决定颜色（契约枚举）；没有 status 才退回 score.color
    const st = STATUS_MAP[status] || null;
    const col = safeColor(color || (st ? st.color : "#71717a"));
    const hasValue = v != null && Number.isFinite(Number(v));

    // 状态徽标：用 border+color，避免拼接 hex alpha（命名色会拼出非法值）
    const badge = st
      ? '<span class="rpt-status" style="color:' + col + ';border-color:' + col + '">' + escapeHtml(st.text) + '</span>'
      : "";

    const num = hasValue ? Number(v) : 0;
    const pct = hasValue ? clampScore((num / max) * 100) : 0; // max 非 100 时归一化后再截断
    const labelHtml = label
      ? '<span>' + escapeHtml(label) + '</span>'
      : (hasValue ? "" : '<span>评分暂不可用</span>');

    const row =
      '<div class="rpt-score-row">' +
        '<div class="rpt-score-num" style="color:' + col + '">' + (hasValue ? fmtScore(num) : "—") + '</div>' +
        '<div class="rpt-score-body">' +
          '<div class="rpt-score-bar"><div class="rpt-score-bar-fill" style="width:' + pct + '%;background:' + col + '"></div></div>' +
          (badge || labelHtml ? '<div class="rpt-score-label">' + badge + labelHtml + '</div>' : '') +
        '</div>' +
      '</div>';

    const parts = ['<div class="rpt-block">', '<div class="rpt-subtitle">综合评分</div>', row];
    if (components) parts.push(renderScoreComponents(components));
    // 评分口径：契约要求披露算法，防用户把 100 分当「审计通过」
    if (method) parts.push('<div class="rpt-method">评分口径：' + escapeHtml(method) + '</div>');
    parts.push('</div>');
    return parts.join('');
  }

  function normalizeKv(stats) {
    // 支持：[[k,v]] / [{key,label,value,unit}] / {k:v}
    const out = [];
    if (Array.isArray(stats)) {
      for (const item of stats) {
        if (Array.isArray(item) && item.length >= 2) out.push([String(item[0]), item[1]]);
        else if (item && typeof item === "object" && !Array.isArray(item)) {
          // {key,label,value,unit}：优先展示中文 label（key 是 totalAdapted 这类机器名）
          const k = item.label != null ? item.label : (item.key != null ? item.key : item.name);
          if (k != null) {
            let v = item.value !== undefined ? item.value : item.val;
            if (v == null || v === "") v = "—";
            else if (typeof v === "number" && Number.isFinite(v)) v = fmtNum(v);
            else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = fmtDateTime(v);
            out.push([String(k), item.unit ? (v + " " + item.unit) : v]);
          }
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

  // 列定义既可能是 ["级别","问题"] 纯字符串，也可能是契约的 [{key,label}]
  function splitColumns(cols) {
    const head = [], keys = [];
    for (const c of cols) {
      if (c && typeof c === "object") {
        keys.push(String(c.key != null ? c.key : c.label));
        head.push(String(c.label != null ? c.label : c.key));
      } else {
        keys.push(String(c));
        head.push(String(c));
      }
    }
    return { head, keys };
  }

  function normalizeTable(table) {
    // 支持：{head,rows} / {title,columns:[{key,label}],rows:[{obj}]} / [ {obj}, ... ]
    let title = "", head = [], keys = [], rows = [];
    if (!table) return null;
    if (Array.isArray(table)) {
      if (table.length && typeof table[0] === "object" && !Array.isArray(table[0])) {
        keys = Object.keys(table[0]);
        head = keys.slice();
        rows = table.map((o) => keys.map((k) => cellText(o[k])));
        title = "明细";
      }
      return { title, head, rows };
    }
    if (typeof table === "object") {
      title = table.title || table.caption || "明细";
      const cols = Array.isArray(table.head) ? table.head
        : (Array.isArray(table.columns) ? table.columns : null);
      if (cols) { const s = splitColumns(cols); head = s.head; keys = s.keys; }
      if (Array.isArray(table.rows)) rows = table.rows;
      else if (Array.isArray(table.data)) rows = table.data;
      else if (Array.isArray(table.items)) rows = table.items;
      // 没给列定义但行是对象：从第一行的键推导列
      if (!keys.length && rows.length && rows[0] && !Array.isArray(rows[0]) && typeof rows[0] === "object") {
        keys = Object.keys(rows[0]);
        head = keys.slice();
      }
      // 对象行 → 按 keys 取值成数组行，后面的渲染只认数组行
      if (keys.length) {
        rows = rows.map((r) => {
          if (r && !Array.isArray(r) && typeof r === "object") return keys.map((k) => cellText(r[k]));
          if (Array.isArray(r)) return r.map(cellText);
          return [String(r == null ? "" : r)];
        });
      }
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
        if (x && typeof x === "object") return {
          // tracking-quality-report.v1 的整改建议字段叫 action（不是 text）
          text: x.text != null ? x.text : (x.action != null ? x.action : x.tip),
          priority: x.priority != null ? x.priority : x.severity,
          verification: x.verification != null ? x.verification : null,
          issueId: x.issueId != null ? x.issueId : null,
        };
        return { text: String(x) };
      }).filter((x) => x.text);
    } else if (s && Array.isArray(s.items)) {
      arr = s.items.map((x) => ({
        text: x.text != null ? x.text : (x.action != null ? x.action : x),
        priority: x.priority, verification: x.verification, issueId: x.issueId,
      })).filter((x) => x.text);
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
      const sev = sevOfPriority(item.priority); // P1/P2 → 高/中
      badge = '<span class="' + severityClass(sev) + '" style="' + severityInline(sev) + '">' + escapeHtml(sev) + '</span>';
    }
    // 埋点质量报告每条建议都带 verification（怎么验证改好了），丢掉等于只给结论不给判据
    const ver = item.verification
      ? '<div class="rpt-verify">验收：' + escapeHtml(item.verification) + '</div>'
      : "";
    return '<li class="rpt-suggestion">' + badge + '<span>' + escapeHtml(text) + ver + '</span></li>';
  }

  function renderSuggestions(s) {
    const items = normalizeSuggestions(s);
    if (!items.length) return '';
    return '<div class="rpt-block"><div class="rpt-subtitle">整改建议</div>' +
      '<ul class="rpt-suggestions">' + items.map(renderSuggestion).join('') + '</ul></div>';
  }

  /* ------------------- 诚实性区块（tracking-quality-report.v1 契约强制） -------------------
   * 这四个区块是报告契约 required 字段，本质是「这份报告没覆盖什么 / 不能怎么解读」。
   * 通用 report 不带这些字段，走 renderReportHTML 的 != null 判断自动跳过。
   * -------------------------------------------------------------------------------- */

  function renderCoverage(cov) {
    if (!cov || typeof cov !== "object") return "";
    const expected = Array.isArray(cov.expectedEvents) ? cov.expectedEvents : [];
    const title = cov.status === "not_assessed"
      ? "⚠️ 核心事件覆盖：未评估"
      : "核心事件覆盖：" + String(cov.status == null ? "" : cov.status);
    const reason = cov.reason ? '<div class="rpt-note-text">' + escapeHtml(cov.reason) + '</div>' : "";
    const chips = expected.length
      ? '<div class="rpt-chips">' +
          expected.map((e) => '<span class="rpt-chip">' + escapeHtml(e) + '</span>').join("") +
        '</div>'
      : "";
    return '<div class="rpt-block"><div class="rpt-subtitle">覆盖范围</div>' +
      '<div class="rpt-note rpt-note-warn">' +
        '<div class="rpt-note-title">' + escapeHtml(title) + '</div>' + reason + chips +
      '</div></div>';
  }

  function renderLimitations(list) {
    const arr = Array.isArray(list) ? list : (typeof list === "string" ? [list] : []);
    if (!arr.length) return "";
    return '<div class="rpt-block"><div class="rpt-subtitle">局限说明</div>' +
      '<ul class="rpt-limits">' +
        arr.map((x) => '<li>' + escapeHtml(x) + '</li>').join("") +
      '</ul></div>';
  }

  function renderSource(src) {
    if (!src || typeof src !== "object") return "";
    const snap = (src.snapshot && typeof src.snapshot === "object") ? src.snapshot : null;
    const rows = [];
    if (src.kind) rows.push(["数据来源", String(src.kind)]);
    if (src.scope) rows.push(["统计范围", src.scope === "workspace" ? "当前工作区" : String(src.scope)]);
    if (src.window) rows.push(["统计窗口", String(src.window)]);
    if (snap && snap.workspaceId) rows.push(["工作区", String(snap.workspaceId)]);
    // client_count 是 kv 没覆盖的一项（kv 只列了兜底条数），这里补齐
    if (snap && snap.timestampFallback && Number.isFinite(Number(snap.timestampFallback.client_count))) {
      rows.push(["客户端提供时间戳", fmtNum(Number(snap.timestampFallback.client_count)) + " 条"]);
    }
    if (!rows.length) return "";
    const body = rows.map(([k, v]) =>
      '<div class="rpt-kv-row"><span class="rpt-kv-k">' + escapeHtml(k) + '</span>' +
      '<span class="rpt-kv-v">' + escapeHtml(v) + '</span></div>').join("");
    return '<div class="rpt-block"><div class="rpt-subtitle">数据来源</div>' +
      '<div class="rpt-kv">' + body + '</div></div>';
  }

  function renderInterpretation(itp) {
    if (!itp || typeof itp !== "object") return "";
    const mode = itp.mode ? String(itp.mode) : "";
    const ins = itp.instruction ? String(itp.instruction) : "";
    if (!mode && !ins) return "";
    return '<div class="rpt-block"><div class="rpt-subtitle">解读约束</div>' +
      '<div class="rpt-note rpt-note-info">' +
        (mode ? '<div class="rpt-note-title">规则来源：' + escapeHtml(mode) + '</div>' : "") +
        (ins ? '<div class="rpt-note-text">' + escapeHtml(ins) + '</div>' : "") +
      '</div></div>';
  }

  /* --------------------------- 总渲染入口 --------------------------- */

  // 返回 report 主体 HTML（不含抽屉外壳）。纯函数，可单测。
  function renderReportHTML(input) {
    const r = coerceFields(normalizeReport(input) || {});
    const title = (r.title != null) ? String(r.title) : "未命名报告";
    let meta = (r.meta != null) ? String(r.meta) : "";
    const schema = (r.schemaVersion != null) ? String(r.schemaVersion) : "";
    // 契约 report 没有 meta 字段，用 workspaceId / generatedAt / template 补一行副标题，
    // 否则抽屉里标题下面一片空白，用户看不出这份报告是哪个工作区、什么时候生成的。
    if (!meta) {
      const bits = [];
      if (r.workspaceId) bits.push("工作区 " + r.workspaceId);
      if (r.generatedAt) bits.push("生成于 " + fmtDateTime(r.generatedAt));
      if (r.template) bits.push("模板 " + r.template);
      meta = bits.join(" · ");
    }

    const parts = [];
    parts.push('<div class="rpt-head">');
    parts.push('<h2 class="rpt-title">' + escapeHtml(title) + '</h2>');
    if (meta) parts.push('<p class="rpt-meta">' + escapeHtml(meta) + '</p>');
    if (schema) parts.push('<div class="rpt-schema">schema: ' + escapeHtml(schema) + '</div>');
    parts.push('</div>');

    if (r.score != null) parts.push(renderScore(r.score));
    // 覆盖范围紧跟评分：它限定的是「这个分数评的是什么」，放太后面会被当成免责声明略过
    if (r.coverage != null) parts.push(renderCoverage(r.coverage));
    if (r.stats != null) parts.push(renderKv(r.stats));
    if (r.table != null) parts.push(renderTable(r.table));
    if (r.suggestions != null) parts.push(renderSuggestions(r.suggestions));
    if (r.limitations != null) parts.push(renderLimitations(r.limitations));
    if (r.source != null) parts.push(renderSource(r.source));
    if (r.interpretation != null) parts.push(renderInterpretation(r.interpretation));

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

  /* ------------------- 埋点质量报告样本（tracking-quality-report.v1） -------------------
   * 形状与字段逐一对齐 business/attribution/contracts/tracking-quality-report.json，
   * 数值取自 buildTrackingQualityReport 的同一套算法（回归测试会逐项核对，见
   * tests/regression/ui-tracking-quality-report-test.mjs）。
   * 抽屉里那个早期 sampleReport 用的是通用 report.v1 旧字段名，留着做向后兼容验证，
   * 首页「埋点质量 AI 分析」chip 的预览走这一份。
   * ------------------------------------------------------------------------------ */
  const sampleTrackingQualityReport = {
    schemaVersion: "tracking-quality-report.v1",
    outputType: "report",
    title: "埋点质量 AI 分析",
    template: "saas_token_marketplace",
    workspaceId: "ws_demo",
    generatedAt: "2026-10-12T04:18:00.000Z",
    scoreBar: {
      value: 87,
      max: 100,
      status: "attention",
      label: "已观测事件适配质量",
      method: "100 - 40×未映射/非忽略事件 - 35×ID兜底/已适配事件 - 25×时间戳兜底/已适配事件；仅在存在已适配事件时评分。",
      components: [
        { key: "event_mapping", label: "事件映射", weight: 40, numerator: 612, denominator: 12445, deduction: 1.9671 },
        { key: "event_id", label: "客户端事件标识", weight: 35, numerator: 2731, denominator: 11833, deduction: 8.0778 },
        { key: "timestamp", label: "客户端时间戳", weight: 25, numerator: 1455, denominator: 11833, deduction: 3.0741 },
      ],
    },
    kv: [
      { key: "totalAdapted", label: "适配尝试总数", value: 12875, unit: "条" },
      { key: "adaptedEventCount", label: "已适配事件", value: 11833, unit: "条" },
      { key: "ignored", label: "配置为忽略", value: 430, unit: "条" },
      { key: "unmappedEventCount", label: "未映射事件", value: 612, unit: "条" },
      { key: "client_native_unique", label: "客户端有效 UUID", value: 9102, unit: "条" },
      { key: "adapter_fallback", label: "适配层 ID 兜底", value: 2731, unit: "条" },
      { key: "timestampFallback", label: "时间戳兜底", value: 1455, unit: "条" },
      { key: "mappedViaConfig", label: "经配置映射的已适配事件", value: 11200, unit: "条" },
      { key: "updatedAt", label: "统计更新时间", value: "2026-10-12T04:18:00.000Z", unit: null },
    ],
    issuesTable: {
      columns: [
        { key: "severity", label: "级别" },
        { key: "title", label: "问题" },
        { key: "evidence", label: "统计依据" },
        { key: "impact", label: "业务影响" },
      ],
      rows: [
        {
          id: "unmapped_events", severity: "high", title: "存在未映射事件，无法进入归因事件白名单",
          evidence: { metric: "unmappedEventCount", count: 612, denominator: 12445, ratio: 0.0492, summary: "612 / 12445 条非忽略事件（4.9%）" },
          impact: "若未映射事件属于注册、API Key 创建、模型调用或充值，会形成归因漏斗缺口；当前汇总不能判断具体事件名称。",
        },
        {
          id: "fallback_event_id", severity: "high", title: "部分事件依赖适配层生成 event_id",
          evidence: { metric: "eventIdQuality.adapter_fallback", count: 2731, denominator: 11833, ratio: 0.2308, summary: "2731 / 11833 条已适配事件（23.1%）" },
          impact: "确定性兜底会依赖原始字段指纹。重试时字段变化可能产生新 ID，不同真实操作指纹相同可能合并；这不是已证实的重复计数。",
        },
        {
          id: "fallback_timestamp", severity: "medium", title: "部分事件使用接收时间代替发生时间",
          evidence: { metric: "timestampFallback.count", count: 1455, denominator: 11833, ratio: 0.123, summary: "1455 / 11833 条已适配事件（12.3%）" },
          impact: "延迟上报或重试的充值、模型调用可能被记到接收日，影响业务时序和按日归因；当前统计无法测量实际延迟。",
        },
      ],
    },
    recommendations: [
      {
        issueId: "unmapped_events", priority: "P1",
        action: "在 U6 核对业务事件映射：visit、signup、key_created、model_call、recharge、auto_recharge_toggle；非业务噪声可明确标为 ignore，不能把所有未知事件强映射为 visit。",
        verification: "逐项触发真实业务操作，确认适配返回对应标准事件；后续新请求不再增加 unmappedEventCount。历史累计不会自动清零。",
      },
      {
        issueId: "fallback_event_id", priority: "P1",
        action: "在真实操作创建时生成有效 UUID：signup、key_created、model_call、recharge 分别使用各自事件 ID；同一操作的重试复用同一 ID，不能用 user_id 或 API Key 代替事件 ID。",
        verification: "用一个充值或模型调用事件重放，确认 event_id 保持不变；两次不同操作应使用不同 UUID；后续事件应增加 client_native_unique 而非 adapter_fallback。",
      },
      {
        issueId: "fallback_timestamp", priority: "P2",
        action: "由事件生产端发送真实发生时间的 Unix 毫秒值。充值用成功确认时间、模型调用用实际调用时间；重试保留原发生时间，避免发送秒值、空值或格式化日期字符串。",
        verification: "触发并延迟重发同一事件，确认 timestamp 保持原发生时间；后续事件应增加 client_count 而非 timestampFallback.count。",
      },
    ],
    source: {
      kind: "ingestion-quality-stats", scope: "workspace",
      window: "累计：自当前进程启动或该工作区统计重置以来",
      snapshot: {
        workspaceId: "ws_demo", totalAdapted: 12875, ignored: 430, unmappedEventCount: 612,
        eventIdQuality: { client_native_unique: 9102, adapter_fallback: 2731, client_native_ratio: 0.7692 },
        timestampFallback: { count: 1455, ratio: 0.123, client_count: 10378 },
        mappedViaConfig: 11200, updatedAt: "2026-10-12T04:18:00.000Z",
      },
    },
    coverage: {
      status: "not_assessed",
      expectedEvents: ["visit", "signup", "key_created", "model_call", "recharge", "auto_recharge_toggle"],
      reason: "snapshot 无按事件名计数或事件明细，不能判断核心事件覆盖、字段完整性或业务时序。",
    },
    limitations: [
      "本期仅审计 saas_token_marketplace 的适配质量，不是通用四维审计。",
      "ignored 是配置行为，不作为丢失错误扣分；需人工确认是否误忽略业务事件。",
      "client_native_unique 仅代表有效 UUID 来源，不证明真实唯一性或端到端去重。",
      "适配计数不是 Collect 成功入库数，重放、连接测试也可能增加计数。",
      "时间戳非兜底不等于时间准确，秒/毫秒混用或时钟偏差仍需明细验证。",
    ],
    interpretation: {
      mode: "backend_rules",
      instruction: "评分与证据由后端计算；Agent 仅按本报告转述，不补造事件样例、缺失事件、收入损失或审计通过结论。",
    },
  };

  const api = {
    renderReportHTML, normalizeReport, coerceFields,
    sampleReport, sampleTrackingQualityReport,
    escapeHtml, safeColor,
  };

  // 浏览器：挂全局；Node：导出
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReportRender = api;

})(typeof window !== "undefined" ? window : null);
