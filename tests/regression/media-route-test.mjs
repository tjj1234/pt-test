"use strict";
/**
 * tests/regression/media-route-test.mjs — media.route skill 接线 + 模型路由验收
 * ============================================================================
 * 覆盖：
 *   ① 模型分类映射表 MODEL_ROUTING（4 类各 1 代表模型、kind/needsImage 正确）
 *   ② callMediaRoute 按 taskType 路由（mock PowerTokens 响应，不花真实调用）
 *      - text2image / image2image → /v1/images/generations（image 字段）
 *      - text2video / image2video → /v1/videos（media.first_frame 字段 + 轮询）
 *   ③ 错误路径：未知 taskType / 缺 prompt / 图生* 缺 inputImageUrl / 相对 URL 被拒
 *   ④ Shell 层定义 + autoload PROVIDERS 能发现 media.route
 * ============================================================================
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  MODEL_ROUTING,
  TASK_TYPES,
  resolveRouting,
  callMediaRoute,
  parseMediaParams,
  renderStylePrompt,
} from "../../business/media/powertokens.cjs";
import { STYLE_PRESETS, getStylePreset, listStylePresets } from "../../business/media/presets.cjs";
import { mediaRouteToolDefinition } from "../../business/media/registry/tool.js";
import { loadBusinessTools } from "../../shell/tools/autoload.cjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};

const jsonResponse = (obj) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(obj),
  json: async () => obj,
});

async function main() {
  console.log("🧪 media.route 模型路由 + 接线验收");

  // ---- ① 映射表 ----
  ok("MODEL_ROUTING 覆盖 4 类", TASK_TYPES.length === 4, JSON.stringify(TASK_TYPES));
  ok("text2image → seedream / image / 无需图", MODEL_ROUTING.text2image.model === "seedream-5-0-260128" && MODEL_ROUTING.text2image.kind === "image" && MODEL_ROUTING.text2image.needsImage === false);
  ok("image2image → 需图", MODEL_ROUTING.image2image.needsImage === true && MODEL_ROUTING.image2image.kind === "image");
  ok("text2video → wan2.7-t2v / video", MODEL_ROUTING.text2video.model === "wan2.7-t2v" && MODEL_ROUTING.text2video.kind === "video" && MODEL_ROUTING.text2video.needsImage === false);
  ok("image2video → wan2.7-i2v / 需图", MODEL_ROUTING.image2video.model === "wan2.7-i2v" && MODEL_ROUTING.image2video.needsImage === true && MODEL_ROUTING.image2video.kind === "video");

  // ---- ② text2image（同步 OpenAI 风格）----
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ data: [{ url: "https://img.example.com/gen.png" }] });
    };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "一只猫" }, { apiKey: "test-key", fetchImpl });
    ok("text2image 返回 URL", r.url === "https://img.example.com/gen.png", JSON.stringify(r));
    ok("text2image 模型正确", r.model === "seedream-5-0-260128" && r.kind === "image");
    ok("text2image 请求打到 /v1/images/generations", calls[0].url.endsWith("/v1/images/generations"));
    const body = JSON.parse(calls[0].options.body);
    ok("text2image 不带 image 字段", body.image === undefined, JSON.stringify(body));
    ok("text2image 带 prompt", body.prompt === "一只猫");
  }

  // ---- ② image2image（带 image 字段）----
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ data: [{ url: "https://img.example.com/i2i.png" }] });
    };
    const r = await callMediaRoute({}, { taskType: "image2image", prompt: "改成油画风", inputImageUrl: "https://cdn.example.com/in.png" }, { apiKey: "test-key", fetchImpl });
    ok("image2image 返回 URL", r.url === "https://img.example.com/i2i.png");
    const body = JSON.parse(calls[0].options.body);
    ok("image2image 带 image 字段", body.image === "https://cdn.example.com/in.png", JSON.stringify(body));
  }

  // ---- ② image2video（异步任务 + 轮询）----
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, options });
      if (u.endsWith("/v1/videos") && (options.method || "GET") === "POST") {
        return jsonResponse({ task_id: "task-1" });
      }
      if (u.includes("/v1/videos/task-1")) {
        return jsonResponse({ status: "completed", metadata: { url: "https://vid.example.com/i2v.mp4" } });
      }
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    };
    const r = await callMediaRoute({}, { taskType: "image2video", prompt: "让猫跑起来", inputImageUrl: "https://cdn.example.com/in.png" }, { apiKey: "test-key", fetchImpl });
    ok("image2video 返回视频 URL", r.url === "https://vid.example.com/i2v.mp4", JSON.stringify(r));
    ok("image2video 模型正确", r.model === "wan2.7-i2v" && r.kind === "video");
    const postCall = calls.find((c) => c.url.endsWith("/v1/videos"));
    const body = JSON.parse(postCall.options.body);
    ok("image2video 带 media.first_frame", Array.isArray(body.media) && body.media[0].type === "first_frame" && body.media[0].url === "https://cdn.example.com/in.png", JSON.stringify(body));
    ok("image2video 触发轮询", calls.some((c) => c.url.includes("/v1/videos/task-1")));
  }

  // ---- ② text2video（无 image，不带 media）----
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, options });
      if (u.endsWith("/v1/videos") && (options.method || "GET") === "POST") return jsonResponse({ task_id: "task-2" });
      if (u.includes("/v1/videos/task-2")) return jsonResponse({ status: "completed", url: "https://vid.example.com/t2v.mp4" });
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    };
    const r = await callMediaRoute({}, { taskType: "text2video", prompt: "海边日落" }, { apiKey: "test-key", fetchImpl });
    ok("text2video 返回 URL", r.url === "https://vid.example.com/t2v.mp4");
    const body = JSON.parse(calls[0].options.body);
    ok("text2video 不带 media", body.media === undefined, JSON.stringify(body));
  }

  // ---- ② data URL（base64 内嵌图片，规避 /uploads 不可外链）----
  {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, options });
      if (u.endsWith("/v1/images/generations")) return jsonResponse({ data: [{ url: "https://img.example.com/d.png" }] });
      if (u.endsWith("/v1/videos") && (options.method || "GET") === "POST") return jsonResponse({ task_id: "task-d" });
      if (u.includes("/v1/videos/task-d")) return jsonResponse({ status: "completed", metadata: { url: "https://vid.example.com/d.mp4" } });
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    };
    const r1 = await callMediaRoute({}, { taskType: "image2image", prompt: "油画风", inputImageUrl: dataUrl }, { apiKey: "test-key", fetchImpl });
    ok("data URL 图生图返回 URL", r1.url === "https://img.example.com/d.png", JSON.stringify(r1));
    const imgBody = JSON.parse(calls.find((c) => c.url.endsWith("/v1/images/generations")).options.body);
    ok("data URL 写入 image 字段", imgBody.image === dataUrl, JSON.stringify(imgBody));

    const r2 = await callMediaRoute({}, { taskType: "image2video", prompt: "动起来", inputImageUrl: dataUrl }, { apiKey: "test-key", fetchImpl });
    ok("data URL 图生视频返回 URL", r2.url === "https://vid.example.com/d.mp4", JSON.stringify(r2));
    const vidBody = JSON.parse(calls.find((c) => c.url.endsWith("/v1/videos")).options.body);
    ok("data URL 写入 media.first_frame.url", vidBody.media[0].url === dataUrl, JSON.stringify(vidBody));
  }

  // ---- ② 风格预设（可选加分项）----
  {
    ok("风格预设数量 ≥ 8", STYLE_PRESETS.length >= 8, "当前 " + STYLE_PRESETS.length);
    ok("每个预设都保留作者署名与出处", STYLE_PRESETS.every((p) => p.author && p.source), "存在缺署名/出处的预设");
    const city = getStylePreset("city-magnet");
    ok("city-magnet 为文生图无需图", !!city && city.taskType === "text2image" && city.needsImage === false);
    const plush = getStylePreset("plush-toy");
    ok("plush-toy 为图生图需图", !!plush && plush.taskType === "image2image" && plush.needsImage === true);
  }
  {
    const out = renderStylePrompt(getStylePreset("city-magnet"), "东京");
    ok("单一占位符被填充", out.includes("东京") && !out.includes("{城市名称}"), out);
  }
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ data: [{ url: "https://img.example.com/magnet.png" }] });
    };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "东京", stylePreset: "city-magnet" }, { apiKey: "test-key", fetchImpl });
    ok("stylePreset 文生图返回 URL", r.url === "https://img.example.com/magnet.png", JSON.stringify(r));
    const body = JSON.parse(calls[0].options.body);
    ok("stylePreset 渲染进 prompt（含城市名、不含占位符）", body.prompt.includes("东京") && !body.prompt.includes("{城市名称}"), body.prompt.slice(0, 80));
  }
  {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ data: [{ url: "https://img.example.com/plush.png" }] });
    };
    const r = await callMediaRoute({}, { taskType: "image2image", prompt: "我的logo", inputImageUrl: dataUrl, stylePreset: "plush-toy" }, { apiKey: "test-key", fetchImpl });
    ok("图生图预设 + data URL 返回 URL", r.url === "https://img.example.com/plush.png", JSON.stringify(r));
    const body = JSON.parse(calls[0].options.body);
    ok("图生图预设 image 字段透传", body.image === dataUrl, JSON.stringify(body));
    ok("图生图预设 prompt 含模板+补充内容", body.prompt.includes("蓬松") && body.prompt.includes("补充内容"), body.prompt.slice(0, 80));
  }
  {
    let threw = false;
    try { await callMediaRoute({}, { taskType: "text2image", prompt: "x", stylePreset: "plush-toy" }, { apiKey: "test-key", fetchImpl: async () => jsonResponse({}) }); } catch (e) { threw = /需要输入图片/.test(e.message); }
    ok("图生图预设缺图抛错", threw);
  }
  {
    let threw = false;
    try { await callMediaRoute({}, { taskType: "text2video", prompt: "x", stylePreset: "city-magnet" }, { apiKey: "test-key", fetchImpl: async () => jsonResponse({}) }); } catch (e) { threw = /仅支持文生图/.test(e.message); }
    ok("视频任务用 stylePreset 抛错", threw);
  }
  {
    let threw = false;
    try { await callMediaRoute({}, { taskType: "text2image", prompt: "x", stylePreset: "nope" }, { apiKey: "test-key", fetchImpl: async () => jsonResponse({}) }); } catch (e) { threw = /未知的 stylePreset/.test(e.message); }
    ok("未知 stylePreset 抛错", threw);
  }

  // ---- ②b 参数解析（prompt 解析 / 显式 opts 优先 / 兜底保留 / 防误伤）----
  // 图片：prompt 里的尺寸解析生效（不同模型各测一次；image2image 需图）
  for (const taskType of ["text2image", "image2image"]) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); return jsonResponse({ data: [{ url: "https://img.example.com/gen.png" }] }); };
    const args = { taskType, prompt: "一只猫，尺寸1024x1024" };
    if (taskType === "image2image") args.inputImageUrl = "https://cdn.example.com/in.png";
    const r = await callMediaRoute({}, args, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    ok(`${taskType} 解析 prompt 尺寸 1024x1024 生效`, body.size === "1024x1024", JSON.stringify(body));
  }
  // 图片：不同分隔符 / 全角 ×
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); return jsonResponse({ data: [{ url: "https://img.example.com/g.png" }] }); };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "风景照 800×600" }, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    ok("全角 × 分隔尺寸解析 800x600", body.size === "800x600", JSON.stringify(body));
    ok("尺寸解析不影响返回 URL", r.url === "https://img.example.com/g.png");
  }
  // 图片：prompt 无尺寸 → 兜底 2048x2048 仍然保留
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); return jsonResponse({ data: [{ url: "https://img.example.com/d.png" }] }); };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "一只猫" }, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    ok("无尺寸 → 兜底 2048x2048", body.size === "2048x2048", JSON.stringify(body));
    ok("无张数 → 兜底 n=1", body.n === 1, JSON.stringify(body));
  }
  // 图片：防误伤（年份 / 版本号不应被当作尺寸）
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); return jsonResponse({ data: [{ url: "https://img.example.com/y.png" }] }); };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "2024 年度发布海报" }, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    ok("年份 2024 不被误判为尺寸（兜底 2048x2048）", body.size === "2048x2048", JSON.stringify(body));
  }
  // 图片：张数解析 n
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); return jsonResponse({ data: [{ url: "https://img.example.com/n.png" }] }); };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "生成 2 张猫咪图" }, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    ok("张数解析 n=2 生效", body.n === 2, JSON.stringify(body));
  }
  // 视频：分辨率 + 时长解析（prompt 含 1080p 与 10秒）
  for (const taskType of ["text2video", "image2video"]) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, options });
      if (u.endsWith("/v1/videos") && (options.method || "GET") === "POST") return jsonResponse({ task_id: "t-parse" });
      if (u.includes("/v1/videos/t-parse")) return jsonResponse({ status: "completed", url: "https://vid.example.com/p.mp4" });
      return { ok: false, status: 404, text: async () => "nf", json: async () => ({}) };
    };
    const r = await callMediaRoute({}, { taskType, prompt: "海边日落 1080p 时长10秒", ...(taskType === "image2video" ? { inputImageUrl: "https://cdn.example.com/in.png" } : {}) }, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v1/videos")).options.body);
    ok(`${taskType} 解析分辨率 → 1080P`, body.size === "1080P", JSON.stringify(body));
    ok(`${taskType} 解析时长 → 10`, body.seconds === "10", JSON.stringify(body));
  }
  // 视频：无解析 → 兜底 720P / 5s
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, options });
      if (u.endsWith("/v1/videos") && (options.method || "GET") === "POST") return jsonResponse({ task_id: "t-def" });
      if (u.includes("/v1/videos/t-def")) return jsonResponse({ status: "completed", url: "https://vid.example.com/d.mp4" });
      return { ok: false, status: 404, text: async () => "nf", json: async () => ({}) };
    };
    const r = await callMediaRoute({}, { taskType: "text2video", prompt: "海边日落" }, { apiKey: "test-key", fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    ok("视频无解析 → 兜底 720P", body.size === "720P", JSON.stringify(body));
    ok("视频无解析 → 兜底 5s", body.seconds === "5", JSON.stringify(body));
  }
  // 优先级：显式 opts 覆盖 prompt 解析值
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); return jsonResponse({ data: [{ url: "https://img.example.com/o.png" }] }); };
    const r = await callMediaRoute({}, { taskType: "text2image", prompt: "一只猫，尺寸1024x1024" }, { apiKey: "test-key", fetchImpl, size: "512x512" });
    const body = JSON.parse(calls[0].options.body);
    ok("显式 opts.size 覆盖 prompt 解析值", body.size === "512x512", JSON.stringify(body));
  }
  // parseMediaParams 单测
  {
    ok("parseMediaParams 尺寸 1024x1024", parseMediaParams("尺寸1024x1024").size === "1024x1024");
    ok("parseMediaParams 年份不误判", parseMediaParams("2024 年度").size === undefined);
    ok("parseMediaParams 1080p→1080P", parseMediaParams("1080p 视频").resolution === "1080P");
    ok("parseMediaParams 720p→720P", parseMediaParams("720p 视频").resolution === "720P");
    ok("parseMediaParams 10秒→10", parseMediaParams("时长10秒").duration === 10);
    ok("parseMediaParams 2张→n=2", parseMediaParams("生成2张").n === 2);
    ok("parseMediaParams version=2 不误判 n", parseMediaParams("version=2 发布").n === undefined);
    ok("parseMediaParams 10stars 不误判时长", parseMediaParams("10stars 视频").duration === undefined);
    ok("parseMediaParams 无匹配全 undefined", JSON.stringify(parseMediaParams("一只猫")) === JSON.stringify({}));
  }

  // ---- ③ 错误路径 ----
  {
    let threw = false;
    try { resolveRouting("nope"); } catch (e) { threw = /未知的 taskType/.test(e.message); }
    ok("未知 taskType 抛错", threw);
  }
  {
    let threw = false;
    try { await callMediaRoute({}, { taskType: "text2image", prompt: "" }, { apiKey: "test-key", fetchImpl: async () => jsonResponse({}) }); } catch (e) { threw = /prompt 不能为空/.test(e.message); }
    ok("缺 prompt 抛错", threw);
  }
  {
    let threw = false;
    try { await callMediaRoute({}, { taskType: "image2video", prompt: "x" }, { apiKey: "test-key", fetchImpl: async () => jsonResponse({}) }); } catch (e) { threw = /需要 inputImageUrl/.test(e.message); }
    ok("图生视频缺 inputImageUrl 抛错", threw);
  }
  {
    let threw = false;
    try { await callMediaRoute({}, { taskType: "image2image", prompt: "x", inputImageUrl: "/uploads/123/foo.png" }, { apiKey: "test-key", fetchImpl: async () => jsonResponse({}) }); } catch (e) { threw = /可公网访问/.test(e.message); }
    ok("相对路径 inputImageUrl 被拒（不可外链）", threw);
  }

  // ---- ④ Shell 层定义 + autoload 发现 ----
  {
    const def = mediaRouteToolDefinition();
    const required = ["name", "type", "version", "description", "inputSchema", "outputType", "riskLevel", "requiredPermissions"];
    ok("定义含全部必填字段", required.every((k) => def[k] != null), JSON.stringify(required.filter((k) => def[k] == null)));
    ok("名称为 media.route", def.name === "media.route");
    ok("inputSchema enum 覆盖 4 类", JSON.stringify(def.inputSchema.properties.taskType.enum) === JSON.stringify(["text2image", "image2image", "text2video", "image2video"]));
    ok("inputSchema required 含 taskType+prompt", JSON.stringify(def.inputSchema.required) === JSON.stringify(["taskType", "prompt"]));
    ok("inputSchema 含 stylePreset 枚举", Array.isArray(def.inputSchema.properties.stylePreset.enum) && def.inputSchema.properties.stylePreset.enum.includes("city-magnet"));
  }
  {
    const loaded = loadBusinessTools({});
    const media = loaded.find((d) => d.definition && d.definition.name === "media.route");
    ok("autoload 能发现 media.route", !!media && typeof media.execute === "function");
    ok("media.route executor 可调用", typeof media.execute === "function");
  }

  console.log(`\n==== media.route 验收：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试失败:", err && err.stack ? err.stack : err);
  process.exit(1);
});
