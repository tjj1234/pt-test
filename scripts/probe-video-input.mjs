"use strict";
/**
 * scripts/probe-video-input.mjs —— 用真实调用确认 /v1/videos 是否接受 data URL 作为输入图片。
 * 结论靠真实调用，不猜（坑 10）。
 * 输出同时写 console 与 probe-video-input.log（坑 17：PowerShell 偶发零回显）。
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
const logFile = path.join(root, "probe-video-input.log");
const lines = [];
function log(s) { lines.push(String(s)); console.log(s); }
function flush() { fs.writeFileSync(logFile, lines.join("\n") + "\n", "utf8"); }

// 1x1 透明 PNG（合法图片，仅用于探针是否被网关接受）
const tinyPngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function post(body) {
  const res = await fetch(`${baseUrl}/v1/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  log("== probe-video-input ==");
  log("key 非空=" + !!apiKey + " 长度=" + apiKey.length);
  log("baseUrl=" + baseUrl);
  if (!apiKey) { log("无 key，退出"); flush(); process.exit(1); }

  const model = "wan2.7-i2v";
  const base = { model, prompt: "probe input image url", seconds: "5", size: "720P" };

  log("\n--- 探针 A：media[].url = data URL ---");
  let r = await post({ ...base, media: [{ type: "first_frame", url: tinyPngDataUrl }] });
  log("HTTP " + r.status);
  log(r.text.slice(0, 800));

  log("\n--- 探针 B：media[].url = 公网 https URL ---");
  r = await post({ ...base, media: [{ type: "first_frame", url: "https://picsum.photos/seed/ptprobe/512/512.jpg" }] });
  log("HTTP " + r.status);
  log(r.text.slice(0, 800));

  flush();
}

main().catch((e) => { log("异常：" + (e && e.stack || e)); flush(); process.exit(1); });
