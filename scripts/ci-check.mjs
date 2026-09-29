/**
 * ci-check.mjs —— 语法检查（CI 用）
 * ============================================================================
 * 遍历仓库所有 .js / .cjs / .mjs 源文件，逐个 `node --check`（只解析、不执行），
 * 有任一语法错误就非零退出。跳过 node_modules / 运行时产物 / 数据目录 / 测试脚本目录。
 *
 * 兼容 ESM .js：DSH 插件（如 shell/dsh-headless-stream.js）是 ESM 却用 .js 后缀、
 * 由 DSH 的加载器解析，裸 `node --check` 会按 CJS 误报。本脚本先探测顶层
 * import/export，若为 ESM 则写入临时 .mjs 再查。
 *
 * 用法：node scripts/ci-check.mjs
 * ============================================================================
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const EXTS = new Set([".js", ".cjs", ".mjs"]);

/** 目录名跳过列表（含前缀匹配）。 */
function shouldSkipDir(name) {
  if (name.startsWith(".")) return true;             // .git / .pgdata / .pgdata-recovered 等
  if (name === "node_modules") return true;
  if (name.startsWith("local-test-runtime")) return true; // 运行时产物（shell 的拷贝）
  if (name === "_persistent-test-runtime") return true;
  if (name === "browsertest-runtime") return true;
  if (name === "_pg-test") return true;              // PG 一次性验证脚本（依赖外部 PG 环境）
  return false;
}

/** 探测文件是否为 ESM（顶层 import/export，排除注释与 shebang）。 */
function looksLikeEsm(content) {
  const stripped = content
    .replace(/^#![^\n]*\n/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return /(^|\n)\s*(import|export)\b/m.test(stripped.slice(0, 800));
}

const files = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch (e) { return; }
  for (const name of entries) {
    if (shouldSkipDir(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p);
    else if (EXTS.has(name.slice(name.lastIndexOf(".")).toLowerCase())) files.push(p);
  }
}

walk(ROOT);

const tmp = mkdtempSync(join(tmpdir(), "ci-check-"));
let failed = 0;

function checkOk(file, ext) {
  const r = spawnSync(process.execPath, ["--check", file], { stdio: "ignore" });
  return r.status === 0;
}

for (const f of files) {
  const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
  let ok = false;
  if (ext === ".js") {
    let content = "";
    try { content = readFileSync(f, "utf8"); } catch (e) {}
    if (looksLikeEsm(content)) {
      // ESM .js → 临时 .mjs 再查
      const tmpF = join(tmp, "esm-check-" + (failed + files.indexOf(f)) + ".mjs");
      try {
        writeFileSync(tmpF, content);
        ok = checkOk(tmpF, ".mjs");
      } catch (e) { ok = false; }
    } else {
      ok = checkOk(f, ext);
    }
  } else {
    ok = checkOk(f, ext);
  }
  if (!ok) {
    console.error("✗ 语法错误：" + relative(ROOT, f));
    failed += 1;
  }
}

try { rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

console.log(`ci-check：共检查 ${files.length} 个 JS 文件，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
