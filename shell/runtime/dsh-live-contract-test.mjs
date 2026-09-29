/**
 * dsh-live-contract-test.mjs —— 真实 DSH Adapter 契约验证（B1 · 真实验证）
 * ============================================================================
 * 把 tests/regression/runtime-contract-test.mjs 的 26 个契约断言，对着【真实】
 * dsh-adapter.cjs（不是 mock）跑一遍：
 *   · S1/S2/S9：纯 contract.cjs 校验 / 归一化 / 形状断言，原样保留；
 *   · S3~S8：原本针对 mock-adapter 的 14 个行为断言，逐条映射到真实 DSH + 真实 PT key。
 *
 * 真实 DSH 通过显式 dshEntry 指向 @deepseek-ai/dsh/lib/bin.js（本机 workbuddy 已装
 * 0.1.1-rc.2），避免依赖 shell/node_modules。PT key 从环境变量 DSH_LIVE_PT_KEY 读取。
 *
 * 运行：
 *   $env:DSH_LIVE_PT_KEY="<真实 PT key>"
 *   node shell/runtime/dsh-live-contract-test.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { validateRuntime, assertRuntime, normalizeRunResult, normalizeStep, normalizeDelta, RUNTIME_METHODS } = require("./contract.cjs");
const { createMockRuntime } = require("./mock-adapter.cjs");
const { createDshRuntime, findDshEntry } = require("./dsh-adapter.cjs");

const API_KEY = process.env.DSH_LIVE_PT_KEY || "";
const MODEL = process.env.DSH_LIVE_MODEL || "deepseek-v4-pro";
const SETTINGS = path.resolve(__dirname, "../dsh-settings.yaml");
const RUNNER = path.resolve(__dirname, "../persistent-runner.mjs");
const DSH_ENTRY = process.env.DSH_LIVE_ENTRY || "C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  const d = detail != null ? String(detail) : "";
  results.push({ name, pass: !!cond, detail: d });
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (d ? " — " + d : "")); }
}

if (!API_KEY) {
  console.error("缺少环境变量 DSH_LIVE_PT_KEY（真实 PT key）");
  process.exit(2);
}

/* ===== S1. Runtime Contract 校验（纯）===== */
console.log("\n[S1] contract.cjs 校验");
ok("validateRuntime: 空对象报缺 4 方法", JSON.stringify(validateRuntime({})) === JSON.stringify(["缺方法: run", "缺方法: abort", "缺方法: closeSession", "缺方法: close"]));
ok("validateRuntime: 完整对象通过", validateRuntime({ run() {}, abort() {}, closeSession() {}, close() {} }).length === 0);
let threw = false;
try { assertRuntime({ run() {} }, "x"); } catch (e) { threw = true; }
ok("assertRuntime: 缺方法抛错", threw === true);
ok("assertRuntime: 通过则原样返回", assertRuntime({ run() {}, abort() {}, closeSession() {}, close() {} }) !== null);
ok("RUNTIME_METHODS = 4 个", RUNTIME_METHODS.length === 4);

/* ===== S2. normalize 归一化（纯）===== */
console.log("\n[S2] normalize 归一化");
ok("normalizeRunResult: 补默认值", normalizeRunResult({}).ok === true && normalizeRunResult({}).text === "" && normalizeRunResult({}).steps.length === 0 && normalizeRunResult({}).code === null);
ok("normalizeRunResult: stopped 归一", normalizeRunResult({ stopped: true }).stopped === true && normalizeRunResult({ canceled: true }).stopped === true);
ok("normalizeStep: 补 name", normalizeStep({}).name === "tool" && normalizeStep({ name: "x", isError: true }).isError === true);
ok("normalizeDelta: 转字符串", normalizeDelta(123) === "123" && normalizeDelta(null) === "");

/* ===== 构造真实 DSH runtime ===== */
console.log("\n[准备] 构造真实 DSH runtime");
const base = path.join(os.tmpdir(), "dsh-live-contract-" + process.pid + "-" + Date.now());
const dshHome = path.join(base, "home");
const tmpDir = path.join(base, "runtime");
const wsBase = path.join(base, "ws");
for (const d of [dshHome, tmpDir, wsBase]) fs.mkdirSync(d, { recursive: true });

const entry = fs.existsSync(DSH_ENTRY) ? DSH_ENTRY : findDshEntry().js;
if (!entry) {
  console.error("找不到 DSH 入口 bin.js");
  process.exit(2);
}
console.log("  dshEntry     : " + entry);
console.log("  settings     : " + SETTINGS + " (存在 " + fs.existsSync(SETTINGS) + ")");
console.log("  persistentRunner: " + RUNNER + " (存在 " + fs.existsSync(RUNNER) + ")");

const rt = createDshRuntime({ dshEntry: entry, dshHome, settingsTemplate: SETTINGS, persistentRunner: RUNNER, tmpDir, taskTimeoutMs: 120000 });

const baseSpec = (s) => Object.assign({ tenantId: "live", model: MODEL, apiKey: API_KEY, workspace: wsBase, timeoutMs: 60000 }, s);

try {
  /* ===== S3. 真实 DSH ok / 流式（映射 mock ok 模式）===== */
  console.log("\n[S3] 真实 DSH ok / 流式");
  const deltas = [], steps = [];
  const r1 = await rt.run(baseSpec({
    sessionKey: "live-s1", question: "请用一句话介绍你自己",
    onDelta: (d) => deltas.push(d), onStep: (s) => steps.push(s),
  }));
  ok("真实 DSH: run 返回 ok=true", r1.ok === true, "ok=" + r1.ok);
  ok("真实 DSH: 返回非空文本", typeof r1.text === "string" && r1.text.length > 0, "len=" + (r1.text || "").length);
  ok("真实 DSH: delta 流式回调（≥1）", deltas.length >= 1, "delta 数=" + deltas.length);
  ok("真实 DSH: steps 归一为数组", Array.isArray(r1.steps), "steps=" + JSON.stringify(r1.steps).slice(0, 120));
  ok("真实 DSH: 首次 fresh=true", r1.fresh === true, "fresh=" + r1.fresh);

  /* ===== S4. 热会话：同 sessionKey 复用 ===== */
  console.log("\n[S4] 热会话（同 sessionKey 复用）");
  const r2 = await rt.run(baseSpec({ sessionKey: "live-s1", question: "再简短一点" }));
  ok("真实 DSH: 同 sessionKey 复用 fresh=false", r2.fresh === false, "fresh=" + r2.fresh);

  /* ===== S5. error / empty / timeout 模式映射 ===== */
  console.log("\n[S5] error / 空问题 / timeout");
  const rErr = await rt.run({ sessionKey: "err-1", tenantId: "live-err", model: MODEL, apiKey: "invalid-key-for-error-test", workspace: wsBase, question: "你好", timeoutMs: 60000 });
  ok("真实 DSH: 无效 key → ok=false + error", rErr.ok === false && !!rErr.error, "ok=" + rErr.ok + " error=" + JSON.stringify(rErr.error).slice(0, 80));

  const rEmpty = await rt.run(baseSpec({ sessionKey: "empty-1", tenantId: "live-empty", question: "" }));
  ok("真实 DSH: 空 question 不崩溃且 ok=true", rEmpty.ok === true, "ok=" + rEmpty.ok);

  const rTimeout = await rt.run({ sessionKey: "to-1", tenantId: "live-timeout", model: MODEL, apiKey: API_KEY, workspace: wsBase, question: "从1数到1000", timeoutMs: 1 });
  ok("真实 DSH: 极小 timeoutMs → code=TIMEOUT", rTimeout.ok === false && rTimeout.code === "TIMEOUT", "ok=" + rTimeout.ok + " code=" + rTimeout.code);

  /* ===== S6. abort 中途停止 ===== */
  console.log("\n[S6] abort 中途停止");
  let jobRef = null, aborted1 = false;
  const pAbort = rt.run(baseSpec({
    sessionKey: "abort-1", tenantId: "live-abort", question: "请从1数到1000",
    onSpawn: (j) => { jobRef = j; },
    onDelta: () => { if (!aborted1 && jobRef) { aborted1 = true; jobRef.abort(); } },
  }));
  ok("真实 DSH: onSpawn 先于任务回调（拿到停止句柄）", !!jobRef);
  const rAbort = await pAbort;
  ok("真实 DSH: job.abort() 中途 → stopped=true", rAbort.stopped === true, "stopped=" + rAbort.stopped + " ok=" + rAbort.ok);

  let aborted2 = false;
  const pAbort2 = rt.run(baseSpec({
    sessionKey: "abort-2", tenantId: "live-abort", question: "请从1数到1000",
    onDelta: () => { if (!aborted2) { aborted2 = true; rt.abort("abort-2"); } },
  }));
  const rAbort2 = await pAbort2;
  ok("真实 DSH: runtime.abort(sessionKey) → stopped=true", rAbort2.stopped === true, "stopped=" + rAbort2.stopped + " ok=" + rAbort2.ok);

  /* ===== S7. closeSession 重置会话 ===== */
  console.log("\n[S7] closeSession 重置会话");
  await rt.run(baseSpec({ sessionKey: "cs-1", tenantId: "live", question: "你好" }));
  rt.closeSession("cs-1");
  const rCs = await rt.run(baseSpec({ sessionKey: "cs-1", tenantId: "live", question: "第二次" }));
  ok("真实 DSH: closeSession 后 fresh=true（冷启动）", rCs.fresh === true, "fresh=" + rCs.fresh);

  /* ===== S8. persona 组装路径（映射 mock 自定义 script）===== */
  console.log("\n[S8] persona 组装路径");
  const rPersona = await rt.run(baseSpec({ sessionKey: "persona-1", tenantId: "live", persona: "你是严格的会计，只回答数字相关的问题。", question: "1+1=?" }));
  ok("真实 DSH: 注入 persona 仍正常返回 ok=true", rPersona.ok === true, "ok=" + rPersona.ok);
} finally {
  console.log("\n[清理] 关闭 runtime…");
  rt.close();
  await sleep(3500);
}

/* ===== S9. Mock 与真实 DSH Adapter 满足同一契约（可互换）===== */
console.log("\n[S9] 形状可互换");
const dshShape = { run() {}, abort() {}, closeSession() {}, close() {} };
const dshEmpty = createDshRuntime({ dshHome: "/nonexistent", settingsTemplate: "/nonexistent", persistentRunner: "/nonexistent", tmpDir: "/nonexistent" });
ok("mock 满足契约", validateRuntime(createMockRuntime()).length === 0);
ok("真实 DSH Adapter 满足同一契约（方法齐全）", validateRuntime(dshEmpty).length === 0);
ok("两个 adapter 方法集一致（可互换）", JSON.stringify(RUNTIME_METHODS.map((m) => typeof dshEmpty[m])) === JSON.stringify(RUNTIME_METHODS.map((m) => typeof dshShape[m])));

console.log("\n==== 结果：" + pass + " 通过 / " + fail + " 失败 ====");
console.log("JSON_SUMMARY=" + JSON.stringify({ pass, fail, results }));
process.exit(fail ? 1 : 0);
