/**
 * run-regression.mjs —— 回归测试强制门禁（CI 用）
 * ============================================================================
 * 逐项执行 tests/regression/ 下的全部 .mjs 套件（不只做语法检查，而是真正跑起来），
 * 任一项失败（非零退出）就让整个流程非零退出，从而让 CI 标红、阻止合并。
 *
 * 与 ci-check.mjs 的区别：ci-check 只 `node --check`（解析不执行），这里才是真跑。
 *
 * 排除项：
 *   · mock-dsh-runner.mjs —— 它是回归测试的辅助进程（读 stdin 不退出），不是独立测试；
 *   · SMOKE.md 等非 .mjs 文件。
 *
 * 用法：node scripts/run-regression.mjs
 * ============================================================================
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIR = join(ROOT, "tests", "regression");
const SKIP = new Set(["mock-dsh-runner.mjs"]); // 辅助进程，非独立测试
const TIMEOUT_MS = 120 * 1000; // 单测试超时保护，避免个别套件卡死拖垮 CI

function listTests() {
  const out = [];
  let entries;
  try { entries = readdirSync(DIR); } catch (e) {
    console.error("✗ 无法读取回归目录：" + DIR);
    process.exit(1);
  }
  for (const name of entries) {
    if (!name.endsWith(".mjs")) continue;
    if (SKIP.has(name)) continue;
    const p = join(DIR, name);
    try { if (!statSync(p).isFile()) continue; } catch (e) { continue; }
    out.push(name);
  }
  out.sort();
  return out;
}

function runOne(name) {
  return new Promise((resolve) => {
    const file = join(DIR, name);
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });

    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve({ name, status, ms: Date.now() - t0, out, err });
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
      finish("timeout");
    }, TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      finish("error:" + (e && e.message ? e.message : String(e)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? "ok" : "exit-" + (code == null ? "signal" : code));
    });
  });
}

async function main() {
  const tests = listTests();
  console.log(`run-regression：发现 ${tests.length} 个回归套件\n`);

  const results = [];
  for (const name of tests) {
    const r = await runOne(name);
    results.push(r);
    const mark = r.status === "ok" ? "✓" : "✗";
    const extra = r.status === "ok" ? "" : "  [" + r.status + "]";
    console.log(`${mark} ${name} (${r.ms}ms)${extra}`);
  }

  const failed = results.filter((r) => r.status !== "ok");
  console.log("");
  for (const f of failed) {
    const tail = (f.out + f.err).split("\n").filter(Boolean).slice(-30).join("\n");
    console.log(`—— ${f.name} 输出末尾 ——`);
    console.log(tail || "（无输出）");
    console.log("");
  }

  console.log(`run-regression：共 ${results.length} 个套件，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main();
