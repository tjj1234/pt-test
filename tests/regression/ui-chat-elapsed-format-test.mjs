/**
 * 超长等待计时器格式化 —— 回归测试。
 *
 * 覆盖 app.js 顶层函数 formatElapsed(sec)：
 *   - 60 秒以内          -> "已等待 N 秒"
 *   - 超过 60 秒（含）   -> "已等待 X分Y秒"（例如 712 秒 -> "已等待 11分52秒"）
 * 目的：视频生成真实要等 ~12 分钟，逐秒跳到「已等待 720 秒」看着像卡死；
 *       超过 1 分钟后换成「分+秒」更安心，也不容易误以为出问题。
 *
 * 用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，直接调用顶层函数 formatElapsed。
 *
 * 跑法：node tests/regression/ui-chat-elapsed-format-test.mjs
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
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {}, dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); return c; }, replaceChild(nw, old) { const i = el.children.indexOf(old); if (i >= 0) el.children.splice(i, 1, nw); else el.children.push(nw); return old; },
    remove() {}, removeAttribute() {}, setAttribute() {}, getAttribute() { return null; }, replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {}, cloneNode() { return makeEl(); }, matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null, querySelector() { return makeEl(); }, querySelectorAll() { return []; }, closest() { return null; }, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }, insertAdjacentHTML() {},
  };
  Object.defineProperty(el, "innerHTML", { get() { return ""; }, set(v) { if (v === "") el.children.length = 0; } });
  if (tag === "video" || tag === "audio") { el.duration = 42; el.currentTime = 0; el.crossOrigin = ""; Object.defineProperty(el, "src", { configurable: true, get() { return this._src || ""; }, set(v) { this._src = v; setTimeout(() => { el.dispatch("loadedmetadata", {}); el.dispatch("loadeddata", {}); if (tag === "video") setTimeout(() => el.dispatch("seeked", {}), 0); }, 0); } }); }
  if (tag === "canvas") { el.getContext = () => ({ drawImage() {} }); el.toDataURL = () => "data:image/jpeg;base64,POSTERSTUB"; }
  return el;
}
const elCache = new Map();
const document = { body: makeEl("body"), querySelector(sel) { if (!elCache.has(sel)) { const e = makeEl(); e.id = String(sel).replace(/^#/, ""); elCache.set(sel, e); } return elCache.get(sel); }, querySelectorAll() { return []; }, createElement(t) { return makeEl(t); }, addEventListener() {}, removeEventListener() {} };
const lsStore = new Map();
const localStorage = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k) };
const win = { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {}, AudioContext: class { decodeAudioData(_b, ok) { setTimeout(() => ok({ getChannelData: () => new Float32Array(8), length: 8 }), 0); } close() {} }, FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:x"; if (this.onload) this.onload(); }, 0); } } };
const ctx = vm.createContext({ console, document, localStorage, window: win, location: { search: "", href: "http://local/" }, navigator: { userAgent: "node" }, fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }), setTimeout, clearTimeout, setInterval, clearInterval, Event: class { constructor(t, o) { Object.assign(this, o || {}); } }, XMLHttpRequest: class { open() {} send() {} addEventListener() {} setRequestHeader() {} upload = { addEventListener() {} }; }, URL, URLSearchParams, Blob: class {}, FormData: class {}, Headers: class {}, JSON, Math, Date, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error });

vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);

console.log("[1] 60 秒以内 -> 『已等待 N 秒』");
ok("0 秒", run("formatElapsed(0)") === "已等待 0 秒");
ok("1 秒", run("formatElapsed(1)") === "已等待 1 秒");
ok("59 秒", run("formatElapsed(59)") === "已等待 59 秒");

console.log("\n[2] 恰好 60 秒 -> 切换为『分+秒』");
ok("60 秒 -> 已等待 1分0秒", run("formatElapsed(60)") === "已等待 1分0秒");

console.log("\n[3] 超过 60 秒 -> 『已等待 X分Y秒』");
ok("61 秒 -> 已等待 1分1秒", run("formatElapsed(61)") === "已等待 1分1秒");
ok("119 秒 -> 已等待 1分59秒", run("formatElapsed(119)") === "已等待 1分59秒");
ok("120 秒 -> 已等待 2分0秒", run("formatElapsed(120)") === "已等待 2分0秒");

console.log("\n[4] 视频真实时长量级（~12 分钟）-> 安心易读的『分+秒』");
ok("712 秒 -> 已等待 11分52秒", run("formatElapsed(712)") === "已等待 11分52秒");
ok("720 秒 -> 已等待 12分0秒", run("formatElapsed(720)") === "已等待 12分0秒");
ok("1272 秒 -> 已等待 21分12秒", run("formatElapsed(1272)") === "已等待 21分12秒");

console.log("\n[5] 格式正确：分位不含『秒』字样、秒位为 0-59、整串以『已等待』开头");
const big = run("formatElapsed(712)");
ok("以『已等待』开头", big.startsWith("已等待"), big);
ok("分位格式 X分", /^已等待 \d+分\d+秒$/.test(big), big);
const sec = Number(big.replace(/^已等待 \d+分(\d+)秒$/, "$1"));
ok("秒位在 0-59", sec >= 0 && sec <= 59, String(sec));

if (failures.length) { console.log("\n以下断言失败："); failures.forEach((f) => console.log("  - " + f)); }
console.log("\n结果： " + pass + " 通过, " + failures.length + " 失败");
process.exit(failures.length ? 1 : 0);
