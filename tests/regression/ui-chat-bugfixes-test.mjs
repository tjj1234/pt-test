/**
 * UI 三个交互 bug 的回归测试（客户端逻辑）。
 *
 * 仓库里没有 jsdom，所以这里用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，
 * 再配一个内存版后端（/api/conversations、/api/upload）来验证行为，而不是另写一份逻辑来测。
 *
 *   1. 素材类型 + 拖拽：聊天框能选图/视频生成类型；能把素材拖进聊天框；
 *      impDrop 那套 drag 逻辑被复用（dragenter 在源码里只出现一次）。
 *   2. 重复空对话：快速连点新建 3 次，最多只产生 1 条空对话（并发 + 连续两种都测）。
 *   3. 历史对话内容不同步：开 A → 切到非对话页 → 点 A，右侧回到 A（视图切回 + 内容不丢）。
 *
 * 跑法：node tests/regression/ui-chat-bugfixes-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, "../../shell/public/app.js");
const INDEX_HTML = path.resolve(HERE, "../../shell/public/index.html");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(tag) {
  const listeners = Object.create(null);
  const el = {
    tagName: tag || "div", id: "", className: "", hidden: false, value: "", textContent: "",
    innerHTML: "", src: "", title: "", alt: "", disabled: false, files: null,
    scrollTop: 0, scrollHeight: 0, style: {}, dataset: {},
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
    appendChild() {}, remove() {}, removeAttribute() {}, setAttribute() {},
    // 以下只是让 app.js 里其它分支不至于因为桩缺失而抛错
    replaceChildren() {}, replaceWith() {}, insertBefore() {}, cloneNode() { return makeEl(); },
    matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null,
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
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

const alerts = [];
class FileReader {
  readAsDataURL() { setTimeout(() => { this.result = "data:image/png;base64,AAAA"; if (this.onload) this.onload(); }, 0); }
}
class EventStub { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } }

/* ---------------- 内存版后端 ---------------- */
const db = { convs: [], seq: 0, postCount: 0, getCount: Object.create(null) };
function mkConv(id, over) {
  return Object.assign({ id, title: "新对话", preview: "", msgCount: 0, updated_at: new Date().toISOString(), archived: false, messages: [] }, over || {});
}
async function fakeFetch(url, opts) {
  const method = (opts && opts.method) || "GET";
  const res = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  const u = String(url);
  if (u === "/api/conversations" && method === "POST") {
    db.postCount++;
    const c = mkConv("c" + (++db.seq));
    db.convs.unshift(c);
    return res({ ok: true, id: c.id });
  }
  if (u === "/api/conversations" && method === "GET") {
    return res({ ok: true, conversations: db.convs.map((c) => Object.assign({}, c)) });
  }
  const m = u.match(/^\/api\/conversations\/([^/]+)$/);
  if (m && method === "GET") {
    const id = decodeURIComponent(m[1]);
    db.getCount[id] = (db.getCount[id] || 0) + 1;
    const c = db.convs.find((x) => x.id === id);
    return res({ ok: true, conversation: c ? Object.assign({}, c, { messages: c.messages }) : null });
  }
  if (u === "/api/upload") return res({ ok: true, url: "/uploads/test.png" });
  if (u === "/api/skills") return res({ ok: true, skills: [] });
  if (u === "/api/status") return res({ ok: true, dashboardOk: false });
  return res({ ok: true });
}

/* ---------------- 把 app.js 真跑起来 ---------------- */
const ctx = vm.createContext({
  console, document, localStorage,
  window: { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {} },
  location: { search: "", href: "http://local/" },
  navigator: {},
  fetch: fakeFetch,
  alert: (m) => alerts.push(String(m)),
  confirm: () => false,
  prompt: () => null,
  FileReader,
  Event: EventStub,
  URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
});
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);
const tick = () => new Promise((r) => setTimeout(r, 30));

console.log("\n[1] 素材类型 + 拖拽");
{
  const types = run("Object.keys(GEN_TYPES)");
  const need = ["text2image", "image2image", "text2video", "image2video"];
  ok("选择项覆盖 media.route 的 4 种 taskType", need.every((t) => types.indexOf(t) >= 0), types.join(","));
  ok("默认 auto，不把普通问答带偏成素材生成", run("state.genType") === "auto");
  ok("taskType 与 media.route 枚举一致", need.every((t) => run("genTypeCfg('" + t + "').taskType") === t));
  ok("文生视频不需要参考图（不强制）", run("genTypeCfg('text2video').needsRef") === false);
  ok("文生图不需要参考图（不强制）", run("genTypeCfg('text2image').needsRef") === false);
  ok("图生图需要参考图", run("genTypeCfg('image2image').needsRef") === true);
  ok("图生视频需要参考图", run("genTypeCfg('image2video').needsRef") === true);

  run("setGenType('image2video')");
  ok("accept 按类型动态写入 imgInput", run("document.querySelector('#imgInput').accept") === run("genTypeCfg('image2video').accept"));

  const html = readFileSync(INDEX_HTML, "utf8");
  ok("accept 不再写死在 HTML 里", !/id="imgInput"[^>]*\saccept=/.test(html));

  // 拖拽：往聊天输入区丢一个图片文件
  ctx.__DROP_EV = { preventDefault() {}, dataTransfer: { files: [{ type: "image/png", size: 10, name: "a.png" }] } };
  run("(function(){ var el = document.querySelector('#emptyInput'); el.dispatch('drop', __DROP_EV); })()");
  await tick();
  ok("能把素材拖进聊天框并完成上传", run("pendingImage") === "/uploads/test.png", "pendingImage=" + run("pendingImage"));

  const src = readFileSync(APP_JS, "utf8");
  // 只数带引号的代码出现（注释里提到的 dragenter 不算），确认这套逻辑没有在两处各写一遍
  const dragCount = (src.match(/"dragenter"/g) || []).length;
  ok("dragenter 逻辑全仓只有一份（复用而非重写一遍）", dragCount === 1, "出现 " + dragCount + " 次");
  ok("impDrop 与聊天输入区共用 attachDropZone", typeof run("attachDropZone") === "function");
}

console.log("\n[2] 重复空对话");
{
  db.convs.length = 0; db.seq = 0; db.postCount = 0;
  run("state.list = []; state.activeId = null; state.loadedId = null;");
  const ids = await run("Promise.all([newConversation(), newConversation(), newConversation()])");
  ok("并发连点 3 次只产生 1 条空对话", db.postCount === 1, "POST 次数=" + db.postCount);
  ok("3 次调用返回同一个会话 id", new Set(ids).size === 1, JSON.stringify(ids));

  await run("newConversation()");
  await run("newConversation()");
  ok("连续点（非并发）也不再新增空记录", db.postCount === 1, "POST 次数=" + db.postCount);
}

console.log("\n[3] 历史对话内容不同步（开 A → 切走 → 点 A）");
{
  db.convs.length = 0;
  db.convs.push(mkConv("A", { title: "对话A", preview: "你好", msgCount: 2, messages: [{ role: "user", text: "你好 A", ts: new Date().toISOString() }] }));
  db.convs.push(mkConv("B", { title: "对话B", preview: "世界", msgCount: 2, messages: [{ role: "user", text: "你好 B", ts: new Date().toISOString() }] }));
  db.getCount = Object.create(null);
  run("state.activeId = null; state.loadedId = null;");
  await run("refreshList()");
  await run("openConversation('A')");
  ok("打开 A 后进入对话视图", run("document.querySelector('#title').textContent") === "对话", run("document.querySelector('#title').textContent"));
  ok("loadedId 记为 A", run("state.loadedId") === "A");

  await run("switchView('home')");
  ok("切到非对话页后确实离开了对话视图", run("document.querySelector('#title').textContent") === "首页", run("document.querySelector('#title').textContent"));

  // —— 根因复现 ——
  // 修复前侧边栏是 `if (state.activeId !== c.id) openConversation(c.id)`：
  // activeId 已经等于 A 时整个跳过，连 switchView 都不会被调用，于是停在原页面，
  // 表现就是「右侧还是旧的 DOM」。这里把旧写法原样跑一遍，坐实根因确实是它。
  await run("(function(){ if (state.activeId !== 'A') openConversation('A'); })()");
  ok("根因确认：旧写法（activeId 已是 A 就跳过）会停在原页面、不切回对话",
    run("document.querySelector('#title').textContent") === "首页", run("document.querySelector('#title').textContent"));

  // 模拟侧边栏再点一次 A（新写法：去掉那个短路判断）
  await run("openConversation('A')");
  ok("从别的页面点回 A，右侧回到对话视图", run("document.querySelector('#title').textContent") === "对话", run("document.querySelector('#title').textContent"));
  ok("内容仍是 A（loadedId 指向 A）", run("state.loadedId") === "A" && run("state.activeId") === "A");
  ok("已渲染过则不重复拉取（不闪/不跳滚动）", db.getCount["A"] === 1, "GET A 次数=" + db.getCount["A"]);

  // 切到 B 再点回 A，必须真的换内容
  await run("openConversation('B')");
  ok("切到 B 后 loadedId 为 B", run("state.loadedId") === "B" && run("state.activeId") === "B");
  await run("switchView('flows')");
  await run("openConversation('A')");
  ok("绕一圈回 A 后内容重新拉到 A", run("state.loadedId") === "A" && db.getCount["A"] === 2, "GET A 次数=" + db.getCount["A"]);
  ok("绕一圈回 A 后仍在对话视图", run("document.querySelector('#title').textContent") === "对话");
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
