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
 *   - 加载失败：img/video 绑定 onerror，失败时把破图标/空白替换为兜底文案（.bubmedia-fallback），文案含类型与失败 URL
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

  /* 加载失败兜底：用一段文案替换破图标 / 空白。kind 决定文案（图片/视频）。 */
  function makeFallback(kind, url) {
    const fb = document.createElement("div");
    fb.className = "bubmedia-fallback";
    const label = kind === "video" ? "视频" : "图片";
    const msg = document.createElement("span");
    msg.className = "bubmedia-fallback-msg";
    msg.textContent = label + "加载失败，请检查链接";
    fb.appendChild(msg);
    if (url) {
      const u = document.createElement("span");
      u.className = "bubmedia-fallback-url";
      u.textContent = url;
      fb.appendChild(u);
    }
    return fb;
  }

  /* 绑定 onerror：加载失败时把破媒体节点替换成兜底文案（优先 replaceChild，降级 appendChild）。 */
  function attachErrorFallback(el, kind, url, bub) {
    el.onerror = function () {
      const fb = makeFallback(kind, url);
      if (bub && bub.replaceChild) {
        try { bub.replaceChild(fb, el); return; } catch (e) { /* fallthrough */ }
      }
      if (bub && bub.appendChild) bub.appendChild(fb);
    };
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
        attachErrorFallback(v, "video", url, bub); // 先绑 onerror 再设 src，避免漏掉错误事件
        v.src = url;
        v.controls = true;
        v.preload = "metadata";
        v.setAttribute("playsinline", "");
        if (bub.appendChild) bub.appendChild(v);
      } else {
        const img = document.createElement("img");
        img.className = "bubmedia";
        attachErrorFallback(img, "image", url, bub); // 先绑 onerror 再设 src
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
