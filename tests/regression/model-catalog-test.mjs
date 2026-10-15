/**
 * 模型目录：每日自动同步 + AUTO 智能路由 —— 回归测试（任务包 B · B3 后端部分）。
 *
 * 覆盖 shell/model-catalog.cjs：
 *   1. 归一化：id/name 抽取、chat 判定（端点信息优先，名字特征兜底）
 *   2. 生成类模型必须被标成 chat=false（否则用户选了就干等）
 *   3. AUTO 路由：代码 / 长文本 / 推理 / 其余 四类
 *   4. 同步：注入 fetch 桩，不打真网络；失败要能退回旧缓存 / 静态列表
 *   5. 缓存 TTL：24 小时内不再重复拉
 *
 * 跑法：node tests/regression/model-catalog-test.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const C = require("../../shell/model-catalog.cjs");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

console.log("模型目录（B3）回归：");

/* ---------------- 归一化与 chat 判定 ---------------- */
console.log("\n[1] normalizeModel / isChatModel");
ok("AUTO 常量", C.AUTO_ID === "AUTO");
const chatRaw = { id: "deepseek-v4-pro", supported_endpoint_types: ["anthropic"] };
ok("带 anthropic 端点 -> 可聊", C.isChatModel(chatRaw) === true);
ok("带 openai-response 端点 -> 可聊", C.isChatModel({ id: "x", supported_endpoint_types: ["openai-response"] }) === true);
ok("只有 image 端点 -> 不可聊", C.isChatModel({ id: "x", supported_endpoint_types: ["image-generation"] }) === false);
ok("名字含 seedance -> 不可聊（端点缺失兜底）", C.isChatModel({ id: "seedance-2.5" }) === false);
ok("名字含 seedream -> 不可聊", C.isChatModel({ id: "seedream-4.0" }) === false);
ok("名字含 tts -> 不可聊", C.isChatModel({ id: "speech-tts-1" }) === false);
ok("名字含 embedding -> 不可聊", C.isChatModel({ id: "text-embedding-3" }) === false);
ok("普通对话模型 -> 可聊", C.isChatModel({ id: "glm-5.2" }) === true);
ok("空 id -> 不可聊", C.isChatModel({}) === false);

const n1 = C.normalizeModel({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supported_endpoint_types: ["anthropic"] });
ok("归一化 id", n1 && n1.id === "deepseek-v4-pro");
ok("归一化 name", n1 && n1.name === "DeepSeek V4 Pro");
ok("归一化 kind=chat", n1 && n1.kind === "chat");
const n2 = C.normalizeModel({ id: "seedance-2.5" });
ok("生成类 kind=video", n2 && n2.chat === false && n2.kind === "video");
ok("生成类 kind=image", C.normalizeModel({ id: "seedream-4.0" }).kind === "image");
ok("生成类 kind=audio", C.normalizeModel({ id: "speech-02-tts" }).kind === "audio");
ok("空对象 -> null", C.normalizeModel({}) === null && C.normalizeModel(null) === null);
ok("只有 name 时把 name 当 id（有的网关只给 name）", C.normalizeModel({ name: "x" }).id === "x");
ok("name 缺失时退回 id", C.normalizeModel({ id: "abc" }).name === "abc");

/* ---------------- 列表抽取 / 去重排序 ---------------- */
console.log("\n[2] extractList / dedupeAndSort");
ok("{data:[...]}", C.extractList({ data: [{ id: "a" }] }).length === 1);
ok("裸数组", C.extractList([{ id: "a" }]).length === 1);
ok("{models:[...]}", C.extractList({ models: [{ id: "a" }] }).length === 1);
ok("垃圾输入 -> []", C.extractList(null).length === 0 && C.extractList("x").length === 0);
const dedup = C.dedupeAndSort([
  { id: "b", chat: true }, { id: "a", chat: true }, { id: "b", chat: true }, { id: "z-vid", chat: false },
]);
ok("去重", dedup.length === 3);
ok("可聊的排前面", dedup[0].chat === true && dedup[dedup.length - 1].chat === false);
ok("同组内按 id 排序", dedup[0].id === "a" && dedup[1].id === "b");

/* ---------------- AUTO 路由 ---------------- */
console.log("\n[3] routeModelFor：AUTO 智能路由");
const catalog = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", chat: true },
  { id: "qwen3-coder-plus", name: "Qwen Coder", chat: true },
  { id: "qwen3-max", name: "Qwen Max", chat: true },
  { id: "glm-5.2", name: "GLM", chat: true },
  { id: "seedance-2.5", name: "Seedance", chat: false },
];
const FB = "deepseek-v4-pro";
ok("代码（含代码块）-> coder", C.routeModelFor("帮我看下这段代码\n```js\nlet a=1\n```", catalog, FB) === "qwen3-coder-plus");
ok("代码（关键词：报错）-> coder", C.routeModelFor("这段代码报错了，帮我看看", catalog, FB) === "qwen3-coder-plus");
ok("推理（推导）-> pro/max", ["deepseek-v4-pro", "qwen3-max"].includes(C.routeModelFor("帮我推导一下这个公式", catalog, FB)));
ok("长文本（总结）-> max", C.routeModelFor("帮我总结这篇文章的要点", catalog, FB) === "qwen3-max");
ok("超长输入 -> max", C.routeModelFor("长文本".repeat(1200), catalog, FB) === "qwen3-max");
ok("普通闲聊 -> 默认模型", C.routeModelFor("你好呀", catalog, FB) === FB);
ok("空输入 -> 默认模型", C.routeModelFor("", catalog, FB) === FB);
ok("只匹配可聊模型（不会路由到 seedance）", C.routeModelFor("生成一段视频```", catalog, FB) !== "seedance-2.5");
ok("目录为空 -> 返回 fallback", C.routeModelFor("x", [], FB) === FB);
ok("fallback 不可聊时退回第一个可聊的", C.routeModelFor("你好", catalog, "seedance-2.5") === "deepseek-v4-pro");
ok("looksLikeCode 基本判定", C.looksLikeCode("function a(){}") === true && C.looksLikeCode("今天天气") === false);
ok("looksLikeLongText 判定", C.looksLikeLongText("帮我翻译这篇文档") === true);
ok("looksLikeReasoning 判定", C.looksLikeReasoning("请证明这个定理") === true);

/* ---------------- 同步（注入 fetch 桩，不打真网络） ---------------- */
console.log("\n[4] syncFromPt：注入 fetch 桩");
const ptPayload = { data: [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supported_endpoint_types: ["anthropic"] },
  { id: "seedance-2.5", name: "Seedance", supported_endpoint_types: ["video"] },
  { id: "seedream-4.0", name: "Seedream", supported_endpoint_types: ["image"] },
] };
const fakeFetch = async (url, opts) => {
  fakeFetch.lastUrl = url; fakeFetch.lastOpts = opts;
  return { ok: true, status: 200, json: async () => ptPayload };
};
const r1 = await C.syncFromPt({ apiKey: "sk-test", fetchImpl: fakeFetch });
ok("同步成功", r1.ok === true);
ok("拉到 3 个模型", r1.models.length === 3);
ok("请求 URL 是 /v1/models", String(fakeFetch.lastUrl).endsWith("/models"));
ok("带 Bearer 鉴权", fakeFetch.lastOpts && fakeFetch.lastOpts.headers && fakeFetch.lastOpts.headers.Authorization === "Bearer sk-test");
ok("生成类被标 chat=false", r1.models.filter((m) => m.chat === false).length === 2);
ok("对话模型 chat=true", r1.models.find((m) => m.id === "deepseek-v4-pro").chat === true);

ok("没有 key -> 不同步（不报错）", (await C.syncFromPt({ apiKey: "", fetchImpl: fakeFetch })).ok === false);
ok("PT 返回错误码 -> ok=false", (await C.syncFromPt({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 500 }) })).ok === false);
ok("网络异常 -> ok=false 不抛", (await C.syncFromPt({ apiKey: "k", fetchImpl: async () => { throw new Error("boom"); } })).ok === false);
ok("返回空列表 -> ok=false", (await C.syncFromPt({ apiKey: "k", fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) })).ok === false);

/* ---------------- 缓存与 TTL ---------------- */
console.log("\n[5] 缓存 / TTL / getCatalog 兜底");
// 缓存落在模块常量指定的真实 runtime 路径上，测试必须自带清理：
// ① 开始前删掉残留缓存（否则上一轮跑留下的缓存会让「同步失败退回静态列表」这类断言失真）；
// ② 结束后删掉自己写的，不把测试产物留在仓库里。
const tmpHome = mkdtempSync(path.join(tmpdir(), "catalog-"));
const origCache = C.CACHE_FILE;
try { rmSync(origCache, { force: true }); } catch (e) {}
try {
  const now = Date.now();
  ok("无缓存时 isStale=true", C.isStale(null, now) === true);
  ok("刚同步的缓存不过期", C.isStale({ syncedAt: now }, now) === false);
  ok("超过 24h 过期", C.isStale({ syncedAt: now - 25 * 3600 * 1000 }, now) === true);
  ok("23h 内不过期", C.isStale({ syncedAt: now - 23 * 3600 * 1000 }, now) === false);

  // getCatalog：同步失败且无缓存 -> 退回静态列表
  const c1 = await C.getCatalog({
    apiKey: "",
    fallback: [{ id: "deepseek-v4-pro", name: "DS" }],
    now,
  });
  ok("同步失败 -> 退回静态列表", c1.models.length === 1 && c1.models[0].id === "deepseek-v4-pro");
  ok("带 syncError 说明原因", typeof c1.syncError === "string" && c1.syncError.length > 0);
  ok("返回 auto 字段", c1.auto === "AUTO");

  // getCatalog：同步成功
  const c2 = await C.getCatalog({ apiKey: "sk", fetchImpl: fakeFetch, fallback: [], now, force: true });
  ok("强制同步生效", c2.models.length === 3 && c2.fresh === true);
  ok("syncedAt 被记录", c2.syncedAt === now);

  // 写缓存 + 读回（验证落盘格式）
  const wrote = C.writeCache(c2.models, { syncedAt: now });
  ok("写缓存成功", wrote === true);
  const back = C.readCache();
  ok("读回缓存", back && Array.isArray(back.models) && back.models.length === 3);
  ok("缓存带 syncedAt", back && back.syncedAt === now);
  ok("缓存落的是真实 runtime 路径", existsSync(origCache));
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
  try { rmSync(origCache, { force: true }); } catch (e) {}
}

/* ---------------- 默认模型挑选 ---------------- */
console.log("\n[6] pickDefaultModel");
ok("优先用设置里的", C.pickDefaultModel(catalog, "glm-5.2") === "glm-5.2");
ok("设置里的不可聊则不用", C.pickDefaultModel(catalog, "seedance-2.5") === "deepseek-v4-pro");
ok("没有偏好就取第一个可聊的", C.pickDefaultModel(catalog, "") === "deepseek-v4-pro");
ok("空目录 -> 空", C.pickDefaultModel([], "") === "");

console.log("\n模型目录（B3）回归：" + pass + " 通过 / " + (pass + failures.length) + " 项");
if (failures.length) { console.log("失败项："); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
