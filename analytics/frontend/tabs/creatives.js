/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.2 素材 Tab 【修正版 creatives.fixed.js】
   --------------------------------------------------------------------------
   ⚠️ 本文件是 creatives.js 的修正版，仅修正「排序方向」缺陷（见下）。
      开发期沙箱对已存在文件只读，无法就地覆盖，故以新文件名交付。
      部署收口：用本文件内容覆盖 creatives.js，然后删除本文件。
      （部署门禁 scripts/preflight-deploy.mjs 会校验收口是否完成）
   --------------------------------------------------------------------------
   修正内容（依据独立验收意见 + 设计文档 3.2 §4.4）：

   【缺陷】原 sortRows() 末尾 `return sortDir === "desc" ? -cmp : cmp;`
          对整体比较结果取负。而 cmp 是在「升序 + null 沉底」语义下算出的，
           整体取负把三件事一起翻反了：
             ① null 定位 —— null 不再沉底，反而浮到表格最顶部
             ② 同值时的花费次级排序 —— 由降序变成升序
           后果：roi=null（无法归因/无意义）的行出现在「ROI 排行」顶部，
                 会让运营误把「无法归因」当成「排行靠前」。
                 原文件表尾文案自己写着「null 沉底」，与实际行为矛盾。

   【修法】把「null 判定」与「排序方向」解耦：
             · null 一律沉底 —— 不受 asc/desc 影响（返回固定的 1 / -1）
             · 有效值比较才应用 sortDir（desc 时 b-a，asc 时 a-b）
             · 同值恒按 attr_spend_usd 降序（不随 sortDir 变）
   --------------------------------------------------------------------------
   依赖全局（先加载 app.fixed.js → tabs/tabs-common.js）：
     state / resolveRange / buildFunnelParams / AnalyticsClient / loadingHtml /
     emptyHtml / errorHtml / escapeHtml / RENDERERS / renderPage / PT_TABS
   只读：仅 GET /api/analytics/funnel，roi_by_entity 渲染，不编造任何数字。
   关键口径：roi=0（有花费无充值）与 roi=null（无法归因/分母缺失）严格区分。
   ========================================================================== */
(function (global) {
  "use strict";

  const PT = global.PT_TABS || {};

  let rowsCache = [];
  let freshnessCache = null;
  let sortKey = "roi";
  let sortDir = "desc";
  let sortBound = false;

  function toNum(v) { return v == null ? NaN : Number(v); }

  /* ---------- 实体名（设计 3.2 §4.2 列 1） ---------- */
  function entityName(r) {
    if (r.level === "creative") return r.utm_content;
    if (r.level === "campaign") return r.utm_campaign;
    if (r.level === "account") return r.platform;
    // level=null（no_match / ambiguous_name）
    return r.utm_content != null ? r.utm_content
      : (r.utm_campaign != null ? r.utm_campaign
        : (r.utm_source != null ? r.utm_source : null));
  }

  function cell(v) { return v == null ? "—" : escapeHtml(String(v)); }

  function badge(cls, text) { return '<span class="badge badge-' + cls + '">' + text + "</span>"; }

  function levelBadge(level) {
    if (level === "creative") return badge("indigo", "素材");
    if (level === "campaign") return badge("violet", "系列");
    if (level === "account") return badge("emerald", "账户");
    return badge("zinc", "—");
  }
  function platformBadge(p) {
    const m = { google: ["emerald", "Google"], meta: ["indigo", "Meta"], x: ["violet", "X"] }[p];
    return m ? badge(m[0], m[1]) : badge("zinc", "—");
  }
  function matchBadge(match) {
    const m = {
      id: ["emerald", "精确ID"], name_unique: ["indigo", "名称唯一"], account: ["violet", "账户级"],
      ambiguous_name: ["amber", "重名"], no_match: ["rose", "未命中"],
    }[match];
    return m ? badge(m[0], m[1]) : badge("zinc", "—");
  }

  /* ---------- roi_note 前端兜底（设计 3.2 §4.3；API 给了就用，没给按字段推导） ---------- */
  function roiNoteFallback(r) {
    if (r.roi_note) return r.roi_note;
    if (r.match === "ambiguous_name") return "素材/系列名重名，无法唯一归因（建议埋点改存 creative_id）";
    if (r.match === "no_match") return "有 UTM 但未匹配到广告实体";
    const spend = toNum(r.attr_spend_usd);
    if (!Number.isFinite(spend) || spend === 0) {
      return (toNum(r.recharges) || 0) === 0
        ? "广告花费缺失/为0（且无充值），ROI 无意义"
        : "广告花费缺失/为0，ROI 无意义";
    }
    const rc = toNum(r.recharges) || 0;
    if (rc === 0) return "有花费无充值";
    if (r.recharge_amount_usd == null) return "充值币种折算缺失";
    const fx = toNum(r.recharge_fx_missing) || 0;
    if (fx > 0 && fx < rc) return "部分充值币种折算缺失";
    return "";
  }

  /* ---------- ROI 单元格三态（设计 3.2 §4.3） ---------- */
  function roiCell(r) {
    if (r.roi != null) {
      const v = toNum(r.roi);
      if (Number.isFinite(v) && v === 0) {
        return '<span class="roi-zero">0.00×</span><div class="roi-note muted">' + escapeHtml(r.roi_note || "有花费无充值") + "</div>";
      }
      const cls = Number.isFinite(v) && v >= 1 ? "roi-pos" : "roi-neg";
      const note = r.roi_note ? '<div class="roi-note muted">' + escapeHtml(r.roi_note) + "</div>" : "";
      return '<span class="' + cls + '">' + PT.fmtRatio(v) + "</span>" + note;
    }
    return '<span class="roi-null">—</span><div class="roi-note muted">' + escapeHtml(roiNoteFallback(r)) + "</div>";
  }

  /* ---------- 排序（设计 3.2 §4.4）：有效数值（含 0）在前、null 沉底 ----------
     【本次修正】null 定位与排序方向解耦，见文件头说明。 */
  function spendDesc(a, b) {
    return (toNum(b.attr_spend_usd) || 0) - (toNum(a.attr_spend_usd) || 0);
  }

  function sortRows(rows) {
    const arr = rows.slice();
    arr.sort((a, b) => {
      if (sortKey === "roi") {
        const av = a.roi == null ? null : toNum(a.roi);
        const bv = b.roi == null ? null : toNum(b.roi);
        const aNull = av == null || !Number.isFinite(av);
        const bNull = bv == null || !Number.isFinite(bv);
        // null 一律沉底 —— 与 sortDir 无关（修正点①）
        if (aNull || bNull) {
          if (aNull && bNull) return spendDesc(a, b);
          return aNull ? 1 : -1;
        }
        if (av !== bv) return sortDir === "desc" ? bv - av : av - bv; // 只有有效值比较才看方向
        return spendDesc(a, b); // 同值恒按花费降序 —— 与 sortDir 无关（修正点②）
      }
      const av = toNum(a[sortKey]), bv = toNum(b[sortKey]);
      const aNull = !Number.isFinite(av), bNull = !Number.isFinite(bv);
      // 同上：null 一律沉底 —— 与 sortDir 无关
      if (aNull || bNull) {
        if (aNull && bNull) return 0;
        return aNull ? 1 : -1;
      }
      if (av !== bv) return sortDir === "desc" ? bv - av : av - bv;
      return 0;
    });
    return arr;
  }

  function th(label, key) {
    const sortable = !!key;
    const active = sortable && sortKey === key;
    const arrow = active ? (sortDir === "desc" ? " ▾" : " ▴") : "";
    return '<th' + (sortable ? ' data-sort="' + key + '" class="sortable"' : "") + ">" + escapeHtml(label) + arrow + "</th>";
  }

  function tableHtml(rows) {
    const sorted = sortRows(rows);
    const thead = "<thead><tr>" +
      th("实体", null) + th("层级", null) + th("平台", null) +
      th("计划 utm_campaign", null) + th("素材 utm_content", null) + th("归因解析", null) +
      th("充值次数", "recharges") + th("充值用户", null) + th("充值额 USD", null) +
      th("广告花费 USD", "attr_spend_usd") + th("ROI", "roi") +
      th("平台自报 ROAS", null) + th("花费天数", "spend_days") +
      "</tr></thead>";
    const tbody = "<tbody>" + sorted.map((r) => {
      const name = entityName(r);
      const matchTip = (r.match === "ambiguous_name" && Array.isArray(r.matched_entities) && r.matched_entities.length)
        ? ' title="重名实体：' + escapeHtml(r.matched_entities.join(", ")) + '"' : "";
      return "<tr>" +
        '<td class="entity-cell">' + (name == null ? "—" : escapeHtml(String(name))) + "</td>" +
        "<td>" + levelBadge(r.level) + "</td>" +
        "<td>" + platformBadge(r.platform) + "</td>" +
        "<td>" + cell(r.utm_campaign) + "</td>" +
        "<td>" + cell(r.utm_content) + "</td>" +
        "<td" + matchTip + ">" + matchBadge(r.match) + "</td>" +
        '<td class="num">' + PT.fmtInt(r.recharges) + "</td>" +
        '<td class="num">' + PT.fmtInt(r.recharge_users) + "</td>" +
        '<td class="num">' + PT.fmtUsd(r.recharge_amount_usd) + "</td>" +
        '<td class="num">' + PT.fmtUsd(r.attr_spend_usd) + "</td>" +
        "<td>" + roiCell(r) + "</td>" +
        '<td class="num muted">' + (r.platform_roas == null ? "—" : PT.fmtRatio(r.platform_roas)) + "</td>" +
        '<td class="num">' + PT.fmtInt(r.spend_days) + "</td>" +
        "</tr>";
    }).join("") + "</tbody>";
    return thead + tbody;
  }

  function contentHtml(rows, freshness) {
    const head = '<div class="creatives-head"><h2 class="section-title">素材归因 ROI 排行</h2>' +
      '<div class="caliber muted">归因口径：Meta 广告可归到素材级；Google 搜索广告归到广告/系列级（无素材级，utm_content 列为 —）。未能唯一归因的行以「—」+ note 标注原因。</div></div>';
    const legend = '<div class="table-footnote muted">ROI 口径：真实充值 USD ÷ 广告花费 USD（' +
      '<span class="roi-pos">≥1</span> 绿 · <span class="roi-neg">&lt;1</span> 红 · <span class="roi-zero">0</span> 有花费无充值 · <span class="roi-null">—</span> 无意义/无法归因，见行内 note）。平台自报 ROAS 仅参考，不参与 ROI。</div>';
    const countNote = rows.length >= 200
      ? '<div class="table-footnote muted">已返回 ' + rows.length + ' 条；若达接口上限（默认 200）可能被截断，请收紧筛选。</div>'
      : '<div class="table-footnote muted">共 ' + rows.length + " 条归因实体（默认按 ROI 降序，null 沉底；点击「充值次数 / 广告花费 / ROI / 花费天数」表头可切换排序）。</div>";
    return PT.freshnessHtml(freshness) + head +
      '<div class="table-scroll"><table class="data-table">' + tableHtml(rows) + "</table></div>" +
      legend + countNote;
  }

  /* ---------- 排序点击（事件委托挂在 section 上，不随 innerHTML 丢失） ---------- */
  function onSortClick(e) {
    const t = e.target && e.target.closest ? e.target.closest("th[data-sort]") : null;
    if (!t) return;
    const key = t.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "desc" ? "asc" : "desc";
    else { sortKey = key; sortDir = "desc"; }
    const container = document.getElementById("page-creatives");
    if (container) container.innerHTML = contentHtml(rowsCache, freshnessCache);
  }

  function ensureSortBound() {
    if (sortBound) return;
    const c = document.getElementById("page-creatives");
    if (c) { c.addEventListener("click", onSortClick); sortBound = true; }
  }

  /* ---------- 素材渲染入口 ---------- */
  async function renderCreativesTab() {
    const container = document.getElementById("page-creatives");
    if (!container) return;
    container.innerHTML = loadingHtml("正在加载素材 ROI 数据…");
    try {
      const f = state.filters;
      const { from, to } = resolveRange(f);
      const total = await AnalyticsClient.getFunnel({ from, to, granularity: "total" });
      const rows = PT.filterRoi(total && total.roi_by_entity, f);

      if (!rows.length) {
        container.innerHTML = emptyHtml("当前筛选下无素材 ROI 数据");
        rowsCache = [];
        freshnessCache = null;
        return;
      }
      rowsCache = rows;
      freshnessCache = total && total.data_freshness;
      container.innerHTML = contentHtml(rows, freshnessCache);
      ensureSortBound();
    } catch (err) {
      container.innerHTML = errorHtml(err);
      const retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderCreativesTab);
    }
  }

  /* ---------- 接线：挂到 3.1 骨架的 RENDERERS 分发上 ---------- */
  function wire() {
    if (typeof RENDERERS === "undefined" || typeof renderPage !== "function") return false;
    RENDERERS.creatives = renderCreativesTab;
    ensureSortBound();
    if (typeof state !== "undefined" && state.page === "creatives") renderPage();
    return true;
  }
  if (!wire()) global.addEventListener("load", wire);
})(window);
