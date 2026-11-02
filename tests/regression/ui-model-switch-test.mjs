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
const ssStore = new Map();
const sessionStorage = { getItem: (k) => (ssStore.has(k) ? ssStore.get(k) : null), setItem: (k, v) => ssStore.set(k, String(v)), removeItem: (k) => ssStore.delete(k) };
const win = { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {}, open() {}, AudioContext: class { decodeAudioData(_b, okk) { setTimeout(() => okk({ getChannelData: () => new Float32Array(8), length: 8 }), 0); } close() {} }, FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:x"; if (this.onload) this.onload(); }, 0); } } };

/* 可控的 /api/models 响应 + 记录是否真的发了 /api/chat（守卫测试的关键证据） */
let modelsPayload = { ok: true, models: [], current: "AUTO", default: "AUTO", auto: "AUTO" };
let chatCalls = 0;
let chatResponse = { ok: true, status: 200, json: async () => ({ ok: true }) };
let modelSelectCalls = 0;
let modelFetchOverride = null;
let reasoningFetchOverride = null;
const fetchStub = async (url, opts) => {
  const u = String(url || "");
  if (u.startsWith("/api/models/reasoning")) return reasoningFetchOverride ? reasoningFetchOverride(u,opts) : {ok:true,json:async()=>({ok:true,efforts:[]})};
  if (u.indexOf("/api/models") >= 0 && modelFetchOverride) return modelFetchOverride(u, opts);
  if (u.indexOf("/api/models") >= 0 && (!opts || opts.method !== "POST")) return { ok: true, json: async () => modelsPayload };
  if (u.indexOf("/api/models") >= 0) { modelSelectCalls++; return { ok: true, json: async () => ({ ok: true, model: "x" }) }; }
  if (u.indexOf("/api/chat") >= 0) { chatCalls++; return { ...chatResponse, headers: { get: () => "application/json" } }; }
  return { ok: true, json: async () => ({}) };
};

const ctx = vm.createContext({
  console, document, localStorage, sessionStorage, window: win,
  location: { search: "", href: "http://local/" }, navigator: { userAgent: "node" },
  fetch: fetchStub,
  setTimeout, clearTimeout, setInterval: (fn, ms) => setInterval(() => {}, 1e9), clearInterval,
  Event: class { constructor(t, o) { Object.assign(this, o || {}); } },
  XMLHttpRequest: class { open() {} send() {} addEventListener() {} setRequestHeader() {} upload = { addEventListener() {} }; },
  AbortController, URL, URLSearchParams, Blob: class {}, FormData: class {}, Headers: class {},
  JSON, Math, Date, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error,
});

vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);

console.log("模型切换（B3）回归：");

/* ---------------- 1) loadModels：全量展示 + AUTO 置顶 + 状态显式 ---------------- */
console.log("\n[1] loadModels：AUTO 置顶 + 能力/runtime状态显式");
modelsPayload = {
  ok: true, auto: "AUTO", current: "AUTO", default: "AUTO",
  availability: { status: "available", modelIds: ["deepseek-v4-pro"] },
  models: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", chat: true, kind: "chat", capabilityStatus: "supported", runtimeStatus: "verified", availability: "present" },
    { id: "seedance-2.5", name: "Seedance 2.5", chat: false, kind: "video" },
    { id: "seedream-4.0", name: "Seedream 4.0", chat: false, kind: "image" },
    { id: "speech-02-tts", name: "Speech TTS", chat: false, kind: "audio" },
    { id: "unknown-chat", name: "Unknown Chat", chat: null, capabilityStatus: "unknown", runtimeStatus: "unadapted", availability: "present" },
    { id: "unadapted-chat", name: "Unadapted Chat", chat: true, capabilityStatus: "supported", runtimeStatus: "unadapted", availability: "present" },
    { id: "unverified-chat", name: "Unverified Chat", chat: true, capabilityStatus: "supported", runtimeStatus: "adapted_unverified", availability: "present" },
    { id: "removed-chat", name: "Removed Chat", chat: true, capabilityStatus: "supported", runtimeStatus: "verified", availability: "removed" },
  ],
  eligibility: { "unverified-chat": { ok: true, mode: "manual", verificationRequired: true } },
};
await run("loadModels()");
const sel = run('document.querySelector("#modelSelect")');
ok("渲染出 9 个选项（AUTO + 8 个模型）", sel.children.length === 9, "实际 " + sel.children.length);
ok("第一个是 AUTO", sel.children[0].value === "AUTO");
ok("AUTO 文案含「智能选模型」", (sel.children[0].textContent || "").indexOf("智能选模型") >= 0);
ok("AUTO 默认选中", sel.children[0].selected === true);
ok("对话模型不带不可聊天后缀", (sel.children[1].textContent || "").indexOf("不可聊天") < 0);
ok("视频模型标不支持聊天", (sel.children[2].textContent || "").indexOf("不支持聊天") >= 0 && sel.children[2].disabled === true);
ok("视频模型标了类型", (sel.children[2].textContent || "").indexOf("视频生成") >= 0);
ok("图片模型标了类型", (sel.children[3].textContent || "").indexOf("图片生成") >= 0);
ok("语音模型标了类型", (sel.children[4].textContent || "").indexOf("语音生成") >= 0);
ok("chat:null 显示能力未确认且禁用", (sel.children[5].textContent || "").includes("能力未确认") && sel.children[5].disabled === true);
ok("未适配模型标状态并禁用", (sel.children[6].textContent || "").includes("运行时未适配") && sel.children[6].disabled === true);
ok("已获手动资格的适配模型可首调", (sel.children[7].textContent || "").includes("可手动首调") && sel.children[7].disabled === false);
ok("removed 模型标下架并禁用", (sel.children[8].textContent || "").includes("已下架") && sel.children[8].disabled === true);
ok("modelCaps 记了 8 个模型", run("__modelCaps.size") === 8);
ok("modelCaps 里 seedance 不可聊", run('__modelCaps.get("seedance-2.5").chat') === false);
ok("modelCaps 里对话模型可聊", run('__modelCaps.get("deepseek-v4-pro").chat') === true);

/* ---------------- 1b) unknown catalog gives a useful cause and recovery path ---------------- */
const catalogNotice = run('catalogDiagnosticMessage({ state: "credential_unavailable", errorCode: "PT_KEY_MISSING" })');
ok("Key缺失诊断明确且不暴露凭据", catalogNotice.includes("尚未配置 PT API Key") && !catalogNotice.includes("fixture-secret"), catalogNotice);
const internalCatalogNotice = run('catalogDiagnosticMessage({ state: "internal_error", errorCode: "MODEL_CATALOG_INTERNAL_TYPE_ERROR" })');
ok("目录内部错误显示安全诊断码", internalCatalogNotice.includes("MODEL_CATALOG_INTERNAL_TYPE_ERROR") && !internalCatalogNotice.includes("fixture-secret"), internalCatalogNotice);
run('__modelCaps.set("glm-5", { chat: true, availability: "unknown", eligibilityCode: "AVAILABILITY_UNKNOWN" });');
run('document.querySelector("#modelSelect").value = "glm-5";');
run('modelContextReady = true;');
chatCalls = 0;
await run("runChat({ conversationId: 'c1', text: '你好' });");
const unknownNotice = run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent');
ok("目录状态unknown仍阻止请求并指向目录排障", chatCalls === 0 && unknownNotice.includes("目录同步状态"), unknownNotice);
modelsPayload = { ...modelsPayload, availability: { status: "available", modelIds: ["deepseek-v4-pro"] } };
await run("loadModels()");

/* ---------------- 2) currentModelChat ---------------- */
console.log("\n[2] currentModelChat 四种情况");
run('document.querySelector("#modelSelect").value = "AUTO";');
ok("AUTO -> 可聊", run("currentModelChat()") === true);
run('document.querySelector("#modelSelect").value = "deepseek-v4-pro";');
ok("已验证且可用的对话模型 -> 可聊", run("currentModelChat()") === true);
run('document.querySelector("#modelSelect").value = "seedance-2.5";');
ok("视频模型 -> 不可聊", run("currentModelChat()") === false);
run('document.querySelector("#modelSelect").value = "speech-02-tts";');
ok("语音模型 -> 不可聊", run("currentModelChat()") === false);
run('document.querySelector("#modelSelect").value = "unknown-chat";');
ok("chat:null -> 不可执行", run("currentModelChat()") === false);
run('document.querySelector("#modelSelect").value = "unverified-chat";');
ok("服务端准许手动首调的模型 -> 可聊", run("currentModelChat()") === true);
run('document.querySelector("#modelSelect").value = "没见过的模型";');
ok("目录中查不到的模型 fail-closed", run("currentModelChat()") === false);
ok("modelKindLabel", run('modelKindLabel("video")') === "视频生成" && run('modelKindLabel("image")') === "图片生成" && run('modelKindLabel("audio")') === "语音生成");

/* ---------------- 3) runChat 守卫：不可聊就不发 ---------------- */
console.log("\n[3] runChat 守卫：选中不可聊天模型时不发请求");
await run("state.busy = false;");
run('state.activeId = "c1";');
chatCalls = 0;
run('document.querySelector("#modelSelect").value = "seedance-2.5";');
await run("runChat({ conversationId: 'c1', text: '画只猫' });");
ok("不可聊天模型：没有发出 /api/chat", chatCalls === 0, "实际发了 " + chatCalls + " 次");
const notice = run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent');
ok("给出了明确不可执行提示", typeof notice === "string" && notice.indexOf("不可执行") >= 0, "提示内容：" + notice);

for (const id of ["unknown-chat", "unadapted-chat", "removed-chat"]) {
  run('document.querySelector("#modelSelect").value = ' + JSON.stringify(id) + ';');
  await run("runChat({ conversationId: 'c1', text: '你好' });");
}
ok("能力未知/运行时未验证/下架模型均不发 chat", chatCalls === 0, "实际发了 " + chatCalls + " 次");

chatCalls = 0;
run('document.querySelector("#modelSelect").value = "unverified-chat";');
await run("runChat({ conversationId: 'c1', text: '首次受控验证' });");
ok("已获手动首调资格的模型发出一次 /api/chat", chatCalls === 1, "实际 " + chatCalls);

chatCalls = 0;
run('document.querySelector("#modelSelect").value = "deepseek-v4-pro";');
await run("runChat({ conversationId: 'c1', text: '你好' });");
ok("对话模型正常放行（发了 /api/chat）", chatCalls === 1, "实际 " + chatCalls);
chatCalls = 0;
run('document.querySelector("#modelSelect").value = "AUTO";');
await run("runChat({ conversationId: 'c1', text: '你好' });");
ok("AUTO 正常放行", chatCalls === 1, "实际 " + chatCalls);

/* ---------------- 4) change 事件阻止无效手动选择 ---------------- */
console.log("\n[4] 切换模型时的提示与回退");
const selEl = run('document.querySelector("#modelSelect")');
run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent = "";');
selEl.value = "seedance-2.5";
await run('document.querySelector("#modelSelect").dispatchEvent({ type: "change" });');
await new Promise((r) => setTimeout(r, 10));
const n2 = run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent');
ok("选择生成类模型 -> 提示不可执行", typeof n2 === "string" && n2.indexOf("不可执行") >= 0, "提示内容：" + n2);
ok("无效模型选择未发送持久化请求", modelSelectCalls === 0, "实际 " + modelSelectCalls);
ok("无效模型选择恢复到 AUTO", selEl.value === "AUTO", "实际 " + selEl.value);

run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent = "占位";');
selEl.value = "deepseek-v4-pro";
await run('document.querySelector("#modelSelect").dispatchEvent({ type: "change" });');
await new Promise((r) => setTimeout(r, 10));
ok("切回对话模型 -> 清掉提示", run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent') === "");

/* ---------------- 5) AUTO 无候选保留服务端真实错误，不切换模型 ---------------- */
console.log("\n[5] AUTO 无候选展示服务端错误");
run('document.querySelector("#modelSelect").value = "AUTO";');
chatResponse = { ok: false, status: 409, json: async () => ({ ok: false, code: "NO_ELIGIBLE_MODEL", error: "没有可用的聊天模型" }) };
await run("runChat({ conversationId: 'c1', text: '你好' });");
const sysErrors = run('Array.from(document.querySelector("#chat").children).map(x => x.textContent).filter(Boolean)');
ok("AUTO 无候选呈现服务端原始错误", sysErrors.some(x => x.includes("没有可用的聊天模型")), JSON.stringify(sysErrors));
ok("AUTO 错误后仍保持 AUTO", selEl.value === "AUTO", "实际 " + selEl.value);

/* ---------------- 6) conversation-scoped asynchronous responses ---------------- */
console.log("\n[6] 对话模型请求与异步回包隔离");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const modelResponse = current => ({ ok: true, json: async () => ({ ...modelsPayload, current }) });
const pendingA = deferred(), pendingB = deferred(); const modelRequests = [];
modelFetchOverride = (url) => { modelRequests.push(url); return url.includes('conversationId=race-a') ? pendingA.promise : pendingB.promise; };
run('state.activeId = "race-a";'); const loadA = run('loadModels()');
ok("模型未加载期间禁止发送", run('modelContextReady') === false && selEl.disabled === true);
run('state.activeId = "race-b";'); const loadB = run('loadModels()');
pendingB.resolve(modelResponse('deepseek-v4-pro')); await loadB;
pendingA.resolve(modelResponse('AUTO')); await loadA;
ok("GET携带所属对话ID", modelRequests.some(u => u.includes('conversationId=race-a')) && modelRequests.some(u => u.includes('conversationId=race-b')));
ok("A迟到响应不覆盖B模型", selEl.value === 'deepseek-v4-pro' && run('lastAcceptedModelSelection') === 'deepseek-v4-pro');

for (const outcome of ['success', 'failure']) {
  modelFetchOverride = null; run('state.activeId = "race-a";'); modelsPayload.current = 'AUTO'; await run('loadModels()');
  const selection = deferred(); let submitted;
  modelFetchOverride = (url, opts) => { submitted = JSON.parse(opts.body); return selection.promise; };
  selEl.value = 'deepseek-v4-pro'; selEl.dispatchEvent({ type: 'change' });
  ok('POST绑定发起时的对话ID（' + outcome + '）', submitted?.conversationId === 'race-a' && submitted?.model === 'deepseek-v4-pro');
  const sentBeforeSelection = chatCalls;
  await run("runChat({ conversationId: 'race-a', text: 'must wait for model selection' });");
  ok('模型选择未持久化前禁止发送（' + outcome + '）', chatCalls === sentBeforeSelection);
  run('state.activeId = "race-b";'); modelFetchOverride = null; modelsPayload.current = 'AUTO'; await run('loadModels()');
  const before = run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent');
  selection.resolve({ ok: outcome === 'success', json: async () => outcome === 'success' ? { ok: true } : { ok: false, error: 'late A failure' } });
  await new Promise(r => setTimeout(r, 0));
  ok('A迟到' + outcome + '不污染B选择或提示', selEl.value === 'AUTO' && run('lastAcceptedModelSelection') === 'AUTO' && run('document.querySelector("#composerNotice").querySelector(".cn-text").textContent') === before);
}
modelFetchOverride = null;

modelFetchOverride=async()=>{throw new Error('network unavailable');};
await run('loadModels()');
ok('同步失败明确进入可重试状态',run('modelLoadFailed')===true&&run('modelContextReady')===false);
modelFetchOverride=null;
const beforeRetry=chatCalls;
await run("runChat({conversationId:state.activeId,text:'retry sync'});");
ok('发送可恢复目录但不会自动提交付费聊天',run('modelContextReady')===true&&run('modelLoadFailed')===false&&chatCalls===beforeRetry);

console.log("\n[7] 原生元数据推理档位与保存/回包隔离");
run('state.activeId="reasoning-a"; modelSelect.value="deepseek-v4-pro"; modelContextReady=true; reasoningEffort="high";');
reasoningFetchOverride=async()=>({ok:true,json:async()=>({ok:true,efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]})});
await run('loadReasoningOptions()');
const effortEl=document.querySelector('#reasoningSelect');
ok('仅显示原生档位并恢复已存偏好',!document.querySelector('#reasoningControl').hidden&&effortEl.options.length===3&&effortEl.value==='high');
const save=deferred();let effortBody;
modelFetchOverride=(url,opts)=>{effortBody=JSON.parse(opts.body);return save.promise;};
effortEl.value='low';effortEl.dispatchEvent({type:'change'});
ok('档位保存绑定当前会话与模型',effortBody?.conversationId==='reasoning-a'&&effortBody?.model==='deepseek-v4-pro'&&effortBody?.reasoningEffort==='low');
ok('档位未保存前阻止发送',run('modelContextReady')===false);
const beforeUnsent=chatCalls;
run('ta.value="retain pending message";');
await run('ask("retain pending message")');
ok('档位保存期间保留未发送文本',run('ta.value')==='retain pending message'&&chatCalls===beforeUnsent);

save.resolve({ok:true,json:async()=>({ok:true,reasoningEffort:'low'})});await new Promise(r=>setTimeout(r,0));
ok('保存成功后采用已确认档位',run('reasoningEffort')==='low'&&run('modelContextReady')===true);
modelFetchOverride=async()=>({ok:false,json:async()=>({ok:false})});
effortEl.value='high';effortEl.dispatchEvent({type:'change'});await new Promise(r=>setTimeout(r,0));
ok('保存失败保留已接受档位',run('reasoningEffort')==='low'&&effortEl.value==='low');
const late=deferred();reasoningFetchOverride=()=>late.promise;
const loading=run('loadReasoningOptions()');
run('state.activeId="reasoning-b"; modelSelect.value="AUTO"; reasoningEffort=null;');await run('loadReasoningOptions()');
late.resolve({ok:true,json:async()=>({ok:true,efforts:[{id:'high',name:'High'}]})});await loading;
ok('旧会话元数据晚到不污染新会话',document.querySelector('#reasoningControl').hidden&&run('reasoningEffort')===null);
reasoningFetchOverride=null;modelFetchOverride=null;

console.log("\n模型切换（B3）回归：" + pass + " 通过 / " + (pass + failures.length) + " 项");
if (failures.length) { console.log("失败项："); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
