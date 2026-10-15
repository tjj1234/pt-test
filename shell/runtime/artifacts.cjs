"use strict";
/**
 * 产出文件（artifact）收集 —— B2「生成 PDF/HTML + 左侧预览」的后端底座。
 *
 * 场景：Agent 在租户 workspace 里写文件（生成一份 PDF 报告、一个 HTML 页面、一份 md 文档），
 * 以前这些文件只有 Agent 自己知道路径，前端完全看不到，用户只能靠 Agent 在回复里口述
 * 「我给你生成了 /xxx/report.pdf」，还得自己去服务器上找。
 *
 * 这里做的事只有两件：
 *   1. 扫出本轮任务期间「新增或修改过」的可预览文件（pdf / html / htm / md / markdown）；
 *   2. 把它们整理成前端能直接用的形状（带 kind 和同源 URL）。
 *
 * 刻意不做的事：
 *   · 不依赖 Agent 主动上报。写文件的工具名各家不一（write_file / Write / fs_write…），
 *     而用 bash + python 生成 PDF 的情况根本不经过工具调用帧，所以这里以「扫描目录」为准，
 *     工具调用帧只作为「立刻先显示一个」的提前量（见 dsh-adapter.cjs 的 onArtifact）。
 *   · 不读文件内容、不解析 PDF、不做全文索引 —— 前端按 kind 自己去 /api/artifact 拉。
 *
 * 导出全是纯函数 / 只依赖 fs 的同步扫描，方便回归测试直接调用（无需起服务）。
 */
const fs = require("fs");
const path = require("path");

/** 可预览的扩展名。刻意不含图片/音视频 —— 那些气泡里已经能直接展示了，不抢预览面板。 */
const ARTIFACT_EXTS = [".pdf", ".html", ".htm", ".md", ".markdown"];

/** 扫描时整个跳过的目录：依赖目录 / 配置目录 / 上传目录，量大且不可能有人工产出。 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".dsh", ".workbuddy", ".cache", ".next",
  "dist", "build", "coverage", "_uploads", "__pycache__", ".venv", "venv",
]);

/** 扩展名 -> 展示类型；不可预览返回 null。入参可以是 "report.pdf" 也可以是 ".pdf"。 */
function artifactKind(nameOrExt) {
  const s = String(nameOrExt || "").toLowerCase();
  const dot = s.lastIndexOf(".");
  const ext = dot >= 0 ? s.slice(dot) : "." + s.replace(/^\.+/, "");
  if (ext === ".pdf") return "pdf";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".md" || ext === ".markdown") return "md";
  return null;
}

/** 这个文件名是不是可预览产物（不含目录判断）。 */
function isArtifactName(name) {
  return artifactKind(String(name || "")) !== null;
}

/**
 * 相对路径安全性：拒绝绝对路径、`..` 上跳、以及 Windows 盘符。
 * /api/artifact 用它挡目录穿越 —— 这是租户隔离之外第二道必须自己把住的门。
 */
function isSafeRel(rel) {
  const s = String(rel || "");
  if (!s || s.length > 1024) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return false;          // C:\... 或 C:/...
  if (s.charAt(0) === "/" || s.charAt(0) === "\\") return false; // 绝对路径
  const parts = s.split(/[\\/]+/);
  for (const p of parts) {
    if (p === ".." || p === ".") return false;
    if (p === "") return false;                          // 空段（双斜杠、尾部斜杠）
  }
  return true;
}

/** 相对路径 -> 前端可直接访问的同源 URL（租户校验由 /api/artifact 做）。 */
function artifactUrlFor(rel) {
  return "/api/artifact?p=" + encodeURIComponent(String(rel || "").split(path.sep).join("/"));
}

/** 补齐 kind / url / name 等展示字段；缺字段或类型不支持时返回 null。 */
function normalizeArtifact(a) {
  if (!a || !a.rel) return null;
  const rel = String(a.rel).split(path.sep).join("/");
  if (!isSafeRel(rel)) return null;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const kind = artifactKind(base);
  if (!kind) return null;
  return {
    name: a.name || base,
    rel,
    kind,
    url: artifactUrlFor(rel),
    size: typeof a.size === "number" ? a.size : 0,
    mtime: typeof a.mtime === "number" ? a.mtime : 0,
  };
}

/** 按「修改时间倒序、同时间按名字」排序，让最新产出的排在最前（前端默认展示第一条）。 */
function sortArtifacts(list) {
  return list.slice().sort((x, y) => (y.mtime - x.mtime) || String(x.rel).localeCompare(String(y.rel)));
}

/**
 * 递归扫描 root 下的可预览产物。
 * @param {string} root        工作区根目录（租户 workspace 绝对路径）
 * @param {object} [opts]
 * @param {number} [opts.sinceMs]  只要 mtimeMs >= 这个值的文件（用来挑「本轮任务期间」的）
 * @param {number} [opts.maxFiles] 最多返回多少条（防御 workspace 里堆了几千个文件）
 * @param {number} [opts.maxDepth] 递归深度上限
 * @param {number} [opts.maxBytes] 超过这个体积的不收（几十 MB 的 PDF 没意义还拖慢前端）
 */
function scanArtifacts(root, opts) {
  const o = opts || {};
  const since = typeof o.sinceMs === "number" ? o.sinceMs : 0;
  const maxFiles = typeof o.maxFiles === "number" ? o.maxFiles : 50;
  const maxDepth = typeof o.maxDepth === "number" ? o.maxDepth : 4;
  const maxBytes = typeof o.maxBytes === "number" ? o.maxBytes : 50 * 1024 * 1024;
  const out = [];
  if (!root) return out;

  let rootReal = null;
  try { rootReal = fs.realpathSync(root); } catch (e) { return out; }

  /** 目录里的条目太多也看一眼就走，避免 node_modules 之类被意外扫到时卡死。 */
  const MAX_ENTRIES_PER_DIR = 2000;

  (function walk(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.length > MAX_ENTRIES_PER_DIR) entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.charAt(0) === "." && ent.name !== ".") continue; // 隐藏目录不进
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!isArtifactName(ent.name)) continue;
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st || !st.isFile()) continue;
      if (since && st.mtimeMs < since) continue;
      if (st.size > maxBytes) continue;
      const rel = path.relative(rootReal, full).split(path.sep).join("/");
      const norm = normalizeArtifact({ name: ent.name, rel, size: st.size, mtime: st.mtimeMs });
      if (norm) out.push(norm);
    }
  })(rootReal, 0);

  return sortArtifacts(out);
}

/**
 * 收集本轮任务的产出 —— 唯一对外的主入口。
 * 兜底语义：workspace 不存在 / 读不动 / 一个都没有时返回 []，绝不抛错打断回复流程
 * （产物预览是锦上添花，不能因为它把整条对话搞挂）。
 */
function collectArtifacts(workspace, sinceMs, opts) {
  try {
    return scanArtifacts(workspace, Object.assign({}, opts, { sinceMs: sinceMs || 0 }));
  } catch (e) {
    return [];
  }
}

/** 扩展名 -> Content-Type（/api/artifact 响应用；PDF 必须给对，否则浏览器不进内置阅读器）。 */
function artifactContentType(rel) {
  const k = artifactKind(String(rel || ""));
  if (k === "pdf") return "application/pdf";
  if (k === "html") return "text/html; charset=utf-8";
  if (k === "md") return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

module.exports = {
  ARTIFACT_EXTS,
  SKIP_DIRS,
  artifactKind,
  isArtifactName,
  isSafeRel,
  artifactUrlFor,
  normalizeArtifact,
  sortArtifacts,
  scanArtifacts,
  collectArtifacts,
  artifactContentType,
};
