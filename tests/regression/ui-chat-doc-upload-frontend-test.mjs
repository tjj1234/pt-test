/**
 * 聊天输入区「文本文档上传」前端回归测试。
 *
 * 仓库没有 jsdom，所以还是用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，
 * 配一个内存版 /api/upload-doc（行为对齐基座 server.cjs：扩展名白名单 / 5MB / NUL 字节拒绝），
 * 验证的是真代码，不是另写一份逻辑。
 *
 * 覆盖：
 *   1. 入口：HTML 里有文档按钮 + accept 只收 .txt/.md/.csv；拖拽复用 attachDropZone（不重写）。
 *   2. 合法文件：点选 / 拖拽 .txt/.md/.csv 都能上传并挂到 pendingDocs。
 *   3. 非法文件：非文本扩展名、超限、内容含 NUL —— 前端或后端拒绝都要有清楚提示。
 *   4. 发送：documents 数组随消息提交，发完清空；图片路径不被文档逻辑抢走。
 *   5. 后端：跨租户 / 失效文档 URL 被明确拒绝（不再静默跳过）。
 *
 * 跑法：node tests/regression/ui-chat-doc-upload-frontend-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, "../../shell/public/app.js");
const INDEX_HTML = path.resolve(HERE, "../../shell/public/index.html");
const SERVER_CJS = path.resolve(HERE, "../../shell/server.cjs");
const TENANT = "t1";

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
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
    remove() {}, removeAttribute() {}, setAttribute() {},
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
let docContent = "hello";   // FileReader 读出来的文件内容，测试里可换成含 NUL 的二进制
class FileReader {
  readAsDataURL() {
    setTimeout(() => {
      this.result = "data:text/plain;base64," + Buffer.from(docContent, "utf8").toString("base64");
      if (this.onload) this.onload();
    }, 0);
  }
}
class EventStub { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } }

/* ---------------- 内存版后端（对齐 server.cjs 的 /api/upload-doc） ---------------- */
const db = { convs: [], seq: 0, docUploads: 0, lastChatBody: null };
function res(obj, code) {
  return {
    ok: (code || 200) < 400, status: code || 200,
    headers: { get: () => "application/json" },
    json: async () => obj, text: async () => JSON.stringify(obj),
  };
}
async function fakeFetch(url, opts) {
  const method = (opts && opts.method) || "GET";
  const u = String(url);

  if (u === "/api/upload-doc" && method === "POST") {
    const b = JSON.parse((opts && opts.body) || "{}");
    const name = String(b.name || "");
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (["txt", "md", "csv"].indexOf(ext) < 0) return res({ ok: false, error: "仅支持 .txt / .md / .csv 纯文本文档" }, 400);
    const dm = /base64,([\s\S]*)$/.exec(String(b.data || ""));
    const buf = Buffer.from(dm ? dm[1] : "", "base64");
    if (!buf.length) return res({ ok: false, error: "文档数据无效" }, 400);
    if (buf.length > 5 * 1024 * 1024) return res({ ok: false, error: "文档过大（单文件上限 5MB）" }, 400);
    if (buf.indexOf(0) >= 0) return res({ ok: false, error: "不是有效的纯文本文件" }, 400);  // 对齐 decodeTextBuffer：NUL 一律拒绝
    db.docUploads++;
    return res({ ok: true, url: "/uploads/" + TENANT + "/doc" + db.docUploads + "." + ext, name, size: buf.length, chars: buf.length });
  }
  if (u === "/api/chat" && method === "POST") {
    db.lastChatBody = JSON.parse((opts && opts.body) || "{}");
    return res({ ok: true });
  }
  if (u === "/api/upload") return res({ ok: true, url: "/uploads/test.png" });
  if (u === "/api/conversations" && method === "POST") {
    const id = "c" + (++db.seq);
    db.convs.unshift({ id, title: "新对话", preview: "", msgCount: 0, messages: [] });
    return res({ ok: true, id });
  }
  if (u === "/api/skills") return res({ ok: true, skills: [] });
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

/** 取当前提示条文案（没显示则返回空串）。 */
function noticeText() {
  const el = ctx.document.querySelector("#composerNotice");
  return el.hidden ? "" : String(el.querySelector(".cn-text").textContent || "");
}
function resetComposer() {
  run("pendingDocs = []; renderDocList(); pendingImage = null;");
  const el = ctx.document.querySelector("#composerNotice");
  el.hidden = true; el.querySelector(".cn-text").textContent = "";
  docContent = "hello";
}
const mkFile = (name, size, type) => ({ name, size: size == null ? 20 : size, type: type || "" });

console.log("\n[1] 上传入口与拖拽复用");
{
  const html = readFileSync(INDEX_HTML, "utf8");
  ok("聊天输入区有文档上传按钮 #docBtn", /id="docBtn"/.test(html));
  ok("有隐藏的 #docInput 文件选择框", /id="docInput"/.test(html));
  const acc = /id="docInput"[^>]*accept="([^"]*)"/.exec(html);
  ok("accept 只收 .txt/.md/.csv", !!acc && /\.txt/.test(acc[1]) && /\.md/.test(acc[1]) && /\.csv/.test(acc[1]) && !/image|\.pdf/i.test(acc[1]), acc && acc[1]);
  ok("#docInput 允许多选（documents 是数组）", /id="docInput"[^>]*multiple/.test(html));
  ok("有提示条容器 #composerNotice", /id="composerNotice"/.test(html));

  const src = readFileSync(APP_JS, "utf8");
  const dragCount = (src.match(/"dragenter"/g) || []).length;
  ok("拖拽逻辑仍只有一份（文档上传复用 attachDropZone，没重写）", dragCount === 1, "dragenter 出现 " + dragCount + " 次");
  ok("聊天输入区挂的是 handleComposerFile", /attachDropZone\(emptyInputEl,\s*handleComposerFile\)/.test(src));

  ok("客户端扩展名白名单与后端一致", run("Array.from(DOC_EXT_WHITELIST).sort().join(',')") === "csv,md,txt");
  ok("客户端上限与后端默认一致（5MB）", run("DOC_MAX_BYTES") === 5 * 1024 * 1024);
}

console.log("\n[2] 合法文档：点选 / 拖拽都能上传");
{
  resetComposer();
  ok("初始没有附加文档", run("pendingDocs.length") === 0);

  for (const nm of ["a.txt", "b.md", "c.csv"]) {
    ctx.__F = mkFile(nm, 30, "text/plain");
    const r = await run("uploadDocFile(__F)");
    ok("上传 " + nm + " 成功", r === true);
  }
  ok("三个文档都进了 pendingDocs", run("pendingDocs.length") === 3, "len=" + run("pendingDocs.length"));
  ok("存的是后端返回的 /uploads/<租户>/... URL",
    run("pendingDocs.every(function(d){ return /^\\/uploads\\/[^/]+\\/[^/]+$/.test(d.url); })") === true,
    JSON.stringify(run("pendingDocs.map(function(d){return d.url;})")));
  ok("上传成功后有回执提示", /已附加/.test(noticeText()), noticeText());
  ok("胶囊列表渲染出 3 个", ctx.document.querySelector("#docList").children.length === 3);

  // 拖拽入口：往 #emptyInput 丢一个 .txt
  resetComposer();
  ctx.__DROP_EV = { preventDefault() {}, dataTransfer: { files: [mkFile("dragged.txt", 40, "text/plain")] } };
  run("(function(){ document.querySelector('#emptyInput').dispatch('drop', __DROP_EV); })()");
  await tick();
  ok("拖拽 .txt 进聊天框能上传（复用同一套 drop 逻辑）", run("pendingDocs.length") === 1, "len=" + run("pendingDocs.length"));

  // 点选入口：#docInput change 事件
  resetComposer();
  const di = ctx.document.querySelector("#docInput");
  di.files = [mkFile("picked.md", 25, "text/markdown")];
  run("(function(){ document.querySelector('#docInput').dispatch('change', {}); })()");
  await tick();
  ok("点「文档」按钮选文件能上传", run("pendingDocs.length") === 1, "len=" + run("pendingDocs.length"));
  ok("选完清空 input.value（同一文件可再选一次）", di.value === "");
}

console.log("\n[3] 非法文件：都要被拒绝且说清原因");
{
  // 3a 扩展名不是 txt/md/csv —— 前端拦
  const uploadCountBefore = db.docUploads;
  resetComposer();
  ctx.__F = mkFile("report.pdf", 100, "application/pdf");
  ok("非文档扩展名被前端拒绝", (await run("uploadDocFile(__F)")) === false);
  ok("提示里说清了只支持哪几类", /只支持 \.txt \/ \.md \/ \.csv/.test(noticeText()), noticeText());
  ok("被拒后不进 pendingDocs", run("pendingDocs.length") === 0);
  ok("被拒后没有真的发请求", db.docUploads === uploadCountBefore, "docUploads=" + db.docUploads + " vs " + uploadCountBefore);

  // 3b 超过 5MB —— 前端拦
  resetComposer();
  ctx.__F = mkFile("big.txt", 6 * 1024 * 1024, "text/plain");
  ok("超过 5MB 被前端拒绝", (await run("uploadDocFile(__F)")) === false);
  ok("提示里给出上限和实测大小", /上限 5MB/.test(noticeText()) && /6\.0 MB/.test(noticeText()), noticeText());

  // 3c 空文件
  resetComposer();
  ctx.__F = mkFile("empty.txt", 0, "text/plain");
  ok("空文件被拒绝", (await run("uploadDocFile(__F)")) === false);
  ok("空文件提示清楚", /空文件/.test(noticeText()), noticeText());

  // 3d 扩展名合法但内容是二进制（含 NUL）—— 前端放行，后端拒绝，提示要透传
  resetComposer();
  docContent = "PK\u0000\u0003\u0004binary";   // 伪装成 .txt 的 zip 头
  ctx.__F = mkFile("fake.txt", 100, "text/plain");
  ok("伪装成 .txt 的二进制被后端拒绝", (await run("uploadDocFile(__F)")) === false);
  ok("后端原因原样提示出来", /不是有效的纯文本文件/.test(noticeText()), noticeText());
  ok("后端拒绝后不进 pendingDocs", run("pendingDocs.length") === 0);

  // 3e 拖拽进来的非文本文件，也要提示而不是静默
  resetComposer();
  ctx.__DROP_EV = { preventDefault() {}, dataTransfer: { files: [mkFile("x.exe", 10, "application/octet-stream")] } };
  run("(function(){ document.querySelector('#emptyInput').dispatch('drop', __DROP_EV); })()");
  await tick();
  ok("拖进来的非文本/非图片文件有提示", /都不是|只支持/.test(noticeText()), noticeText());
  ok("拖进来的非法文件不进 pendingDocs", run("pendingDocs.length") === 0);
  ok("也没被当成图片", run("pendingImage") === null);
}

console.log("\n[4] 发送：documents 随消息提交，发完清空");
{
  resetComposer();
  ctx.__F = mkFile("spec.md", 50, "text/markdown");
  await run("uploadDocFile(__F)");
  const urls = run("pendingDocs.map(function(d){return d.url;})");
  ok("上传后拿到 1 个 url", urls.length === 1);

  // 用桩替换 runChat，只截获 ask() 组装出来的 payload（避免真的走 SSE 流程）
  run("state.busy = false; state.activeId = 'c1'; var __cap = null; runChat = function(p){ __cap = p; };");
  await run("ask('这份文档说了什么？')");
  const body = run("__cap");
  ok("payload 带上 documents 数组", Array.isArray(body.documents) && body.documents.length === 1, JSON.stringify(body.documents));
  ok("documents 里是后端返回的 url（不是文件名/内容）", body.documents[0] === urls[0], body.documents[0]);
  ok("message 正常带上", body.message === "这份文档说了什么？");
  ok("发完清空 pendingDocs", run("pendingDocs.length") === 0);
  ok("发完胶囊区收起", ctx.document.querySelector("#docList").hidden === true);

  // 没附加文档时不应带 documents 字段
  resetComposer();
  await run("ask('普通问题')");
  ok("没附加文档时不发 documents 字段", !("documents" in run("__cap")));
}

console.log("\n[5] 图片路径不被文档逻辑抢走");
{
  resetComposer();
  ctx.__DROP_EV = { preventDefault() {}, dataTransfer: { files: [mkFile("ref.png", 100, "image/png")] } };
  run("(function(){ document.querySelector('#emptyInput').dispatch('drop', __DROP_EV); })()");
  await tick();
  ok("拖图片仍走图片上传", run("pendingImage") === "/uploads/test.png", String(run("pendingImage")));
  ok("拖图片不会进 pendingDocs", run("pendingDocs.length") === 0);
}

console.log("\n[6] 后端：跨租户 / 失效文档 URL 不再静默跳过");
{
  const srv = readFileSync(SERVER_CJS, "utf8");
  const guard = /for \(const d of documents\)[\s\S]{0,400}?无法读取该文档/.exec(srv);
  ok("/api/chat 里有 documents 归属校验", !!guard);
  const before = srv.indexOf("无法读取该文档");
  const after = srv.indexOf("const um = { role: \"user\"");
  ok("校验发生在写入消息之前（拦得住）", before > 0 && after > 0 && before < after);

  // 直接取源码里那两个正则来验，测的是真代码不是抄一份
  const m1 = /const m = (\/.*\/)\.exec\(d\);/.exec(srv);
  const m2 = /!(\/.*\/)\.test\(m\[2\]\)/.exec(srv);
  ok("能取到路径校验正则", !!m1);
  ok("能取到文件名校验正则", !!m2);
  if (m1 && m2) {
    const pathRe = eval(m1[1]);   // eslint-disable-line no-eval
    const nameRe = eval(m2[1]);   // eslint-disable-line no-eval
    const own = pathRe.exec("/uploads/" + TENANT + "/abc123.txt");
    ok("本租户文档 URL 通过校验", !!own && own[1] === TENANT && nameRe.test(own[2]));
    const other = pathRe.exec("/uploads/t2/abc123.txt");
    ok("跨租户文档 URL 被判为不合法", !!other && other[1] !== TENANT);
    ok("路径穿越（../）被判为不合法", pathRe.exec("/uploads/" + TENANT + "/../etc/passwd") === null);
    ok("带文件名非法字符的 URL 被判为不合法", nameRe.test("a/b") === false);
  }
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
