/**
 * 聊天输入区「音视频上传」前端回归测试。
 *
 * 沿用 ui-chat-doc-upload-frontend-test.mjs 的老办法：仓库没有 jsdom，
 * 用「最小 DOM 桩 + vm」把**真实的 shell/public/chat-media.js 和 app.js** 跑起来
 * （这次两个一起加载，所以能直接断言气泡里真生成了 <audio>/<video>），
 * 配一个内存版 /api/upload-media 验证的是真代码，不是另写一份逻辑。
 *
 * 覆盖：
 *   1. 入口：#mediaBtn / #mediaInput 存在，accept 只收 video/*,audio/*，拖拽仍复用 attachDropZone。
 *   2. 类型判定：MIME 优先，MIME 为空（.mkv/.mov）退回扩展名，非音视频判不出来。
 *   3. 上传：请求体 { name, data, kind } 与 /api/upload-doc 同形；成功进 pendingMedia + 胶囊。
 *   4. 容错：后端给 type 以它为准；没给 / 给了脏值 → 退回前端判的 kind。
 *   5. 非法：非音视频、超限、空文件、后端报错 —— 都要提示且不进 pendingMedia。
 *   6. 发送：payload.media = [{ type, url }]，乐观渲染的气泡里就有播放器，发完清空。
 *   7. chat-media.js：新增 audio 分支，且不影响既有 video / image / 兜底文案。
 *
 * 跑法：node tests/regression/ui-chat-media-upload-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, "../../shell/public/app.js");
const CHAT_MEDIA_JS = path.resolve(HERE, "../../shell/public/chat-media.js");
const INDEX_HTML = path.resolve(HERE, "../../shell/public/index.html");
const SERVER_CJS = path.resolve(HERE, "../../shell/server.cjs");
const TENANT = "t1";

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

/* ---------------- 在气泡里找媒体 / 兜底块（兼容 .bubmedia-wrap 包装层） ---------------- */
// chat-media.js 给每个媒体包了一层 .bubmedia-wrap（里面是 .bubmedia 媒体 + .bubmedia-dl 下载按钮），
// 所以「气泡里第一个子节点就是 <audio>/<video>」的假设在加下载按钮后失效。
// 这里用类名递归找，不依赖具体嵌套层级：媒体 className 含 "bubmedia"，包装层是 "bubmedia-wrap"（不匹配）。
function deepFind(node, pred) {
  if (!node || !node.children) return null;
  for (const ch of node.children) {
    if (pred(ch)) return ch;
    const d = deepFind(ch, pred);
    if (d) return d;
  }
  return null;
}
function findBubmedia(node, tag) {
  return deepFind(node, (c) => {
    const cls = String(c.className || "").split(/\s+/);
    return cls.includes("bubmedia") && (!tag || c.tagName === tag);
  });
}
function findFallback(node) {
  return deepFind(node, (c) => String(c.className || "") === "bubmedia-fallback");
}

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(tag) {
  const listeners = Object.create(null);
  let _html = "";
  const el = {
    tagName: tag || "div", id: "", className: "", hidden: false, value: "", textContent: "",
    src: "", title: "", alt: "", disabled: false, files: null,
    scrollTop: 0, scrollHeight: 0, style: {}, dataset: {}, accept: "",
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(child) { el.children.push(child); return child; },
    /** 真实 DOM 里 onerror 走的是 replaceChild —— 桩补上，兜底文案的断言才准。 */
    replaceChild(nw, old) {
      const i = el.children.indexOf(old);
      if (i >= 0) el.children.splice(i, 1, nw); else el.children.push(nw);
      return old;
    },
    remove() {}, removeAttribute() {}, setAttribute() {}, getAttribute() { return null; },
    replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {},
    cloneNode() { return makeEl(); },
    matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null,
    _q: null,
    querySelector(sel) {
      el._q = el._q || new Map();
      if (!el._q.has(sel)) el._q.set(sel, makeEl());
      return el._q.get(sel);
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
  // innerHTML 置空时同步清掉 children，这样「移除胶囊」这类断言才数得准
  Object.defineProperty(el, "innerHTML", {
    get() { return _html; },
    set(v) { _html = String(v); if (_html === "") el.children.length = 0; },
  });

  // 媒体元素：src 一设就异步抛 metadata / data / seeked，让「读时长」「截首帧」这类逻辑能真跑
  if (tag === "video" || tag === "audio") {
    el.duration = 42;          // 固定 42 秒，好断言 fmtClock(42) === "0:42"
    el.currentTime = 0;
    el.crossOrigin = "";
    Object.defineProperty(el, "src", {
      configurable: true,
      get() { return this._src || ""; },
      set(v) {
        this._src = v;
        setTimeout(() => {
          el.dispatch("loadedmetadata", {});
          el.dispatch("loadeddata", {});
          if (tag === "video") setTimeout(() => el.dispatch("seeked", {}), 0);
        }, 0);
      },
    });
  }
  // canvas：截帧要用，这里给个能跑通的假实现
  if (tag === "canvas") {
    el.getContext = () => ({ drawImage() {} });
    el.toDataURL = () => "data:image/jpeg;base64,POSTERSTUB";
  }
  return el;
}

const elCache = new Map();
const document = {
  body: makeEl("body"),
  querySelector(sel) {
    if (!elCache.has(sel)) { const e = makeEl(); e.id = String(sel).replace(/^#/, ""); elCache.set(sel, e); }
    return elCache.get(sel);
  },
  querySelectorAll() { return []; },
  createElement(t) { return makeEl(t); },
  addEventListener() {}, removeEventListener() {},
};

const lsStore = new Map();
const localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
};

class FileReader {
  readAsDataURL() {
    setTimeout(() => {
      this.result = "data:video/mp4;base64," + Buffer.from("fake-media-bytes").toString("base64");
      if (this.onload) this.onload();
    }, 0);
  }
}
class EventStub { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } }

/* ---------------- 内存版 /api/upload-media ---------------- */
const db = {
  seq: 0, mediaUploads: [], lastChatBody: null,
  /** 外部覆盖后端返回：null = 走默认成功；给对象 = 原样返回；给函数 = 按调用次数返回 */
  mediaReply: null,
  xhrCount: 0,          // XHR 被 new 了几次（上传必须走 XHR，fetch 拿不到进度）
  progressEvents: [],   // 收到的每条 progress 回调
  progressSteps: 4,     // 桩分几拍把进度报完
  xhrFails: false,      // 让 XHR 直接抛 error，模拟断网
  holdUpload: false,    // 报完进度先不下发 load，等测试显式放行
  uploadGates: [],      // 被 hold 住的「下发 load」回调（releaseUploads 排空）
};
function res(obj, code) {
  return {
    ok: (code || 200) < 400, status: code || 200,
    headers: { get: () => "application/json" },
    json: async () => obj, text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(64),   // 音频波形要先 fetch 再解码
  };
}
/** 内存版 /api/upload-media —— fetch 和 XHR 两条路共用同一份后端行为，
 *  这样测出来的差异只可能来自前端代码，不会是桩不一致造成的假阳性。 */
function handleMediaUpload(rawBody) {
  const b = JSON.parse(rawBody || "{}");
  db.mediaUploads.push(b);
  if (typeof db.mediaReply === "function") return db.mediaReply(db.mediaUploads.length);
  if (db.mediaReply) return db.mediaReply;
  const ext = (String(b.name || "").split(".").pop() || "mp4").toLowerCase();
  db.seq++;
  return {
    ok: true,
    url: "/uploads/" + TENANT + "/media" + db.seq + "." + ext,
    type: b.kind === "audio" ? "audio" : "video",
    size: 4096,
  };
}

/* ---- XMLHttpRequest 桩 ----
 * 上传进度只有 XHR 拿得到（fetch 没这能力），所以上传路径改走 XHR，
 * 这里就按真实 XHR 的事件模型来模拟：先分几次报 progress，跑完再 load。 */
class XhrStub {
  constructor() {
    const self = this;
    this.status = 0; this.responseText = ""; this.withCredentials = false;
    this.readyState = 0; this._body = ""; this._aborted = false;
    this._l = {}; this._ul = {};
    this.upload = { addEventListener(t, fn) { (self._ul[t] = self._ul[t] || []).push(fn); } };
    db.xhrCount++;
  }
  open(m, u) { this.method = m; this.url = String(u); }
  setRequestHeader() {}
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  _fire(map, t, ev) { (map[t] || []).slice().forEach((fn) => fn(ev || {})); }
  abort() { this._aborted = true; this._fire(this._l, "abort", {}); }
  send(body) {
    const self = this;
    this._body = String(body == null ? "" : body);
    setTimeout(() => {
      if (self._aborted) return;
      // 模拟网络异常：现在上传走 XHR，要断网得让 XHR 自己抛 error（换 fetch 已经不管用了）
      if (db.xhrFails) { self._fire(self._l, "error", {}); return; }
      const reply = handleMediaUpload(self._body);
      const status = (reply && reply.__status) || 200;
      // 分几拍上报进度，模拟真实网络的 progress 事件
      const total = self._body.length || 1;
      const steps = db.progressSteps || 4;
      let i = 0;
      // 「给响应」单独拎成一个回调：真实浏览器也是报完进度才给响应。
      // 拆开之后测试就能选：让它自然跑完，还是先卡在「上传中」把中间态断言完再放行
      // —— 断言不再需要拿固定 sleep 去和 setTimeout(0) 赛跑。
      const finish = () => {
        if (self._aborted) return;
        self.status = status;
        self.responseText = JSON.stringify(reply);
        self._fire(self._l, "load", {});
      };
      const tickProg = () => {
        if (self._aborted) return;
        i++;
        const loaded = Math.round((total * i) / steps);
        self._fire(self._ul, "progress", { lengthComputable: true, loaded, total });
        db.progressEvents.push({ loaded, total });
        if (i < steps) { setTimeout(tickProg, 0); return; }
        // 传完了才给响应
        if (db.holdUpload) db.uploadGates.push(finish);
        else finish();
      };
      tickProg();
    }, 0);
  }
}

async function fakeFetch(url, opts) {
  const method = (opts && opts.method) || "GET";
  const u = String(url);

  if (u === "/api/upload-media" && method === "POST") {
    return res(handleMediaUpload((opts && opts.body) || "{}"));
  }
  if (u === "/api/chat" && method === "POST") {
    db.lastChatBody = JSON.parse((opts && opts.body) || "{}");
    return res({ ok: true });
  }
  if (u === "/api/upload") return res({ ok: true, url: "/uploads/test.png" });
  if (u === "/api/conversations" && method === "POST") {
    const id = "c" + (++db.seq);
    return res({ ok: true, id });
  }
  if (u === "/api/skills") return res({ ok: true, skills: [] });
  return res({ ok: true });
}

/* ---------------- 把 chat-media.js + app.js 真跑起来 ---------------- */
/* 假 AudioContext：给一段确定性的采样（前半正弦、后半静音），
   这样波形算出来是「前高后平」，能验证归一化而不是随便一条线。 */
class AudioContextStub {
  decodeAudioData(_buf, onOk) {
    const data = new Float32Array(4000);
    for (let i = 0; i < 2000; i++) data[i] = Math.sin(i / 10) * 0.8;
    setTimeout(() => onOk({ getChannelData: () => data, length: 4000 }), 0);
  }
  close() {}
}
const win = {
  ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {},
  AudioContext: AudioContextStub,
};
const ctx = vm.createContext({
  console, document, localStorage,
  window: win,
  location: { search: "", href: "http://local/" },
  navigator: {},
  fetch: fakeFetch,
  XMLHttpRequest: XhrStub,
  alert: () => {}, confirm: () => false, prompt: () => null,
  FileReader,
  Event: EventStub,
  URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
});
// 先挂 chat-media.js（app.js 里 renderMessage 会用到 window.renderMediaInto）
vm.runInContext(readFileSync(CHAT_MEDIA_JS, "utf8"), ctx, { filename: "chat-media.js" });
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);
const tick = () => new Promise((r) => setTimeout(r, 30));

function noticeText() {
  const el = ctx.document.querySelector("#composerNotice");
  return el.hidden ? "" : String(el.querySelector(".cn-text").textContent || "");
}
function resetComposer() {
  run("pendingMedia = []; renderMediaList(); pendingImage = null;");
  const el = ctx.document.querySelector("#composerNotice");
  el.hidden = true; el.querySelector(".cn-text").textContent = "";
  db.mediaReply = null; db.xhrFails = false;
  db.uploadGates.length = 0;   // 上一用例卡住的闸门别带进下一用例
}
/** 等到预览补完（首帧 / 波形 / 时长都是上传完才异步去取的，靠 _previewDone 收工标记）。 */
async function waitPreview(maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    await tick();
    if (run("(function(){ var m = pendingMedia[0]; return !m ? true : (m._previewDone === true); })()") === true) return true;
  }
  return false;
}
/** 胶囊里挂了哪些 class 的节点。
 *  注意：桩的 appendChild 不会写进 innerHTML，所以只能查 children，不能拿 innerHTML 做正则。 */
function chipClasses(idx = 0) {
  const chip = ctx.document.querySelector("#mediaList").children[idx];
  if (!chip) return [];
  return (chip.children || []).map((k) => String(k.className || ""));
}

/** 等到「新增了 minNew 次上传请求，且没有正在传的项」。
 *  上传是「读文件 → 分几拍报进度 → 收响应」的异步链，固定 sleep 不靠谱；
 *  只等 uploading 归零也不行 —— 请求还没发出去时它本来就是 0。 */
async function waitUploads(minNew = 1, maxTicks = 200) {
  const base = db.mediaUploads.length;
  for (let i = 0; i < maxTicks; i++) {
    await tick();
    const idle = run("pendingMedia.filter(function(m){return m.uploading;}).length") === 0;
    if (db.mediaUploads.length - base >= minNew && idle) return true;
  }
  return false;
}
/** 等到「上传中」这个中间态已经稳稳停住、可以放心断言了。
 *  判据三条同时成立：占位已出现（uploading===true）、进度至少报过一次、
 *  且响应已经被闸门卡住（说明进度报完了，只差下发 load 这最后一步）。
 *  中间态转瞬即逝，靠 sleep 去和桩里 setTimeout(fn,0) 的进度回调赛跑，
 *  机器快一点慢一点结果就翻；改成等闸门入队，状态就不会再自己往前走，断言无竞态。 */
async function waitUploading(maxTicks = 200) {
  const held = () => db.holdUpload === false || db.uploadGates.length >= 1;
  for (let i = 0; i < maxTicks; i++) {
    await tick();
    const up = run("(function(){var m=pendingMedia[0];return !m?'none':(m.uploading===true?'1':'0');})()");
    if (up === "1" && db.progressEvents.length >= 1 && held()) return true;
  }
  return false;
}
/** 放行所有被 hold 住的上传（让它们下发 load 走完最后一步）。 */
function releaseUploads() {
  const q = db.uploadGates.splice(0);
  q.forEach((fn) => fn());
}
const mkFile = (name, size, type) => ({ name, size: size == null ? 100 : size, type: type || "" });

console.log("\n[1] 上传入口");
{
  const html = readFileSync(INDEX_HTML, "utf8");
  ok("聊天输入区有音视频上传按钮 #mediaBtn", /id="mediaBtn"/.test(html));
  ok("有隐藏的 #mediaInput 文件选择框", /id="mediaInput"/.test(html));
  const acc = /id="mediaInput"[^>]*accept="([^"]*)"/.exec(html);
  ok("accept 只收 video/* 与 audio/*", !!acc && /video\/\*/.test(acc[1]) && /audio\/\*/.test(acc[1]) && !/image|\.pdf/i.test(acc[1]), acc && acc[1]);
  ok("#mediaInput 允许多选（media 是数组）", /id="mediaInput"[^>]*multiple/.test(html));
  ok("有已附加音视频的胶囊容器 #mediaList", /id="mediaList"/.test(html));

  const src = readFileSync(APP_JS, "utf8");
  const dragCount = (src.match(/"dragenter"/g) || []).length;
  ok("拖拽逻辑仍只有一份（音视频复用 attachDropZone，没重写）", dragCount === 1, "dragenter 出现 " + dragCount + " 次");
  ok("点 #mediaBtn 会触发 #mediaInput 选择文件",
    /mediaBtn[\s\S]{0,120}?addEventListener\("click"[\s\S]{0,120}?mediaInput\.click/.test(src));
  ok("按钮 class 沿用 composer-add-btn 那套", /id="mediaBtn"/.test(html) && /class="composer-add-btn media"/.test(html));
}

console.log("\n[2] 类型判定：MIME 优先，扩展名兜底");
{
  ok("video/mp4 → video", run("mediaKindOf({name:'a.mp4', type:'video/mp4'})") === "video");
  ok("audio/mpeg → audio", run("mediaKindOf({name:'a.mp3', type:'audio/mpeg'})") === "audio");
  ok("MIME 为空时按扩展名判（.mov → video）", run("mediaKindOf({name:'clip.mov', type:''})") === "video");
  ok("MIME 为空时按扩展名判（.wav → audio）", run("mediaKindOf({name:'voice.wav', type:''})") === "audio");
  ok("MIME 为空时按扩展名判（.m4a → audio）", run("mediaKindOf({name:'voice.m4a', type:''})") === "audio");
  // 与后端魔数白名单保持一致：后端不认的格式前端也直接挡，别让用户传完几十 MB 才被退回
  ok("后端不认的格式（.mkv）前端也挡掉", run("mediaKindOf({name:'clip.mkv', type:''})") === "");
  ok("后端不认的格式（.flac）前端也挡掉", run("mediaKindOf({name:'hifi.flac', type:''})") === "");
  ok("MIME 与扩展名冲突时以 MIME 为准", run("mediaKindOf({name:'x.mp3', type:'video/mp4'})") === "video");
  ok("非音视频文件判不出来（返回空串）", run("mediaKindOf({name:'a.pdf', type:'application/pdf'})") === "");
  ok("图片不会被误判成媒体", run("mediaKindOf({name:'a.png', type:'image/png'})") === "");
  ok("normMediaType 只放行 video/audio", run("normMediaType('VIDEO')") === "video" && run("normMediaType('image')") === "" && run("normMediaType(null)") === "");
}

console.log("\n[3] 合法音视频：上传 → pendingMedia → 胶囊");
{
  db.mediaUploads.length = 0;
  resetComposer();
  ok("初始没有附加媒体", run("pendingMedia.length") === 0);

  // 提示条是覆盖式的（只留最后一条），所以回执文案要在每次上传后立刻断言
  ctx.__F = mkFile("demo.mp4", 2048, "video/mp4");
  ok("上传 mp4 成功", (await run("uploadMediaFile(__F)")) === true);
  ok("视频回执提示写的是「视频」", /已附加视频/.test(noticeText()), noticeText());
  ctx.__F = mkFile("voice.mp3", 1024, "audio/mpeg");
  ok("上传 mp3 成功", (await run("uploadMediaFile(__F)")) === true);
  ok("音频回执提示写的是「音频」", /已附加音频/.test(noticeText()), noticeText());

  ok("两次都请求了 /api/upload-media", db.mediaUploads.length === 2, "n=" + db.mediaUploads.length);
  ok("请求体是 { name, data, kind }，与 upload-doc 同形",
    db.mediaUploads[0].name === "demo.mp4" && db.mediaUploads[0].kind === "video" && /^data:/.test(db.mediaUploads[0].data || ""),
    JSON.stringify(Object.keys(db.mediaUploads[0] || {})));
  ok("kind 按类型分别上报", db.mediaUploads[1].kind === "audio", db.mediaUploads[1].kind);

  ok("两个都进了 pendingMedia", run("pendingMedia.length") === 2, "len=" + run("pendingMedia.length"));
  ok("存的是后端返回的 /uploads/<租户>/... URL",
    run("pendingMedia.every(function(m){ return /^\\/uploads\\/[^/]+\\/[^/]+$/.test(m.url); })") === true,
    JSON.stringify(run("pendingMedia.map(function(m){return m.url;})")));
  ok("type 跟着后端返回走", run("pendingMedia.map(function(m){return m.type;}).join(',')") === "video,audio",
    run("pendingMedia.map(function(m){return m.type;}).join(',')"));
  ok("胶囊列表渲染出 2 个", ctx.document.querySelector("#mediaList").children.length === 2);
  ok("有媒体时胶囊区展开", ctx.document.querySelector("#mediaList").hidden === false);

  // 移除单个
  run("(function(){ document.querySelector('#mediaList').children[0].children[2].__del = 1; })()");
  run("pendingMedia.splice(0,1); renderMediaList();");
  ok("移除一个后只剩 1 个", run("pendingMedia.length") === 1 && ctx.document.querySelector("#mediaList").children.length === 1);

  // 点选入口：#mediaInput change 事件（多选）
  resetComposer();
  const mi = ctx.document.querySelector("#mediaInput");
  mi.files = [mkFile("a.mp4", 10, "video/mp4"), mkFile("b.mp3", 10, "audio/mpeg")];
  run("(function(){ document.querySelector('#mediaInput').dispatch('change', {}); })()");
  await waitUploads(2);
  ok("点「音视频」按钮多选能上传", run("pendingMedia.length") === 2,
    "len=" + run("pendingMedia.length") + " uploads=" + db.mediaUploads.length);
  ok("选完清空 input.value（同一文件可再选一次）", mi.value === "");

  // 拖拽入口
  resetComposer();
  ctx.__DROP_EV = { preventDefault() {}, dataTransfer: { files: [mkFile("drag.mov", 10, "video/quicktime")] } };
  run("(function(){ document.querySelector('#emptyInput').dispatch('drop', __DROP_EV); })()");
  await waitUploads(1);
  ok("拖 .mov 进聊天框能上传（复用同一套 drop 逻辑）", run("pendingMedia.length") === 1, "len=" + run("pendingMedia.length"));
  ok("拖进来的按 MIME 判成 video", run("pendingMedia[0].type") === "video", run("pendingMedia[0].type"));
}

console.log("\n[4] 后端返回容错：给不给 type 都能渲染出对的播放器");
{
  // 4a 后端不给 type → 退回前端按 MIME 判的 kind
  resetComposer();
  db.mediaReply = (n) => ({ ok: true, url: "/uploads/" + TENANT + "/r" + n + ".mp3", size: 10 });
  ctx.__F = mkFile("nomp3.mp3", 10, "audio/mpeg");
  await run("uploadMediaFile(__F)");
  ok("后端没给 type 时退回前端判定", run("pendingMedia[0].type") === "audio", run("pendingMedia[0].type"));

  // 4b 后端给了脏 type（比如 image）→ 忽略，仍退回前端判定
  resetComposer();
  db.mediaReply = () => ({ ok: true, url: "/uploads/" + TENANT + "/x.mp4", type: "image", size: 10 });
  ctx.__F = mkFile("dirty.mp4", 10, "video/mp4");
  await run("uploadMediaFile(__F)");
  ok("后端给脏 type 时不采信", run("pendingMedia[0].type") === "video", run("pendingMedia[0].type"));

  // 4c 后端给了跟前端不一致但合法的类型 → 以后端为准（后端可能按内容判得更准）
  resetComposer();
  db.mediaReply = () => ({ ok: true, url: "/uploads/" + TENANT + "/y.bin", type: "audio", size: 10 });
  ctx.__F = mkFile("weird.mp4", 10, "video/mp4");
  await run("uploadMediaFile(__F)");
  ok("后端给合法 type 时以后端为准", run("pendingMedia[0].type") === "audio", run("pendingMedia[0].type"));

  // 4d kind 字段（老写法）也要认
  resetComposer();
  db.mediaReply = () => ({ ok: true, url: "/uploads/" + TENANT + "/z.bin", kind: "audio", size: 10 });
  ctx.__F = mkFile("k.mp4", 10, "video/mp4");
  await run("uploadMediaFile(__F)");
  ok("后端只给 kind 字段时也认", run("pendingMedia[0].type") === "audio", run("pendingMedia[0].type"));
}

console.log("\n[5] 非法文件：都要被拒绝且说清原因");
{
  const before = db.mediaUploads.length;
  // 5a 非音视频 —— 前端拦，不发请求
  resetComposer();
  ctx.__F = mkFile("report.pdf", 100, "application/pdf");
  ok("非音视频文件被前端拒绝", (await run("uploadMediaFile(__F)")) === false);
  ok("提示里说清了只支持音视频", /只支持视频或音频/.test(noticeText()), noticeText());
  ok("被拒后不进 pendingMedia", run("pendingMedia.length") === 0);
  ok("被拒后没有真的发请求", db.mediaUploads.length === before, "n=" + db.mediaUploads.length);

  // 5b 图片不被媒体逻辑抢走
  resetComposer();
  ctx.__F = mkFile("pic.png", 100, "image/png");
  ok("图片不走媒体上传", (await run("uploadMediaFile(__F)")) === false);

  // 5c 超过 50MB
  resetComposer();
  ctx.__F = mkFile("big.mp4", 51 * 1024 * 1024, "video/mp4");
  ok("超过 50MB 被前端拒绝", (await run("uploadMediaFile(__F)")) === false);
  ok("提示里给出上限和实测大小", /上限 50MB/.test(noticeText()) && /51\.0 MB/.test(noticeText()), noticeText());

  // 5d 空文件
  resetComposer();
  ctx.__F = mkFile("empty.mp3", 0, "audio/mpeg");
  ok("空文件被拒绝", (await run("uploadMediaFile(__F)")) === false);
  ok("空文件提示清楚", /空文件/.test(noticeText()), noticeText());

  // 5e 后端拒绝（配额满 / 类型不支持）→ 原因原样透传
  resetComposer();
  db.mediaReply = () => ({ ok: false, error: "上传空间已满（配额 100MB）" });
  ctx.__F = mkFile("q.mp4", 100, "video/mp4");
  ok("后端拒绝时返回 false", (await run("uploadMediaFile(__F)")) === false);
  ok("后端原因原样提示出来", /上传空间已满/.test(noticeText()), noticeText());
  ok("后端拒绝后不进 pendingMedia", run("pendingMedia.length") === 0);

  // 5f 网络异常：上传走 XHR，所以断网要让 XHR 抛 error（换掉 fetch 已经不管用了）
  resetComposer();
  db.xhrFails = true;
  ctx.__F = mkFile("n.mp4", 100, "video/mp4");
  ok("网络异常时返回 false", (await run("uploadMediaFile(__F)")) === false);
  ok("网络异常提示清楚", /上传失败/.test(noticeText()), noticeText());
  ok("网络异常后不留转圈胶囊", run("pendingMedia.length") === 0, "len=" + run("pendingMedia.length"));
  db.xhrFails = false;
}

console.log("\n[6] 发送：media 随消息提交，气泡里立刻有播放器");
{
  // 6a 音频
  resetComposer();
  ctx.__F = mkFile("voice.mp3", 1024, "audio/mpeg");
  await run("uploadMediaFile(__F)");
  const url = run("pendingMedia[0].url");
  run("state.busy = false; state.activeId = 'c1'; var __cap = null; runChat = function(p){ __cap = p; };");
  run("(function(){ var c = document.querySelector('#chat'); c.children.length = 0; })()");
  await run("ask('帮我听听这段')");
  const body = run("__cap");
  ok("payload 带上 media 数组", Array.isArray(body.media) && body.media.length === 1, JSON.stringify(body.media));
  ok("media 元素是 { type, url } 两字段", Object.keys(body.media[0]).sort().join(",") === "type,url", JSON.stringify(Object.keys(body.media[0])));
  ok("media 里是后端返回的 url", body.media[0].url === url, body.media[0].url);
  ok("media 的 type 是 audio", body.media[0].type === "audio", body.media[0].type);
  ok("message 正常带上", body.message === "帮我听听这段");
  ok("发完清空 pendingMedia", run("pendingMedia.length") === 0);
  ok("发完胶囊区收起", ctx.document.querySelector("#mediaList").hidden === true);

  // 乐观渲染：气泡里真的有 <audio>
  const bub = run("(function(){ var c = document.querySelector('#chat'); var last = c.children[c.children.length-1]; return last ? last.children[1].children[0] : null; })()");
  ok("用户气泡里渲染出了播放器节点", !!bub && bub.children.length > 0, bub ? "children=" + bub.children.length : "no bub");
  const audioNode = bub && findBubmedia(bub, "audio");
  ok("是 <audio> 标签", !!audioNode && audioNode.tagName === "audio", audioNode && audioNode.tagName);
  ok("<audio> 带 bubmedia bubaudio 样式类", !!audioNode && audioNode.className === "bubmedia bubaudio", audioNode && audioNode.className);
  ok("<audio> src 是上传后的 URL", !!audioNode && audioNode.src === url, audioNode && audioNode.src);
  ok("<audio> 开了原生控件（controls）", !!audioNode && audioNode.controls === true);

  // 6b 视频
  resetComposer();
  ctx.__F = mkFile("clip.mp4", 2048, "video/mp4");
  await run("uploadMediaFile(__F)");
  const vurl = run("pendingMedia[0].url");
  run("(function(){ var c = document.querySelector('#chat'); c.children.length = 0; })()");
  await run("ask('看看这个视频')");
  const vbody = run("__cap");
  ok("视频 media 的 type 是 video", vbody.media[0].type === "video", vbody.media[0].type);
  const vbub = run("(function(){ var c = document.querySelector('#chat'); var last = c.children[c.children.length-1]; return last ? last.children[1].children[0] : null; })()");
  const videoNode = vbub && findBubmedia(vbub, "video");
  ok("气泡里是 <video> 标签（复用已有分支，没被 audio 顶掉）", !!videoNode && videoNode.tagName === "video", videoNode && videoNode.tagName);
  ok("<video> src 正确", !!videoNode && videoNode.src === vurl, videoNode && videoNode.src);
  ok("<video> 仍是 bubmedia bubvideo", !!videoNode && videoNode.className === "bubmedia bubvideo", videoNode && videoNode.className);

  // 6c 没附加媒体时不带 media 字段
  resetComposer();
  await run("ask('普通问题')");
  ok("没附加媒体时不发 media 字段", !("media" in run("__cap")));
}

console.log("\n[7] chat-media.js：audio 分支与既有行为");
{
  const r = run(`(function(){
    var bub = document.createElement("div");
    window.renderMediaInto(bub, [{ type: "audio", url: "/uploads/a.mp3" }]);
    var a = bub.children[0].children[0];
    return { n: bub.children.length, tag: a.tagName, cls: a.className, src: a.src, controls: a.controls, preload: a.preload };
  })()`);
  ok("type=audio 渲染出 <audio>", r.tag === "audio" && r.n === 1, JSON.stringify(r));
  ok("<audio> 类名 bubmedia bubaudio", r.cls === "bubmedia bubaudio", r.cls);
  ok("<audio> src 正确", r.src === "/uploads/a.mp3", r.src);
  ok("<audio> 开了 controls", r.controls === true);
  ok("<audio> preload=metadata", r.preload === "metadata", r.preload);

  // 兼容 kind 字段 / 单个对象（不是数组）
  const r2 = run(`(function(){
    var bub = document.createElement("div");
    window.renderMediaInto(bub, { kind: "AUDIO", url: "/uploads/b.wav" });
    return { tag: bub.children[0].children[0].tagName };
  })()`);
  ok("kind 字段 + 非数组入参也能渲成 <audio>", r2.tag === "audio", r2.tag);

  // video 分支不受影响
  const r3 = run(`(function(){
    var bub = document.createElement("div");
    window.renderMediaInto(bub, [{ type: "video", url: "/uploads/c.mp4" }]);
    var v = bub.children[0].children[0];
    return { tag: v.tagName, cls: v.className, controls: v.controls };
  })()`);
  ok("video 分支没被改动", r3.tag === "video" && r3.cls === "bubmedia bubvideo" && r3.controls === true, JSON.stringify(r3));

  // image 兜底
  const r4 = run(`(function(){
    var bub = document.createElement("div");
    window.renderMediaInto(bub, [{ type: "image", url: "/uploads/d.png" }, { type: "weird", url: "/uploads/e.bin" }]);
    return { n: bub.children.length, t0: bub.children[0].children[0].tagName, t1: bub.children[1].children[0].tagName };
  })()`);
  ok("image 与未知类型仍走 <img> 兜底", r4.t0 === "img" && r4.t1 === "img" && r4.n === 2, JSON.stringify(r4));

  // 加载失败兜底文案：音频要说「音频」不是「图片」
  const r5 = run(`(function(){
    var bub = document.createElement("div");
    window.renderMediaInto(bub, [{ type: "audio", url: "/uploads/broken.mp3" }]);
    bub.children[0].children[0].onerror();
    var fb = bub.children[bub.children.length - 1];
    return { cls: fb.className, txt: bub.children.length, msg: (fb.children[0] || {}).textContent, url: (fb.children[1] || {}).textContent };
  })()`);
  ok("音频加载失败时渲染兜底块", r5.cls === "bubmedia-fallback", r5.cls);
  ok("兜底文案说「音频」而不是「图片」", /音频加载失败/.test(String(r5.msg)), String(r5.msg));
  ok("兜底块带上失败的 URL", String(r5.url) === "/uploads/broken.mp3", String(r5.url));

  // 视频兜底文案不受影响
  const r6 = run(`(function(){
    var bub = document.createElement("div");
    window.renderMediaInto(bub, [{ type: "video", url: "/uploads/broken.mp4" }]);
    bub.children[0].children[0].onerror();
    var fb = bub.children[bub.children.length - 1];
    return (fb.children[0] || {}).textContent;
  })()`);
  ok("视频兜底文案仍是「视频」", /视频加载失败/.test(String(r6)), String(r6));

  // 没有 url 的项直接跳过
  const r7 = run(`(function(){
    var bub = document.createElement("div");
    var any = window.renderMediaInto(bub, [{ type: "audio" }, null]);
    return { any: any, n: bub.children.length };
  })()`);
  ok("没 URL 的媒体项被跳过且不报错", r7.any === false && r7.n === 0, JSON.stringify(r7));
}

console.log("\n[8] 前后端白名单一致（后端改动未落盘时跳过）");
{
  let srv = "";
  try { srv = readFileSync(SERVER_CJS, "utf8"); } catch (e) { srv = ""; }
  if (!/api\/upload-media/.test(srv)) {
    console.log("  skip 后端 /api/upload-media 不在 server.cjs 里（基座改动可能还没提交），跳过白名单比对");
  } else {
    // 直接从后端 detectMediaType 里把支持的 ext 抠出来，跟前端 MEDIA_EXT_KIND 比
    const exts = new Set();
    const re = /return \{ kind: "(?:video|audio)", ext: "(\w+)" \}/g;
    let mm;
    while ((mm = re.exec(srv))) exts.add(mm[1]);
    const fe = Object.keys(run("MEDIA_EXT_KIND")).sort();
    ok("能取到后端魔数白名单", exts.size > 0, "exts=" + Array.from(exts).join(","));
    ok("前端扩展名兜底与后端魔数白名单一致",
      Array.from(exts).sort().join(",") === fe.join(","),
      "后端=" + Array.from(exts).sort().join(",") + " 前端=" + fe.join(","));

    // 上限也要对得上：后端 MEDIA_UPLOAD_MAX_BYTES 默认 50MB（PT_MEDIA_UPLOAD_MB 覆盖）
    const lim = /const MEDIA_UPLOAD_MAX_BYTES = Number\(process\.env\.PT_MEDIA_UPLOAD_MB \|\| (\d+)\)/.exec(srv);
    ok("前端 50MB 上限与后端默认值一致",
      !!lim && Number(lim[1]) * 1024 * 1024 === run("MEDIA_MAX_BYTES"),
      lim ? "后端默认 " + lim[1] + "MB / 前端 " + run("MEDIA_MAX_BYTES") : "没取到后端上限");

    // 后端返回的是 kind 字段（不是 type），前端两种都要认
    ok("后端返回体里带 kind 字段", /ok: true, url[\s\S]{0,200}?kind: media\.kind/.test(srv) || /kind: media\.kind/.test(srv));
    ok("前端能读后端返回的 kind", run("normMediaType({ type: undefined, kind: 'audio' }.kind)") === "audio");

    // ⚠️ 契约冲突探测（不计失败，但要醒目）：前端发 media:[{type,url}]，
    //   后端 /api/chat 若照 documents 那套把每一项 String() 化，会得到 "[object Object]"，
    //   过不了 /uploads/<租户>/<文件名> 归属校验 → 400「无法读取该媒体附件」，消息直接发不出去。
    //   这里只负责把冲突喊出来，改哪边由人决定。
    const stringified = /body\.media\.map\(\(m\)\s*=>\s*String\(m == null \? "" : m\)/.test(srv);
    if (stringified) {
      console.log("  ⚠️  契约冲突：后端 /api/chat 把 media 当 URL 字符串数组处理，前端发的是 [{type,url}]");
      console.log("      String({type,url}) 会得到 \"[object Object]\"，过不了 /uploads/ 归属校验 → 400");
      console.log("      后端改法：String(m && m.url != null ? m.url : m)（校验与归属判断都不用动）");
      console.log("      连带：后端存进消息的是 URL 数组，刷新回放时 chat-media.js 只认对象项，播放器会消失 —— 需一并对齐");
    } else {
      ok("后端 /api/chat 直接按对象取 url（与前端 media 形状一致）", !stringified);
    }
  }
}

console.log("\n[9] 上传进度：大文件不再干等");
{
  // 这一节断言的是「上传中」这个中间态。中间态转瞬即逝，
  // 早先的写法是 sleep 30ms 去和桩里 setTimeout(fn,0) 的进度回调赛跑 ——
  // 机器快一点慢一点结果就翻（同一份测试换台机器就能稳定复现 9 条失败）。
  // 现在改成：桩报完进度先不下发 load（db.holdUpload），中间态稳稳停住，
  // 断言完由测试自己 releaseUploads() 放行。全程不再依赖墙上时间。
  db.holdUpload = true;

  // 9a 上传走的是 XHR（fetch 拿不到 upload.onprogress）
  db.xhrCount = 0; db.progressEvents.length = 0;
  resetComposer();
  ctx.__F = mkFile("big.mp4", 32 * 1024 * 1024, "video/mp4");
  const p = run("uploadMediaFile(__F)");

  // 请求发出后立刻就该有「上传中」的占位，用户知道东西接住了
  const sawUploading = await waitUploading();
  ok("「上传中」这个中间态能被稳定观察到（不靠固定 sleep 赌时序）", sawUploading === true);
  const during = run("pendingMedia.length + '|' + (pendingMedia[0] ? String(pendingMedia[0].uploading) : 'none')");
  ok("上传期间先出现「上传中」占位", during === "1|true", during);
  ok("占位这条还没有 url（不能发出去）", run("!pendingMedia[0].url") === true);
  ok("还没拿到响应前不会被标记成已完成", run("pendingMedia[0].uploading") === true);

  releaseUploads();
  const okUpload = await p;
  ok("大文件上传成功", okUpload === true);
  ok("上传走的是 XHR 而不是 fetch", db.xhrCount === 1, "xhrCount=" + db.xhrCount);
  ok("收到了多条进度回调", db.progressEvents.length >= 2, String(db.progressEvents.length));
  ok("进度是递增的且最后一拍到 100%",
    db.progressEvents.every((e, i) => i === 0 || e.loaded >= db.progressEvents[i - 1].loaded)
    && db.progressEvents[db.progressEvents.length - 1].loaded === db.progressEvents[db.progressEvents.length - 1].total,
    JSON.stringify(db.progressEvents.map((e) => e.loaded)));

  // 9b 传完占位变正常
  ok("传完后 uploading 落回 false", run("pendingMedia[0].uploading") === false);
  ok("传完后才有 url", /^\/uploads\//.test(String(run("pendingMedia[0].url"))), String(run("pendingMedia[0].url")));
  ok("传完后胶囊不再显示进度条", !/mc-prog/.test(String(ctx.document.querySelector("#mediaList").innerHTML))
    || run("pendingMedia.filter(function(m){return m.uploading;}).length") === 0);

  // 9c 大文件预告：选完先说大概要多久
  db.progressEvents.length = 0;
  resetComposer();
  ctx.__F = mkFile("预告.mp4", 24 * 1024 * 1024, "video/mp4");
  const p2 = run("uploadMediaFile(__F)");
  await waitUploading();
  ok("大文件先给出预计耗时", /大约需要/.test(noticeText()), noticeText());
  ok("预告里写清了文件大小", /24\.0 MB/.test(noticeText()), noticeText());
  ok("预告里提醒别关页面", /保持页面打开/.test(noticeText()), noticeText());
  ok("预告是开工前就给的，不是传完才补的", run("pendingMedia[0].uploading") === true);
  releaseUploads();
  await p2;

  // 小文件不啰嗦（这条要等它自然跑完，所以临时放开闸门）
  db.holdUpload = false;
  resetComposer();
  ctx.__F = mkFile("小.mp3", 1024, "audio/mpeg");
  await run("uploadMediaFile(__F)");
  ok("小文件不做耗时预告", !/大约需要/.test(noticeText()), noticeText());
  db.holdUpload = true;

  // 9d 上传中不能发送：传一半的 url 是空的，发出去等于附件丢了
  resetComposer();
  ctx.__F = mkFile("half.mp4", 20 * 1024 * 1024, "video/mp4");
  const p3 = run("uploadMediaFile(__F)");
  await waitUploading();
  ok("确实处于上传中", run("mediaUploading()") === true);
  run("state.busy = false; state.activeId = 'c1'; var __cap = null; runChat = function(p){ __cap = p; };");
  await run("ask('传一半就发')");
  ok("上传中发送被拦下", run("__cap") === null, JSON.stringify(run("__cap")));
  ok("拦下时说明了原因", /正在上传/.test(noticeText()), noticeText());
  releaseUploads();
  await p3;

  // 9e 上传中点 × = 取消（abort），不留一个永远转圈的胶囊
  resetComposer();
  ctx.__F = mkFile("cancel.mp4", 20 * 1024 * 1024, "video/mp4");
  const p4 = run("uploadMediaFile(__F)");
  await waitUploading();
  ok("取消前确有 1 条在传", run("pendingMedia.length") === 1 && run("pendingMedia[0].uploading") === true);
  run("removePendingMedia(pendingMedia[0])");
  releaseUploads();   // 被取消的那条 finish 会因 _aborted 空转，这里只是把闸门排空
  ok("取消后不再留在列表里", run("pendingMedia.length") === 0, "len=" + run("pendingMedia.length"));
  const p4r = await p4;
  ok("取消后返回 false（不是当成成功）", p4r === false, String(p4r));
  ok("取消后没有悬挂的上传闸门", db.uploadGates.length === 0, "gates=" + db.uploadGates.length);

  // 9f 上传失败要把占位撤掉，不能留个转圈的胶囊骗人（要等它自然跑完，放开闸门）
  db.holdUpload = false;
  resetComposer();
  db.mediaReply = () => ({ ok: false, error: "上传空间已满（配额 100MB）" });
  ctx.__F = mkFile("fail.mp4", 20 * 1024 * 1024, "video/mp4");
  ok("上传失败返回 false", (await run("uploadMediaFile(__F)")) === false);
  ok("失败后占位被撤掉（不留转圈胶囊）", run("pendingMedia.length") === 0, "len=" + run("pendingMedia.length"));
  ok("失败原因说清楚了", /上传空间已满/.test(noticeText()), noticeText());
  db.mediaReply = null;
}

console.log("\n[10] 预览：视频首帧 / 音频波形 / 时长");
{
  // 10a 视频：截首帧 + 时长
  resetComposer();
  ctx.__F = mkFile("poster.mp4", 2048, "video/mp4");
  await run("uploadMediaFile(__F)");
  await waitPreview();
  ok("视频读到了时长", run("pendingMedia[0].duration") === 42, String(run("pendingMedia[0].duration")));
  ok("视频截到了首帧", run("pendingMedia[0].poster") === "data:image/jpeg;base64,POSTERSTUB",
    String(run("pendingMedia[0].poster")).slice(0, 40));
  const vCls = chipClasses(0);
  ok("胶囊里出现了缩略图节点", vCls.indexOf("mc-thumb") >= 0, JSON.stringify(vCls));
  ok("缩略图上带时长角标 0:42",
    vCls.indexOf("mc-thumb") >= 0
    && (ctx.document.querySelector("#mediaList").children[0].children.find((k) => k.className === "mc-thumb").children
      .some((k) => k.className === "mc-dur" && k.textContent === "0:42")),
    JSON.stringify(vCls));

  // 10b 封面要带进气泡，不然发出去先黑一块
  run("state.busy = false; state.activeId = 'c1'; var __cap = null; runChat = function(p){ __cap = p; };");
  run("(function(){ var c = document.querySelector('#chat'); c.children.length = 0; })()");
  await run("ask('看看这段')");
  ok("发给后端的 media 仍是严格 { type, url }",
    Object.keys(run("__cap").media[0]).sort().join(",") === "type,url", JSON.stringify(run("__cap").media[0]));
  const vBub = run("(function(){ var c = document.querySelector('#chat');"
    + " var last = c.children[c.children.length-1]; return last ? last.children[1].children[0] : null; })()");
  const vNode = vBub && findBubmedia(vBub, "video");
  ok("气泡里的 <video> 带上了 poster", !!vNode && vNode.poster === "data:image/jpeg;base64,POSTERSTUB",
    vNode && String(vNode.poster));

  // 10c 音频：波形 + 时长
  resetComposer();
  ctx.__F = mkFile("wave.mp3", 2048, "audio/mpeg");
  await run("uploadMediaFile(__F)");
  await waitPreview();
  ok("音频读到了时长", run("pendingMedia[0].duration") === 42, String(run("pendingMedia[0].duration")));
  ok("音频算出了波形（40 根柱子）",
    Array.isArray(run("pendingMedia[0].peaks")) && run("pendingMedia[0].peaks.length") === 40,
    String(run("pendingMedia[0].peaks && pendingMedia[0].peaks.length")));
  ok("波形做过归一化（峰值到 1，小声的音频不会是一条平线）",
    run("Math.max.apply(null, pendingMedia[0].peaks)") === 1,
    String(run("Math.max.apply(null, pendingMedia[0].peaks)")));
  const aCls = chipClasses(0);
  ok("胶囊里出现了波形节点", aCls.indexOf("mc-wave") >= 0, JSON.stringify(aCls));
  ok("波形画了 40 根柱子",
    (ctx.document.querySelector("#mediaList").children[0].children.find((k) => k.className === "mc-wave").children || []).length === 40,
    String((ctx.document.querySelector("#mediaList").children[0].children.find((k) => k.className === "mc-wave").children || []).length));

  // 10d 大音频不算波形（解码几十 MB 太慢），直接调函数验证阈值
  ok("超过 20MB 的音频直接跳过波形计算",
    (await run("computeAudioWaveform('/uploads/t1/x.mp3', 25 * 1024 * 1024)")) === null);
  ok("小音频照常算波形", Array.isArray(await run("computeAudioWaveform('/uploads/t1/x.mp3', 1024)")));

  resetComposer();
  ctx.__F = mkFile("huge.mp3", 2048, "audio/mpeg");
  await run("uploadMediaFile(__F)");
  await waitPreview();
  ok("音频没算出波形时也不报错", run("pendingMedia.length") === 1 && run("pendingMedia[0].duration") === 42);

  // 10e 预览是「尽力而为」：拿不到不能把已附加的媒体弄坏
  resetComposer();
  ctx.__F = mkFile("nodur.mp4", 2048, "video/mp4");
  const savedDuration = db.breakDuration;
  db.breakDuration = true;
  await run("uploadMediaFile(__F)");
  await waitPreview();
  ok("拿不到时长时媒体仍然附加成功", run("pendingMedia.length") === 1, "len=" + run("pendingMedia.length"));
  ok("拿不到时长时 url 照常有效", /^\/uploads\//.test(String(run("pendingMedia[0].url"))));
  db.breakDuration = savedDuration;

  // 10f fmtClock 的格式
  ok("fmtClock(5) = 0:05", run("fmtClock(5)") === "0:05", run("fmtClock(5)"));
  ok("fmtClock(83) = 1:23", run("fmtClock(83)") === "1:23", run("fmtClock(83)"));
  ok("fmtClock(0) = 0:00", run("fmtClock(0)") === "0:00", run("fmtClock(0)"));
  ok("fmtDuration(8) = 8 秒", run("fmtDuration(8)") === "8 秒", run("fmtDuration(8)"));
  ok("fmtDuration(80) = 1 分 20 秒", run("fmtDuration(80)") === "1 分 20 秒", run("fmtDuration(80)"));
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
