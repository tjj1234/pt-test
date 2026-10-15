"use strict";
/**
 * model-catalog.cjs —— 模型目录：每日自动同步 + 智能路由（任务包 B · B3）
 * ============================================================================
 * 以前模型列表是 shell/dsh-settings.yaml 里手抄的一份静态白名单，三个毛病：
 *   ① PT 上了新模型，得有人手动改 yaml 再重启，否则用户永远看不到；
 *   ② 白名单筛掉了图片/视频/语音等生成类模型 —— 用户想切成 seedance 才发现没有；
 *   ③ 默认模型写死 deepseek-v4-pro，不问用户问的是什么。
 *
 * 现在：
 *   ① 每日定时从 PT /v1/models 拉全量（不做对话能力筛选，含生成类）；
 *   ② 给每个模型标 chat 字段（是否支持多轮对话），前端靠它决定能不能聊；
 *   ③ 默认 AUTO：按用户输入简单规则路由到合适的模型，其余走默认模型。
 *
 * 三条设计取舍：
 *   · 同步失败绝不连累对话：拉不到就用上次的缓存，缓存也没有就退回 yaml 静态列表。
 *   · 全量列表只用于「展示与选择」，DSH 实际能调哪些仍由 dsh-settings.yaml 决定 ——
 *     把生成类模型塞进 DSH 配置只会让对话侧选到不能聊的模型，那是倒退。
 *   · 路由规则刻意做简单（代码/长文本/推理 三类特征），PM 验收后再精细化；
 *     规则匹配不上就退回默认模型，绝不为了「显得智能」乱选。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");

const SHELL = __dirname;
const REPO_ROOT = path.resolve(SHELL, "..");
const RUNTIME = path.join(REPO_ROOT, "runtime");
const CACHE_FILE = path.join(RUNTIME, "model-catalog.json");

/** 缓存有效期：24 小时（「每日自动同步」）。 */
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

/** AUTO：不指定模型，由服务端按输入路由。 */
const AUTO_ID = "AUTO";

/** 同步用的 baseURL（PT 网关）；测试可注入覆盖。 */
const DEFAULT_BASE_URL = "https://api.powertokens.ai/v1";

/**
 * 生成类模型的名字特征。PT 的 /v1/models 大多带 supported_endpoint_types，
 * 但有的模型字段缺失 —— 这时靠名字兜底判定，宁可判成「不可聊天」也别让用户选了干等。
 */
const GENERATIVE_KEYWORDS = [
  "seedream", "seedance", "kling", "wan", "hailuo", "vidu", "happyhorse", "mimo",
  "qwen-image", "flux", "sora", "midjourney", "dall-e", "imagen",
  "tts", "speech", "whisper", "asr", "voice", "audio", "music", "song", "sound",
  "embedding", "embed", "rerank", "moderation",
  "image", "video", "animate", "avatar", "lipsync",
];

/** 出现这些端点类型就认为「支持多轮对话」（与 dsh-settings.yaml 里的判定口径一致）。 */
const CHAT_ENDPOINTS = ["anthropic", "openai-response", "openai-chat", "chat", "chat-completions", "responses", "openai"];

/** 名字里有这些就认为「不擅长对话」（补充兜底，优先级低于端点判定）。 */
const NON_CHAT_SUFFIX = ["-embedding", "-rerank", "-tts", "-asr", "-img", "-image", "-video", "-audio"];

/** 取某个字段的多种可能拼写（PT 与各网关字段名不统一）。 */
function pickField(raw, names) {
  for (const n of names) {
    const v = raw && raw[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** 模型 id（PT 返回 id / name / model 三种都可能）。 */
function modelIdOf(raw) {
  return pickField(raw, ["id", "model", "name"]) || "";
}

/** 展示名：优先显式 name，其次 id。 */
function modelNameOf(raw, id) {
  const nm = pickField(raw, ["display_name", "displayName", "title", "name"]);
  return nm || id;
}

/** 端点类型列表（可能是数组或逗号分隔字符串）。 */
function endpointsOf(raw) {
  const v = raw && (raw.supported_endpoint_types || raw.supported_endpoints || raw.endpoints || raw.type || raw.object);
  if (Array.isArray(v)) return v.map((x) => String(x || "").toLowerCase());
  if (typeof v === "string") return v.split(/[,\s]+/).map((x) => x.toLowerCase()).filter(Boolean);
  return [];
}

/** 名字像不像生成类模型（端点信息缺失时的兜底）。 */
function looksGenerative(id) {
  const s = String(id || "").toLowerCase();
  if (!s) return false;
  for (const k of GENERATIVE_KEYWORDS) if (s.indexOf(k) >= 0) return true;
  for (const k of NON_CHAT_SUFFIX) if (s.endsWith(k)) return true;
  return false;
}

/**
 * 这个模型支持不支持多轮对话。
 * 判定顺序：显式端点信息 > 名字特征 > 默认 true（信息不足时按「能聊」处理，
 * 因为 PT 上绝大多数模型本来就是对话模型，标错了比漏标更烦人）。
 */
function isChatModel(raw) {
  const eps = endpointsOf(raw);
  if (eps.length) {
    for (const e of eps) for (const c of CHAT_ENDPOINTS) if (e.indexOf(c) >= 0) return true;
    // 有端点信息但没有一个是对话端点 -> 明确不可聊
    return false;
  }
  const id = modelIdOf(raw);
  if (!id) return false;
  return !looksGenerative(id);
}

/** 生成类模型细分：image / video / audio / other（仅用于前端打标签，不参与路由）。 */
function generativeKindOf(id) {
  const s = String(id || "").toLowerCase();
  if (!s) return null;
  if (/seedance|kling|wan|hailuo|vidu|happyhorse|sora|animate|lipsync|video/.test(s)) return "video";
  if (/seedream|flux|dall|imagen|midjourney|qwen-image|image|img/.test(s)) return "image";
  if (/tts|speech|whisper|asr|voice|audio|music|song|sound/.test(s)) return "audio";
  return "other";
}

/** 归一化成前端能直接用的形状。id 为空则丢弃。 */
function normalizeModel(raw) {
  const id = modelIdOf(raw);
  if (!id) return null;
  const chat = isChatModel(raw);
  return {
    id,
    name: modelNameOf(raw, id),
    chat,
    kind: chat ? "chat" : (generativeKindOf(id) || "other"),
  };
}

/** 从 PT /v1/models 的响应体里抽出模型数组（兼容 {data:[...]} / [...] / {models:[...]}）。 */
function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

/** 去重（按 id，保留先出现的）+ 排序（可聊的在前，其次按 id 字典序）。 */
function dedupeAndSort(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => {
    if (a.chat !== b.chat) return a.chat ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

/** 从归一化列表里挑一个默认对话模型：优先设置里的，其次第一个可聊的。 */
function pickDefaultModel(list, preferred) {
  const chat = list.filter((m) => m.chat);
  if (preferred && chat.some((m) => m.id === preferred)) return preferred;
  if (chat.length) return chat[0].id;
  return list.length ? list[0].id : "";
}

/* ============================================================================
 * AUTO 路由：按用户输入特征挑模型
 * ========================================================================== */

/** 像不像在问代码（有代码块、或出现明显的编程词）。 */
function looksLikeCode(text) {
  const t = String(text || "");
  if (/```/.test(t)) return true;
  if (/\b(function|const\s|let\s|var\s|class\s|def\s|import\s|from\s+\w|#include|public\s|SELECT\s|INSERT\s|=>|console\.log)\b/.test(t)) return true;
  if (/(代码|报错|异常|堆栈|编译|函数|接口|调试|bug|重构|正则)/i.test(t)) return true;
  return false;
}

/** 像不像长文本处理（原文很长，或明确说要总结/翻译/摘要）。 */
function looksLikeLongText(text) {
  const t = String(text || "");
  if (t.length > 2000) return true;
  if (/(总结|摘要|概括|归纳|翻译|润色|通读|全文|这篇文章|这份文档)/i.test(t)) return true;
  return false;
}

/** 像不像要推理/数学（规则简单点，够用即可）。 */
function looksLikeReasoning(text) {
  const t = String(text || "");
  if (/(推导|证明|计算|推理|逻辑|算法复杂度|为什么.*原理)/i.test(t)) return true;
  if (/\d+\s*[\+\-\*\/]\s*\d+/.test(t) && t.length < 200) return true;
  return false;
}

/** 在候选里按关键字挑一个（找不到返回 null）。 */
function findByKeyword(list, keywords) {
  for (const kw of keywords) {
    const hit = list.find((m) => String(m.id).toLowerCase().indexOf(kw) >= 0);
    if (hit) return hit.id;
  }
  return null;
}

/**
 * AUTO 路由：给一段用户输入，从目录里挑一个合适的对话模型。
 * 规则刻意简单（PM 说先做一版，后续精细化）：
 *   代码      -> 名字含 coder / code 的模型
 *   长文本    -> 名字含 max / pro / plus 的大杯模型
 *   推理/数学 -> 名字含 pro / max / reason 的模型
 *   其余      -> 默认模型
 * 任何一步匹配不到都退回默认模型 —— 宁可保守，也不为了「显得智能」乱选。
 */
function routeModelFor(text, list, fallback) {
  const chat = (Array.isArray(list) ? list : []).filter((m) => m && m.chat && m.id);
  if (!chat.length) return fallback || "";
  const safeFallback = fallback && chat.some((m) => m.id === fallback) ? fallback : chat[0].id;

  if (looksLikeCode(text)) {
    const hit = findByKeyword(chat, ["coder", "code"]);
    if (hit) return hit;
  }
  if (looksLikeReasoning(text)) {
    const hit = findByKeyword(chat, ["reason", "pro", "max"]);
    if (hit) return hit;
  }
  if (looksLikeLongText(text)) {
    const hit = findByKeyword(chat, ["max", "pro", "plus"]);
    if (hit) return hit;
  }
  return safeFallback;
}

/* ============================================================================
 * 缓存与同步
 * ========================================================================== */

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!j || !Array.isArray(j.models)) return null;
    return j;
  } catch (e) { return null; }
}

function writeCache(models, meta) {
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      syncedAt: (meta && meta.syncedAt) || Date.now(),
      source: (meta && meta.source) || "pt",
      count: models.length,
      models,
    }, null, 2));
    fs.renameSync(tmp, CACHE_FILE);   // 原子替换，避免同步到一半被读到半截文件
    return true;
  } catch (e) { return false; }
}

/** 缓存是否过期（没有缓存也算过期）。 */
function isStale(cache, now) {
  if (!cache || typeof cache.syncedAt !== "number") return true;
  return (now || Date.now()) - cache.syncedAt > SYNC_TTL_MS;
}

/**
 * 从 PT /v1/models 拉全量模型。
 * @param {object} opts
 * @param {string} opts.apiKey     PT API key（没有就不同步）
 * @param {string} [opts.baseURL]
 * @param {function} [opts.fetchImpl]  注入用（测试不打真网络）
 * @returns {Promise<{ok:boolean, models:Array, error?:string}>}
 */
async function syncFromPt(opts) {
  const o = opts || {};
  const key = String(o.apiKey || "").trim();
  if (!key) return { ok: false, models: [], error: "没有可用的 PT key，跳过同步" };
  const base = String(o.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = typeof o.fetchImpl === "function" ? o.fetchImpl : (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return { ok: false, models: [], error: "当前环境没有 fetch，跳过同步" };

  try {
    const r = await fetchImpl(base + "/models", {
      headers: { Authorization: "Bearer " + key },
    });
    if (!r || r.ok === false) return { ok: false, models: [], error: "PT 返回 " + ((r && r.status) || "错误") };
    const payload = typeof r.json === "function" ? await r.json() : r;
    const raw = extractList(payload);
    const models = dedupeAndSort(raw.map(normalizeModel).filter(Boolean));
    if (!models.length) return { ok: false, models: [], error: "PT 返回的模型列表为空" };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: (e && e.message) || String(e) };
  }
}

/**
 * 取模型目录（主入口）：缓存新鲜就用缓存，过期就试着同步，同步失败退回旧缓存。
 * @param {object} opts
 * @param {Array} [opts.fallback]  兜底静态列表（通常是 readModels() 从 yaml 读的）
 * @param {boolean} [opts.force]   忽略 TTL 强制同步
 */
async function getCatalog(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const cache = readCache();
  let syncError = null;
  let syncedAt = cache ? cache.syncedAt : 0;
  let models = cache ? cache.models : null;
  let fresh = false;

  if (o.force || isStale(cache, now)) {
    const r = await syncFromPt(o);
    if (r.ok && r.models.length) {
      writeCache(r.models, { syncedAt: now, source: "pt" });
      models = r.models;
      syncedAt = now;
      fresh = true;
    } else {
      syncError = r.error || "同步失败";
    }
  }

  if (!models || !models.length) {
    // 一次都没同步成功过：退回 yaml 静态列表（全部按「可聊」处理，因为那本来就是对话白名单）
    models = dedupeAndSort((o.fallback || []).map((m) => normalizeModel(m)).filter(Boolean));
  }

  return { models, syncedAt, fresh, syncError, auto: AUTO_ID };
}

module.exports = {
  AUTO_ID,
  SYNC_TTL_MS,
  CACHE_FILE,
  DEFAULT_BASE_URL,
  GENERATIVE_KEYWORDS,
  CHAT_ENDPOINTS,
  pickField,
  modelIdOf,
  modelNameOf,
  endpointsOf,
  looksGenerative,
  isChatModel,
  generativeKindOf,
  normalizeModel,
  extractList,
  dedupeAndSort,
  pickDefaultModel,
  looksLikeCode,
  looksLikeLongText,
  looksLikeReasoning,
  findByKeyword,
  routeModelFor,
  readCache,
  writeCache,
  isStale,
  syncFromPt,
  getCatalog,
};
