"use strict";
/**
 * scripts/media-route-real-key.mjs —— media.route 真实 key 验收脚本
 * ============================================================================
 * 用法：
 *   POWERTOKENS_API_KEY=sk-xxx node scripts/media-route-real-key.mjs \
 *     --image ./sample.png --prompt "让画面里的主体动起来"
 *
 * 可选环境变量：
 *   POWERTOKENS_BASE_URL  默认 https://api.powertokens.ai
 *
 * 它会：
 *   ① 文生图（text2image）：真实调用 callMediaRoute，验证 /v1/images/generations；
 *   ② 图生视频（image2video）：读本地图片 → 转 data URL → 调 callMediaRoute，
 *      验证 /v1/videos 的 media[].url 是否接受 data URL；
 *   ③ 若 ② 失败，则自动降级探针 image / img_url 字段，用真实调用确定 PT 认哪个字段
 *      （结论靠真实调用，不猜）。
 * ============================================================================
 */
import fs from "node:fs";
import path from "node:path";

import {
  callMediaRoute,
  MODEL_ROUTING,
  DEFAULT_BASE_URL,
} from "../business/media/powertokens.cjs";

function mimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] || "image/png";
}

function readImageAsDataUrl(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`);
  const buf = fs.readFileSync(abs);
  const mime = mimeFromPath(abs);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function parseArgs(argv) {
  const args = { prompt: "让画面里的主体自然地动起来" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image" && argv[i + 1]) args.image = argv[++i];
    else if (a === "--prompt" && argv[i + 1]) args.prompt = argv[++i];
  }
  return args;
}

async function runText2Image(apiKey, prompt) {
  console.log("\n===== ① 文生图 text2image =====");
  const t0 = Date.now();
  const r = await callMediaRoute(
    {},
    { taskType: "text2image", prompt },
    { apiKey }
  );
  console.log("✅ 文生图成功");
  console.log("  模型：", r.model, "| kind：", r.kind);
  console.log("  结果 URL：", r.url);
  console.log("  耗时：", Date.now() - t0, "ms");
  return r;
}

async function runImage2Video(apiKey, prompt, dataUrl) {
  console.log("\n===== ② 图生视频 image2video（data URL → media[].url）=====");
  console.log("  data URL 长度：", dataUrl.length, "字符（含 base64）");
  const t0 = Date.now();
  try {
    const r = await callMediaRoute(
      {},
      { taskType: "image2video", prompt, inputImageUrl: dataUrl },
      { apiKey }
    );
    console.log("✅ 图生视频成功 —— media[].url 接受 data URL");
    console.log("  模型：", r.model, "| kind：", r.kind);
    console.log("  结果 URL：", r.url);
    console.log("  耗时：", Date.now() - t0, "ms");
    return { ok: true, result: r };
  } catch (e) {
    console.log("❌ 图生视频失败（media[].url + data URL）：");
    console.log("  ", String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function postVideo(baseUrl, apiKey, body) {
  const res = await fetch(`${baseUrl}/v1/videos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function pollVideo(baseUrl, apiKey, taskId, timeoutMs = 240000) {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < timeoutMs) {
    n++;
    const res = await fetch(`${baseUrl}/v1/videos/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json();
    const status = json && json.status;
    console.log(`  [轮询 #${n}] status=${status ?? "（无）"} 已等 ${Math.round((Date.now() - start) / 1000)}s`);
    if (status === "completed" || status === "succeeded" || status === "success") {
      return { ok: true, status, json };
    }
    if (status === "failed" || status === "error" || status === "cancelled" || status === "expired") {
      return { ok: false, status, json };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, status: "timeout", json: null };
}

async function probeOne(baseUrl, apiKey, name, body) {
  console.log(`\n--- 探针：${name} ---`);
  const r = await postVideo(baseUrl, apiKey, body);
  console.log(`  POST 状态：${r.status}`);
  if (r.status >= 200 && r.status < 300) {
    const taskId = r.json && (r.json.task_id || r.json.id);
    if (taskId) {
      console.log(`  task_id：${taskId}`);
      const pr = await pollVideo(baseUrl, apiKey, taskId);
      console.log(`  轮询结果 status：${pr.status}`);
      if (pr.json) console.log(`  ${JSON.stringify(pr.json).slice(0, 600)}`);
      return pr.ok;
    }
    console.log(`  ${JSON.stringify(r.json).slice(0, 600)}`);
    return true;
  }
  console.log(`  ${r.text.slice(0, 600)}`);
  return false;
}

async function probeVideoFallbacks(baseUrl, apiKey, prompt, dataUrl) {
  console.log("\n===== ③ 降级探针：确定 /v1/videos 认哪个输入图片字段 =====");
  const model = MODEL_ROUTING.image2video.model;
  const base = { model, prompt, seconds: "5", size: "720P" };
  const layouts = [
    { name: "image 字段", body: { ...base, image: dataUrl } },
    { name: "img_url 字段", body: { ...base, img_url: dataUrl } },
  ];
  for (const l of layouts) {
    const ok = await probeOne(baseUrl, apiKey, l.name, l.body);
    if (ok) {
      console.log(`\n✅ 结论：/v1/videos 接受「${l.name}」携带 data URL`);
      return;
    }
  }
  console.log("\n❌ 结论：image / img_url 两个字段的 data URL 均未被接受，需要进一步排查 PT 视频接口的入参格式。");
}

async function main() {
  const apiKey = process.env.POWERTOKENS_API_KEY || "";
  if (!apiKey) {
    console.error("缺少 POWERTOKENS_API_KEY（请先 export / set 你的 PT key）");
    process.exit(1);
  }
  const baseUrl = process.env.POWERTOKENS_BASE_URL || DEFAULT_BASE_URL;
  const args = parseArgs(process.argv.slice(2));

  console.log("baseUrl：", baseUrl);
  console.log("prompt：", args.prompt);

  await runText2Image(apiKey, args.prompt);

  if (!args.image) {
    console.log("\n⚠️  未提供 --image，跳过图生视频；如需验收图生视频请加：--image ./你的图片.png");
    return;
  }

  const dataUrl = readImageAsDataUrl(args.image);
  const r = await runImage2Video(apiKey, args.prompt, dataUrl);
  if (!r.ok) {
    await probeVideoFallbacks(baseUrl, apiKey, args.prompt, dataUrl);
  }
}

main().catch((err) => {
  console.error("❌ 验收脚本异常：", err && err.stack ? err.stack : err);
  process.exit(1);
});
