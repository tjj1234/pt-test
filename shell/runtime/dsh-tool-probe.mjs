/**
 * dsh-tool-probe.mjs —— M1 探针：验证「对话 → 真实 tool/call → tool/result」链路
 * ============================================================================
 * 复用真实 DSH Adapter（同 dsh-live-smoke-test.mjs 启动方式），注册了
 * persistent-runner.mjs 里的 get_current_time demo 工具，然后问「现在几点」，
 * 断言 onStep 轨迹里出现真实的 tool/call 与 tool/result。
 *
 * 运行：
 *   $env:DSH_LIVE_PT_KEY="<真实 PT key>"
 *   node shell/runtime/dsh-tool-probe.mjs
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

if (!API_KEY) {
  console.error("缺少环境变量 DSH_LIVE_PT_KEY（真实 PT key）");
  process.exit(2);
}

const base = path.join(os.tmpdir(), "dsh-tool-probe-" + process.pid + "-" + Date.now());
const dshHome = path.join(base, "home");
const tmpDir = path.join(base, "runtime");
const wsBase = path.join(base, "ws");
for (const d of [dshHome, tmpDir, wsBase]) fs.mkdirSync(d, { recursive: true });

const entry = fs.existsSync(DSH_ENTRY) ? DSH_ENTRY : findDshEntry().js;
const rt = createDshRuntime({ dshEntry: entry, dshHome, settingsTemplate: SETTINGS, persistentRunner: RUNNER, tmpDir, taskTimeoutMs: 120000 });

const SESSION = "probe-s1";
const TENANT = "probe-tenant";

const steps = [];
const spec = {
  sessionKey: SESSION,
  tenantId: TENANT,
  model: MODEL,
  apiKey: API_KEY,
  workspace: wsBase,
  question: "现在几点？请用工具查询当前时间。",
  timeoutMs: 60000,
  onStep: (s) => { steps.push(s); console.log("  [step] " + JSON.stringify(s)); },
};

try {
  const r = await rt.run(spec);
  console.log("\ntext=" + JSON.stringify(r.text));
  console.log("steps=" + JSON.stringify(steps));

  const callStep = steps.find((s) => s.name === "get_current_time" && s.args !== undefined);
  const resultStep = steps.find((s) => s.name === "get_current_time" && s.result !== undefined && !s.isError);

  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log("  ✅ " + name); }
    else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
  };
  ok("run.ok=true", r.ok === true, "error=" + r.error);
  ok("出现真实 tool/call（get_current_time args）", !!callStep, "steps=" + steps.map((s) => s.name + "/" + (s.args ? "call" : "result")).join(","));
  ok("出现真实 tool/result（get_current_time result）", !!resultStep, "result=" + (resultStep && resultStep.result));
  ok("最终文本非空", r.text.length > 0);

  console.log("\n==== 探针结果：" + pass + " 通过 / " + fail + " 失败 ====");
  process.exit(fail ? 1 : 0);
} finally {
  rt.close();
}
