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
 *   ② 保留 PT 能力事实与来源；缺少明确元数据时 chat 为 null（unknown）；
 *   ③ 默认 AUTO：按用户输入简单规则路由到合适的模型，其余走默认模型。
 *
 * 三条设计取舍：
 *   · 同步失败绝不连累对话：拉不到就用上次的缓存，缓存也没有就退回 yaml 静态列表。
 *   · 目录发现、能力证据、runtime adapter 与验证状态分开；模型名/端点不能授予 AUTO 资格。
 *   · 路由规则刻意做简单（代码/长文本/推理 三类特征），PM 验收后再精细化；
 *     规则匹配不上就退回默认模型，绝不为了「显得智能」乱选。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const capabilityModel = require("./models/capabilities.cjs");
const scopedCache = require("./models/catalog-cache.cjs");

const SHELL = __dirname;
const REPO_ROOT = path.resolve(SHELL, "..");
const RUNTIME = process.env.PT_RUNTIME_DIR ? path.resolve(process.env.PT_RUNTIME_DIR) : path.join(REPO_ROOT, "runtime");
const CACHE_FILE = path.join(RUNTIME, "model-catalog.json");

/** 缓存有效期：24 小时（「每日自动同步」）。 */
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

/** AUTO：不指定模型，由服务端按输入路由。 */
const AUTO_ID = "AUTO";

/** 同步用的 baseURL（PT 网关）；测试可注入覆盖。 */
const DEFAULT_BASE_URL = "https://api.powertokens.ai/v1";
const CATALOG_FAILURE_STAGES = Object.freeze([
  "scope", "qualification", "cache_read", "fetch_or_parse", "merge",
  "local_update", "cache_write", "projection", "fallback_projection",
]);
function markCatalogStage(opts, stage) {
  if (!CATALOG_FAILURE_STAGES.includes(stage)) return;
  try { if (typeof opts?.onCatalogStage === "function") opts.onCatalogStage(stage); } catch { /* diagnostic observer must not affect catalog behavior */ }
}

/**
 * 名称特征只用于 kind 展示分组，不用来判断能力或 AUTO 资格。
 */
const GENERATIVE_KEYWORDS = [
  "seedream", "seedance", "kling", "wan", "hailuo", "vidu", "happyhorse", "mimo",
  "qwen-image", "flux", "sora", "midjourney", "dall-e", "imagen",
  "tts", "speech", "whisper", "asr", "voice", "audio", "music", "song", "sound",
  "embedding", "embed", "rerank", "moderation",
  "image", "video", "animate", "avatar", "lipsync",
];

/** 出现这些端点类型就认为「支持多轮对话」（与 dsh-settings.yaml 里的判定口径一致）。 */
const CHAT_ENDPOINTS = ["anthropic", "openai-response"];

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

/** 名字像不像生成类模型（展示分组提示，不代表已证实的任务能力）。 */
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
  return normalizeModel(raw)?.chat === true;
}

/** 生成类模型细分：image / video / audio / other（仅用于展示，不证明能力）。 */
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
  let rich;
  try {
    rich = capabilityModel.normalizePtRecord({ ...(raw && typeof raw === "object" ? raw : {}), id }, {
      scopeId: "projection-only",
      observedAt: new Date().toISOString(),
      sourceVersion: "PT /v1/models",
    });
  } catch { return null; }
  if (!rich) return null;
  const chat = rich.tasks.textChat.value;
  return {
    id,
    name: rich.name || modelNameOf(raw, id),
    chat,
    kind: chat === true ? "chat" : (generativeKindOf(id) || "other"),
    capabilityRevision: rich.capabilityRevision,
    capabilityScopeId: rich.scopeId,
    tasks: rich.tasks,
    inputModalities: rich.inputModalities,
    outputModalities: rich.outputModalities,
    endpoints: rich.endpoints,
    protocol: rich.protocol,
    features: rich.features,
    limits: rich.limits,
    metadataFields: rich.metadataFields,
    capabilityFields: rich.capabilityFields,
    availability: rich.availability,
    permission: rich.permission,
    localPolicy: rich.localPolicy,
    adaptations: rich.adaptations,
    verifications: rich.verifications,
    states: rich.states,
    capabilityStatus: chat === null ? "unknown" : chat ? "supported" : "unsupported",
    runtimeStatus: rich.states.textChat.verified ? "verified" : rich.states.textChat.adapted ? "adapted_unverified" : "unadapted",
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
  const chat = list.filter((m) => m && m.chat === true && (!m.capabilityRevision || m.states?.textChat?.autoEligible === true));
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
  const all = Array.isArray(list) ? list : [];
  const chat = all.filter((m) => m && m.chat === true && m.id && (!m.capabilityRevision || m.states?.textChat?.autoEligible === true));
  if (!chat.length) return all.some((m) => m && m.capabilityRevision) ? "" : (fallback || "");
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

function readScopedCache(scopeId, options = {}) {
  return scopedCache.readScopedCache(options.cacheDir || RUNTIME, scopeId);
}

function writeScopedCache(scopeId, snapshot, options = {}) {
  return scopedCache.writeScopedCache(options.cacheDir || RUNTIME, scopeId, snapshot);
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

function responseHasUnfollowedPages(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const pageObjects = [payload];
  for (const candidate of [payload.pagination, payload.meta?.pagination]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) pageObjects.push(candidate);
  }
  return pageObjects.some((page) => page.has_more === true || page.hasMore === true || page.has_next === true || page.hasNext === true ||
    page.next_cursor != null || page.nextCursor != null || page.next_page != null || page.nextPage != null ||
    (typeof page.next === "string" && page.next.length > 0) || (page.links && typeof page.links.next === "string" && page.links.next.length > 0));
}

async function fetchPtSnapshot(opts = {}) {
  const apiKey = String(opts.apiKey || "").trim();
  if (!apiKey) return { ok: false, error: "PT credential unavailable", errorCode: "PT_CREDENTIAL_UNAVAILABLE" };
  const baseURL = String(opts.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return { ok: false, error: "fetch unavailable", errorCode: "FETCH_UNAVAILABLE" };
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, 60000) : 10000;
  let timeout;
  try {
    const operation = (async () => {
      const response = await fetchImpl(baseURL + "/models", { headers: { Authorization: "Bearer " + apiKey }, ...(controller ? { signal: controller.signal } : {}) });
      if (!response || response.ok === false) return { ok: false, error: "PT models request failed", errorCode: "PT_HTTP_ERROR", status: Number(response?.status) || null };
      let payload;
      try { payload = typeof response.json === "function" ? await response.json() : response; }
      catch { return { ok: false, error: "PT models response was not valid JSON", errorCode: "PT_INVALID_RESPONSE", status: Number(response.status) || null }; }
      const records = extractList(payload);
      const hasUnfollowedPages = responseHasUnfollowedPages(payload);
      // Returned IDs are trusted permission facts even on a partial page. Keep
      // completeness separate: only a caller-verified terminal snapshot may
      // tombstone models omitted from this response.
      const complete = !hasUnfollowedPages && typeof opts.isCompleteSnapshot === "function" && opts.isCompleteSnapshot(payload, response) === true;
      if (!records.length && !complete && !hasUnfollowedPages) return { ok: false, error: "PT models response has no records and no completeness evidence", errorCode: "PT_EMPTY_OR_UNRECOGNIZED_RESPONSE", status: Number(response.status) || null };
      const version = response.headers?.get?.("etag") || response.headers?.get?.("x-api-version") || null;
      return { ok: true, records, complete, sourceVersion: typeof version === "string" && /^[A-Za-z0-9._:+-]{1,128}$/.test(version) ? version : null };
    })();
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timeout = setTimeout(() => { controller?.abort(); reject(Object.assign(new Error("PT model sync timeout"), { code: "MODEL_SYNC_TIMEOUT" })); }, timeoutMs); }),
    ]);
  } catch (error) {
    return error?.code === "MODEL_SYNC_TIMEOUT"
      ? { ok: false, error: "PT models request timed out", errorCode: "PT_TIMEOUT" }
      : { ok: false, error: "PT models request failed", errorCode: "PT_NETWORK_ERROR" };
  } finally { clearTimeout(timeout); }
}

const inFlightByScope = new Map();
function expandQualificationDefaults(options, ids) {
  const defaults = options.qualificationDefaults;
  if (!defaults || typeof defaults !== "object") return options;
  const expanded = { ...options };
  if (defaults.policy) {
    const policies = { ...(options.policies || {}) };
    for (const id of ids) if (typeof id === "string" && id && !Object.hasOwn(policies, id)) policies[id] = defaults.policy;
    expanded.policies = policies;
  }
  return expanded;
}
function hasExplicitTextChatTextIo(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const trustedChatEndpoint = Array.isArray(record.supported_endpoint_types) && record.supported_endpoint_types.some((endpoint) => CHAT_ENDPOINTS.includes(endpoint));
  const capability = record.capabilities?.textChat === true || record.capabilities?.["text-chat"] === true;
  const supported = Array.isArray(record.supported_tasks) && record.supported_tasks.some((task) => task === "textChat" || task === "text-chat");
  const hasTextIo = (Array.isArray(record.input_modalities) ? record.input_modalities.includes("text") : trustedChatEndpoint) &&
    (Array.isArray(record.output_modalities) ? record.output_modalities.includes("text") : trustedChatEndpoint);
  return (capability || supported || trustedChatEndpoint) && hasTextIo;
}
function cacheIsStale(cache, now) {
  return !cache || typeof cache.lastSuccessfulAt !== "string" || !Number.isFinite(Date.parse(cache.lastSuccessfulAt)) ||
    now - Date.parse(cache.lastSuccessfulAt) > SYNC_TTL_MS;
}

async function syncScopedCatalog(scopeId, opts, previous, now) {
  const pending = inFlightByScope.get(scopeId);
  if (pending) return pending;
  const promise = (async () => {
    markCatalogStage(opts, "fetch_or_parse");
    const fetched = await fetchPtSnapshot(opts);
    markCatalogStage(opts, "merge");
    let mergeOptions = {};
    for (const key of ["permission", "policies", "adaptations", "verifications", "overrides"]) {
      if (Object.hasOwn(opts, key)) mergeOptions[key] = opts[key];
    }
    if (!fetched.ok) {
      // A stale authenticated listing cannot prove that this credential still
      // has access; retain catalog facts but close execution permission.
      mergeOptions.permission = null;
      mergeOptions = expandQualificationDefaults({ ...opts, ...mergeOptions }, (previous?.models || []).map((model) => model.id));
      const retained = capabilityModel.mergeSnapshot(previous, {
        scopeId, observedAt: new Date(now).toISOString(), success: false, records: null,
      }, mergeOptions);
      const failureCount = Math.min(10, (Number(previous?.syncFailureCount) || 0) + 1);
      const backoff = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000][Math.min(failureCount - 1, 4)];
      retained.syncFailureCount = failureCount;
      retained.nextSyncAt = new Date(now + backoff).toISOString();
      markCatalogStage(opts, "cache_write");
      const cacheWritten = writeScopedCache(scopeId, retained, opts);
      return {
        snapshot: retained,
        error: fetched.error,
        errorCode: cacheWritten ? (fetched.errorCode || "PT_SYNC_FAILED") : "CATALOG_CACHE_WRITE_FAILED",
        upstreamStatus: fetched.status || null,
        state: cacheWritten ? "sync_failed" : "cache_write_failed",
        failureStage: cacheWritten ? "fetch_or_parse" : "cache_write",
      };
    }
    // Under the user's confirmed PT contract, a model ID returned for this
    // credential is invocation-authorized. Apply this per ID so a partial or
    // changed directory can never authorize cached models that were not listed.
    const listedIds = new Set(fetched.records.map((record) => modelIdOf(record)).filter(Boolean));
    mergeOptions = expandQualificationDefaults({ ...opts, ...mergeOptions },
      [...new Set([...(previous?.models || []).map((model) => model.id), ...listedIds])]);
    if (opts.qualificationDefaults?.adaptation) {
      const adaptations = { ...(mergeOptions.adaptations || {}) };
      for (const record of fetched.records) {
        const id = modelIdOf(record);
        if (id && !Object.hasOwn(adaptations, id) && hasExplicitTextChatTextIo(record)) {
          adaptations[id] = { textChat: opts.qualificationDefaults.adaptation };
        }
      }
      mergeOptions.adaptations = adaptations;
    }
    mergeOptions.permissions = Object.fromEntries([
      ...new Set([...(previous?.models || []).map((model) => model.id), ...listedIds]),
    ].map((id) => [id, listedIds.has(id) ? true : null]));
    const observedAt = new Date(now).toISOString();
    const merged = capabilityModel.mergeSnapshot(previous, {
      scopeId, observedAt, sourceVersion: fetched.sourceVersion, success: true,
      complete: fetched.complete, records: fetched.records,
    }, mergeOptions);
    if (merged.events?.[0]?.type === "snapshot-ignored" && ["scope-mismatch", "stale-snapshot"].includes(merged.events[0].reason)) {
      return { snapshot: previous, error: "snapshot ignored" };
    }
    merged.syncFailureCount = 0;
    merged.nextSyncAt = null;
    markCatalogStage(opts, "cache_write");
    if (!writeScopedCache(scopeId, merged, opts)) return { snapshot: merged, error: "catalog cache write failed", errorCode: "CATALOG_CACHE_WRITE_FAILED", state: "cache_write_failed", fresh: true, failureStage: "cache_write" };
    return { snapshot: merged, error: null, errorCode: null, upstreamStatus: null, state: "fresh", fresh: true };
  })().finally(() => inFlightByScope.delete(scopeId));
  inFlightByScope.set(scopeId, promise);
  return promise;
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
  markCatalogStage(o, "scope");
  // Scope the endpoint that fetchPtSnapshot actually uses. Omitting the default
  // base must not create a second credential scope beside an explicit default.
  const scopeId = resolveCatalogScope(o);
  if (scopeId) {
    markCatalogStage(o, "cache_read");
    const prior = readScopedCache(scopeId, o);
    let snapshot = prior;
    let syncError = null, fresh = false;
    let syncState = prior ? "cached" : "fallback";
    let syncErrorCode = null, upstreamStatus = null;
    let syncFailureStage = null;
    const backoffActive = !o.force && prior?.nextSyncAt && Number.isFinite(Date.parse(prior.nextSyncAt)) && now < Date.parse(prior.nextSyncAt);
    if (!backoffActive && (o.force || cacheIsStale(prior, now))) {
      const result = await syncScopedCatalog(scopeId, o, prior, now);
      snapshot = result.snapshot;
      syncError = result.error;
      fresh = result.fresh === true;
      syncState = result.state || (syncError ? "sync_failed" : "fresh");
      syncErrorCode = result.errorCode || null;
      upstreamStatus = result.upstreamStatus || null;
      syncFailureStage = result.failureStage || (result.errorCode === "CATALOG_CACHE_WRITE_FAILED" ? "cache_write" : null);
    } else if (backoffActive) {
      syncError = "Model catalog sync is in retry backoff";
      syncState = "backoff";
      syncErrorCode = "CATALOG_SYNC_BACKOFF";
    }
    markCatalogStage(o, "local_update");
    let localUpdates = {};
    for (const key of ["permission", "permissions", "policies", "adaptations", "verifications", "overrides"]) {
      if (Object.hasOwn(o, key)) localUpdates[key] = o[key];
    }
    if (snapshot) localUpdates = expandQualificationDefaults({ ...localUpdates, qualificationDefaults: o.qualificationDefaults },
      (snapshot.models || []).map((model) => model.id));
    if (snapshot && Object.keys(localUpdates).length) {
      // Reuse the capability model's local update/revalidation rules even when
      // TTL or retry backoff prevents a provider fetch. Revocation cannot wait
      // for the next successful network synchronization.
      const updated = capabilityModel.mergeSnapshot(snapshot, {
        scopeId, observedAt: new Date(now).toISOString(), success: false, records: null,
      }, localUpdates);
      updated.events = snapshot.events;
      snapshot = updated;
      markCatalogStage(o, "cache_write");
      if (!writeScopedCache(scopeId, snapshot, o)) {
        syncError = syncError || "catalog local policy cache write failed";
        syncErrorCode = syncErrorCode || "CATALOG_CACHE_WRITE_FAILED";
        syncState = "cache_write_failed";
        syncFailureStage = "cache_write";
      }
    }
    markCatalogStage(o, "projection");
    let models = (snapshot?.models || []).map((model) => ({
      ...model,
      chat: model.tasks?.textChat?.value ?? null,
      kind: model.tasks?.textChat?.value === true ? "chat" : (generativeKindOf(model.id) || "other"),
      capabilityStatus: model.tasks?.textChat?.value == null ? "unknown" : model.tasks.textChat.value ? "supported" : "unsupported",
      runtimeStatus: model.states?.textChat?.verified ? "verified" : model.states?.textChat?.adapted ? "adapted_unverified" : "unadapted",
    }));
    // Availability comes only from the scoped successful snapshot, never from
    // display fallbacks. A later failed refresh retains the last known evidence.
    const knownAvailability = Boolean(snapshot?.lastSuccessfulAt && Number.isFinite(Date.parse(snapshot.lastSuccessfulAt)));
    const availability = {
      status: knownAvailability ? "available" : "unknown",
      modelIds: knownAvailability ? (snapshot.models || []).filter((model) => model.availability === "present").map((model) => model.id) : [],
    };
    if (!models.length) {
      markCatalogStage(o, "fallback_projection");
      models = dedupeAndSort((o.fallback || []).map(normalizeModel).filter(Boolean).map((model) => ({ ...model, source: "static-config" })));
    }
    const syncedAt = snapshot?.lastSuccessfulAt ? Date.parse(snapshot.lastSuccessfulAt) : 0;
    return {
      models, availability, syncedAt, fresh, syncError, auto: AUTO_ID, scopeId,
      catalogDiagnostics: {
        state: syncState,
        errorCode: syncErrorCode,
        upstreamStatus,
        lastSuccessfulAt: snapshot?.lastSuccessfulAt || null,
        failureCount: Math.max(0, Number(snapshot?.syncFailureCount) || 0),
        failureCountKnown: true,
        retryAt: snapshot?.nextSyncAt || null,
        modelCount: models.length,
        failureStage: syncFailureStage || null,
      },
    };
  }

  // No credential means no previous credential-scoped cache can be trusted.
  markCatalogStage(o, "cache_read");
  const cache = null;
  let syncError = null;
  let syncedAt = 0;
  let models = null;
  let fresh = false;

  if (o.force || isStale(cache, now)) {
    markCatalogStage(o, "fetch_or_parse");
    const r = await syncFromPt(o);
    if (r.ok && r.models.length) {
      markCatalogStage(o, "cache_write");
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
    markCatalogStage(o, "fallback_projection");
    models = dedupeAndSort((o.fallback || []).map((m) => normalizeModel(m)).filter(Boolean));
  }

  return {
    models, availability: { status: "unknown", modelIds: [] }, syncedAt, fresh, syncError, auto: AUTO_ID,
    catalogDiagnostics: {
      state: "fallback",
      errorCode: syncError ? "PT_SYNC_FAILED" : null,
      upstreamStatus: null,
      lastSuccessfulAt: null,
      failureCount: 0,
      failureCountKnown: true,
      retryAt: null,
      modelCount: models.length,
      failureStage: syncError ? "fetch_or_parse" : null,
    },
  };
}

function resolveCatalogScope(options = {}) {
  return scopedCache.resolveScopeId({ ...options, baseURL: options.baseURL || DEFAULT_BASE_URL });
}

// A completed manual product Run can qualify exactly the model/adapter/scope
// it exercised. Read the current cache again so a catalog revision or
// permission change between routing and completion cannot be promoted.
function recordManualChatVerification({ catalog, modelId, runId, budget, modelIdentity, cacheDir,task='textChat',imageInput } = {}) {
  if(!['textChat','imageUnderstanding'].includes(task))return false;
  if(task==='imageUnderstanding'&&(imageInput?.kind!=='dsh-native-images-v1'||imageInput.capabilityChecked!==true||
      !Number.isSafeInteger(imageInput.newImageCount)||imageInput.newImageCount<1||imageInput.newImageCount>4))return false;
  if (!catalog || !/^pt-scope-[a-f0-9]{64}$/.test(catalog.scopeId || '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId || '') ||
      typeof modelId !== 'string' || budget?.snapshot?.modelCalls !== 1 ||
      budget?.snapshot?.policyStatus !== 'configured') return false;
  const qualify=task==='imageUnderstanding'?model=>require('./models/native-image-qualification.cjs').nativeImageCandidates({models:[model]})[0]:model=>model;
  const routedRaw=catalog.models?.find(model => model.id === modelId);
  const routed=routedRaw?qualify(routedRaw):null;
  const snapshot = readScopedCache(catalog.scopeId, { cacheDir });
  const index = snapshot?.models?.findIndex(model => model.id === modelId) ?? -1;
  if (!routed || index < 0 || snapshot.lastSuccessfulAt == null ||
      catalog.availability?.status !== 'available' ||
      !catalog.availability.modelIds?.includes(modelId)) return false;
  const current = qualify(snapshot.models[index]);
  if (current.capabilityRevision !== routed.capabilityRevision ||
      current.scopeId !== catalog.scopeId || current.permission !== true ||
      current.availability !== 'present' || current.tasks?.[task]?.value !== true ||
      current.localPolicy?.enabled !== true || !current.localPolicy.tasks?.includes(task) ||
      current.states?.[task]?.adapted !== true || current.states?.[task]?.endpointCompatible !== true ||
      !current.inputModalities?.value?.includes('text') || !current.outputModalities?.value?.includes('text')) return false;
  if(task==='imageUnderstanding'&&!current.inputModalities.value.includes('image'))return false;
  const adapter = current.adaptations?.[task];
  if (!adapter?.adapterId || !adapter.version || !adapter.endpoint) return false;
  const responses = modelIdentity?.responses;
  if (!Array.isArray(responses) || responses.length !== 1 ||
      responses[0]?.configuredModelId !== modelId ||
      (responses[0].providerReportedModelId != null && responses[0].providerReportedModelId !== modelId)) return false;
  const verifiedAt = new Date().toISOString();
  const verification = { status:'passed', modelId, task, adapterId:adapter.adapterId,
    adapterVersion:adapter.version, endpoint:adapter.endpoint, scopeId:catalog.scopeId,
    capabilityRevision:current.capabilityRevision, source:`product-run/${runId}` , verifiedAt };
  const updated = capabilityModel.applyLocalUpdates(current, {
    verifications:{ [modelId]:{ ...current.verifications, [task]:verification } },
  });
  if (updated.states?.[task]?.verified !== true || updated.states?.[task]?.autoEligible !== true) return false;
  snapshot.models[index] = updated;
  return writeScopedCache(catalog.scopeId, snapshot, { cacheDir }) === true;
}

function recordManualTextChatVerification(input){return recordManualChatVerification({...input,task:'textChat'});}
function recordManualImageUnderstandingVerification(input){return recordManualChatVerification({...input,task:'imageUnderstanding'});}

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
  readScopedCache,
  writeScopedCache,
  isStale,
  syncFromPt,
  fetchPtSnapshot,
  resolveScopeId: resolveCatalogScope,
  CATALOG_FAILURE_STAGES,
  getCatalog,
  recordManualTextChatVerification,
  recordManualImageUnderstandingVerification,
};
