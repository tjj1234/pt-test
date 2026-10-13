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
 *   - type === "audio"        → <audio class="bubmedia bubaudio" controls preload="metadata">
 *   - 其余（image 或未知类型）→ <img class="bubmedia" loading="lazy">（未知类型按图片兜底，避免媒体无法展示）
 *   - 每个媒体右上角挂一个「下载」按钮：优先 fetch 成 blob 真正下载，跨域/失败则退化到新标签页打开
 *   - 加载失败：img/video/audio 绑定 onerror，失败时把破图标/空白替换为兜底文案（.bubmedia-fallback）
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

  /* 给媒体起个下载文件名：优先用 URL 末段；拿不到扩展名就按类型补 .mp4/.mp3/.png */
  function filenameFor(url, kind) {
    try {
      const u = new URL(url, location.href);
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last && /\.[a-z0-9]+$/i.test(last)) return last;
    } catch (e) { /* 非法 URL 走兜底 */ }
    const ext = kind === "video" ? ".mp4" : (kind === "audio" ? ".mp3" : ".png");
    return (kind || "file") + ext;
  }

  /* 真正下载：fetch 成 blob → 用 object URL 触发浏览器下载；拿不到（跨域/网络）就退化到新标签页打开 */
  function downloadMedia(url, kind) {
    const openFallback = () => { try { window.open(url, "_blank", "noopener"); } catch (e) { /* 静默 */ } };
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; openFallback(); } }, 8000); // 8s 无结果直接开新标签，避免卡死
    try {
      fetch(url, { credentials: "same-origin" })
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then((blob) => {
          if (done) return;
          done = true; clearTimeout(timer);
          const u = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = u; a.download = filenameFor(url, kind);
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 1500);
        })
        .catch(() => { if (!done) { done = true; clearTimeout(timer); openFallback(); } });
    } catch (e) { if (!done) { done = true; clearTimeout(timer); openFallback(); } }
  }

  /* 媒体右上角的「下载」按钮（避开视频原生控制条，放右上角） */
  function makeDownloadBtn(url, kind) {
    const a = document.createElement("a");
    a.className = "bubmedia-dl";
    a.textContent = "下载";
    a.href = "#";
    a.setAttribute("role", "button");
    a.style.cssText =
      "position:absolute;top:8px;right:8px;z-index:2;" +
      "display:inline-flex;align-items:center;padding:5px 11px;border-radius:8px;" +
      "background:rgba(17,20,26,.62);color:#fff;font-size:12px;line-height:1.4;" +
      "text-decoration:none;cursor:pointer;font-family:inherit;backdrop-filter:blur(2px)";
    a.addEventListener("click", (e) => { e.preventDefault(); downloadMedia(url, kind); });
    return a;
  }

  /* 把媒体元素包进一个相对定位容器，并在右上角挂下载按钮 */
  function wrapWithDownload(mediaEl, url, kind) {
    const wrap = document.createElement("div");
    wrap.className = "bubmedia-wrap";
    wrap.style.cssText = "position:relative;display:inline-block;max-width:100%;line-height:0;vertical-align:top";
    wrap.appendChild(mediaEl);
    wrap.appendChild(makeDownloadBtn(url, kind));
    return wrap;
  }

  /* 加载失败兜底：用一段文案替换破图标 / 空白。kind 决定文案（图片/视频/音频）。 */
  function makeFallback(kind, url) {
    const fb = document.createElement("div");
    fb.className = "bubmedia-fallback";
    const label = kind === "video" ? "视频" : (kind === "audio" ? "音频" : "图片");
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

  /* 绑定 onerror：加载失败时把破媒体节点替换成兜底文案（优先 replaceChild，降级 appendChild）。
     媒体元素现在包在 wrap 里，所以优先在 el.parentNode（wrap）内替换；都不行就追加到 bub。 */
  function attachErrorFallback(el, kind, url, bub) {
    el.onerror = function () {
      const fb = makeFallback(kind, url);
      const parent = el.parentNode;
      if (parent && parent.replaceChild) {
        try { parent.replaceChild(fb, el); return; } catch (e) { /* fallthrough */ }
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
      let el;
      if (type === "video") {
        const v = document.createElement("video");
        v.className = "bubmedia bubvideo";
        attachErrorFallback(v, "video", url, bub); // 先绑 onerror 再设 src，避免漏掉错误事件
        v.src = url;
        v.controls = true;
        v.preload = "metadata";
        // 上传时截好的首帧：有的话先显示，别让气泡里先黑一块再出画面
        if (m.poster) v.poster = m.poster;
        v.setAttribute("playsinline", "");
        el = v;
      } else if (type === "audio") {
        // 音频：与 video 分支同一套写法，只换成 <audio>（自带浏览器原生播放器，无需 poster/playsinline）
        const a = document.createElement("audio");
        a.className = "bubmedia bubaudio";
        attachErrorFallback(a, "audio", url, bub); // 先绑 onerror 再设 src
        a.src = url;
        a.controls = true;
        a.preload = "metadata";
        el = a;
      } else {
        const img = document.createElement("img");
        img.className = "bubmedia";
        attachErrorFallback(img, "image", url, bub); // 先绑 onerror 再设 src
        img.src = url;
        img.alt = "图片";
        img.loading = "lazy";
        el = img;
      }
      if (bub.appendChild) bub.appendChild(wrapWithDownload(el, url, type || "image"));
      any = true;
    }
    return any;
  }

  window.renderMediaInto = renderMediaInto;
})();
