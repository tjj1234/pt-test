"use strict";
/**
 * scripts/poll-video-tasks.mjs —— 轮询 /v1/videos/{taskId} 直到出片或失败，写日志。
 * 用法：node scripts/poll-video-tasks.mjs <taskId> [taskId...]
 * 输出同时写 console 与 poll-video-tasks.log（坑 17/18）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnv();

const apiKey = process.env.POWERTOKENS_API_KEY || "";
const baseUrl = process.env.POWERTOKENS_BASE_URL || "https://api.powertokens.ai";
const logFile = path.join(root, "poll-video-tasks.log");
const lines = [];
function log(s) { lines.push(String(s)); console.log(String(s)); }
function flush() { fs.writeFileSync(logFile, lines.join("\n") + "\n", "utf8"); }

const SUCCESS = new Set(["completed", "succeeded", "success", "successful", "finished", "done", "ready", "ok"]);
const FAIL = new Set(["failed", "error", "cancelled", "canceled", "expired", "rejected", "timeout"]);

function collectUrls(node, out) {
  if (!node) return out;
  if (typeof node === "string") { if (/^https?:\/\//i.test(node)) out.push(node); return out; }
  if (Array.isArray(node)) { for (const v of node) collectUrls(v, out); return out; }
  if (typeof node === "object") { for (const v of Object.values(node)) collectUrls(v, out); }
  return out;
}
function readStatus(d) {
  if (!d) return "";
  const s = d.status || (d.data && d.data.status) || (d.result && d.result.status) || (d.metadata && d.metadata.status);
  return typeof s === "string" ? s.trim() : "";
}
function isDone(d) {
  const urls = []; collectUrls(d, urls);
  if (urls[0]) return { done: true, url: urls[0] };
  const s = readStatus(d).toLowerCase();
  if (s && SUCCESS.has(s)) return { done: true, url: urls[0] || null };
  const p = Number(d && (d.progress ?? (d.data && d.data.progress) ?? (d.result && d.result.progress)));
  if (Number.isFinite(p) && p >= 100) return { done: true, url: urls[0] || null };
  if (s && FAIL.has(s)) return { failed: true, status: s };
  return {};
}

async function getTask(taskId) {
  const res = await fetch(`${baseUrl}/v1/videos/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { http: res.status, json, text };
}

async function pollOne(taskId) {
  const start = Date.now();
  let n = 0, err5 = 0, err429 = 0, unread = 0;
  while (Date.now() - start < 600000) {
    n++;
    const { http, json, text } = await getTask(taskId);
    if (http === 429) { err429++; if (err429 > 30) return { failed: true, status: "429 熔断" }; await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** Math.min(err429, 5), 60000))); continue; }
    if (http >= 500) { err5++; if (err5 >= 8) return { failed: true, status: `5xx 熔断(${http})` }; await new Promise(r => setTimeout(r, 3000)); continue; }
    if (http !== 200) return { failed: true, status: `HTTP ${http}: ${text.slice(0, 200)}` };
    err5 = 0; err429 = 0;
    const r = isDone(json);
    const prog = (json && json.progress) ?? "-";
    log(`[${taskId}] #${n} http=${http} status=${readStatus(json) || "（无）"} progress=${prog} 已等${Math.round((Date.now()-start)/1000)}s`);
    if (r.done) { log(`[${taskId}] ✅ 完成 URL=${r.url}`); return { done: true, url: r.url, json }; }
    if (r.failed) { log(`[${taskId}] ❌ 失败 status=${r.status} 原始=${text.slice(0,400)}`); return { failed: true, status: r.status, text }; }
    if (readStatus(json)) unread = 0; else { unread++; if (unread >= 40) return { failed: true, status: `读不出状态熔断 原始=${text.slice(0,400)}` }; }
    await new Promise(r => setTimeout(r, 8000));
  }
  return { failed: true, status: "本地守护超时 600s" };
}

async function main() {
  const ids = process.argv.slice(2);
  log("== poll-video-tasks ==");
  log("key 非空=" + !!apiKey + " 长度=" + apiKey.length);
  log("任务数=" + ids.length + " ids=" + ids.join(", "));
  if (!ids.length) { log("无 taskId，退出"); flush(); process.exit(1); }
  const results = [];
  for (const id of ids) {
    const r = await pollOne(id);
    results.push({ id, ...r });
    log(`\n===== 结果 ${id} =====`);
    log(JSON.stringify(r));
    log("");
  }
  flush();
  log("\n全部完成，日志见 poll-video-tasks.log");
}

main().catch((e) => { log("异常：" + (e && e.stack || e)); flush(); process.exit(1); });
