/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.3 · 用户 Tab（#page-users）
   --------------------------------------------------------------------------
   原生 JS + HTML，无框架、无构建。只读：仅 GET /api/analytics/funnel。
   数据源：GET /funnel?granularity=total 的 groups[]，多选筛选走「客户端过滤」，
           聚合/漏斗/按来源/按模型/调用渠道全部由 groups[] 汇总，绝不编造数字。
   三态：加载 / 空 / 错误，全部渲染在当前 Tab 容器内（container.querySelector
         作用域查找，绝不用 document.getElementById 找 Tab 内元素）。

   接线方式（本文件只「新建」，不修改任何已有文件）：
     1. 本文件加载后把全局 RENDERERS.users 替换为本 Tab 渲染器；
     2. 部署时在 index.html 底部、app.fixed.js 之后引入本文件（DOMContentLoaded 前）：
          <script src="app.fixed.js"></script>
          <script src="tabs/users.js"></script>
   ========================================================================== */
(function () {
  "use strict";

  /* 依赖自检：骨架 app.fixed.js 必须先加载（否则本文件静默退出并报错） */
  if (typeof AnalyticsClient === "undefined" || typeof RENDERERS === "undefined") {
    console.error("[tabs/users.js] 依赖缺失：请确保 app.fixed.js 先于 tabs/users.js 加载");
    return;
  }

  /* ---------- 组件样式（一次注入 <head>，不改 styles.css；前缀 pu-） ---------- */
  (function injectCss() {
    if (document.getElementById("pt-users-css")) return;
    var css = "" +
      ".pu-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}" +
      ".pu-title{font-size:15px;font-weight:600;margin:0}" +
      ".pu-sub{font-size:12px;color:var(--muted)}" +
      ".pu-grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}" +
      ".pu-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}" +
      ".pu-card{margin-bottom:16px}" +
      ".pu-rate{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:2px}" +
      ".pu-rate b{font-size:22px;font-weight:700;color:var(--brand-strong);font-variant-numeric:tabular-nums}" +
      ".pu-rate .lbl{font-size:12px;color:var(--muted)}" +
      ".pu-rate .hint{font-size:11px;color:var(--muted-2)}" +
      ".pu-bars{display:flex;flex-direction:column;gap:10px}" +
      ".pu-bar-row{display:grid;grid-template-columns:150px 1fr 72px;align-items:center;gap:10px;font-size:12.5px}" +
      ".pu-bar-label{color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".pu-bar-track{background:var(--zinc-soft);border-radius:4px;height:14px;overflow:hidden}" +
      ".pu-bar-fill{height:100%;border-radius:4px;transition:width .2s}" +
      ".pu-bar-val{text-align:right;color:var(--text-2);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".pu-table-wrap{overflow-x:auto}" +
      ".pu-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:640px}" +
      ".pu-table th,.pu-table td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--border);white-space:nowrap}" +
      ".pu-table th{color:var(--muted);font-weight:600;font-size:11.5px}" +
      ".pu-table th:first-child,.pu-table td:first-child{text-align:left}" +
      ".pu-table tbody tr{cursor:pointer}" +
      ".pu-table tbody tr:hover{background:var(--surface-2)}" +
      ".pu-table tbody tr.active{background:var(--brand-soft)}" +
      ".pu-td-src{font-weight:500;color:var(--text)}" +
      ".pu-none-tag{display:inline-block;margin-left:6px;font-size:10.5px;color:var(--muted);background:var(--zinc-soft);border-radius:999px;padding:1px 7px}" +
      ".pu-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}" +
      ".pu-chip{background:var(--brand-soft);color:var(--brand-strong);border-radius:999px;padding:3px 10px;font-size:11.5px}" +
      ".pu-link-btn{border:1px solid var(--border);background:var(--surface);color:var(--brand-strong);border-radius:6px;font-size:12px;padding:3px 10px}" +
      ".pu-link-btn:hover{border-color:var(--brand);background:var(--brand-soft)}" +
      ".pu-doughnut{display:flex;align-items:center;gap:18px;flex-wrap:wrap}" +
      ".pu-doughnut-ring{position:relative;width:120px;height:120px;border-radius:50%;flex-shrink:0}" +
      ".pu-doughnut-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:70px;height:70px;background:#fff;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}" +
      ".pu-doughnut-center b{font-size:17px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}" +
      ".pu-doughnut-unit{font-size:10.5px;color:var(--muted)}" +
      ".pu-legend{display:flex;flex-direction:column;gap:7px;font-size:12.5px}" +
      ".pu-legend-item{display:flex;align-items:center;gap:6px}" +
      ".pu-legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}" +
      ".pu-note{font-size:11.5px;color:var(--muted);margin:10px 0 0}" +
      "@media(max-width:720px){.pu-grid2,.pu-grid3{grid-template-columns:1fr}.pu-bar-row{grid-template-columns:96px 1fr 60px}}";
    var st = document.createElement("style");
    st.id = "pt-users-css";
    st.textContent = css;
    document.head.appendChild(st);
  })();

  var COLORS = { brand: "#6366f1", violet: "#8b5cf6", emerald: "#059669", amber: "#d97706", rose: "#e11d48" };

  /* ============================ 纯函数工具 ============================ */

  function num(v) { return Number(v) || 0; }
  function fmtInt(n) { return Math.round(num(n)).toLocaleString("en-US"); }
  function fmtAmount(n) {
    return num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(rate) {
    if (rate == null) return "—";
    return (num(rate) * 100).toFixed(1) + "%";
  }
  function fmtFreshness(gen) {
    if (!gen) return "";
    var s = String(gen);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (m) return "数据截至 " + m[1] + " " + m[2] + " UTC";
    return "数据截至 " + s;
  }

  /** 客户端多选筛选：platforms→utm_source、countries、utmSources、utmCampaigns（设计 3.3 §4.2）。 */
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

  /** 跨组汇总 funnel 字段 + 全量转化率（用汇总值重算，不平均各组 rates，避免 Simpson 悖论）。 */
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
    s.signup_rate = s.visits ? s.signups / s.visits : 0;
    s.key_rate = s.signups ? s.key_users / s.signups : 0;
    s.recharge_rate = s.key_users ? s.recharge_users / s.key_users : 0;
    s.avg_latency_ms = s.latency_wcnt ? s.latency_wsum / s.latency_wcnt : null;
    return s;
  }

  /** 按 utm_source rollup（折叠 campaign/content/country），重算转化率。 */
  function rollupBySource(groups) {
    var m = {};
    (groups || []).forEach(function (g) {
      var k = g.utm_source || "__none__";
      (m[k] = m[k] || []).push(g);
    });
    return Object.keys(m).map(function (k) {
      var a = aggregateGroups(m[k]);
      var isNone = k === "__none__";
      return {
        key: k,
        isNone: isNone,
        source: isNone ? "无 UTM / organic" : k,
        visits: a.visits, signups: a.signups, key_users: a.key_users,
        recharge_users: a.recharge_users, recharge_amount: a.recharge_amount,
        signup_rate: a.signup_rate, key_rate: a.key_rate, recharge_rate: a.recharge_rate,
      };
    }).sort(function (x, y) { return y.signups - x.signups || y.visits - x.visits; });
  }

  /** by_model 跨组求和 → [{model, calls}] 降序。 */
  function rollupByModel(groups) {
    var bm = aggregateGroups(groups).by_model;
    return Object.keys(bm).map(function (model) {
      return { model: model, calls: bm[model] };
    }).sort(function (a, b) { return b.calls - a.calls; });
  }

  /* ============================ 渲染片段 ============================ */

  function barRow(label, value, max, color) {
    var pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
    return '<div class="pu-bar-row">' +
      '<div class="pu-bar-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
      '<div class="pu-bar-track"><div class="pu-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
      '<div class="pu-bar-val">' + fmtInt(value) + '</div>' +
      '</div>';
  }

  function rateBox(lbl, rate, hint) {
    return '<div class="pu-rate"><span class="lbl">' + escapeHtml(lbl) + '</span><b>' + fmtPct(rate) + '</b><span class="hint">' + escapeHtml(hint) + '</span></div>';
  }

  function doughnutHtml(items) {
    var total = items.reduce(function (s, x) { return s + x.value; }, 0);
    if (total <= 0) return '<div class="pu-note">暂无调用数据</div>';
    var acc = 0;
    var stops = items.map(function (it) {
      var from = acc / total * 100;
      acc += it.value;
      var to = acc / total * 100;
      return it.color + ' ' + from.toFixed(2) + '% ' + to.toFixed(2) + '%';
    }).join(', ');
    var legend = items.map(function (it) {
      var pct = total ? (it.value / total * 100).toFixed(1) : "0.0";
      return '<div class="pu-legend-item"><span class="pu-legend-dot" style="background:' + it.color + '"></span>' +
        escapeHtml(it.label) + '：' + fmtInt(it.value) + '（' + pct + '%）</div>';
    }).join('');
    return '<div class="pu-doughnut">' +
      '<div class="pu-doughnut-ring" style="background:conic-gradient(' + stops + ')">' +
      '<div class="pu-doughnut-center"><b>' + fmtInt(total) + '</b><span class="pu-doughnut-unit">调用</span></div>' +
      '</div><div class="pu-legend">' + legend + '</div></div>';
  }

  /* ============================ 子卡渲染 ============================ */

  function renderUsersFunnel(container, agg) {
    var el = container.querySelector(".pu-funnel");
    var stages = [
      { label: "注册", value: agg.signups, color: COLORS.brand },
      { label: "建Key", value: agg.key_users, color: COLORS.violet },
      { label: "充值", value: agg.recharge_users, color: COLORS.emerald },
    ];
    var max = Math.max(1, stages[0].value, stages[1].value, stages[2].value);
    el.innerHTML = stages.map(function (s) { return barRow(s.label, s.value, max, s.color); }).join("") +
      '<div class="pu-note">起点访问（去重 visitor）：' + fmtInt(agg.visits) +
      ' · Key 数（Key 个数）：' + fmtInt(agg.key_created) +
      ' · 充值次数：' + fmtInt(agg.recharges) + '（后两项仅作补充，不进转化率分母）</div>';
  }

  function renderRates(container, agg) {
    var el = container.querySelector(".pu-rates");
    el.innerHTML =
      rateBox("注册率", agg.signup_rate, "注册 / 访问") +
      rateBox("建Key率", agg.key_rate, "建Key / 注册") +
      rateBox("充值率", agg.recharge_rate, "充值 / 建Key");
  }

  function renderSourceTable(container) {
    var el = container.querySelector(".pu-source-table");
    var rows = rollupBySource(allGroups);
    if (!rows.length) { el.innerHTML = emptyHtml("当前筛选条件下暂无来源转化数据"); return; }
    var trs = rows.map(function (r) {
      var noneTag = r.isNone ? '<span class="pu-none-tag">无广告来源</span>' : '';
      return '<tr data-drill-source="' + escapeHtml(r.key) + '" data-drill-label="' + escapeHtml(r.source) + '">' +
        '<td class="pu-td-src">' + escapeHtml(r.source) + noneTag + '</td>' +
        '<td>' + fmtInt(r.visits) + '</td><td>' + fmtInt(r.signups) + '</td><td>' + fmtInt(r.key_users) + '</td>' +
        '<td>' + fmtInt(r.recharge_users) + '</td><td>' + fmtAmount(r.recharge_amount) + '</td>' +
        '<td>' + fmtPct(r.signup_rate) + '</td><td>' + fmtPct(r.key_rate) + '</td><td>' + fmtPct(r.recharge_rate) + '</td>' +
        '</tr>';
    }).join("");
    el.innerHTML = '<div class="pu-table-wrap"><table class="pu-table">' +
      '<thead><tr><th>来源</th><th>访问</th><th>注册</th><th>建Key</th><th>充值</th><th>充值额</th><th>注册率</th><th>建Key率</th><th>充值率</th></tr></thead>' +
      '<tbody>' + trs + '</tbody></table></div>';

    el.querySelectorAll("[data-drill-source]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        var k = tr.dataset.drillSource;
        currentDrill = (currentDrill === k) ? null : k;
        syncDrillRows(container);
        renderUsersByModel(container);
      });
    });
  }

  function syncDrillRows(container) {
    container.querySelectorAll("[data-drill-source]").forEach(function (r) {
      r.classList.toggle("active", r.dataset.drillSource === currentDrill);
    });
  }

  function renderUsersByModel(container) {
    var card = container.querySelector(".pu-model-card");
    var subset = currentDrill == null ? allGroups : allGroups.filter(function (g) {
      return (g.utm_source || "__none__") === currentDrill;
    });
    var drillLabel = currentDrill == null ? null : (currentDrill === "__none__" ? "无 UTM / organic" : currentDrill);
    var title = drillLabel ? '按模型调用分布 · 来源「' + escapeHtml(drillLabel) + '」' : "按模型调用分布（by_model）";
    var models = rollupByModel(subset);
    if (!models.length) {
      card.innerHTML = '<h2 class="section-title">' + title + '</h2>' + emptyHtml("该维度暂无模型调用数据");
      return;
    }
    var top = models.slice(0, 8);
    var max = top[0].calls;
    var bars = top.map(function (m) { return barRow(m.model, m.calls, max, COLORS.brand); }).join("");
    var chips = top.map(function (m) { return '<span class="pu-chip">' + escapeHtml(m.model) + ' · ' + fmtInt(m.calls) + '</span>'; }).join("");
    card.innerHTML = '<div class="pu-head" style="margin-bottom:10px">' +
      '<h2 class="section-title" style="margin:0">' + title + '</h2>' +
      (drillLabel ? '<button type="button" class="pu-link-btn" data-clear-drill>清除下钻</button>' : '') +
      '</div><div class="pu-bars">' + bars + '</div><div class="pu-chips">' + chips + '</div>';
    var clearBtn = card.querySelector("[data-clear-drill]");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      currentDrill = null;
      syncDrillRows(container);
      renderUsersByModel(container);
    });
  }

  function renderSourceDoughnut(container) {
    var el = container.querySelector(".pu-source-doughnut");
    var bs = aggregateGroups(allGroups).by_source;
    el.innerHTML = doughnutHtml([
      { label: "Playground", value: bs.playground, color: COLORS.brand },
      { label: "API", value: bs.api, color: COLORS.violet },
    ]);
  }

  /* ============================ 布局骨架 ============================ */

  function usersLayout(freshness) {
    return '<div class="pu-head">' +
      '<h2 class="pu-title">用户转化路径</h2>' +
      '<span class="pu-sub">' + escapeHtml(freshness) + '</span>' +
      '</div>' +
      '<div class="pu-grid2">' +
      '<div class="card"><h2 class="section-title">注册 → 建Key → 充值 漏斗</h2><div class="pu-funnel"></div></div>' +
      '<div class="card"><h2 class="section-title">转化率</h2><div class="pu-grid3 pu-rates"></div>' +
      '<p class="pu-note">口径：注册率 = 注册/访问 · 建Key率 = 建Key/注册 · 充值率 = 充值/建Key（去重 user 数）</p></div>' +
      '</div>' +
      '<div class="card pu-card">' +
      '<div class="pu-head"><h2 class="section-title" style="margin:0">按广告来源（utm_source）转化</h2><span class="pu-sub">点击行 → 按模型下钻</span></div>' +
      '<div class="pu-source-table"></div></div>' +
      '<div class="pu-grid2">' +
      '<div class="card"><div class="pu-model-card"></div></div>' +
      '<div class="card"><h2 class="section-title">调用渠道（by_source）</h2><div class="pu-source-doughnut"></div></div>' +
      '</div>';
  }

  /* ============================ 主渲染 + 三态 ============================ */

  var allGroups = [];
  var currentDrill = null;

  async function renderUsersTab() {
    var container = document.getElementById("page-users");
    if (!container) return;
    container.innerHTML = loadingHtml("正在加载用户转化数据…");
    try {
      var f = state.filters;
      var res = await AnalyticsClient.getFunnel(buildFunnelParams("total"));
      var groups = filterGroupsBySelection(res && res.groups, f);
      if (!groups.length) {
        container.innerHTML = emptyHtml("当前筛选条件下暂无用户转化数据");
        return;
      }
      allGroups = groups;
      currentDrill = null;
      var agg = aggregateGroups(groups);
      var freshness = fmtFreshness(res && res.data_freshness && res.data_freshness.generated_at);
      container.innerHTML = usersLayout(freshness);
      renderUsersFunnel(container, agg);
      renderRates(container, agg);
      renderSourceTable(container);
      renderUsersByModel(container);
      renderSourceDoughnut(container);
    } catch (err) {
      container.innerHTML = errorHtml(err);
      var retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderUsersTab);
    }
  }

  /* 注册到骨架：替换 RENDERERS.users（renderPage() 每次按 state.page 动态读取）。 */
  RENDERERS.users = renderUsersTab;
})();
