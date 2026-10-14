/**
 * 首字等待态「正在连接模型…」—— 回归测试（UI 任务包 · 任务4）。
 *
 * 覆盖 shell/public/app.js 的两处改动：
 *   1. thinking()：把写死的「思考中…」包进 <span class="think-label">，便于单独替换文案
 *   2. 顶层 showConnecting(t)：把该 label 文案切成「正在连接模型…」
 *   3. 没有 .think-label 时（非思考气泡 / 结构变化）静默跳过，不抛错
 *   4. 明确「不引入额外计时器或状态管理」：showConnecting 不调用 setInterval / setTimeout
 *
 * 背景：基座在请求一开始、还没真正拿到模型回复前，会先往 SSE 流里多发一帧
 *       {connecting:true}（对应连接池冷启动）。runChat 收到后调用 showConnecting(t)。
 *       一旦真正的 delta 开始流式返回，streamInto() 会整体替换掉气泡内容，
 *       提示自然消失 —— 连接快时用户就是一闪而过，不做额外处理。
 *
 * 与既有 ui-chat-* 测试同一套打法：「最小 DOM 桩 + vm」把真实 app.js 跑起来，
 * 直接调用顶层函数 thinking() / showConnecting()。
 * 注意：默认 DOM 桩的 innerHTML setter 会丢弃内容，本测试特意让它记录原始字符串，
 *       否则无法断言 span 结构（这是本用例唯一对桩做的增强）。
 *
 * 跑法：node tests/regression/ui-chat-connecting-label-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, "../../shell/public/app.js");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

/* ---------------- 最小 DOM 桩（仅够把真实 app.js 顶层初始化跑通） ---------------- */
function makeEl(tag) {
  const listeners = Object.create(null);
  const el = {
    tagName: tag || "div", id: "", className: "", hidden: false, value: "", textContent: "",
    src: "", title: "", alt: "", disabled: false, files: null, scrollTop: 0, scrollHeight: 0,
    style: {}, dataset: {}, accept: "", href: "",
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } } , contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {}, dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); return c; }, replaceChild(nw, old) { const i = el.children.indexOf(old); if (i >= 0) el.children.splice(i, 1, nw); else el.children.push(nw); return old; },
    remove() {}, removeAttribute() {}, setAttribute() {}, getAttribute() { return null; }, replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {}, cloneNode() { return makeEl(); }, matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null, querySelector() { return makeEl(); }, querySelectorAll() { return []; }, closest() { return null; }, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
  // 与既有测试唯一的差别：记录 innerHTML 原始字符串，好断言 thinking() 里 span 的结构。
  // 同时保留「赋空串清空子节点」的语义，避免影响 app.js 顶层初始化。
  Object.defineProperty(el, "innerHTML", {
    get() { return el._rawHTML || ""; },
    set(v) { el._rawHTML = String(v); if (v === "") el.children.length = 0; },
  });
  if (tag === "video" || tag === "audio") {
    el.duration = 42; el.currentTime = 0; el.crossOrigin = "";
    Object.defineProperty(el, "src", { configurable: true, get() { return this._src || ""; }, set(v) { this._src = v; } });
  }
  if (tag === "canvas") { el.getContext = () => ({ drawImage() {} }); el.toDataURL = () => "data:image/jpeg;base64,POSTERSTUB"; }
  return el;
}
const elCache = new Map();
const document = {
  body: makeEl("body"),
  querySelector(sel) { if (!elCache.has(sel)) { const e = makeEl(); e.id = String(sel).replace(/^#/, ""); elCache.set(sel, e); } return elCache.get(sel); },
  querySelectorAll() { return []; },
  createElement(t) { return makeEl(t); },
  addEventListener() {}, removeEventListener() {},
};
const lsStore = new Map();
const localStorage = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k) };
const win = { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {}, AudioContext: class { decodeAudioData(_b, okk) { setTimeout(() => okk({ getChannelData: () => new Float32Array(8), length: 8 }), 0); } close() {} }, FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:x"; if (this.onload) this.onload(); }, 0); } } };

/* 计时器 spy：任务4 明确要求「不引入额外计时器或状态管理」，这里直接锚定。 */
let intervalCalls = 0, timeoutCalls = 0;
const setIntervalSpy = (fn, ms) => { intervalCalls++; return setInterval(() => {}, 1e9); };
const setTimeoutSpy = (fn, ms) => { timeoutCalls++; return setTimeout(fn, ms); };

const ctx = vm.createContext({
  console, document, localStorage, window: win,
  location: { search: "", href: "http://local/" }, navigator: { userAgent: "node" },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
  setTimeout: setTimeoutSpy, clearTimeout, setInterval: setIntervalSpy, clearInterval,
  Event: class { constructor(t, o) { Object.assign(this, o || {}); } },
  XMLHttpRequest: class { open() {} send() {} addEventListener() {} setRequestHeader() {} upload = { addEventListener() {} }; },
  URL, URLSearchParams, Blob: class {}, FormData: class {}, Headers: class {},
  JSON, Math, Date, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error,
});

/* 把真实 app.js 跑进 vm；顶层函数 thinking / showConnecting 变成 ctx 全局，可直接调用。 */
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);

const CONNECTING_TEXT = "正在连接模型…";

console.log("[1] thinking()：思考气泡里的文案必须包进 span.think-label（才能被单独替换）");
const thinkEl = run("thinking()");
const html = thinkEl.innerHTML;
ok("气泡 HTML 含 <span class=\"think-label\">", html.indexOf('class="think-label"') >= 0, html);
ok("span 内初始文案是「思考中…」", /<span class="think-label">思考中…<\/span>/.test(html), html);
ok("气泡类名仍是 msg a（未破坏原有结构）", thinkEl.className === "msg a", thinkEl.className);
ok("HTML 仍含 typing 动画点（未破坏）", html.indexOf('class="typing"') >= 0, html);
ok("HTML 仍含 elapsed 计时位（未破坏，任务3 依赖它）", html.indexOf('class="elapsed"') >= 0, html);

console.log("\n[2] showConnecting(t)：把 label 文案切成「正在连接模型…」");
const label = makeEl("span");
const fakeT = { querySelector: (sel) => (sel === ".think-label" ? label : null) };
ctx.__fakeT = fakeT;
run("showConnecting(__fakeT)");
ok("label 文案变成「正在连接模型…」", label.textContent === CONNECTING_TEXT, label.textContent);

console.log("\n[3] 重复收到 connecting 帧：幂等，文案保持一致（不会叠加/串味）");
run("showConnecting(__fakeT)");
run("showConnecting(__fakeT)");
ok("多次调用后仍是同一句", label.textContent === CONNECTING_TEXT, label.textContent);

console.log("\n[4] 没有 .think-label 的气泡（结构变化 / 非思考气泡）：静默跳过，不抛错");
const noLabel = { querySelector: () => null };
ctx.__noLabel = noLabel;
let threw = false;
try { run("showConnecting(__noLabel)"); } catch (e) { threw = true; }
ok("querySelector 返回 null 时不抛错", threw === false);

console.log("\n[5] 明确不引入额外计时器/状态：showConnecting 不新建 interval，也不新建 timeout");
const i0 = intervalCalls, t0 = timeoutCalls;
run("showConnecting(__fakeT)");
ok("未调用 setInterval（不新增等待计时器）", intervalCalls === i0, "before=" + i0 + " after=" + intervalCalls);
ok("未调用 setTimeout（不新增延迟状态）", timeoutCalls === t0, "before=" + t0 + " after=" + timeoutCalls);

console.log("\n[6] 文案本身：友好、不含内部字段名/技术黑话");
ok("文案不含 connecting 原始字段", CONNECTING_TEXT.indexOf("connecting") < 0);
ok("文案不含 media_route 等内部工具名", !/media_route|progress|pool/.test(CONNECTING_TEXT));
ok("结尾是省略号（表示进行中）", CONNECTING_TEXT.endsWith("…"));

console.log("\n[7] 与任务1-3 共存：相关顶层 helper 都还在，未互相覆盖");
ok("mediaRouteStepMessage 仍存在", typeof run("mediaRouteStepMessage") === "function");
ok("formatElapsed 仍存在", typeof run("formatElapsed") === "function");
ok("showConnecting 已定义", typeof run("showConnecting") === "function");
ok("thinking 仍是函数", typeof run("thinking") === "function");

const total = pass + failures.length;
console.log("\n" + "-".repeat(56));
console.log(failures.length === 0
  ? "全部通过：" + pass + " 通过 / " + total + " 项"
  : "有失败：" + failures.length + " 失败 / " + total + " 项");
if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
