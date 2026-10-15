/**
 * 产出文件（artifact）收集 —— 回归测试（任务包 B · B2 后端部分）。
 *
 * 覆盖两个文件：
 *   1. shell/runtime/artifacts.cjs：类型判定、路径安全、目录扫描、Content-Type
 *   2. shell/runtime/dsh-adapter.cjs：从工具调用里认出「写了一个可预览文件」
 *
 * 为什么要测这些：
 *   · 目录扫描是「Agent 用 bash + python 生成 PDF」这类场景的唯一兜底 —— 工具调用帧认不出来时全靠它。
 *   · isSafeRel 是 /api/artifact 防目录穿越的第一道门（第二道是 realpath 前缀校验）。
 *     租户隔离的另一半在这里，测漏了就是越权读文件。
 *   · artifactFromToolStep 只是「提前量」，认错最多多弹一次面板，但绝不能因为抛错打断对话 ——
 *     所以各种畸形入参（null、截断 JSON、绝对路径、非写文件工具）都必须返回 null 而不是炸。
 *
 * 跑法：node tests/regression/artifacts-test.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const A = require("../../shell/runtime/artifacts.cjs");
const AD = require("../../shell/runtime/dsh-adapter.cjs");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

console.log("产出文件（artifact）回归：");

/* ---------------- 类型判定 ---------------- */
console.log("\n[1] artifactKind / isArtifactName");
ok("pdf", A.artifactKind("report.pdf") === "pdf");
ok("html", A.artifactKind("page.html") === "html");
ok("htm", A.artifactKind("page.htm") === "html");
ok("md", A.artifactKind("README.md") === "md");
ok("markdown", A.artifactKind("a.markdown") === "md");
ok("大写扩展名也认", A.artifactKind("REPORT.PDF") === "pdf");
ok("纯扩展名入参（.md）", A.artifactKind(".md") === "md");
ok("不支持的类型 -> null", A.artifactKind("a.txt") === null);
ok("图片/音视频不算产出（气泡里已能展示）", A.artifactKind("a.png") === null && A.artifactKind("a.mp4") === null);
ok("空值 -> null", A.artifactKind("") === null && A.artifactKind(null) === null);
ok("isArtifactName 与 kind 一致", A.isArtifactName("x.pdf") === true && A.isArtifactName("x.txt") === false);

/* ---------------- 路径安全（防目录穿越） ---------------- */
console.log("\n[2] isSafeRel：/api/artifact 的第一道门");
ok("普通相对路径放行", A.isSafeRel("report.pdf") === true);
ok("子目录放行", A.isSafeRel("out/sub/page.html") === true);
ok("../ 上跳拦截", A.isSafeRel("../other/a.pdf") === false);
ok("内嵌 .. 拦截", A.isSafeRel("a/../../b.pdf") === false);
ok("绝对路径拦截", A.isSafeRel("/etc/passwd") === false);
ok("反斜杠绝对路径拦截", A.isSafeRel("\\windows\\a.md") === false);
ok("Windows 盘符拦截", A.isSafeRel("C:\\secret\\a.pdf") === false);
ok("C:/ 形式也拦", A.isSafeRel("C:/secret/a.pdf") === false);
ok("空串/超长拦截", A.isSafeRel("") === false && A.isSafeRel("a".repeat(2000)) === false);
ok("单字符 . 拦截", A.isSafeRel(".") === false);

/* ---------------- URL 与归一化 ---------------- */
console.log("\n[3] artifactUrlFor / normalizeArtifact");
ok("URL 是同源 /api/artifact", A.artifactUrlFor("report.pdf") === "/api/artifact?p=report.pdf");
ok("子目录斜杠被编码", A.artifactUrlFor("out/a b.pdf").indexOf("%2F") > 0);
const n1 = A.normalizeArtifact({ rel: "out/doc.md", size: 12, mtime: 5 });
ok("归一化补 kind", n1 && n1.kind === "md");
ok("归一化补 name", n1 && n1.name === "doc.md");
ok("归一化补 url", n1 && n1.url === "/api/artifact?p=out%2Fdoc.md");
ok("反斜杠路径统一成 /", A.normalizeArtifact({ rel: "out\\doc.md" }).rel === "out/doc.md");
ok("不安全路径 -> null", A.normalizeArtifact({ rel: "../x.md" }) === null);
ok("不可预览类型 -> null", A.normalizeArtifact({ rel: "a.txt" }) === null);
ok("缺 rel -> null", A.normalizeArtifact({}) === null && A.normalizeArtifact(null) === null);

/* ---------------- 排序 ---------------- */
console.log("\n[4] sortArtifacts：最新产出排最前");
const sorted = A.sortArtifacts([
  { rel: "old.md", mtime: 100 }, { rel: "new.md", mtime: 300 }, { rel: "mid.md", mtime: 200 },
]);
ok("按 mtime 倒序", sorted[0].rel === "new.md" && sorted[2].rel === "old.md");

/* ---------------- 真目录扫描 ---------------- */
console.log("\n[5] scanArtifacts：真实临时目录");
const ws = mkdtempSync(path.join(tmpdir(), "art-ws-"));
try {
  writeFileSync(path.join(ws, "report.pdf"), "x");
  mkdirSync(path.join(ws, "out"), { recursive: true });
  writeFileSync(path.join(ws, "out", "page.html"), "<h1>hi</h1>");
  writeFileSync(path.join(ws, "notes.md"), "# t");
  writeFileSync(path.join(ws, "ignore.txt"), "not artifact");
  mkdirSync(path.join(ws, "node_modules"), { recursive: true });
  writeFileSync(path.join(ws, "node_modules", "dep.pdf"), "x");   // 依赖目录必须跳过
  mkdirSync(path.join(ws, ".hidden"), { recursive: true });
  writeFileSync(path.join(ws, ".hidden", "h.pdf"), "x");           // 隐藏目录跳过

  const all = A.scanArtifacts(ws, {});
  const rels = all.map((a) => a.rel);
  ok("扫到 3 个产出", all.length === 3, "实际 " + all.length + " -> " + rels.join(","));
  ok("含 report.pdf", rels.includes("report.pdf"));
  ok("含子目录 out/page.html", rels.includes("out/page.html"));
  ok("含 notes.md", rels.includes("notes.md"));
  ok("跳过 .txt", !rels.includes("ignore.txt"));
  ok("跳过 node_modules", !rels.some((r) => r.indexOf("node_modules") >= 0));
  ok("跳过隐藏目录", !rels.some((r) => r.indexOf(".hidden") >= 0));
  ok("带 kind 与 url", all.every((a) => a.kind && a.url.indexOf("/api/artifact?p=") === 0));

  // sinceMs 过滤：把 report.pdf 的 mtime 调到过去，应该被筛掉
  const past = new Date(Date.now() - 60_000);
  utimesSync(path.join(ws, "report.pdf"), past, past);
  const recent = A.scanArtifacts(ws, { sinceMs: Date.now() - 10_000 });
  ok("sinceMs 过滤掉旧文件", !recent.some((a) => a.rel === "report.pdf"));

  // 深度限制
  let deep = path.join(ws, "d1");
  for (let i = 1; i <= 6; i++) { deep = path.join(deep, "d" + (i + 1)); }
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, "deep.md"), "x");
  const limited = A.scanArtifacts(ws, { maxDepth: 2 });
  ok("maxDepth 生效（深层文件不收）", !limited.some((a) => a.rel.indexOf("deep.md") >= 0));

  // 数量上限
  const many = A.scanArtifacts(ws, { maxFiles: 1 });
  ok("maxFiles 生效", many.length === 1);
} finally {
  rmSync(ws, { recursive: true, force: true });
}

/* ---------------- 兜底与 Content-Type ---------------- */
console.log("\n[6] collectArtifacts 兜底 / Content-Type");
ok("目录不存在 -> []", Array.isArray(A.collectArtifacts("/no/such/dir-xyz", 0)) && A.collectArtifacts("/no/such/dir-xyz", 0).length === 0);
ok("空入参 -> []", A.collectArtifacts("", 0).length === 0);
ok("pdf -> application/pdf", A.artifactContentType("a.pdf") === "application/pdf");
ok("html -> text/html", A.artifactContentType("a.html").indexOf("text/html") === 0);
ok("md -> text/markdown", A.artifactContentType("a.md").indexOf("text/markdown") === 0);

/* ---------------- dsh-adapter：从工具调用认产出 ---------------- */
console.log("\n[7] toolWroteFile / pathFromToolArgs");
ok("write_file 认", AD.toolWroteFile("write_file") === true);
ok("Write 认", AD.toolWroteFile("Write") === true);
ok("fs_write 认", AD.toolWroteFile("fs_write") === true);
ok("create_file 认", AD.toolWroteFile("create_file") === true);
ok("read_file 不认", AD.toolWroteFile("read_file") === false);
ok("media_route 不认", AD.toolWroteFile("media_route") === false);
ok("空值不认", AD.toolWroteFile("") === false && AD.toolWroteFile(null) === false);
ok("对象 args 取 path", AD.pathFromToolArgs({ path: "a.pdf" }) === "a.pdf");
ok("对象 args 取 file_path", AD.pathFromToolArgs({ file_path: "b.md" }) === "b.md");
ok("对象 args 取 filePath", AD.pathFromToolArgs({ filePath: "c.html" }) === "c.html");
ok("字符串 args（stringify 过）", AD.pathFromToolArgs(JSON.stringify({ path: "d.pdf" })) === "d.pdf");
ok("截断的字符串 args 靠正则兜底", AD.pathFromToolArgs('{"path":"cut.pdf","content":"很长') === "cut.pdf");
ok("无路径 -> null", AD.pathFromToolArgs({}) === null && AD.pathFromToolArgs(null) === null);

console.log("\n[8] artifactRelFromToolPath / artifactFromToolStep");
const WS = "/runtime/workspaces/t1";
ok("相对路径原样", AD.artifactRelFromToolPath(WS, "report.pdf") === "report.pdf");
ok("./ 前缀去掉", AD.artifactRelFromToolPath(WS, "./report.pdf") === "report.pdf");
ok("workspace 内绝对路径 -> 相对", AD.artifactRelFromToolPath(WS, WS + "/out/doc.md") === "out/doc.md");
ok("workspace 外绝对路径 -> 退化为文件名", AD.artifactRelFromToolPath(WS, "/tmp/x/notes.md") === "notes.md");
ok("穿越路径退化为文件名", AD.artifactRelFromToolPath(WS, "../../etc/a.pdf") === "a.pdf");
ok("不可预览 -> null", AD.artifactRelFromToolPath(WS, "a.txt") === null);

const s1 = AD.artifactFromToolStep({ name: "write_file", args: { path: "report.pdf" }, isError: false }, WS);
ok("write_file + pdf -> 产出", s1 && s1.kind === "pdf" && s1.rel === "report.pdf");
ok("产出带同源 url", s1 && s1.url === "/api/artifact?p=report.pdf");
const s2 = AD.artifactFromToolStep({ name: "Write", args: { file_path: "a/b/page.html" } }, WS);
ok("Write + html -> 产出", s2 && s2.kind === "html");
ok("失败的写文件不算产出", AD.artifactFromToolStep({ name: "write_file", args: { path: "x.pdf" }, isError: true }, WS) === null);
ok("非写工具不算产出", AD.artifactFromToolStep({ name: "media_route", args: { path: "x.pdf" } }, WS) === null);
ok("不可预览类型不算产出", AD.artifactFromToolStep({ name: "write_file", args: { path: "x.txt" } }, WS) === null);
ok("缺 args -> null", AD.artifactFromToolStep({ name: "write_file" }, WS) === null);
ok("null step -> null", AD.artifactFromToolStep(null, WS) === null);
ok("无 workspace 也不炸", AD.artifactFromToolStep({ name: "write_file", args: { path: "a.md" } }, "") !== undefined);

console.log("\n产出文件（artifact）回归：" + pass + " 通过 / " + (pass + failures.length) + " 项");
if (failures.length) { console.log("失败项："); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
