/**
 * 产出预览面板 —— 回归测试（任务包 B · B2 前端部分）。
 *
 * 覆盖 shell/public/app.js 里新增的：
 *   1. escapeHtml / safeHref：md 渲染的安全底座
 *   2. minimalMarkdown：标题、列表、代码块、引用、表格、行内标记
 *   3. 安全边界：裸 HTML 必须被转义成文本、javascript: 链接必须被丢弃
 *   4. pushArtifact / mergeArtifacts / artifactIcon：面板状态管理
 *   5. renderArtifactPane：pdf/html 走 iframe（HTML 禁脚本）、md 拉文本转 HTML
 *
 * 为什么重点测安全：md 是 Agent 写出来的内容。如果裸 HTML 不转义，
 * Agent 一句「在文档里写 <img src=x onerror=alert(1)>」就能在用户页面里执行脚本；
 * 链接同理 —— javascript: 必须挡掉。这两条是这个面板最不能破的底线。
 *
 * 与既有 ui-chat-* 测试同一套打法：「最小 DOM 桩 + vm」把真实 app.js 跑起来，
 * 直接调用顶层函数。
 *
 * 跑法：node tests/regression/ui-artifact-preview-test.mjs
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
    style: {}, dataset: {}, accept: "", href: "", _attrs: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {}, dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); return c; }, replaceChild(nw, old) { const i = el.children.indexOf(old); if (i >= 0) el.children.splice(i, 1, nw); else el.children.push(nw); return old; },
    remove() {}, removeAttribute() {}, setAttribute(k, v) { el._attrs[k] = String(v); }, getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {}, cloneNode() { return makeEl(); }, matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null, querySelector() { return makeEl(); }, querySelectorAll() { return []; }, closest() { return null; }, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
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
const win = { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {}, open() {}, AudioContext: class { decodeAudioData(_b, okk) { setTimeout(() => okk({ getChannelData: () => new Float32Array(8), length: 8 }), 0); } close() {} }, FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:x"; if (this.onload) this.onload(); }, 0); } } };

/* md 预览会 fetch 文件文本：桩里返回可控内容，并记录被请求的产出 URL。
   只记 /api/artifact —— app.js 顶层初始化还会 fetch 会话列表等，全记会把断言带偏。 */
let lastFetched = null;
let mdText = "# hi";
const fetchStub = async (url) => {
  if (String(url).indexOf("/api/artifact") >= 0) lastFetched = url;
  return { ok: true, text: async () => mdText, json: async () => ({}) };
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

console.log("产出预览面板回归：");

/* ---------------- escapeHtml / safeHref ---------------- */
console.log("\n[1] escapeHtml / safeHref");
ok("转义 <script>", run('escapeHtml("<script>alert(1)</script>")').indexOf("&lt;script&gt;") >= 0);
ok("转义引号", run('escapeHtml(\'a"b\\\'c\')').indexOf("&quot;") >= 0);
ok("转义 &", run('escapeHtml("a&b")') === "a&amp;b");
ok("null -> 空串", run("escapeHtml(null)") === "");
ok("http 链接放行", run('safeHref("https://a.com/x")') === "https://a.com/x");
ok("mailto 放行", run('safeHref("mailto:a@b.com")') !== null);
ok("相对路径放行", run('safeHref("/a/b.html")') === "/a/b.html");
ok("javascript: 拦截", run('safeHref("javascript:alert(1)")') === null);
ok("data: 拦截", run('safeHref("data:text/html,<script>x</script>")') === null);
ok("vbscript: 拦截", run('safeHref("vbscript:msgbox")') === null);
ok("空串 -> null", run('safeHref("")') === null);

/* ---------------- minimalMarkdown：语法 ---------------- */
console.log("\n[2] minimalMarkdown 语法");
ok("h1", run('minimalMarkdown("# 标题")') === "<h1>标题</h1>");
ok("h3", run('minimalMarkdown("### 小标题")') === "<h3>小标题</h3>");
ok("段落", run('minimalMarkdown("一句话")') === "<p>一句话</p>");
ok("无序列表", (() => { const h = run('minimalMarkdown("- a\\n- b")'); return h.indexOf("<ul>") === 0 && h.indexOf("<li>a</li>") > 0 && h.indexOf("<li>b</li>") > 0; })());
ok("有序列表", run('minimalMarkdown("1. 一\\n2. 二")').indexOf("<ol>") === 0);
ok("代码块", (() => { const h = run('minimalMarkdown("```js\\nlet a=1;\\n```")'); return h.indexOf("<pre><code") === 0 && h.indexOf("let a=1;") > 0 && h.indexOf("lang-js") > 0; })());
ok("行内代码", run('minimalMarkdown("用 `npm i` 装")').indexOf("<code>npm i</code>") > 0);
ok("粗体", run('minimalMarkdown("**加粗**")').indexOf("<strong>加粗</strong>") > 0);
ok("斜体", run('minimalMarkdown("这是 *斜体* 哦")').indexOf("<em>斜体</em>") > 0);
ok("引用", run('minimalMarkdown("> 引用一句")').indexOf("<blockquote>") === 0);
ok("分隔线", run('minimalMarkdown("---")') === "<hr>");
ok("表格", (() => { const h = run('minimalMarkdown("| a | b |\\n|---|---|\\n| 1 | 2 |")'); return h.indexOf("<table>") >= 0 && h.indexOf("<th>a</th>") > 0 && h.indexOf("<td>1</td>") > 0; })());
ok("链接（安全协议）", run('minimalMarkdown("[官网](https://a.com)")').indexOf('href="https://a.com"') > 0);
ok("链接带 noopener", run('minimalMarkdown("[官网](https://a.com)")').indexOf("noopener") > 0);
ok("空输入 -> 空串", run('minimalMarkdown("")') === "" && run("minimalMarkdown(null)") === "");
ok("CRLF 也吃得下", run('minimalMarkdown("# t\\r\\n\\r\\n正文")').indexOf("<h1>t</h1>") >= 0);

/* ---------------- 安全边界（最关键） ---------------- */
console.log("\n[3] 安全边界：裸 HTML 与危险链接");
const xss1 = run('minimalMarkdown("<script>alert(1)</script>")');
ok("裸 script 被转义成文本", xss1.indexOf("<script>") < 0 && xss1.indexOf("&lt;script&gt;") > 0);
const xss2 = run('minimalMarkdown("<img src=x onerror=alert(1)>")');
ok("img onerror 被转义", xss2.indexOf("<img") < 0 && xss2.indexOf("&lt;img") >= 0);
const xss3 = run('minimalMarkdown("[点我](javascript:alert(1))")');
ok("javascript: 链接被丢弃（只留文字）", xss3.indexOf("javascript:") < 0 && xss3.indexOf("点我") > 0);
ok("代码块里的 HTML 也被转义", run('minimalMarkdown("```\\n<script>x</script>\\n```")').indexOf("<script>") < 0);
ok("代码块里的 * 不被当强调", run('minimalMarkdown("`a*b*c`")').indexOf("<em>") < 0);

/* ---------------- 面板状态 ---------------- */
console.log("\n[4] pushArtifact / mergeArtifacts / artifactIcon");
ok("pdf 图标", run('artifactIcon("pdf")').length > 0);
ok("html 图标与 pdf 不同", run('artifactIcon("html")') !== run('artifactIcon("pdf")'));
ok("md 图标", run('artifactIcon("md")').length > 0);
run("artItems = []; artIndex = 0;");
run('pushArtifact({ rel: "a.pdf", kind: "pdf", url: "/api/artifact?p=a.pdf", name: "a.pdf" });');
ok("推入 1 个", run("artItems.length") === 1);
ok("索引归零", run("artIndex") === 0);
run('pushArtifact({ rel: "b.md", kind: "md", url: "/api/artifact?p=b.md", name: "b.md" });');
ok("新的排最前", run("artItems[0].rel") === "b.md" && run("artIndex") === 0);
run('pushArtifact({ rel: "b.md", kind: "md", url: "/api/artifact?p=b.md", name: "b.md(改)" });');
ok("同 rel 覆盖而非新增", run("artItems.length") === 2 && run('artItems[0].name') === "b.md(改)");
run('pushArtifact({ url: null }); pushArtifact(null); pushArtifact();');
ok("脏数据被忽略", run("artItems.length") === 2);
run('mergeArtifacts([{ rel: "c.html", kind: "html", url: "/api/artifact?p=c.html", name: "c.html" }, { rel: "b.md", kind: "md", url: "/api/artifact?p=b.md", name: "b.md" }]);');
ok("merge 并入新项", run("artItems.length") === 3);
ok("merge 去重", run("artItems.filter((x) => x.rel === 'b.md').length") === 1);
ok("merge 非数组不炸", (() => { try { run("mergeArtifacts(null); mergeArtifacts(undefined);"); return true; } catch (e) { return false; } })());

/* ---------------- 面板渲染 ---------------- */
console.log("\n[5] renderArtifactPane：iframe / md");
run("artItems = []; artIndex = 0;");
run('pushArtifact({ rel: "r.pdf", kind: "pdf", url: "/api/artifact?p=r.pdf", name: "r.pdf" });');
run("renderArtifactPane();");
ok("面板打开（hidden=false）", run('document.querySelector("#artPane").hidden') === false);
ok("标题显示文件名", run('document.querySelector("#artTitle").textContent') === "r.pdf");
ok("pdf 用 iframe", run('document.querySelector("#artBody").children[0].tagName') === "iframe");
ok("pdf iframe 指向产物 URL", run('document.querySelector("#artBody").children[0].src') === "/api/artifact?p=r.pdf");
ok("pdf 不给脚本能力", run('document.querySelector("#artBody").children[0].getAttribute("sandbox")') === "allow-same-origin");

run("artItems = []; artIndex = 0;");
run('pushArtifact({ rel: "p.html", kind: "html", url: "/api/artifact?p=p.html", name: "p.html" });');
run("renderArtifactPane();");
ok("html 也用 iframe", run('document.querySelector("#artBody").children[0].tagName') === "iframe");
ok("html 完全禁脚本（空 sandbox）", run('document.querySelector("#artBody").children[0].getAttribute("sandbox")') === "");

run("artItems = []; artIndex = 0;");
mdText = "# 报告\n\n正文 **加粗**";
run('pushArtifact({ rel: "d.md", kind: "md", url: "/api/artifact?p=d.md", name: "d.md" });');
run("renderArtifactPane();");
ok("md 先占位不阻塞", run('document.querySelector("#artBody").children[0].textContent') === "正在读取…");
await new Promise((r) => setTimeout(r, 10));
ok("md 拉的是产物 URL", lastFetched === "/api/artifact?p=d.md");
ok("md 渲染成 HTML", run('document.querySelector("#artBody").children[0].innerHTML').indexOf("<h1>") === 0);
ok("md 不走 iframe", run('document.querySelector("#artBody").children[0].tagName') === "div");

run("closeArtifactPane();");
ok("关闭后面板隐藏", run('document.querySelector("#artPane").hidden') === true);
ok("关闭后清空列表", run("artItems.length") === 0);

console.log("\n产出预览面板回归：" + pass + " 通过 / " + (pass + failures.length) + " 项");
if (failures.length) { console.log("失败项："); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
