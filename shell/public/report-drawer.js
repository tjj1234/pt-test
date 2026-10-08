"use strict";
/* ============================================================================
 * report-drawer.js —— report 类型的「通用侧边抽屉」外壳（仅浏览器）
 * --------------------------------------------------------------------------
 * 与 key-drawer.js 同范式：overlay + aside，关键布局用 inline style，
 * 内容样式注入 <style id="rpt-styles">，避开 [hidden]{display:none!important} 的不确定性。
 * 渲染逻辑全部在 report-render.js（纯函数），本文件只负责「把 HTML 装进抽屉 + 开关」。
 *
 * 暴露：
 *   window.openReportDrawer(report)            —— 通用入口：传入任意 report 结构即渲染
 *   window.closeReportDrawer()                 —— 关闭
 *   window.openSampleReportDrawer()            —— 演示/验收：用 Skill-2 代表性样本打开
 *
 * 接线约定（基座「业务工具通用加载入口」就绪后）：当对话结果/Skill 输出命中
 *   outputType === "report" 时，直接调用 window.openReportDrawer(output) 即可，无需改本文件。
 * ========================================================================== */
(function () {
  if (typeof document === "undefined") return; // Node 下不执行（纯函数层已导出）

  const $ = (s) => document.querySelector(s);

  /* ---- 注入 report 内容样式（scope 在 .rpt-* 上，不影响其它组件） ---- */
  function injectStyles() {
    if (document.getElementById("rpt-styles")) return;
    const css = [
      ".rpt-head{margin-bottom:4px;}",
      ".rpt-title{font-size:17px;margin:0 0 6px;color:var(--text-1);line-height:1.4;word-break:break-word;}",
      ".rpt-meta{margin:0 0 2px;font-size:12.5px;color:var(--sub);line-height:1.5;}",
      ".rpt-schema{font-size:11px;color:var(--text-4);margin-bottom:6px;font-family:ui-monospace,Consolas,monospace;}",
      ".rpt-block{margin-top:18px;}",
      ".rpt-subtitle{font-size:12px;font-weight:600;color:var(--sub);margin-bottom:8px;}",
      ".rpt-score-row{display:flex;align-items:center;gap:14px;padding:12px;background:#fafafa;border:1px solid var(--line);border-radius:12px;}",
      ".rpt-score-num{font-size:30px;font-weight:700;line-height:1;}",
      ".rpt-score-body{flex:1;display:flex;flex-direction:column;gap:6px;}",
      ".rpt-score-bar{height:8px;border-radius:999px;background:#ececec;overflow:hidden;}",
      ".rpt-score-bar-fill{height:100%;border-radius:999px;}",
      ".rpt-score-label{font-size:12.5px;color:var(--sub);line-height:1.5;}",
      ".rpt-score-empty{padding:12px;background:#fafafa;border:1px solid var(--line);border-radius:12px;color:var(--sub);font-size:13px;}",
      ".rpt-kv{display:flex;flex-direction:column;}",
      ".rpt-kv-row{display:grid;grid-template-columns:160px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px;}",
      ".rpt-kv-row:last-child{border-bottom:none;}",
      ".rpt-kv-k{color:var(--sub);}",
      ".rpt-kv-v{color:var(--text-1);font-weight:600;word-break:break-word;}",
      ".rpt-table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;}",
      ".rpt-table{width:100%;border-collapse:collapse;font-size:12.5px;}",
      ".rpt-table th,.rpt-table td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;}",
      ".rpt-table th{background:#fafafa;font-weight:600;color:var(--sub);white-space:nowrap;position:sticky;top:0;}",
      ".rpt-table tbody tr:last-child td{border-bottom:none;}",
      ".rpt-table td{color:var(--text-1);word-break:break-word;}",
      ".rpt-sev{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;}",
      ".rpt-sev-high{background:#fdecec;color:#dc2626;}",
      ".rpt-sev-mid{background:#fef3e2;color:#d97706;}",
      ".rpt-sev-low{background:#f4f4f5;color:#71717a;}",
      ".rpt-no-alert{padding:12px;background:#eef9f1;border:1px dashed #16a34a;border-radius:12px;color:#16a34a;font-size:13px;}",
      ".rpt-suggestions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;}",
      ".rpt-suggestion{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--text-1);line-height:1.55;}",
      ".rpt-suggestion>span:last-child{flex:1;}",
      ".rpt-muted{font-size:13px;color:var(--sub);padding:10px 0;}",
      "@media (max-width:520px){.rpt-kv-row{grid-template-columns:1fr;gap:2px;}}",
    ].join("\n");
    const style = document.createElement("style");
    style.id = "rpt-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---- 构造抽屉 DOM（overlay + aside，inline 布局） ---- */
  const overlay = document.createElement("div");
  overlay.setAttribute("style",
    "position:fixed;top:0;right:0;bottom:0;left:0;z-index:9998;" +
    "display:none;justify-content:flex-end;align-items:stretch");

  overlay.innerHTML =
    '<div style="position:absolute;top:0;right:0;bottom:0;left:0;background:rgba(15,23,42,.38)"></div>' +
    '<aside style="position:relative;width:460px;max-width:94vw;height:100%;background:#fff;' +
      'display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(15,23,42,.2)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)">' +
        '<h2 style="font-size:15px;margin:0;color:var(--text-1)">📊 分析报告</h2>' +
        '<button id="rptClose" type="button" style="width:30px;height:30px;border:0;border-radius:8px;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--sub)">×</button>' +
      '</div>' +
      '<div id="rptBody" style="flex:1;overflow:auto;padding:18px 20px"></div>' +
    '</aside>';
  document.body.appendChild(overlay);

  const elBody = overlay.querySelector("#rptBody");
  const closeBtn = overlay.querySelector("#rptClose");

  function open(report) {
    injectStyles();
    if (!window.ReportRender || typeof window.ReportRender.renderReportHTML !== "function") {
      elBody.innerHTML = '<div style="color:var(--bad);font-size:13px">渲染器未加载（report-render.js 缺失）</div>';
    } else {
      try {
        elBody.innerHTML = window.ReportRender.renderReportHTML(report);
      } catch (e) {
        elBody.innerHTML = '<div style="color:var(--bad);font-size:13px">渲染失败：' + (e && e.message ? e.message : String(e)) + '</div>';
      }
    }
    overlay.style.display = "flex";
  }
  function close() { overlay.style.display = "none"; }

  function openSample() {
    const sample = window.ReportRender && window.ReportRender.sampleReport;
    open(sample || { title: "示例报告", meta: "（无样本数据）" });
  }

  window.openReportDrawer = open;
  window.closeReportDrawer = close;
  window.openSampleReportDrawer = openSample;

  closeBtn.addEventListener("click", close);
  overlay.firstElementChild.addEventListener("click", close); // 遮罩

  /* ---- 演示接线：首页「埋点质量 AI 分析」chip 当前为「即将上线」占位，
   *      在基座「业务工具通用加载入口」就绪前，先让它点击打开样本预览抽屉，
   *      便于在界面中看到完整 report 抽屉内容。基座就绪后用真实 Skill 输出替换即可。 ---- */
  const chip = document.getElementById("skill2Chip");
  if (chip) {
    chip.classList.remove("soon");
    chip.addEventListener("click", openSample);
  }
})();
