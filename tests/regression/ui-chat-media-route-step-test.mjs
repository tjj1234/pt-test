/**
 * 生成类（图片 / 视频）等待态提示 —— 回归测试。
 *
 * 覆盖 app.js 中 media_route 工具调用「开始」步骤（phase=call）的友好提示逻辑：
 *   - text2image / image2image  -> 「🎨 正在生成图片…」
 *   - text2video / image2video  -> 「🎬 正在生成视频中，预计十几分钟，完成后会自动显示在这里，可以先去做别的」
 *   - 其他工具（如归因查询 attribution_query / ga_query）的「开始」步骤 -> 返回 null，走通用渲染（不美化）
 *   - media_route 的「结果」步骤（phase=result）-> 返回 null（不把"正在生成"重复显示在结果上）
 *   - 友好文案绝不暴露原始参数：断言返回值里不含 prompt 原文、不含图片 URL、不含内部工具名 media_route
 *
 * 用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，直接调用顶层函数 mediaRouteStepMessage。
 * 后端 progress 字段长期卡 30% 不可靠，本测试同时锚定「不做进度条」这一约定（只返回固定文案）。
 *
 * 跑法：node tests/regression/ui-chat-media-route-step-test.mjs
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
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); return c; },
    replaceChild(nw, old) { const i = el.children.indexOf(old); if (i >= 0) el.children.splice(i, 1, nw); else el.children.push(nw); return old; },
    remove() {}, removeAttribute() {}, setAttribute() {}, getAttribute() { return null; },
    replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {},
    cloneNode() { return makeEl(); }, matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null,
    querySelector() { return makeEl(); }, querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return ""; },
    set(v) { if (v === "") el.children.length = 0; },
  });
  if (tag === "video" || tag === "audio") {
    el.duration = 42; el.currentTime = 0; el.crossOrigin = "";
    Object.defineProperty(el, "src", {
      configurable: true,
      get() { return this._src || ""; },
      set(v) { this._src = v; setTimeout(() => { el.dispatch("loadedmetadata", {}); el.dispatch("loadeddata", {}); if (tag === "video") setTimeout(() => el.dispatch("seeked", {}), 0); }, 0); },
    });
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
const localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
};
const win = {
  ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {},
  AudioContext: class { decodeAudioData(_b, ok) { setTimeout(() => ok({ getChannelData: () => new Float32Array(8), length: 8 }), 0); } close() {} },
  FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:x"; if (this.onload) this.onload(); }, 0); } },
};
const ctx = vm.createContext({
  console, document, localStorage, window: win,
  location: { search: "", href: "http://local/" }, navigator: { userAgent: "node" },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  Event: class { constructor(t, o) { Object.assign(this, o || {}); } },
  XMLHttpRequest: class { open() {} send() {} addEventListener() {} setRequestHeader() {} upload = { addEventListener() {} }; },
  URL, URLSearchParams, Blob: class {}, FormData: class {}, Headers: class {},
  JSON, Math, Date, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error,
});

/* 把真实 app.js 跑进 vm；顶层函数 mediaRouteStepMessage 会变成 ctx 上的全局，可直接调用。 */
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);

const IMG = "🎨 正在生成图片…";
const VID = "🎬 正在生成视频中，预计十几分钟，完成后会自动显示在这里，可以先去做别的";

console.log("[1] media_route · text2image -> 图片友好提示");
ok("text2image 返回『正在生成图片』", run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{taskType:'text2image',prompt:'一只猫',inputImageUrl:'http://x/a.png'}})") === IMG);

console.log("\n[2] media_route · image2image -> 图片友好提示");
ok("image2image 返回『正在生成图片』", run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{taskType:'image2image',prompt:'改成油画',inputImageUrl:'http://x/a.png'}})") === IMG);

console.log("\n[3] media_route · text2video -> 视频友好提示（含预计时长）");
ok("text2video 返回『正在生成视频中，预计十几分钟…』", run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{taskType:'text2video',prompt:'海浪拍打礁石'}})") === VID);

console.log("\n[4] media_route · image2video -> 视频友好提示");
ok("image2video 返回『正在生成视频中，预计十几分钟…』", run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{taskType:'image2video',prompt:'让这张图动起来',inputImageUrl:'http://x/a.png'}})") === VID);

console.log("\n[5] 非 media_route 工具（归因查询等）-> 返回 null（走通用渲染，不被美化）");
ok("attribution_query 返回 null", run("mediaRouteStepMessage({name:'attribution_query',phase:'call',args:{query:'上周 ROI'}})") === null);
ok("ga_query 返回 null", run("mediaRouteStepMessage({name:'ga_query',phase:'call',args:{}})" ) === null);

console.log("\n[6] media_route 的『结果』步骤（phase=result）-> 返回 null（不在结果上重复显示『正在生成』）");
ok("media_route/result 返回 null", run("mediaRouteStepMessage({name:'media_route',phase:'result',args:{taskType:'text2video'},result:'/uploads/v.mp4'})") === null);

console.log("\n[7] media_route/phase=call 但缺 taskType -> 默认落到图片提示（不暴露原始参数）");
ok("缺 taskType 默认图片提示", run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{}})") === IMG);

console.log("\n[8] 友好文案绝不暴露内部信息（prompt 原文 / 图片 URL / 工具名）");
const vidMsg = run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{taskType:'text2video',prompt:'SECRET_PROMPT_XYZ',inputImageUrl:'https://secret.host/img.png'}})");
ok("视频文案不含 prompt 原文", !vidMsg.includes("SECRET_PROMPT_XYZ"), vidMsg);
ok("视频文案不含图片 URL", !vidMsg.includes("secret.host") && !vidMsg.includes("https://"), vidMsg);
ok("视频文案不含内部工具名 media_route", !vidMsg.toLowerCase().includes("media_route"), vidMsg);
const imgMsg = run("mediaRouteStepMessage({name:'media_route',phase:'call',args:{taskType:'text2image',prompt:'SECRET_PROMPT_ABC',inputImageUrl:'https://secret.host/i.png'}})");
ok("图片文案不含 prompt 原文", !imgMsg.includes("SECRET_PROMPT_ABC"), imgMsg);
ok("图片文案不含图片 URL", !imgMsg.includes("secret.host"), imgMsg);
ok("图片文案不含内部工具名 media_route", !imgMsg.toLowerCase().includes("media_route"), imgMsg);

if (failures.length) {
  console.log("\n以下断言失败：");
  failures.forEach((f) => console.log("  - " + f));
}
console.log("\n结果： " + pass + " 通过, " + failures.length + " 失败");
process.exit(failures.length ? 1 : 0);
