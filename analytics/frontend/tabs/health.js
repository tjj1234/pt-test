/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.4 健康 Tab（打点健康度 + Token 审计 report 渲染）
   --------------------------------------------------------------------------
   原生 JS + HTML，无框架、无构建。只读铁律：本文件只发起 GET（复用骨架的
   AnalyticsClient.getTokenAudit()），绝不发起任何写操作、绝不触发审计。

   数据铁律（对齐设计文档 3.4）：
     · report 是唯一事实源——score / stats / table / suggestions 全部直接渲染
       1.5 审计产出，前端「只展示、不重算、不改键名、不编造」。
     · 色阶一律用 report.score.color（后端算好），前端绝不按 value 自己套阈值。
     · 无数据 → 空态；score 缺失 → 「— / 暂不可用」，绝不凑分。

   依赖（需先加载骨架 app.fixed.js；二者均为经典 <script>，共享全局作用域）：
     RENDERERS / AnalyticsClient / state / escapeHtml / loadingHtml / errorHtml

   接线方式（本文件不改骨架，只做「自接线」）：
     1) 在 index.html 中、app.fixed.js（收口后为 app.js）之后加载本文件：
        <script src="tabs/health.js"></script>
     2) 本文件加载时把 RENDERERS.ads 指向 renderHealthTab，骨架的 renderPage()
        切到「健康」Tab 时自动调用它，无需改 renderPage。
     3) 本文件运行时注入一段 <style id="pt-health-styles">，不改 styles.css。
   ========================================================================== */

"use strict";

(function () {

  /* ---------------------- 健康 Tab 专属样式（运行时注入） ---------------------- */

  function injectStyles() {
    if (document.getElementById("pt-health-styles")) return;
    const css = [
      ".pt-health{display:flex;flex-direction:column;gap:16px;}",
      ".pt-health-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;}",
      ".pt-score-card{grid-column:span 2;display:flex;flex-direction:column;gap:8px;}",
      ".pt-kpi-card{display:flex;flex-direction:column;gap:6px;}",
      ".pt-kpi-label{font-size:12px;color:var(--muted);}",
      ".pt-kpi-value{font-size:15px;font-weight:600;color:var(--text);line-height:1.4;word-break:break-word;}",
      ".pt-kpi-hint{font-size:12px;color:var(--muted);}",
      ".pt-score-value{font-size:40px;font-weight:700;line-height:1;letter-spacing:-0.5px;}",
      ".pt-score-bar{height:8px;border-radius:999px;background:var(--border);overflow:hidden;}",
      ".pt-score-bar-fill{height:100%;border-radius:999px;}",
      ".pt-meta{margin:0 0 4px;font-size:12px;}",
      ".pt-generated{font-size:11px;margin-bottom:8px;}",
      ".pt-subtitle{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;}",
      ".pt-report-block{margin-top:16px;}",
      ".pt-score-row{display:flex;align-items:center;gap:14px;padding:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);}",
      ".pt-score-row-num{font-size:28px;font-weight:700;line-height:1;}",
      ".pt-score-row-body{flex:1;display:flex;flex-direction:column;gap:6px;}",
      ".pt-score-row-label{font-size:12px;color:var(--text-2);}",
      ".pt-score-row-meta{font-size:12px;color:var(--muted);}",
      ".pt-stats-rows{display:flex;flex-direction:column;}",
      ".pt-stat-row{display:grid;grid-template-columns:200px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;}",
      ".pt-stat-row:last-child{border-bottom:none;}",
      ".pt-stat-k{color:var(--muted);}",
      ".pt-stat-v{color:var(--text-2);word-break:break-word;}",
      ".pt-table-wrap{overflow-x:auto;}",
      ".pt-table{width:100%;border-collapse:collapse;font-size:12.5px;}",
      ".pt-table th,.pt-table td{border:1px solid var(--border);padding:7px 9px;text-align:left;vertical-align:top;}",
      ".pt-table th{background:var(--surface-2);font-weight:600;color:var(--text-2);white-space:nowrap;}",
      ".pt-table td{color:var(--text-2);word-break:break-word;}",
      ".pt-sev{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;}",
      ".pt-sev-high{background:var(--rose-soft);color:var(--rose);}",
      ".pt-sev-mid{background:var(--amber-soft);color:var(--amber);}",
      ".pt-sev-low{background:var(--zinc-soft);color:var(--zinc);}",
      ".pt-no-alert{padding:12px;background:var(--emerald-soft);border:1px dashed var(--emerald);border-radius:var(--radius);color:var(--emerald);font-size:13px;}",
      ".pt-no-alert-muted{background:var(--surface-2);border-color:var(--border-strong);color:var(--muted);}",
      ".pt-suggestions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}",
      ".pt-suggestion{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--text-2);}",
      ".pt-suggestion>span:last-child{flex:1;}",
      "@media (max-width:720px){.pt-score-card{grid-column:span 1;}.pt-stat-row{grid-template-columns:1fr;gap:2px;}.pt-score-row{flex-direction:column;align-items:flex-start;}}",
    ].join("\n");
    const style = document.createElement("style");
    style.id = "pt-health-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------------------- 小工具 ---------------------- */

  function esc(v) { return escapeHtml(v); }

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

  // 只接受合法色值，防 style 属性注入；非法值兜底灰
  function safeColor(c) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
    if (typeof c === "string" && /^[a-zA-Z]+$/.test(c)) return c;
    return "#a1a1aa";
  }

  function severityClass(sev) {
    const s = String(sev == null ? "" : sev).trim();
    if (s === "高") return "pt-sev-high";
    if (s === "中") return "pt-sev-mid";
    if (s === "低") return "pt-sev-low";
    return "";
  }

  // 后端端点可能直接返回 report，也可能返回 { report, generated_at }
  function normalizePayload(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (typeof payload.title === "string") {
        return { report: payload, generatedAt: payload.generated_at || null };
      }
      if (payload.report && typeof payload.report === "object") {
        return { report: payload.report, generatedAt: payload.generated_at || null };
      }
    }
    return { report: null, generatedAt: null };
  }

  function formatGeneratedAt(ga) {
    if (ga == null || ga === "") return "";
    if (typeof ga === "number" && Number.isFinite(ga)) {
      const d = new Date(ga);
      if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return String(ga);
  }

  function emptyHealthHtml(msg, hint) {
    return `<div class="state state-empty">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>
      <div class="state-title">${esc(msg)}</div>
      <div class="state-hint muted">${esc(hint)}</div>
    </div>`;
  }

  /* ---------------------- ① 打点健康度摘要 ---------------------- */

  function renderScoreCard(score) {
    if (!score || score.value == null) {
      return `<div class="card pt-score-card">
        <div class="pt-kpi-label">综合评分</div>
        <div class="pt-score-value muted">—</div>
        <div class="pt-kpi-hint">评分暂不可用</div>
      </div>`;
    }
    const v = clampScore(score.value);
    const color = safeColor(score.color);
    return `<div class="card pt-score-card">
      <div class="pt-kpi-label">综合评分</div>
      <div class="pt-score-value" style="color:${color}">${fmtScore(score.value)}</div>
      <div class="pt-score-bar"><div class="pt-score-bar-fill" style="width:${v}%;background:${color}"></div></div>
      <div class="pt-kpi-hint">${esc(score.label || "")}</div>
    </div>`;
  }

  function renderStatCard(k, v) {
    return `<div class="card pt-kpi-card">
      <div class="pt-kpi-label">${esc(k)}</div>
      <div class="pt-kpi-value">${esc(v)}</div>
    </div>`;
  }

  function renderSummary(report) {
    const stats = Array.isArray(report.stats)
      ? report.stats.filter((s) => Array.isArray(s) && s.length >= 2)
      : [];
    const cards = [renderScoreCard(report.score)];
    for (const [k, v] of stats) cards.push(renderStatCard(k, v));
    return `<section class="pt-summary">
      <h2 class="section-title">打点健康度</h2>
      <div class="pt-health-grid">${cards.join("")}</div>
    </section>`;
  }

  /* ---------------------- ② Token 审计 report 全文 ---------------------- */

  function renderScoreBar(score) {
    const inner = (!score || score.value == null)
      ? `<div class="pt-score-row-num muted">—</div><div class="pt-score-row-meta">评分暂不可用</div>`
      : `<div class="pt-score-row-num" style="color:${safeColor(score.color)}">${fmtScore(score.value)}</div>
         <div class="pt-score-row-body">
           <div class="pt-score-bar"><div class="pt-score-bar-fill" style="width:${clampScore(score.value)}%;background:${safeColor(score.color)}"></div></div>
           <div class="pt-score-row-label">${esc(score.label || "")}</div>
         </div>`;
    return `<div class="pt-report-block">
      <div class="pt-subtitle">综合评分</div>
      <div class="pt-score-row">${inner}</div>
    </div>`;
  }

  function renderStatsList(stats) {
    const rows = Array.isArray(stats)
      ? stats.filter((s) => Array.isArray(s) && s.length >= 2)
      : [];
    const body = rows.length
      ? rows.map(([k, v]) =>
          `<div class="pt-stat-row"><span class="pt-stat-k">${esc(k)}</span><span class="pt-stat-v">${esc(v)}</span></div>`
        ).join("")
      : `<div class="muted">暂不可用</div>`;
    return `<div class="pt-report-block">
      <div class="pt-subtitle">关键指标</div>
      <div class="pt-stats-rows">${body}</div>
    </div>`;
  }

  function renderTable(t) {
    const head = Array.isArray(t.head) ? t.head : [];
    const rows = Array.isArray(t.rows) ? t.rows : [];
    let sevIdx = -1;
    head.forEach((h, i) => { if (String(h).trim() === "严重度") sevIdx = i; });

    const thead = head.length
      ? `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`
      : "";

    const tbody = `<tbody>${rows.map((row) => {
      const cells = (Array.isArray(row) ? row : []).map((cell, ci) => {
        const text = String(cell == null ? "" : cell);
        let cls = "";
        if (sevIdx >= 0) {
          if (ci === sevIdx) cls = severityClass(text);
        } else {
          cls = severityClass(text);
        }
        return `<td>${cls ? `<span class="pt-sev ${cls}">${esc(text)}</span>` : esc(text)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("")}</tbody>`;

    return `<div class="pt-report-block">
      <div class="pt-subtitle">${t && t.title ? esc(t.title) : "风险诊断"}</div>
      <div class="pt-table-wrap"><table class="pt-table">${thead}${tbody}</table></div>
    </div>`;
  }

  function renderTableBlock(report) {
    const t = report.table;
    if (t && Array.isArray(t.rows) && t.rows.length) return renderTable(t);
    const hasData = !!(report.score && report.score.value != null);
    const msg = hasData ? "✅ 暂无风险告警" : "暂无风险告警（时间窗内无三事件数据）";
    const cls = hasData ? "pt-no-alert" : "pt-no-alert pt-no-alert-muted";
    return `<div class="pt-report-block">
      <div class="pt-subtitle">风险诊断</div>
      <div class="${cls}">${msg}</div>
    </div>`;
  }

  function renderSuggestion(item) {
    const m = item.match(/\[(高|中|低)\]/);
    let badge = "";
    let text = item;
    if (m) {
      badge = `<span class="pt-sev ${severityClass(m[1])}">${m[1]}</span>`;
      text = item.replace(m[0], "").replace(/^\s+/, "");
    }
    return `<li class="pt-suggestion">${badge}<span>${esc(text)}</span></li>`;
  }

  function renderSuggestions(s) {
    if (typeof s !== "string" || !s.trim()) return "";
    const items = s.split(/\s*·\s*/).filter((x) => x.trim());
    if (!items.length) return "";
    return `<div class="pt-report-block">
      <div class="pt-subtitle">整改建议</div>
      <ul class="pt-suggestions">${items.map(renderSuggestion).join("")}</ul>
    </div>`;
  }

  function renderAuditReport(report, generatedAt) {
    const gen = generatedAt
      ? `<div class="pt-generated muted">审计生成时间：${esc(formatGeneratedAt(generatedAt))}</div>`
      : "";
    return `<section class="card pt-report">
      <h2 class="section-title">${esc(report.title)}</h2>
      <p class="muted pt-meta">${esc(report.meta)}</p>
      ${gen}
      ${renderScoreBar(report.score)}
      ${renderStatsList(report.stats)}
      ${renderTableBlock(report)}
      ${renderSuggestions(report.suggestions)}
    </section>`;
  }

  /* ---------------------- 主渲染（三态） ---------------------- */

  async function renderHealthTab() {
    // 容器作用域查找：定位当前 Tab 的 section（骨架约定 page-<key>）。
    // Tab 内部元素一律用 container.querySelector，绝不用 document.getElementById。
    const container = document.getElementById("page-" + state.page);
    if (!container) return;

    container.innerHTML = loadingHtml();
    try {
      const payload = await AnalyticsClient.getTokenAudit();
      const { report, generatedAt } = normalizePayload(payload);

      if (!report) {
        container.innerHTML = emptyHealthHtml(
          "暂无审计结果",
          "触发一次审计，或等待每日 06:00 定时审计（本看板只读，不自动触发）"
        );
        return;
      }
      if (!report.title || !report.meta) {
        container.innerHTML = emptyHealthHtml(
          "审计报告数据异常",
          "缺少必填字段 title / meta（不符合 report 六字段模具），无法渲染"
        );
        return;
      }

      container.innerHTML =
        `<div class="pt-health">${renderSummary(report)}${renderAuditReport(report, generatedAt)}</div>`;
    } catch (err) {
      container.innerHTML = errorHtml(err);
      const retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderHealthTab);
    }
  }

  /* ---------------------- 自接线：覆盖骨架 renderAdsHealth ---------------------- */

  function wire() {
    if (typeof RENDERERS === "undefined" || !RENDERERS) {
      console.warn("[tabs/health.js] 未找到骨架 RENDERERS，请确认本文件在 app.fixed.js 之后加载");
      return;
    }
    RENDERERS.ads = renderHealthTab;
  }

  injectStyles();
  wire();
})();
