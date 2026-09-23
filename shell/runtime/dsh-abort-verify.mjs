#!/usr/bin/env node
// 单独验证 abort 行为：点停止后 SSE 立即结束（不等模型跑完）
import fs from "fs";
import path from "path";
import { createDshRuntime } from "./dsh-adapter.cjs";

const API_KEY = process.env.DSH_LIVE_PT_KEY || "";
if (!API_KEY) {
  console.error("请设置 DSH_LIVE_PT_KEY");
  process.exit(1);
}

const MODEL = process.env.DSH_LIVE_MODEL || "deepseek-v4-pro";
const SETTINGS = path.resolve(import.meta.dirname, "../dsh-settings.yaml");
const RUNNER = path.resolve(import.meta.dirname, "../persistent-runner.mjs");
const DSH_ENTRY = process.env.DSH_LIVE_ENTRY ||
  "C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js";

const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-dsh-"));
const wsBase = fs.mkdtempSync(path.join(tmpDir, "ws-"));

const rt = createDshRuntime({
  dshEntry: DSH_ENTRY,
  dshHome: path.join(tmpDir, "dsh-home"),
  settingsTemplate: SETTINGS,
  persistentRunner: RUNNER,
  tmpDir,
  taskTimeoutMs: 120000,
});

const spec = (question, extra = {}) => Object.assign({
  sessionKey: "abort-verify",
  tenantId: "abort-tenant",
  model: MODEL,
  apiKey: API_KEY,
  workspace: wsBase,
  question,
  timeoutMs: 60000,
}, extra);

console.log("[验证] 发起一个长回复任务，500ms 后调用 abort…");

let jobHandle;
const promise = rt.run(spec(
  "请用至少 200 字详细解释量子纠缠是什么，以及它在量子计算中的作用。",
  {
    onSpawn(job) { jobHandle = job; },
    onDelta(text) { process.stdout.write(text); }
  }
));

// 500ms 后 abort
setTimeout(() => {
  if (jobHandle) {
    console.log("\n[动作] 调用 job.abort()…");
    jobHandle.abort();
  }
}, 500);

const r = await promise;

console.log("\n\n[结果]");
console.log(`ok=${r.ok} stopped=${r.stopped} ms=${r.ms}`);
console.log(`text 长度=${r.text.length}`);

rt.close();
await new Promise(resolve => setTimeout(resolve, 3500));
process.exit(r.stopped ? 0 : 1);