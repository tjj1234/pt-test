/**
 * 生成类（图片 / 视频）等待态提示 —— 回归测试。
 *
 * 覆盖 app.js 中 media_route 工具调用步骤（开始 / 结束 / 失败）的友好化处理：
 *   - text2image / image2image  -> { text: "🎨 正在生成图片…" }
 *   - text2video / image2video  -> { text: "🎬 正在生成视频中，预计十几分钟，完成后会自动显示在这里，可以先去做别的" }
 *   - 失败步骤 isError          -> { text: "⚠️ 图片生成失败，可以重新试一次" } / "⚠️ 视频生成失败，可以重新试一次"
 *   - 成功结束步骤（isError:false）-> { skip: true }（渲染块据此不冒那行多余的「🔧 media_route」）
 *   - 其他工具（归因查询 attribution_query / ga_query）-> null（走通用渲染，不美化）
 *   - 友好文案绝不暴露原始参数：断言返回值里不含 prompt 原文、不含图片 URL、不含内部工具名 media_route
 *
 * 渲染块的三路分支（r.text / r.skip / 通用）由 app.js 直接实现，本测试通过 helper 的返回值契约锚定：
 *   r !== null && !r.skip -> 渲染 r.text；r === null -> 通用渲染；r.skip -> 不渲染（成功结束抑制）。
 *
 * ⚠️ 假 step 必须是真实链路的形状，不许臆造字段（曾经臆造的 phase 让测试全部假绿）：
 *   - 真实下发给前端的 step 里**没有 phase 字段** —— phase 只存在于基座进程内部的帧上，
 *     前端拿不到。判定「结束步骤」只能靠 isError：只有结束步骤会显式带上这个键（哪怕值是 false）。
 *   - 开始步骤：{ name, args }，且 args 是 **JSON 字符串**（基座把工具入参 stringify 后下发），
 *     不是对象 —— 直接 args.taskType 恒为 undefined，这就是为什么必须解析。
 *   - 结束步骤：{ name, result, isError } —— **不带 args**，所以失败文案要靠「上一次开始步骤
 *     记住的 taskType」才能区分图片/视频；测试里按真实顺序「先发开始、再发结束」构造。
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
const ERR_IMG = "⚠️ 图片生成失败，可以重新试一次";
const ERR_VID = "⚠️ 视频生成失败，可以重新试一次";

/* 真实链路下发给前端的 step 形状（照抄，不臆造）：
 *   开始：{ name, args }          —— args 是 **JSON 字符串**（基座 stringify 后下发）
 *   结束：{ name, result, isError } —— 结束步骤**不带 args**；isError 成功时也是 false
 * 通过 ctx 把对象送进 vm，省掉在源码字符串里转义 JSON 引号的麻烦。 */
function evalStep(step) { ctx.__step = step; return run("mediaRouteStepMessage(__step)"); }
const startStep = (taskType, extra) => ({ name: "media_route", args: JSON.stringify(Object.assign({ taskType: taskType }, extra || {})) });
const endStep = (isError, result) => ({ name: "media_route", result: result == null ? "/uploads/out.mp4" : result, isError: isError === true });

console.log("[0] 先锚定「假 step 就是真实格式」：不许再出现臆造的 phase 字段");
const probeStart = startStep("text2video");
const probeEnd = endStep(false);
ok("开始步骤没有 phase 键", !("phase" in probeStart), JSON.stringify(probeStart));
ok("开始步骤的 args 是 JSON 字符串", typeof probeStart.args === "string", typeof probeStart.args);
ok("结束步骤没有 phase 键", !("phase" in probeEnd), JSON.stringify(probeEnd));
ok("结束步骤不带 args", !("args" in probeEnd), JSON.stringify(probeEnd));
ok("结束步骤带 isError 键，成功时值是 false", "isError" in probeEnd && probeEnd.isError === false);

console.log("\n[1] media_route 开始 · text2image -> 图片友好提示");
ok("text2image 返回『正在生成图片』", evalStep(startStep("text2image", { prompt: "一只猫", inputImageUrl: "http://x/a.png" })).text === IMG);

console.log("\n[2] media_route 开始 · image2image -> 图片友好提示");
ok("image2image 返回『正在生成图片』", evalStep(startStep("image2image", { prompt: "改成油画", inputImageUrl: "http://x/a.png" })).text === IMG);

console.log("\n[3] media_route 开始 · text2video -> 视频友好提示（含预计时长）");
ok("text2video 返回『正在生成视频中，预计十几分钟…』", evalStep(startStep("text2video", { prompt: "海浪拍打礁石" })).text === VID);

console.log("\n[4] media_route 开始 · image2video -> 视频友好提示");
ok("image2video 返回『正在生成视频中，预计十几分钟…』", evalStep(startStep("image2video", { prompt: "让这张图动起来", inputImageUrl: "http://x/a.png" })).text === VID);

console.log("\n[5] 非 media_route 工具（归因查询等）-> 返回 null（走通用渲染，不被美化）");
ok("attribution_query 返回 null", evalStep({ name: "attribution_query", args: '{"query":"上周 ROI"}' }) === null);
ok("ga_query 返回 null", evalStep({ name: "ga_query", args: "{}" }) === null);

console.log("\n[6] media_route 成功结束（isError:false，不带 args）-> { skip:true }（渲染块据此不冒多余一行）");
evalStep(startStep("text2video"));                 // 真实顺序：先开始
ok("成功结束返回 { skip:true }", evalStep(endStep(false)).skip === true);

console.log("\n[7] 开始步骤拿不到 taskType -> 默认落到图片提示（不暴露原始参数）");
ok("args 是合法 JSON 但缺 taskType -> 图片提示", evalStep({ name: "media_route", args: "{}" }).text === IMG);
ok("args 不是合法 JSON -> 图片提示", evalStep({ name: "media_route", args: "这不是JSON" }).text === IMG);

console.log("\n[8] 友好文案绝不暴露内部信息（prompt 原文 / 图片 URL / 工具名 / 原始 JSON）");
const vidMsg = evalStep(startStep("text2video", { prompt: "SECRET_PROMPT_XYZ", inputImageUrl: "https://secret.host/img.png" })).text;
ok("视频文案不含 prompt 原文", !vidMsg.includes("SECRET_PROMPT_XYZ"), vidMsg);
ok("视频文案不含图片 URL", !vidMsg.includes("secret.host") && !vidMsg.includes("https://"), vidMsg);
ok("视频文案不含内部工具名 media_route", !vidMsg.toLowerCase().includes("media_route"), vidMsg);
ok("视频文案不含 args 原始 JSON 串", !vidMsg.includes("taskType") && !vidMsg.includes("{"), vidMsg);
const imgMsg = evalStep(startStep("text2image", { prompt: "SECRET_PROMPT_ABC", inputImageUrl: "https://secret.host/i.png" })).text;
ok("图片文案不含 prompt 原文", !imgMsg.includes("SECRET_PROMPT_ABC"), imgMsg);
ok("图片文案不含图片 URL", !imgMsg.includes("secret.host"), imgMsg);
ok("图片文案不含内部工具名 media_route", !imgMsg.toLowerCase().includes("media_route"), imgMsg);

console.log("\n[9] media_route 失败（图片类）-> 图片友好报错（真实顺序：先开始、后结束）");
evalStep(startStep("text2image"));                 // 开始步骤记住类型
ok("text2image 失败 -> 『图片生成失败，可以重新试一次』", evalStep(endStep(true, "生成失败")).text === ERR_IMG);
evalStep(startStep("image2image"));
ok("image2image 失败 -> 『图片生成失败，可以重新试一次』", evalStep(endStep(true, "生成失败")).text === ERR_IMG);

console.log("\n[10] media_route 失败（视频类）-> 视频友好报错");
evalStep(startStep("text2video"));
ok("text2video 失败 -> 『视频生成失败，可以重新试一次』", evalStep(endStep(true, "生成失败")).text === ERR_VID);
evalStep(startStep("image2video"));
ok("image2video 失败 -> 『视频生成失败，可以重新试一次』", evalStep(endStep(true, "生成失败")).text === ERR_VID);

console.log("\n[11] 失败文案绝不暴露内部信息");
evalStep(startStep("text2video", { prompt: "SECRET_PROMPT_ERR", inputImageUrl: "https://secret.host/e.png" }));
const errMsg = evalStep(endStep(true, "内部错误 SECRET_PROMPT_ERR")).text;
ok("失败文案不含 prompt 原文", !errMsg.includes("SECRET_PROMPT_ERR"), errMsg);
ok("失败文案不含图片 URL", !errMsg.includes("secret.host"), errMsg);
ok("失败文案不含内部工具名 media_route", !errMsg.toLowerCase().includes("media_route"), errMsg);
ok("失败文案明确是『视频生成失败』", errMsg.includes("视频生成失败"), errMsg);

console.log("\n[12] 关键回归：args 是字符串时必须也能识别（以前 args.taskType 恒 undefined，视频提示从未生效）");
ok("args 为 JSON 字符串 -> 能识别视频", evalStep({ name: "media_route", args: '{"taskType":"text2video"}' }).text === VID);
ok("args 为对象 -> 也能识别视频（兼容两种形状）", evalStep({ name: "media_route", args: { taskType: "text2video" } }).text === VID);
ok("args 为 JSON 字符串 -> 能识别图片", evalStep({ name: "media_route", args: '{"taskType":"text2image"}' }).text === IMG);

console.log("\n[13] 关键回归：结束步骤不带 args 时，靠上一次开始步骤记住的类型区分图文视频");
evalStep(startStep("text2video"));
ok("视频开始后失败 -> 视频报错", evalStep(endStep(true)).text === ERR_VID);
evalStep(startStep("text2image"));
ok("图片开始后失败 -> 图片报错", evalStep(endStep(true)).text === ERR_IMG);

if (failures.length) {
  console.log("\n以下断言失败：");
  failures.forEach((f) => console.log("  - " + f));
}
console.log("\n结果： " + pass + " 通过, " + failures.length + " 失败");
process.exit(failures.length ? 1 : 0);
