/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.2 总览 Tab（真实内容）
   --------------------------------------------------------------------------
   依赖全局（先加载 app.fixed.js → tabs/tabs-common.js）：
     state / resolveRange / buildFunnelParams / AnalyticsClient / loadingHtml /
     emptyHtml / errorHtml / escapeHtml / RENDERERS / renderPage / PT_TABS
   图表：纯 SVG / CSS 手绘（无 Chart.js、无框架、无构建）。
   只读：仅 GET /api/analytics/funnel，绝不编造任何数字。
   ========================================================================== */
(function (global) {
  "use strict";

  const PT = global.PT_TABS || {};
  const C = ["#6366f1", "#a78bfa", "#c084fc", "#f472b6"]; // 访问/注册/建Key/充值 四色

  /* ---------- 跨组求和 ---------- */
  function sumGroups(groups, field) {
    return (groups || []).reduce((s, g) => {
      const f = g && g.funnel;
      const v = f ? Number(f[field]) : NaN;
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  }

  /* ---------- 全局 ROI 聚合（设计 3.2 §3.3，沿用 2.4 §3.3 三分支口径） ---------- */
  function aggregateRoi(roiRows) {
    let spend = 0, rechargeUsd = 0, rechargeCnt = 0, fxMissing = 0;
    (roiRows || []).forEach((r) => {
      if (r.attr_spend_usd != null) {
        spend += Number(r.attr_spend_usd) || 0;
        rechargeCnt += Number(r.recharges) || 0;
        if (r.recharge_amount_usd != null) rechargeUsd += Number(r.recharge_amount_usd) || 0;
      }
      fxMissing += Number(r.recharge_fx_missing) || 0;
    });
    if (spend <= 0) return { display: "—", note: "广告花费缺失/为0，ROI 无意义" };
    if (rechargeCnt === 0) return { display: "0.00×", note: "有花费无充值" };
    if (fxMissing > 0) {
      if (fxMissing >= rechargeCnt) return { display: "—", note: "充值币种折算缺失" };
      return { display: PT.fmtRatio(rechargeUsd / spend), note: "部分充值币种折算缺失，ROI 可能低估" };
    }
    return { display: PT.fmtRatio(rechargeUsd / spend), note: "充值 USD ÷ 广告花费 USD（仅统计能唯一归因的行；重名/未命中的行两边都不计入，故与素材页各行加总不同）" };
  }

  /* ---------- 5 张 KPI 卡（设计 3.2 §3.2） ---------- */
  function kpiCards(groups, roiRows) {
    const hasBehavior = (groups || []).length > 0;
    const visits = sumGroups(groups, "visits");
    const signups = sumGroups(groups, "signups");
    const keyUsers = sumGroups(groups, "key_users");
    const keyCreated = sumGroups(groups, "key_created");
    const rechargeUsers = sumGroups(groups, "recharge_users");
    const rechargeAmount = sumGroups(groups, "recharge_amount");

    // 跨组转化率按定义重算（设计 3.2 §3.2），避免「把各组比率平均」的错误
    const signupRate = visits > 0 ? signups / visits : null;
    const keyRate = signups > 0 ? keyUsers / signups : null;
    const rechargeRate = keyUsers > 0 ? rechargeUsers / keyUsers : null;
    const roi = aggregateRoi(roiRows);

    const cards = [
      { label: "访问", value: hasBehavior ? PT.fmtInt(visits) : "—", sub: "去重访客" },
      { label: "注册", value: hasBehavior ? PT.fmtInt(signups) : "—", sub: "注册率 " + (hasBehavior ? PT.fmtPct(signupRate) : "—") },
      { label: "建Key", value: hasBehavior ? PT.fmtInt(keyUsers) : "—", sub: "Key 个数 " + (hasBehavior ? PT.fmtInt(keyCreated) : "—") },
      { label: "充值", value: hasBehavior ? PT.fmtInt(rechargeUsers) : "—", sub: "充值额 " + (hasBehavior ? PT.fmtUsd(rechargeAmount) : "—") },
      { label: "ROI", value: roi.display, sub: roi.note },
    ];
    return '<div class="kpi-grid">' + cards.map((k) =>
      '<div class="kpi-card"><div class="kpi-label muted">' + escapeHtml(k.label) +
      '</div><div class="kpi-value">' + escapeHtml(k.value) +
      '</div><div class="kpi-sub muted">' + escapeHtml(k.sub) + "</div></div>"
    ).join("") + "</div>";
  }

  /* ---------- 转化漏斗（横向 CSS bar，设计 3.2 §3.4） ---------- */
  function funnelHtml(groups) {
    const hasBehavior = (groups || []).length > 0;
    if (!hasBehavior) {
      return '<div class="card chart-card"><h3 class="section-title">转化漏斗 · 事件侧 · 访问→注册→建Key→充值</h3>' +
        '<div class="state state-empty" style="padding:24px 16px"><div class="state-title">暂无漏斗数据</div><div class="state-hint muted">该筛选下没有行为分组</div></div></div>';
    }
    const stages = [
      { name: "访问", v: sumGroups(groups, "visits") },
      { name: "注册", v: sumGroups(groups, "signups") },
      { name: "建Key", v: sumGroups(groups, "key_users") },
      { name: "充值", v: sumGroups(groups, "recharge_users") },
    ];
    const max = Math.max(1, ...stages.map((s) => s.v));
    const rates = [
      null,
      stages[0].v > 0 ? stages[1].v / stages[0].v : null,
      stages[1].v > 0 ? stages[2].v / stages[1].v : null,
      stages[2].v > 0 ? stages[3].v / stages[2].v : null,
    ];
    const rows = stages.map((s, i) => {
      const pct = Math.round((s.v / max) * 100);
      const rate = i === 0 ? "" : '<span class="funnel-rate muted">' + PT.fmtPct(rates[i]) + "</span>";
      return '<div class="funnel-row">' +
        '<div class="funnel-label">' + escapeHtml(s.name) + "</div>" +
        '<div class="funnel-track"><div class="funnel-bar" style="width:' + pct + "%;background:" + C[i] + '"></div></div>' +
        '<div class="funnel-val">' + PT.fmtInt(s.v) + rate + "</div>" +
        "</div>";
    }).join("");
    return '<div class="card chart-card"><h3 class="section-title">转化漏斗 · 事件侧 · 访问→注册→建Key→充值</h3>' +
      '<div class="funnel">' + rows + "</div></div>";
  }

  /* ---------- 漏斗日趋势（SVG 折线，设计 3.2 §3.4） ---------- */
  function dateRange(from, to) {
    const days = [];
    const s = new Date(from), e = new Date(to);
    const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
    const end = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()));
    while (cur.getTime() <= end.getTime()) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
  }

  function trendSeries(dailyGroups, from, to) {
    const days = dateRange(from, to);
    const acc = {};
    (dailyGroups || []).forEach((g) => {
      const b = g.bucket;
      if (b == null) return;
      if (!acc[b]) acc[b] = { visits: 0, signups: 0, key_users: 0, recharge_users: 0 };
      const f = g.funnel || {};
      const a = acc[b];
      a.visits += Number(f.visits) || 0;
      a.signups += Number(f.signups) || 0;
      a.key_users += Number(f.key_users) || 0;
      a.recharge_users += Number(f.recharge_users) || 0;
    });
    return days.map((d) => acc[d] || { visits: 0, signups: 0, key_users: 0, recharge_users: 0 });
  }

  function trendSvg(dailyGroups, from, to) {
    const days = dateRange(from, to);
    const points = trendSeries(dailyGroups, from, to);
    const series = [
      { name: "访问", color: C[0], data: points.map((p) => p.visits) },
      { name: "注册", color: C[1], data: points.map((p) => p.signups) },
      { name: "建Key", color: C[2], data: points.map((p) => p.key_users) },
      { name: "充值", color: C[3], data: points.map((p) => p.recharge_users) },
    ];
    const totalNonZero = series.reduce((s, se) => s + se.data.reduce((a, v) => a + v, 0), 0);
    if (totalNonZero === 0) {
      return '<div class="card chart-card"><h3 class="section-title">漏斗日趋势（granularity=day）</h3>' +
        '<div class="state state-empty" style="padding:24px 16px"><div class="state-title">该区间无日趋势数据</div><div class="state-hint muted">无事件日按 0 补齐，不画全 0 折线</div></div></div>';
    }

    const W = 720, H = 240;
    const padL = 46, padR = 12, padT = 12, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxY = Math.max(1, ...series.flatMap((s) => s.data));
    const n = days.length;
    const x = (i) => (n <= 1 ? padL + iw / 2 : padL + (i / (n - 1)) * iw);
    const y = (v) => padT + ih - (v / maxY) * ih;

    let grid = "";
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const val = (maxY * t) / ticks;
      const yy = y(val);
      grid += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="#e4e4e7" stroke-width="1"/>';
      grid += '<text x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="10" fill="#a1a1aa">' + PT.compact(val) + "</text>";
    }
    let xlabels = "";
    const step = Math.max(1, Math.ceil(n / 8));
    days.forEach((d, i) => {
      if (i % step === 0 || i === n - 1) {
        xlabels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#a1a1aa">' + escapeHtml(d.slice(5)) + "</text>";
      }
    });
    const paths = series.map((s) => {
      const d = s.data.map((v, i) => (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
      return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    }).join("");
    const legend = series.map((s) =>
      '<span class="legend-item"><span class="legend-dot" style="background:' + s.color + '"></span>' + escapeHtml(s.name) + "</span>"
    ).join("");

    return '<div class="card chart-card">' +
      '<div class="chart-head"><h3 class="section-title">漏斗日趋势（granularity=day）</h3><div class="legend">' + legend + "</div></div>" +
      '<svg class="trend-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="漏斗日趋势">' +
      grid + xlabels + paths + "</svg></div>";
  }

  /* ---------- 总览渲染入口 ---------- */
  async function renderOverviewTab() {
    const container = document.getElementById("page-overview");
    if (!container) return;
    container.innerHTML = loadingHtml("正在加载总览数据…");
    try {
      const f = state.filters;
      const { from, to } = resolveRange(f);
      const [total, daily] = await Promise.all([
        AnalyticsClient.getFunnel({ from, to, granularity: "total" }),
        AnalyticsClient.getFunnel({ from, to, granularity: "day" }),
      ]);
      const groups = PT.filterGroups(total && total.groups, f);
      const dailyGroups = PT.filterGroups(daily && daily.groups, f);
      const roiRows = PT.filterRoi(total && total.roi_by_entity, f);

      if (!groups.length && !roiRows.length) {
        container.innerHTML = emptyHtml("当前筛选条件下暂无漏斗数据");
        return;
      }
      container.innerHTML =
        PT.freshnessHtml(total && total.data_freshness) +
        kpiCards(groups, roiRows) +
        funnelHtml(groups) +
        trendSvg(dailyGroups, from, to);
    } catch (err) {
      container.innerHTML = errorHtml(err);
      const retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderOverviewTab);
    }
  }

  /* ---------- 接线：挂到 3.1 骨架的 RENDERERS 分发上 ---------- */
  function wire() {
    if (typeof RENDERERS === "undefined" || typeof renderPage !== "function") return false;
    RENDERERS.overview = renderOverviewTab;
    if (typeof state !== "undefined" && state.page === "overview") renderPage();
    return true;
  }
  if (!wire()) global.addEventListener("load", wire);
})(window);
