/* ==========================================================================
   PowerTokens 归因面板 · 单元 U4 调度与执行 Tab（手动上传触发 · 无自动同步）
   --------------------------------------------------------------------------
   依赖全局（先加载 app.js → tabs/upload.js）：
     RENDERERS / renderPage / state / loadingHtml / emptyHtml / errorHtml / escapeHtml
     PTImportClient / PTUpload（提供 statusChip / errorsHtml / fillReasons）
   背景：A16 已落地导入任务状态机 + firstConnectedAt。本 Tab 把「上传记录」从
   旧的「定时自动任务」语气改写为「手动上传触发」语气，并展示首次接通时间。
   ========================================================================== */
(function (global) {
  "use strict";

  function fmtTime(ts) {
    if (!ts) return "";
    let d;
    if (typeof ts === "number") d = new Date(ts < 1e12 ? ts * 1000 : ts);
    else d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function renderHistory(jobs) {
    if (!jobs || !jobs.length) {
      return '<div class="state state-empty"><div class="state-title">还没有上传记录</div>'
        + '<div class="state-hint muted">点上方「新增上传」开始第一次导入；数据由手动上传触发，不会自动同步。</div></div>';
    }
    const rows = jobs.map((j) => {
      const id = (j.importId || "").slice(0, 8);
      return '<tr data-id="' + escapeHtml(String(j.importId || "")) + '">'
        + "<td>" + PTUpload.statusChip(j.status) + "</td>"
        + "<td>" + escapeHtml(j.provider || "—") + "</td>"
        + '<td class="pt-hist-name"></td>'
        + "<td>" + (j.rowCount != null ? j.rowCount : "—") + "</td>"
        + "<td>" + (j.successRows != null ? j.successRows : "—") + "</td>"
        + "<td>" + fmtTime(j.createdAt) + "</td>"
        + '<td><button type="button" class="pt-hist-view" data-id="' + escapeHtml(String(j.importId || "")) + '">查看</button></td>'
        + "</tr>"
        + '<tr class="pt-hist-detail-row" id="pt-detail-' + escapeHtml(String(j.importId || "")) + '" hidden><td colspan="7"></td></tr>';
    }).join("");
    return '<table class="pt-histab"><thead><tr>'
      + "<th>状态</th><th>平台</th><th>文件</th><th>读到行数</th><th>入库</th><th>上传时间</th><th></th>"
      + "</tr></thead><tbody>" + rows + "</tbody></table>"
      + '<div class="pt-hist-footnote">「上传时间」是该文件被你上传的时间；本页没有「下次运行」——'
      + "数据只在你重新上传时更新，不会自动同步。</div>";
  }

  async function showJobDetail(id, cell) {
    if (!cell) return;
    cell.innerHTML = '<div class="pt-hist-loading">加载详情…</div>';
    try {
      const job = await PTImportClient.getJob(id);
      if (!job) { cell.innerHTML = '<div class="pt-hist-loading">找不到该任务</div>'; return; }
      const meta = [];
      if (job.provider) meta.push("平台 " + job.provider);
      if (job.originalName) meta.push(job.originalName);
      if (job.dateRange && job.dateRange.from) meta.push("数据区间 " + job.dateRange.from + " ~ " + job.dateRange.to);
      if (job.updatedAt) meta.push("更新于 " + fmtTime(job.updatedAt));
      let nums = "";
      if (job.rowCount != null || job.successRows != null) {
        nums = '<div class="pt-nums">'
          + (job.rowCount != null ? '<div class="pt-num"><span class="pt-num-k">读到行数</span><span class="pt-num-v">' + job.rowCount + "</span></div>" : "")
          + (job.successRows != null ? '<div class="pt-num"><span class="pt-num-k">最终入库</span><span class="pt-num-v pt-v-ok">' + job.successRows + "</span></div>" : "")
          + (job.failedRows ? '<div class="pt-num"><span class="pt-num-k">被刷掉</span><span class="pt-num-v pt-v-bad">' + job.failedRows + "</span></div>" : "")
          + "</div>";
      }
      const errs = PTUpload.errorsHtml(job.errorDetails, "最终入库阶段");
      cell.innerHTML = '<div class="pt-hist-detail">'
        + '<div class="pt-jobhead">' + PTUpload.statusChip(job.status) + "</div>"
        + (meta.length ? '<div class="pt-meta">' + meta.map(escapeHtml).join(" · ") + "</div>" : "")
        + nums + errs + "</div>";
      PTUpload.fillReasons(cell, job.errorDetails);
    } catch (e) {
      cell.innerHTML = '<div class="pt-hist-loading">读取失败：' + escapeHtml(e && e.message ? e.message : String(e)) + "</div>";
    }
  }

  async function renderScheduleTab() {
    const container = document.getElementById("page-schedule");
    if (!container) return;
    container.innerHTML = loadingHtml("正在加载调度与执行…");
    try {
      const [jobs, ws] = await Promise.all([
        PTImportClient.listJobs().catch(() => []),
        PTImportClient.getWorkspace().catch(() => null),
      ]);

      const fc = (ws && ws.firstConnectedAt) ? fmtTime(ws.firstConnectedAt)
        : "尚未接通（首次成功导入后自动记录）";

      container.innerHTML =
        '<div class="pt-sched-banner">'
        +   '<div class="pt-sched-banner-h">调度与执行 · 手动上传触发</div>'
        +   '<div class="pt-sched-banner-b">本页展示广告数据的<b>上传记录</b>。数据由你<b>手动上传触发</b>，'
        +     '<b>不会自动同步</b>——这里没有「定时运行 / 下次运行」的概念。'
        +     '要更新归因数据，请点下面的「新增上传」重新传文件。</div>'
        + '</div>'
        + '<div class="card pt-fc-card">'
        +   '<div class="pt-fc-k">首次接通时间</div>'
        +   '<div class="pt-fc-v">' + escapeHtml(fc) + "</div>"
        +   '<div class="pt-fc-note muted">首次成功导入后由系统记录，代表该工作区与广告数据源的接通起点。</div>'
        + "</div>"
        + '<div class="card">'
        +   '<div class="pt-sched-toolbar">'
        +     '<div class="pt-sched-toolbar-h"><h3 class="section-title">上传记录</h3>'
        +       '<span class="pt-sched-sub muted">最近 50 条 · 按上传时间倒序</span></div>'
        +     '<button type="button" class="pt-btn primary" id="pt-sched-upload">＋ 新增上传</button>'
        +   "</div>"
        +   '<div id="pt-sched-history">' + renderHistory(jobs) + "</div>"
        + "</div>";

      // 文件名用 textContent 填（防 XSS）
      container.querySelectorAll(".pt-hist-name").forEach((c, i) => {
        c.textContent = (jobs[i] && jobs[i].originalName) || "—";
      });
      const up = container.querySelector("#pt-sched-upload");
      if (up) up.addEventListener("click", () => PTUpload.open());
      container.querySelectorAll(".pt-hist-view").forEach((b) => {
        b.addEventListener("click", () => {
          const row = document.getElementById("pt-detail-" + b.dataset.id);
          if (!row) return;
          const cell = row.querySelector("td");
          if (row.hidden) {
            row.hidden = false;
            showJobDetail(b.dataset.id, cell);
            b.textContent = "收起";
          } else {
            row.hidden = true;
            b.textContent = "查看";
          }
        });
      });
    } catch (err) {
      container.innerHTML = errorHtml(err);
      const retry = container.querySelector(".retry-btn");
      if (retry) retry.addEventListener("click", renderScheduleTab);
    }
  }

  function wire() {
    if (typeof RENDERERS === "undefined" || typeof renderPage !== "function") return false;
    RENDERERS.schedule = renderScheduleTab;
    if (typeof state !== "undefined" && state.page === "schedule") renderPage();
    return true;
  }
  if (!wire()) global.addEventListener("load", wire);
})(window);
