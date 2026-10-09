/* _u_media_accept.cjs — UI-对话媒体渲染 验收
 * 用最小 DOM shim 加载真实 chat-media.js，构造 mock 媒体消息，验证渲染结果。
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const REPO = __dirname; // 脚本位于仓库根，clone 到任意路径都能相对解析 shell/public/chat-media.js
const OUT = path.join(REPO, "_u_media_accept_result.txt");

/* ---- 最小 DOM shim ---- */
function makeNode(tag) {
  return {
    tagName: String(tag).toLowerCase(),
    className: "", src: "", controls: false, preload: "", alt: "", loading: "",
    style: {}, _children: [], _attrs: {}, _text: "",
    setAttribute(k, v) { this._attrs[k] = v; },
    appendChild(c) { this._children.push(c); return c; },
    replaceChild(newNode, oldNode) { const i = this._children.indexOf(oldNode); if (i >= 0) { this._children[i] = newNode; return newNode; } return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
const sandbox = {
  document: { createElement: makeNode },
  window: {},
  console,
  setTimeout,
};
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(REPO, "shell/public/chat-media.js"), "utf8");
vm.runInContext(code, sandbox);
const renderMediaInto = sandbox.window.renderMediaInto;

if (typeof renderMediaInto !== "function") {
  fs.writeFileSync(OUT, "FAIL: window.renderMediaInto 未定义\n", "utf8");
  process.exit(1);
}

let pass = 0, fail = 0;
const lines = [];
function check(name, cond) {
  if (cond) { pass++; lines.push("PASS " + name); }
  else { fail++; lines.push("FAIL " + name); }
}
const has = (bub, tag) => bub._children.some(c => c.tagName === tag);

/* 1. 单张图片 */
let bub = makeNode("div");
let ok = renderMediaInto(bub, { type: "image", url: "https://x/y.png" });
check("1.image 返回 true", ok === true);
check("1.1 生成 img 节点", has(bub, "img"));
let img = bub._children.find(c => c.tagName === "img");
check("1.2 img.src 正确", img && img.src === "https://x/y.png");
check("1.3 img 带 bubmedia 类", img && /bubmedia/.test(img.className) && !/bubimg/.test(img.className));
check("1.4 img.lazy", img && img.loading === "lazy");

/* 2. 单个视频 */
bub = makeNode("div");
ok = renderMediaInto(bub, { type: "video", url: "https://x/z.mp4" });
check("2.video 返回 true", ok === true);
check("2.1 生成 video 节点", has(bub, "video"));
let vid = bub._children.find(c => c.tagName === "video");
check("2.2 video.controls", vid && vid.controls === true);
check("2.3 video.src 正确", vid && vid.src === "https://x/z.mp4");
check("2.4 video 带 bubvideo 类", vid && /bubvideo/.test(vid.className));
check("2.5 video playsinline", vid && vid._attrs.playsinline !== undefined);

/* 3. 数组（混合图 + 视频） */
bub = makeNode("div");
ok = renderMediaInto(bub, [{ type: "image", url: "a.png" }, { type: "video", url: "b.mp4" }]);
check("3.array 返回 true", ok === true);
check("3.1 同时含 img 和 video", has(bub, "img") && has(bub, "video"));

/* 4. 字段名兼容：src / kind */
bub = makeNode("div");
renderMediaInto(bub, { kind: "video", src: "c.mp4" });
vid = bub._children.find(c => c.tagName === "video");
check("4.1 kind/src 兼容成 video", !!vid && vid.src === "c.mp4");
bub = makeNode("div");
renderMediaInto(bub, { src: "d.png" });   // 无 type，仅有 src
img = bub._children.find(c => c.tagName === "img");
check("4.2 无 type 仅靠 src 兜底成 img", !!img && img.src === "d.png");

/* 5. 空值 / 无媒体 */
bub = makeNode("div");
check("5.1 null 返回 false 且不渲染", renderMediaInto(bub, null) === false && bub._children.length === 0);
bub = makeNode("div");
check("5.2 空 url 跳过", renderMediaInto(bub, { type: "image", url: "" }) === false);
bub = makeNode("div");
check("5.3 非数组非对象返回 false", renderMediaInto(bub, "https://x/y.png") === false);

/* 6. 图片加载失败 → onerror 兜底替换破图标 */
bub = makeNode("div");
renderMediaInto(bub, { type: "image", url: "bad.png" });
let im2 = bub._children.find(c => c.tagName === "img");
check("6.1 img 已创建", !!im2);
if (im2 && typeof im2.onerror === "function") im2.onerror();
check("6.2 失败后生成兜底节点", bub._children.some(c => c.className && /bubmedia-fallback/.test(c.className)));
check("6.3 破图标已移除", !bub._children.some(c => c.tagName === "img"));
let fb6 = bub._children.find(c => c.className && /bubmedia-fallback/.test(c.className));
check("6.4 兜底文案含『图片加载失败』", fb6 && fb6._children.some(c => /图片加载失败/.test(c.textContent)));
check("6.5 兜底含失败 URL", fb6 && fb6._children.some(c => c.textContent === "bad.png"));

/* 7. 视频加载失败 → onerror 兜底 */
bub = makeNode("div");
renderMediaInto(bub, { type: "video", url: "bad.mp4" });
let vd2 = bub._children.find(c => c.tagName === "video");
check("7.1 video 已创建", !!vd2);
if (vd2 && typeof vd2.onerror === "function") vd2.onerror();
let fb7 = bub._children.find(c => c.className && /bubmedia-fallback/.test(c.className));
check("7.2 失败后生成兜底节点", !!fb7);
check("7.3 破视频已移除", !bub._children.some(c => c.tagName === "video"));
check("7.4 兜底文案含『视频加载失败』", fb7 && fb7._children.some(c => /视频加载失败/.test(c.textContent)));

const summary = `\n${pass} passed, ${fail} failed`;
lines.push(summary);
fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
process.exit(fail ? 1 : 0);
