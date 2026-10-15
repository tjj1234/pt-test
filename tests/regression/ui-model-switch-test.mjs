/**
 * 模型切换改造（B3 前端）—— 回归测试。
 *
 * 覆盖 shell/public/app.js：
 *   1. loadModels：AUTO 置顶、生成类模型在名字上标「不可聊天」、chat 标记记进 modelCaps
 *   2. currentModelChat：AUTO / 对话模型 / 生成类 / 未知 四种情况
 *   3. runChat 守卫：选中不可聊天模型时【拦下发送】，不给用户干等的错觉
 *   4. change 事件：选中生成类模型时明确提示
 *
 * 为什么要测「拦下发送」：PM 的验收原话是「不能让用户选了之后干等或者报错不知道为什么」。
 * 生成类模型（seedance / seedream / tts）拿去对话，后端会一直空转到超时 —— 用户只会看到
 * 转圈，不知道是自己选错了模型。所以前端必须在点发送前就拦住并说明原因。
 *
 * 与既有 ui-chat-* 测试同一套打法：「最小 DOM 桩 + vm」把真实 app.js 跑起来，
 * 直接调用顶层函数。
 *
 * 跑法：node tests/regression/ui-model-switch-test.mjs
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

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(tag) {
  const listeners = Object.create(null);
  const el = {
    tagName: tag || "div", id: "", className: "", hidden: false, value: "", textContent: "",
    src: "", title: "", alt: "", disabled: false, files: null, scrollTop: 0, scrollHeight: 0,
    style: {}, dataset: {}, accept: "", href: "", selected: false, _attrs: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {}, dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    dispatchEvent(ev) { (listeners[ev && ev.type] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); return c; }, replaceChild(nw, old) { const i = el.children.indexOf(old); if (i >= 0) el.children.splice(i, 1, nw); else el.children.push(nw); return old; },
    remove() {}, removeAttribute() {}, setAttribute(k, v) { el._attrs[k] = String(v); }, getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {}, cloneNode() { return makeEl(); }, matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null, querySelectorAll() { return []; }, closest() { return null; }, focus() {}, blur() {}, click() {},
    // 按选择器缓存子元素：composerNotice 把文案写进 .cn-text，测试要能读回来
    querySelector(sel2) { if (!el._q) el._q = new Map(); if (!el._q.has(sel2)) { const e = makeEl(); e.className = String(sel2).replace(/^\./, ""); el._q.set(sel2, e); } return el._q.get(sel2); },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._rawHTML || ""; },
    set(v) { el._rawHTML = String(v); if (v === "") el.children.length = 0; },
  });
  // <select> 需要 options / selectedIndex —— 比照原生行为用 children 模拟
  Object.defineProperty(el, "options", { get() { return el.children; } });
  Object.defineProperty(el, "selectedIndex", {
    get() { const i = el.children.findIndex((c) => c.selected); return i < 0 ? 0 : i; },
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
const win = { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {}, open() {}, AudioContext: class { decodeAudioData(_b, okk) { setTimeout(() => okk({ getChannelData: () => new Float32Array(8), length: 8 }), 0); } close() {} }, FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:x"; if (this.onload) this.onload(); }, 0); } } };

/* 可控的 /api/models 响应 + 记录是否真的发了 /api/chat（守卫测试的关键证据） */
let modelsPayload = { ok: true, models: [], current: "AUTO", default: "AUTO", auto: "AUTO" };
let chatCalls = 0;
const fetchStub = async (url, opts) => {
  const u = String(url || "");
  if (u.indexOf("/api/models") >= 0 && (!opts || opts.method !== "POST")) return { ok: true, json: async () => modelsPayload };
  if (u.indexOf("/api/models") >= 0) return { ok: true, json: async () => ({ ok: true, model: "x" }) };
  if (u.indexOf("/api/chat") >= 0) { chatCalls++; return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ ok: true }) }; }
  return { ok: true, json: async () => ({}) };
};

const ctx = vm.createContext({
  console, document, localStorage, window: win,
  location: { search: "", href: "http://local/" }, navigator: { userAgent: "node" },
  fetch: fetchStub,
  setTimeout, clearTimeout, setInterval: (fn, ms) => setInterval(() => {}, 1e9), clearInterval,
  Event: class { constructor(t, o) { Object.assign(this, o || {}); } },
  XMLHttpRequest: class { open() {} send() {} addEventListener() {} setRequestHeader() {} upload = { addEventListener() {} }; },
  URL, URLSearchParams, Blob: class {}, FormData: class {}, Headers: class {},
  JSON, Math, Date, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error,
});

vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);

console.log("模型切换（B3）回归：");

/* ---------------- 1) loadModels：全量展示 + AUTO 置顶 ---------------- */
console.log("\n[1] loadModels：AUTO 置顶 + 生成类标记");
modelsPayload = {
  ok: true, auto: "AUTO", current: "AUTO", default: "AUTO",
  models: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", chat: true, kind: "chat" },
    { id: "seedance-2.5", name: "Seedance 2.5", chat: false, kind: "video" },
    { id: "seedream-4.0", name: "Seedream 4.0", chat: false, kind: "image" },
    { id: "speech-02-tts", name: "Speech TTS", chat: false, kind: "audio" },
  ],
};
await run("loadModels()");
const sel = run('document.querySelector("#modelSelect")');
ok("渲染出 5 个选项（AUTO + 4 个模型）", sel.children.length === 5, "实际 " + sel.children.length);
ok("第一个是 AUTO", sel.children[0].value === "AUTO");
ok("AUTO 文案含「智能选模型」", (sel.children[0].textContent || "").indexOf("智能选模型") >= 0);
ok("AUTO 默认选中", sel.children[0].selected === true);
ok("对话模型不带不可聊天后缀", (sel.children[1].textContent || "").indexOf("不可聊天") < 0);
ok("视频模型标不可聊天", (sel.children[2].textContent || "").indexOf("不可聊天") >= 0);
ok("视频模型标了类型", (sel.children[2].textContent || "").indexOf("视频生成") >= 0);
ok("图片模型标了类型", (sel.children[3].textContent || "").indexOf("图片生成") >= 0);
ok("语音模型标了类型", (sel.children[4].textContent || "").indexOf("语音生成") >= 0);
ok("modelCaps 记了 4 个模型", run("__modelCaps.size") === 4);
ok("modelCaps 里 seedance 不可聊", run('__modelCaps.get("seedance-2.5").chat') === false);
ok("modelCaps 里对话模型可聊", run('__modelCaps.get("deepseek-v4-pro").chat') === true);

/* ---------------- 2) currentModelChat ---------------- */
console.log("\n[2] currentModelChat 四种情况");
run('document.querySelector("#modelSelect").value = "AUTO";');
ok("AUTO -> 可聊", run("currentModelChat()") === true);
run('document.querySelector("#modelSelect").value = "deepseek-v4-pro";');
ok("对话模型 -> 可聊", run("currentModelChat()") === true);
run('document.querySelector("#modelSelect").value = "seedance-2.5";');
ok("视频模型 -> 不可聊", run("currentModelChat()") === false);
run('document.querySelector("#modelSelect").value = "speech-02-tts";');
ok("语音模型 -> 不可聊", run("currentModelChat()") === false);
run('document.querySelector("#modelSelect").value = "没见过的模型";');
ok("查不到的模型按可聊处理（宁可放行也别误拦）", run("currentModelChat()") === true);
ok("modelKindLabel", run('modelKindLabel("video")') === "视频生成" && run('modelKindLabel("image")') === "图片生成" && run('modelKindLabel("audio")') === "语音生成");

/* ---------------- 3) runChat 守卫：不可聊就不发 ---------------- */
console.log("\n[3] runChat 守卫：选中不可聊天模型时不发请求");
await run("state.busy = false;");
chatCalls = 0;
run('document.querySelector("#modelSelect").value = "seedance-2.5";');
await run("runChat({ conversationId: 'c1', text: '画只猫' });");
ok("不可聊天模型：没有发出 /api/chat", chatCalls === 0, "实际发了 " + chatCalls + " 次");
const notice = run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent');
ok("给出了明确提示（说明不能聊天）", typeof notice === "string" && notice.indexOf("不能用于聊天") >= 0, "提示内容：" + notice);

chatCalls = 0;
run('document.querySelector("#modelSelect").value = "deepseek-v4-pro";');
await run("runChat({ conversationId: 'c1', text: '你好' });");
ok("对话模型正常放行（发了 /api/chat）", chatCalls === 1, "实际 " + chatCalls);
chatCalls = 0;
run('document.querySelector("#modelSelect").value = "AUTO";');
await run("runChat({ conversationId: 'c1', text: '你好' });");
ok("AUTO 正常放行", chatCalls === 1, "实际 " + chatCalls);

/* ---------------- 4) change 事件提示 ---------------- */
console.log("\n[4] 切换模型时的提示");
const selEl = run('document.querySelector("#modelSelect")');
run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent = "";');
selEl.value = "seedance-2.5";
await run('document.querySelector("#modelSelect").dispatchEvent({ type: "change" });');
await new Promise((r) => setTimeout(r, 10));
const n2 = run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent');
ok("选中生成类模型 -> 提示不可聊天", typeof n2 === "string" && n2.indexOf("不能用于聊天") >= 0, "提示内容：" + n2);

run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent = "占位";');
selEl.value = "deepseek-v4-pro";
await run('document.querySelector("#modelSelect").dispatchEvent({ type: "change" });');
await new Promise((r) => setTimeout(r, 10));
ok("切回对话模型 -> 清掉提示", run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent') === "");

console.log("\n模型切换（B3）回归：" + pass + " 通过 / " + (pass + failures.length) + " 项");
if (failures.length) { console.log("失败项："); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
