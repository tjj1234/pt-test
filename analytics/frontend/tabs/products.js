/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.3 · 产品 Tab（#page-product）
   --------------------------------------------------------------------------
   原生 JS + HTML，无框架、无构建。只读：仅 GET /api/analytics/funnel。
   数据源：GET /funnel?granularity=total 的 groups[]（KPI / 模型 / 渠道）+ 
           GET /funnel?granularity=day 的 groups[]（充值趋势）。绝不编造数字。
   Token 消耗：funnel 契约（2.4 §3.1）不含 Token 字段 → 走「空态 + 数据来源标注」，
           不拿 model_calls 冒充 Token、不写 0、不估（设计 3.3 §3.3 三级策略之空态）。
   三态：加载 / 空 / 错误，全部渲染在当前 Tab 容器内（container.querySelector
         作用域查找，绝不用 document.getElementById 找 Tab 内元素）。

   接线方式（本文件只「新建」，不修改任何已有文件）：
     1. 本文件加载后把全局 RENDERERS.product 替换为本 Tab 渲染器；
     2. 部署时在 index.html 底部、app.fixed.js 之后引入本文件（DOMContentLoaded 前）：
          <script src="app.fixed.js"></script>
          <script src="tabs/products.js"></script>
   ========================================================================== */
(function () {
  "use strict";

  if (typeof AnalyticsClient === "undefined" || typeof RENDERERS === "undefined") {
    console.error("[tabs/products.js] 依赖缺失：请确保 app.fixed.js 先于 tabs/products.js 加载");
    return;
  }

  /* ---------- 组件样式（一次注入 <head>，不改 styles.css；前缀 pp-） ---------- */
  (function injectCss() {
    if (document.getElementById("pt-products-css")) return;
    var css = "" +
      ".pp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}" +
      ".pp-title{font-size:15px;font-weight:600;margin:0}" +
      ".pp-sub{font-size:12px;color:var(--muted)}" +
      ".pp-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}" +
      ".pp-kpi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 12px;display:flex;flex-direction:column;gap:2px}" +
      ".pp-kpi .lbl{font-size:12px;color:var(--muted)}" +
      ".pp-kpi b{font-size:20px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}" +
      ".pp-approx{font-size:12px;color:var(--muted-2);font-weight:400;margin-left:2px}" +
      ".pp-kpi-inline{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}" +
      ".pp-kpi-inline .lbl{font-size:12px;color:var(--muted)}" +
      ".pp-kpi-inline b{font-size:22px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}" +
      ".pp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}" +
      ".pp-card{margin-bottom:16px}" +
      ".pp-bars{display:flex;flex-direction:column;gap:10px}" +
      ".pp-bar-row{display:grid;grid-template-columns:170px 1fr 80px;align-items:center;gap:10px;font-size:12.5px}" +
      ".pp-bar-label{color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
      ".pp-bar-track{background:var(--zinc-soft);border-radius:4px;height:14px;overflow:hidden}" +
      ".pp-bar-fill{height:100%;border-radius:4px;transition:width .2s}" +
      ".pp-bar-val{text-align:right;color:var(--text-2);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".pp-table-wrap{overflow-x:auto}" +
      ".pp-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:340px}" +
      ".pp-table th,.pp-table td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--border);white-space:nowrap}" +
      ".pp-table th{color:var(--muted);font-weight:600;font-size:11.5px}" +
      ".pp-table th:first-child,.pp-table td:first-child{text-align:left}" +
      ".pp-td-model{font-weight:500;color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
      ".pp-doughnut{display:flex;align-items:center;gap:18px;flex-wrap:wrap}" +
      ".pp-doughnut-ring{position:relative;width:120px;height:120px;border-radius:50%;flex-shrink:0}" +
      ".pp-doughnut-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:70px;height:70px;background:#fff;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}" +
      ".pp-doughnut-center b{font-size:17px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}" +
      ".pp-doughnut-unit{font-size:10.5px;color:var(--muted)}" +
      ".pp-legend{display:flex;flex-direction:column;gap:7px;font-size:12.5px}" +
      ".pp-legend-item{display:flex;align-items:center;gap:6px}" +
      ".pp-legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}" +
      ".pp-trend-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}" +
      ".pp-trend{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px}" +
      ".pp-trend-title{font-size:12px;color:var(--muted);margin-bottom:8px}" +
      ".pp-trend-chart svg{display:block;width:100%;height:auto}" +
      ".pp-note{font-size:11.5px;color:var(--muted);margin:10px 0 0}" +
      "@media(max-width:720px){.pp-kpis{grid-template-columns:repeat(2,1fr)}.pp-grid2,.pp-trend-grid{grid-template-columns:1fr}.pp-bar-row{grid-template-columns:110px 1fr 64px}}";
    var st = document.createElement("style");
    st.id = "pt-products-css";
    st.textContent = css;
    document.head.appendChild(st);
  })();

  var COLORS = { brand: "#6366f1", violet: "#8b5cf6", emerald: "#059669", amber: "#d97706", rose: "#e11d48" };
  var SVG_BORDER = "#e4e4e7", SVG_MUTED = "#71717a";

  /* ============================ 纯函数工具 ============================ */

  function num(v) { return Number(v) || 0; }
  function fmtInt(n) { return Math.round(num(n)).toLocaleString("en-US"); }
  function fmtAmount(n) {
    return num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtCompact(n) {
    n = num(n);
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtFreshness(gen) {
    if (!gen) return "";
    var s = String(gen);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (m) return "数据截至 " + m[1] + " " + m[2] + " UTC";
    return "数据截至 " + s;
  }

  function filterGroupsBySelection(groups, f) {
    f = f || {};
    var srcs = (f.platforms || []).map(function (p) {
      return PLATFORM_UTM[p] && PLATFORM_UTM[p].source;
    }).filter(Boolean);
    return (groups || []).filter(function (g) {
      if ((f.countries || []).length && f.countries.indexOf(g.country) === -1) return false;
      if (srcs.length && srcs.indexOf(g.utm_source) === -1) return false;
      if ((f.utmSources || []).length && f.utmSources.indexOf(g.utm_source) === -1) return false;
      if ((f.utmCampaigns || []).length && f.utmCampaigns.indexOf(g.utm_campaign) === -1) return false;
      return true;
    });
  }

  function aggregateGroups(groups) {
    var s = {
      visits: 0, signups: 0, key_created: 0, key_users: 0,
      recharges: 0, recharge_users: 0, recharge_amount: 0,
      model_calls: 0, success_calls: 0,
      latency_wsum: 0, latency_wcnt: 0,
      by_source: { playground: 0, api: 0 },
      by_model: {},
    };
    (groups || []).forEach(function (g) {
      var fn = g.funnel || {};
      var calls = g.calls || {};
      s.visits += num(fn.visits);
      s.signups += num(fn.signups);
      s.key_created += num(fn.key_created);
      s.key_users += num(fn.key_users);
      s.recharges += num(fn.recharges);
      s.recharge_users += num(fn.recharge_users);
      s.recharge_amount += num(fn.recharge_amount);
      s.model_calls += num(calls.model_calls);
      s.success_calls += num(calls.success_calls);
      var lat = calls.avg_latency_ms;
      var mc = num(calls.model_calls);
      if (lat != null && mc > 0) { s.latency_wsum += num(lat) * mc; s.latency_wcnt += mc; }
      var bs = calls.by_source || {};
      s.by_source.playground += num(bs.playground);
      s.by_source.api += num(bs.api);
      var bm = calls.by_model || {};
      Object.keys(bm).forEach(function (m) { s.by_model[m] = (s.by_model[m] || 0) + num(bm[m]); });
    });
    s.avg_latency_ms = s.latency_wcnt ? s.latency_wsum / s.latency_wcnt : null;
    return s;
  }

  function rollupByModel(groups) {
    var bm = aggregateGroups(groups).by_model;
    return Object.keys(bm).map(function (model) {
      return { model: model, calls: bm[model] };
    }).sort(function (a, b) { return b.calls - a.calls; });
  }

  /** 检测 funnel 是否（未来）已扩展 Token 字段；契约 2.4 §3.1 当前不含，恒返回空。 */
  function detectTokenData(groups) {
    var byModelTokens = {};
    var totalTokens = null;
    (groups || []).forEach(function (g) {
      var c = g.calls || {};
      if (c.by_model_tokens && typeof c.by_model_tokens === "object") {
        Object.keys(c.by_model_tokens).forEach(function (m) {
          byModelTokens[m] = (byModelTokens[m] || 0) + num(c.by_model_tokens[m]);
        });
      }
      if (c.total_tokens != null) {
        totalTokens = (totalTokens == null ? 0 : totalTokens) + num(c.total_tokens);
      }
    });
    return { hasTokenData: Object.keys(byModelTokens).length > 0 || totalTokens != null, byModelTokens: byModelTokens, totalTokens: totalTokens };
  }

  /** granularity=day 的 groups → 按 bucket 求和，并在 [from,to] 区间内补 0 值日（折线不断档）。 */
  function dailySeries(groups, from, to) {
    var byDay = {};
    (groups || []).forEach(function (g) {
      var b = String(g.bucket || "").slice(0, 10);
      if (!b) return;
      byDay[b] = byDay[b] || { amount: 0, users: 0 };
      byDay[b].amount += num(g.funnel && g.funnel.recharge_amount);
      byDay[b].users += num(g.funnel && g.funnel.recharge_users);
    });
    var days = [];
    var d = new Date(from);
    d.setUTCHours(0, 0, 0, 0);
    var end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= end.getTime()) {
      var key = d.toISOString().slice(0, 10);
      var v = byDay[key] || { amount: 0, users: 0 };
      days.push({ date: key, amount: v.amount, users: v.users });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return days;
  }

  /* ============================ 渲染片段 ============================ */

  function barRow(label, value, max, color) {
    var pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
    return '<div class="pp-bar-row">' +
      '<div class="pp-bar-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
      '<div class="pp-bar-track"><div class="pp-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
      '<div class="pp-bar-val">' + fmtInt(value) + '</div>' +
      '</div>';
  }

  function doughnutHtml(items) {
    var total = items.reduce(function (s, x) { return s + x.value; }, 0);
    if (total <= 0) return '<div class="pp-note">暂无调用数据</div>';
    var acc = 0;
    var stops = items.map(function (it) {
      var from = acc / total * 100;
      acc += it.value;
      var to = acc / total * 100;
      return it.color + ' ' + from.toFixed(2) + '% ' + to.toFixed(2) + '%';
    }).join(', ');
    var legend = items.map(function (it) {
      var pct = total ? (it.value / total * 100).toFixed(1) : "0.0";
      return '<div class="pp-legend-item"><span class="pp-legend-dot" style="background:' + it.color + '"></span>' +
        escapeHtml(it.label) + '：' + fmtInt(it.value) + '（' + pct + '%）</div>';
    }).join('');
    return '<div class="pp-doughnut">' +
      '<div class="pp-doughnut-ring" style="background:conic-gradient(' + stops + ')">' +
      '<div class="pp-doughnut-center"><b>' + fmtInt(total) + '</b><span class="pp-doughnut-unit">调用</span></div>' +
      '</div><div class="pp-legend">' + legend + '</div></div>';
  }

  function lineChartSvg(points, color) {
    var W = 640, H = 180, padL = 46, padR = 12, padT = 14, padB = 26;
    var n = points.length || 1;
    var maxV = 0;
    points.forEach(function (p) { if (p.value > maxV) maxV = p.value; });
    if (maxV <= 0) maxV = 1;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    function xAt(i) { return padL + (n === 1 ? innerW / 2 : (i * innerW / (n - 1))); }
    function yAt(v) { return padT + innerH - (v / maxV) * innerH; }

    var grid = [0, 0.5, 1].map(function (f) {
      var y = yAt(maxV * f).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="' + SVG_BORDER + '" stroke-width="1"/>';
    }).join("");
    var maxLabel = '<text x="' + (padL - 6) + '" y="' + (yAt(maxV) + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + SVG_MUTED + '">' + escapeHtml(fmtCompact(maxV)) + '</text>';
    var zeroLabel = '<text x="' + (padL - 6) + '" y="' + (yAt(0) + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + SVG_MUTED + '">0</text>';

    var labelIdx = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0];
    var xlabels = labelIdx.map(function (i) {
      var p = points[i];
      var anchor = i === 0 ? "start" : (i === n - 1 ? "end" : "middle");
      return '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '" font-size="10" fill="' + SVG_MUTED + '">' + escapeHtml(p.label) + '</text>';
    }).join("");

    var pts = points.map(function (p, i) {
      return xAt(i).toFixed(1) + ',' + yAt(p.value).toFixed(1);
    }).join(" ");
    var poly = '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    var dots = points.map(function (p, i) {
      return '<circle cx="' + xAt(i).toFixed(1) + '" cy="' + yAt(p.value).toFixed(1) + '" r="2.5" fill="' + color + '"/>';
    }).join("");

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="趋势折线图">' +
      grid + maxLabel + zeroLabel + poly + dots + xlabels + '</svg>';
  }

  /* ============================ 子卡渲染 ============================ */

  function renderKpis(container, agg) {
    var el = container.querySelector(".pp-kpis");
    var lat = agg.avg_latency_ms == null
      ? "—"
      : Math.round(agg.avg_latency_ms) + ' ms<span class="pp-approx">≈</span>';
    el.innerHTML =
      kpiBox("调用总数", fmtInt(agg.model_calls)) +
      kpiBox("成功调用", fmtInt(agg.success_calls)) +
      kpiBox("平均延时", lat) +
      kpiBox("充值额（原币）", fmtAmount(agg.recharge_amount));
  }

  function kpiBox(lbl, val) {
    return '<div class="pp-kpi"><span class="lbl">' + escapeHtml(lbl) + '</span><b>' + val + '</b></div>';
  }

  function renderModelCard(container) {
    var card = container.querySelector(".pp-model-card");
    var models = rollupByModel(groups);
    var title = "模型调用 Top（by_model）";
    if (!models.length) {
      card.innerHTML = '<h2 class="section-title">' + title + '</h2>' + emptyHtml("暂无模型调用数据");
      return;
    }
    var total = models.reduce(function (s, m) { return s + m.calls; }, 0);
    var top = models.slice(0, 10);
    var max = top[0].calls;
    var bars = top.map(function (m) { return barRow(m.model, m.calls, max, COLORS.brand); }).join("");
    var rows = top.map(function (m) {
      var pct = total ? (m.calls / total * 100).toFixed(1) : "0.0";
      return '<tr><td class="pp-td-model">' + escapeHtml(m.model) + '</td><td>' + fmtInt(m.calls) + '</td><td>' + pct + '%</td></tr>';
    }).join("");
    card.innerHTML = '<h2 class="section-title">' + title + '</h2>' +
      '<div class="pp-bars">' + bars + '</div>' +
      '<div class="pp-table-wrap"><table class="pp-table">' +
      '<thead><tr><th>模型</th><th>调用数</th><th>占比</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderSourceDoughnut(container) {
    var el = container.querySelector(".pp-source-doughnut");
    var bs = aggregateGroups(groups).by_source;
    el.innerHTML = doughnutHtml([
      { label: "Playground", value: bs.playground, color: COLORS.brand },
      { label: "API", value: bs.api, color: COLORS.violet },
    ]);
  }

  function renderTokenCard(container) {
    var card = container.querySelector(".pp-token-card");
    var t = detectTokenData(groups);
    if (!t.hasTokenData) {
      card.innerHTML = '<h2 class="section-title">Token 消耗（按模型 total_tokens）</h2>' +
        emptyHtml("Token 消耗暂未接入（funnel 未返回 token 字段）") +
        '<p class="pp-note">数据来源标注：未接入 —— 2.4 契约的 calls 只返回 model_calls / success_calls / avg_latency_ms / by_source / by_model，不含 Token 字段；需 2.x 在 funnel calls 增加 by_model_tokens / total_tokens，或退 events 本地聚合。此处不编造、不写 0。</p>';
      return;
    }
    // 未来 funnel 已扩展 Token 字段时（funnel 扩展 / 事件兜底聚合后传入），照实渲染
    var byModel = Object.keys(t.byModelTokens).map(function (m) {
      return { model: m, calls: t.byModelTokens[m] };
    }).sort(function (a, b) { return b.calls - a.calls; });
    var totalTok = t.totalTokens != null ? t.totalTokens : byModel.reduce(function (s, m) { return s + m.calls; }, 0);
    var max = byModel.length ? byModel[0].calls : 1;
    var bars = byModel.slice(0, 10).map(function (m) { return barRow(m.model, m.calls, max, COLORS.amber); }).join("");
    card.innerHTML = '<h2 class="section-title">Token 消耗（按模型 total_tokens）</h2>' +
      '<div class="pp-kpi-inline"><span class="lbl">Token 总量</span><b>' + fmtInt(totalTok) + '</b></div>' +
      (byModel.length ? '<div class="pp-bars">' + bars + '</div>' : '') +
      '<p class="pp-note">数据来源标注：funnel 扩展（by_model_tokens / total_tokens）</p>';
  }

  function renderRechargeTrend(container, dayGroups) {
    var card = container.querySelector(".pp-trend-card");
    var title = "充值趋势（granularity=day）";
    if (!dayGroups || !dayGroups.length) {
      card.innerHTML = '<h2 class="section-title">' + title + '</h2>' + emptyHtml("该区间充值趋势暂无数据");
      return;
    }
    var r = resolveRange(state.filters);
    var days = dailySeries(dayGroups, r.from, r.to);
    var amountPts = days.map(function (d) { return { label: d.date.slice(5), value: d.amount }; });
    var userPts = days.map(function (d) { return { label: d.date.slice(5), value: d.users }; });
    var amountTotal = days.reduce(function (s, d) { return s + d.amount; }, 0);
    card.innerHTML = '<h2 class="section-title">' + title + '</h2>' +
      '<div class="pp-trend-grid">' +
      '<div class="pp-trend"><div class="pp-trend-title">充值额（原币）</div><div class="pp-trend-chart">' + lineChartSvg(amountPts, COLORS.brand) + '</div></div>' +
      '<div class="pp-trend"><div class="pp-trend-title">充值用户数（按日）</div><div class="pp-trend-chart">' + lineChartSvg(userPts, COLORS.emerald) + '</div></div>' +
      '</div>' +
      '<p class="pp-note">区间充值额合计：' + fmtAmount(amountTotal) + '（原币）· 含 0 值日（无充值天补 0 点）· 充值用户数按日求和（跨日不去重）</p>';
  }

  /* ============================ 布局骨架 ============================ */

  function productLayout(freshness) {
    return '<div class="pp-head">' +
      '<h2 class="pp-title">产品 · 模型调用与 Token 消耗</h2>' +
      '<span class="pp-sub">' + escapeHtml(freshness) + '</span>' +
      '</div>' +
      '<div class="pp-kpis"></div>' +
      '<p class="pp-note" style="margin:-8px 0 12px">平均延时为按调用次数加权近似（funnel 未暴露 latency_cnt）</p>' +
      '<div class="pp-grid2">' +
      '<div class="card"><div class="pp-model-card"></div></div>' +
      '<div class="card"><h2 class="section-title">调用渠道（by_source）</h2><div class="pp-source-doughnut"></div></div>' +
      '</div>' +
      '<div class="card pp-card"><div class="pp-token-card"></div></div>' +
      '<div class="card pp-card"><div class="pp-trend-card"></div></div>';
  }

  /* ============================ 主渲染 + 三态 ============================ */

  var groups = [];

  async function renderProductTab() {
    var container = document.getElementById("page-product");
    if (!container) return;
    container.innerHTML = loadingHtml("正在加载产品调用数据…");
    try {
      var f = state.filters;
      var res = await Promise.all([
        AnalyticsClient.getFunnel(buildFunnelParams("total")),
        AnalyticsClient.getFunnel(buildFunnelParams("day")),
      ]);
      var totalRes = res[0], dayRes = res[1];
      groups = filterGroupsBySelection(totalRes && totalRes.groups, f);
      if (!groups.length) {
        container.innerHTML = emptyHtml("当前筛选条件下暂无产品调用数据");
        return;
      }
      var dayGroups = filterGroupsBySelection(dayRes && dayRes.groups, f);
      var agg = aggregateGroups(groups);
      var freshness = fmtFreshness(totalRes && totalRes.data_freshness && totalRes.data_freshness.generated_at);
      container.innerHTML = productLayout(freshness);
      renderKpis(container, agg);
      renderModelCard(container);
      renderSourceDoughnut(container);
      renderTokenCard(container);
      renderRechargeTrend(container, dayGroups);
    } catch (err) {
      container.innerHTML = errorHtml(err);
      var retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderProductTab);
    }
  }

  /* 注册到骨架：替换 RENDERERS.product（renderPage() 每次按 state.page 动态读取）。 */
  RENDERERS.product = renderProductTab;
})();
