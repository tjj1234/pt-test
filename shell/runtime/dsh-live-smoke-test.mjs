/**
 * dsh-live-smoke-test.mjs —— 真实多轮对话冒烟（B1 · 真实验证）
 * ============================================================================
 * 用真实 PT key + 真实 DSH Adapter 跑一轮多轮对话冒烟：
 *   1. 冷启动第 1 轮（fresh=true）
 *   2. 热会话第 2 轮（同 sessionKey 复用，验证多轮记忆）
 *   3. 热会话第 3 轮（继续追问）
 *   4. closeSession 后冷启动（验证会话重置 / 记忆丢弃）
 *
 * 运行：
 *   $env:DSH_LIVE_PT_KEY="<真实 PT key>"
 *   node shell/runtime/dsh-live-smoke-test.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { createDshRuntime, findDshEntry } = require("./dsh-adapter.cjs");

const API_KEY = process.env.DSH_LIVE_PT_KEY || "";
const MODEL = process.env.DSH_LIVE_MODEL || "deepseek-v4-pro";
const SETTINGS = path.resolve(__dirname, "../dsh-settings.yaml");
const RUNNER = path.resolve(__dirname, "../persistent-runner.mjs");
const DSH_ENTRY = process.env.DSH_LIVE_ENTRY || "C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!API_KEY) {
  console.error("缺少环境变量 DSH_LIVE_PT_KEY（真实 PT key）");
  process.exit(2);
}

const base = path.join(os.tmpdir(), "dsh-live-smoke-" + process.pid + "-" + Date.now());
const dshHome = path.join(base, "home");
const tmpDir = path.join(base, "runtime");
const wsBase = path.join(base, "ws");
for (const d of [dshHome, tmpDir, wsBase]) fs.mkdirSync(d, { recursive: true });

const entry = fs.existsSync(DSH_ENTRY) ? DSH_ENTRY : findDshEntry().js;
const rt = createDshRuntime({ dshEntry: entry, dshHome, settingsTemplate: SETTINGS, persistentRunner: RUNNER, tmpDir, taskTimeoutMs: 120000 });

const SESSION = "smoke-s1";
const TENANT = "smoke-tenant";
const spec = (question, extra) => Object.assign({ sessionKey: SESSION, tenantId: TENANT, model: MODEL, apiKey: API_KEY, workspace: wsBase, question, timeoutMs: 60000 }, extra);

let pass = 0, fail = 0;
const log = [];
function ok(name, cond, detail) {
  log.push({ name, pass: !!cond, detail: detail || "" });
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
}

try {
  /* 第 1 轮：冷启动，注入一个可被记住的事实 */
  console.log("\n[轮 1] 冷启动");
  let d1 = 0;
  const r1 = await rt.run(spec("你好，我叫小明，请你记住我的名字。", { onDelta: () => d1++ }));
  console.log("  text=" + JSON.stringify(r1.text).slice(0, 120) + " fresh=" + r1.fresh + " delta=" + d1);
  ok("轮1: ok=true", r1.ok === true);
  ok("轮1: 非空文本", r1.text.length > 0);
  ok("轮1: fresh=true（冷启动）", r1.fresh === true, "fresh=" + r1.fresh);
  ok("轮1: 流式 delta 回调", d1 >= 1, "delta=" + d1);

  /* 第 2 轮：热会话，验证多轮记忆 */
  console.log("\n[轮 2] 热会话追问（验证记忆）");
  const r2 = await rt.run(spec("我叫什么名字？"));
  console.log("  text=" + JSON.stringify(r2.text).slice(0, 120) + " fresh=" + r2.fresh);
  ok("轮2: ok=true", r2.ok === true);
  ok("轮2: fresh=false（热会话复用）", r2.fresh === false, "fresh=" + r2.fresh);
  ok("轮2: 记住上一轮的名字（多轮记忆生效）", r2.text.includes("小明"), "text=" + JSON.stringify(r2.text).slice(0, 120));

  /* 第 3 轮：继续追问 */
  console.log("\n[轮 3] 继续追问");
  const r3 = await rt.run(spec("请用一句话总结我们刚才的对话。"));
  console.log("  text=" + JSON.stringify(r3.text).slice(0, 120) + " fresh=" + r3.fresh);
  ok("轮3: ok=true", r3.ok === true);
  ok("轮3: 非空文本", r3.text.length > 0);

  /* 第 4 轮：closeSession 后冷启动，验证会话重置 */
  console.log("\n[轮 4] closeSession 后冷启动");
  rt.closeSession(SESSION);
  const r4 = await rt.run(spec("我叫什么名字？"));
  console.log("  text=" + JSON.stringify(r4.text).slice(0, 120) + " fresh=" + r4.fresh);
  ok("轮4: ok=true", r4.ok === true);
  // 记录 fresh：契约期望 closeSession 后 fresh=true（冷启动）
  ok("轮4: fresh=true（closeSession 后冷启动）", r4.fresh === true, "fresh=" + r4.fresh);
  // 记录记忆是否被丢弃（软观察，不硬断言，避免模型猜测“小明”）
  log.push({ name: "轮4(观察): 是否忘记名字", pass: null, detail: "text=" + JSON.stringify(r4.text).slice(0, 120) });
} finally {
  rt.close();
  await sleep(3500);
}

console.log("\n==== 冒烟结果：" + pass + " 通过 / " + fail + " 失败 ====");
console.log("JSON_SUMMARY=" + JSON.stringify({ pass, fail, log }));
process.exit(fail ? 1 : 0);
