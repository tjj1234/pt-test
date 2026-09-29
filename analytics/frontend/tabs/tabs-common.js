/* ==========================================================================
   PowerTokens 归因面板 · 单元 3.2 共用工具（总览 / 素材 Tab 共享）
   --------------------------------------------------------------------------
   依赖：本文件须在 app.fixed.js 之后加载（复用其全局函数 platformsToUtmSources /
   escapeHtml 等）。本文件只挂一个全局命名空间 window.PT_TABS，纯函数、无 DOM、
   无网络、不编造数据。
   ========================================================================== */
(function (global) {
  "use strict";

  const PT = (global.PT_TABS = global.PT_TABS || {});

  /* ---------- 平台值 → 显示名（素材表 badge 用） ---------- */
  PT.PLATFORM_LABEL = { google: "Google", meta: "Meta", x: "X" };

  /* ---------- 客户端筛选（设计 3.2 §2.2） ----------
     服务端只传时间 + granularity；平台/国家多选一律在这里客户端过滤返回的行。 */

  // 平台多选（显示名）→ 命中 utm_source / roi_by_entity.platform 值集
  function selectedSources(f) {
    const plats = (f && f.platforms) || [];
    if (!plats.length) return [];
    if (typeof platformsToUtmSources === "function") {
      return platformsToUtmSources(plats); // 骨架 3.1 §4.1：Google Ads→google 等
    }
    const MAP = { "Google Ads": "google", "Meta Ads": "meta", "X Ads": "x" };
    return plats.map((p) => MAP[p]).filter(Boolean);
  }

  function filterGroups(groups, f) {
    f = f || {};
    const platformsOn = !!(f.platforms && f.platforms.length);
    const srcs = selectedSources(f);
    const countries = f.countries || [];
    const utmSources = f.utmSources || [];
    const utmCampaigns = f.utmCampaigns || [];
    return (groups || []).filter((g) => {
      if (platformsOn) {
        if (g.utm_source == null) return false;         // 自然流量组：平台被选中时排除
        if (srcs.indexOf(g.utm_source) < 0) return false;
      }
      if (countries.length && countries.indexOf(g.country) < 0) return false;
      if (utmSources.length && utmSources.indexOf(g.utm_source) < 0) return false;
      if (utmCampaigns.length && utmCampaigns.indexOf(g.utm_campaign) < 0) return false;
      return true;
    });
  }

  function filterRoi(rows, f) {
    f = f || {};
    const platformsOn = !!(f.platforms && f.platforms.length);
    const srcs = selectedSources(f);
    const utmSources = f.utmSources || [];
    const utmCampaigns = f.utmCampaigns || [];
    return (rows || []).filter((r) => {
      if (platformsOn) {
        if (r.platform == null) return false;           // no_match/ambiguous 无法判属平台
        if (srcs.indexOf(r.platform) < 0) return false;
      }
      if (utmSources.length && utmSources.indexOf(r.utm_source) < 0) return false;
      if (utmCampaigns.length && utmCampaigns.indexOf(r.utm_campaign) < 0) return false;
      return true;
    });
  }

  PT.filterGroups = filterGroups;
  PT.filterRoi = filterRoi;

  /* ---------- 数值格式化（null → "—"；0 显示真实 "0"，不冒充无数据） ---------- */

  function isFiniteNum(v) { return typeof v === "number" && Number.isFinite(v); }

  function fmtInt(n) {
    if (n == null) return "—";
    const v = Number(n);
    return isFiniteNum(v) ? Math.round(v).toLocaleString("en-US") : "—";
  }
  function fmtUsd(n) {
    if (n == null) return "—";
    const v = Number(n);
    return isFiniteNum(v)
      ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";
  }
  function fmtRatio(n) {
    if (n == null) return "—";
    const v = Number(n);
    return isFiniteNum(v) ? v.toFixed(2) + "×" : "—";
  }
  function fmtPct(n) {
    if (n == null) return "—";
    const v = Number(n);
    return isFiniteNum(v) ? (v * 100).toFixed(1) + "%" : "—";
  }
  function compact(n) {
    if (n == null) return "—";
    const v = Number(n);
    if (!isFiniteNum(v)) return "—";
    if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(Math.round(v));
  }

  PT.fmtInt = fmtInt;
  PT.fmtUsd = fmtUsd;
  PT.fmtRatio = fmtRatio;
  PT.fmtPct = fmtPct;
  PT.compact = compact;

  /* ---------- 数据新鲜度条（可选，一行 muted） ---------- */
  PT.freshnessHtml = function (df) {
    if (!df) return "";
    const bits = [];
    if (df.ads_synced_through) bits.push("数据截至 " + df.ads_synced_through);
    if (df.generated_at) bits.push("生成于 " + df.generated_at);
    if (df.events_max_seq != null) bits.push("事件水位 seq " + df.events_max_seq);
    return bits.length
      ? '<div class="freshness-bar muted">' + bits.map(escapeHtml).join(" · ") + "</div>"
      : "";
  };
})(window);
