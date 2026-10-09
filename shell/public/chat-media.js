/* chat-media.js — 聊天气泡内媒体（图片/视频）渲染层
 *
 * 挂载：window.renderMediaInto(bub, media)
 * 依赖：无（纯 DOM 渲染，不依赖后端 / 不碰上传链路）
 *
 * 字段形状：与基座 media.route 对齐。当前按约定 { type:"image"|"video", url:"..." } 实现；
 *          具体字段名待基座确认识别，集中在下面的 pickUrl / pickType 提取，将来改名只改这里。
 *          兼容：url/src、type/kind；media 可为「单个对象」或「数组」。
 *
 * 渲染规则：
 *   - type === "video"        → <video class="bubmedia bubvideo" controls preload="metadata">
 *   - 其余（image 或未知类型）→ <img class="bubmedia" loading="lazy">（未知类型按图片兜底，避免媒体无法展示）
 */
(function () {
  "use strict";

  function pickUrl(m) {
    if (!m || typeof m !== "object") return null;
    const u = m.url != null ? m.url : m.src;
    return (typeof u === "string" && u.trim()) ? u.trim() : null;
  }

  function pickType(m) {
    const t = m && (m.type != null ? m.type : m.kind);
    return t ? String(t).toLowerCase() : "";
  }

  /* 把媒体渲染进气泡节点 bub，返回是否渲染了任意媒体 */
  function renderMediaInto(bub, media) {
    if (!bub || !media) return false;
    const items = Array.isArray(media) ? media : [media];
    let any = false;
    for (const m of items) {
      const url = pickUrl(m);
      if (!url) continue;
      const type = pickType(m);
      if (type === "video") {
        const v = document.createElement("video");
        v.className = "bubmedia bubvideo";
        v.src = url;
        v.controls = true;
        v.preload = "metadata";
        v.setAttribute("playsinline", "");
        if (bub.appendChild) bub.appendChild(v);
      } else {
        const img = document.createElement("img");
        img.className = "bubmedia";
        img.src = url;
        img.alt = "图片";
        img.loading = "lazy";
        if (bub.appendChild) bub.appendChild(img);
      }
      any = true;
    }
    return any;
  }

  window.renderMediaInto = renderMediaInto;
})();
