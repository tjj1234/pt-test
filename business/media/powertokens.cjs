"use strict";
/**
 * business/media/powertokens.cjs —— media.route 的模型分类映射 + PowerTokens 调用层
 * ============================================================================
 * 职责：
 *   1. MODEL_ROUTING：把 taskType（文生图/图生图/文生视频/图生视频）映射到
 *      PowerTokens 里现有的代表模型 id（本阶段每类 1 个代表模型，跑通链路，
 *      后续再按需扩充模型池）。
 *   2. callMediaRoute(context, args, opts)：按 taskType 选模型、调 PowerTokens
 *      生成接口、必要时轮询异步任务，最终返回结果（图片/视频）URL。
 *
 * 说明：
 *   - baseURL 沿用 PowerTokens CLI 的规则：默认 https://api.powertokens.ai，
 *     可用 POWERTOKENS_BASE_URL 覆盖；路径自带 /v1 或 /kling/v1 等前缀。
 *   - API Key 从 opts.apiKey 或 process.env.POWERTOKENS_API_KEY 读取（BYOK）。
 *   - fetch 可用 opts.fetchImpl 注入（单测 mock 用），默认用全局 fetch（Node>=18）。
 *
 * 模型选型（源数据见 shell/dsh-settings.yaml）：
 *   - 文生图/图生图：seedream-5-0-260128（openai-compatible /v1/images/generations）
 *   - 文生视频/图生视频：wan2.7-t2v / wan2.7-i2v（/v1/videos）
 * ============================================================================
 */

const DEFAULT_BASE_URL = process.env.POWERTOKENS_BASE_URL || "https://api.powertokens.ai";

const { getStylePreset, listStylePresets } = require("./presets.cjs");

/**
 * 模型分类映射表：taskType -> 路由配置。
 * kind：image（走 /v1/images/generations）| video（走 /v1/videos）。
 * needsImage：该任务是否必须有输入图片（图生图 / 图生视频）。
 */
const MODEL_ROUTING = {
  text2image: {
    taskType: "text2image",
    label: "文生图",
    model: "seedream-5-0-260128",
    provider: "seedream",
    kind: "image",
    needsImage: false,
  },
  image2image: {
    taskType: "image2image",
    label: "图生图",
    model: "seedream-5-0-260128",
    provider: "seedream",
    kind: "image",
    needsImage: true,
  },
  text2video: {
    taskType: "text2video",
    label: "文生视频",
    model: "wan2.7-t2v",
    provider: "wan",
    kind: "video",
    needsImage: false,
  },
  image2video: {
    taskType: "image2video",
    label: "图生视频",
    model: "wan2.7-i2v",
    provider: "wan",
    kind: "video",
    needsImage: true,
  },
};

const TASK_TYPES = Object.keys(MODEL_ROUTING);

// These are wire contracts implemented below, not claims about any catalog
// model. A trusted host must qualify a model for one of these exact contracts.
const MEDIA_ADAPTERS = Object.freeze({
  "pt-python-video-v1": Object.freeze({
    adapterId: "pt-python-video-v1", version: "1", endpoint: "openai-videos",
    path: "/v1/videos", provider: "powertokens-video", kind: "video",
    taskTypes: Object.freeze(["text2video", "image2video"]),
  }),
  "pt-python-seedance-v1": Object.freeze({
    adapterId: "pt-python-seedance-v1", version: "1", endpoint: "openai-videos",
    path: "/v1/videos", provider: "powertokens-video", kind: "seedance",
    taskTypes: Object.freeze(["text2video", "image2video"]),
  }),
  "pt-image-generations-v1": Object.freeze({
    adapterId: "pt-image-generations-v1", version: "1", endpoint: "openai-images-generations",
    path: "/v1/images/generations", provider: "powertokens-image", kind: "image",
    taskTypes: Object.freeze(["text2image", "image2image"]),
  }),
  "pt-video-generations-v1": Object.freeze({
    adapterId: "pt-video-generations-v1", version: "1", endpoint: "openai-videos",
    path: "/v1/videos", provider: "powertokens-video", kind: "video",
    taskTypes: Object.freeze(["text2video", "image2video"]),
  }),
});

function routeError(code) { return Object.assign(new Error(code), { code }); }
function boundedIdentity(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

/** Validate a host decision's shape, never grant permission from this object.
 * Only trusted host code may provide opts.resolvedRoute after current-scope
 * catalog qualification; child/tool args must never be forwarded into opts.
 */
function validateResolvedMediaRoute(route, taskType) {
  if (!route || typeof route !== "object" || Array.isArray(route) || route.schemaVersion !== 1 ||
      !Object.hasOwn(MODEL_ROUTING, taskType) || route.taskType !== taskType ||
      !boundedIdentity(route.model) || !boundedIdentity(route.scopeId) ||
      !/^[a-f0-9]{64}$/.test(route.capabilityRevision || "")) throw routeError("MEDIA_ROUTE_INVALID");
  const adapter = Object.hasOwn(MEDIA_ADAPTERS, route.adapterId) ? MEDIA_ADAPTERS[route.adapterId] : null;
  if (!adapter || route.adapterVersion !== adapter.version || !adapter.taskTypes.includes(taskType) ||
      route.endpoint !== adapter.endpoint || route.provider !== adapter.provider || route.kind !== adapter.kind) {
    throw routeError("MEDIA_ADAPTER_UNSUPPORTED");
  }
  // Reconstruct the route: extra keys cannot inject a URL, parameters or provider.
  return Object.freeze({ schemaVersion: 1, taskType, model: route.model,
    scopeId: route.scopeId, capabilityRevision: route.capabilityRevision,
    adapterId: adapter.adapterId, adapterVersion: adapter.version, endpoint: adapter.endpoint,
    provider: adapter.provider, kind: adapter.kind, path: adapter.path,
    label: MODEL_ROUTING[taskType].label, needsImage: MODEL_ROUTING[taskType].needsImage });
}

function resolveRouting(taskType) {
  const t = String(taskType || "").trim();
  const routing = MODEL_ROUTING[t];
  if (!routing) {
    throw new Error(`未知的 taskType "${t}"，可选：${TASK_TYPES.join(", ")}`);
  }
  return routing;
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function upstreamHttpError(status, operation) {
  const codes = {401:"KEY_INVALID",402:"QUOTA_INSUFFICIENT",403:"UPSTREAM_FORBIDDEN"};
  const hints = {401:"API Key 无效或已过期",402:"账户余额不足",403:"模型已下架或当前 Key 无此模型权限"};
  const error = new Error(`PowerTokens ${operation} HTTP ${status}: ${hints[status] || "上游请求失败"}`);
  error.code = codes[status] || "UPSTREAM_HTTP_ERROR";
  error.upstreamStatus = status;
  return error;
}

async function postJson(fetchImpl, url, body, apiKey) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    // 单个 POST 请求超时（生成接口偶发同步等待较久，给足 3 分钟；防无限挂起）
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch {}
    throw upstreamHttpError(res.status, "提交");
  }
  return res.json();
}

/** 指数退避的轮询间隔（与 CLI 一致：2s 起步，上限 30s）。 */
function pollDelay(attempts) {
  return Math.min(2000 * Math.pow(2, Math.min(attempts, 4)), 30000);
}

/** 成功/失败状态词表（坑 01：文档枚举不可信，多路兜底，含常见变体）。 */
const SUCCESS_STATUSES = new Set(["completed", "succeeded", "success", "successful", "finished", "done", "ready", "ok"]);
const FAIL_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "expired", "rejected", "timeout"]);
const PENDING_STATUSES = new Set(["pending", "queued", "running", "processing", "in_progress", "submitted", "created", "waiting"]);

/** 从任意嵌套结构里递归收集 http/https URL（坑 01：兼容 data/result/task 包裹与别名键）。 */
function collectHttpUrls(node, out) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const value of node) collectHttpUrls(value, out);
    return out;
  }
  // Only result fields can contain a generated asset. A task/status URL, input
  // image, documentation link or error URL is never a generated result.
  for (const key of ["url", "image_url", "video_url"]) {
    const value = node[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) out.push(value);
  }
  for (const key of ["data", "result", "output", "images", "videos", "content", "metadata"]) {
    if (node[key] && typeof node[key] === "object") collectHttpUrls(node[key], out);
  }
  return out;
}

/** 多路读取任务状态字符串（坑 01：兼容多种包裹结构）。 */
function readStatus(data) {
  if (!data) return "";
  const s = data.status
    || (data.data && data.data.status)
    || (data.result && data.result.status)
    || (data.task && data.task.status)
    || (data.metadata && data.metadata.status);
  return typeof s === "string" ? s.trim() : "";
}

/** 判断 progress 是否已达 100（坑 01：进度兜底）。 */
function isProgressComplete(data) {
  if (!data) return false;
  const p = data.progress
    ?? (data.data && data.data.progress)
    ?? (data.result && data.result.progress)
    ?? (data.task && data.task.progress)
    ?? (data.metadata && data.metadata.progress);
  const n = Number(p);
  return Number.isFinite(n) && n >= 100;
}

/** 查询一次任务状态，返回 { httpStatus, json, text }，不抛异常（供轮询区分 429/5xx/200）。 */
async function fetchTaskStatus(fetchImpl, url, apiKey) {
  const res = await fetchImpl(url, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { httpStatus: res.status, json, text };
}

/**
 * 通用任务轮询（坑 01/02/03/07/12/13 收敛版）：
 *  - 成功判定多路兜底：拿到产物 URL > status 命中成功词表 > progress≥100；
 *  - 429 单独计数（宽阈值 + 指数退避上限 60s）；5xx 严阈值快速失败；其余非 200 立即报错；
 *  - 200 但读不出 status/URL/progress 时显式计数熔断并打印原始响应；
 *  - timeoutMs 仅作「本地轮询守护」，非 PT 服务端上限。
 */
async function pollTask(fetchImpl, statusUrl, apiKey, timeoutMs, kind) {
  const start = Date.now();
  let attempts = 0;
  let server5xx = 0;
  let rateLimited = 0;
  let unreadable = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const { httpStatus, json } = await fetchTaskStatus(fetchImpl, statusUrl, apiKey);

    if (httpStatus === 429) {
      rateLimited++;
      if (rateLimited > 30) throw new Error(`${kind}任务查询连续 ${rateLimited} 次 429 限流，熔断退出`);
      await sleep(Math.min(2000 * Math.pow(2, Math.min(rateLimited, 5)), 60000));
      continue;
    }
    if (httpStatus >= 500) {
      server5xx++;
      if (server5xx >= 8) throw new Error(`${kind}任务查询连续 ${server5xx} 次 5xx（${httpStatus}），熔断退出`);
      await sleep(pollDelay(attempts));
      continue;
    }
    if (httpStatus !== 200) {
      throw upstreamHttpError(httpStatus, `${kind}任务查询`);
    }

    // 200：重置两个错误计数器（坑 13：查询成功即恢复）
    server5xx = 0;
    rateLimited = 0;

    const data = json;
    const outUrl = kind === "video" ? extractVideoUrl(data) : extractImageUrl(data);
    const status = readStatus(data).toLowerCase();
    if (status && FAIL_STATUSES.has(status)) {
      throw new Error(`${kind}任务失败（status=${status}）`);
    }
    if (outUrl && (!status || SUCCESS_STATUSES.has(status))) return data;
    if (status && SUCCESS_STATUSES.has(status)) return data;
    if ((!status || SUCCESS_STATUSES.has(status)) && isProgressComplete(data)) return data;

    if (PENDING_STATUSES.has(status)) {
      // 只有已识别的进行中状态才能清除异常计数；未知枚举不能静默空转。
      unreadable = 0;
    } else {
      // 状态缺失或未知枚举：显式计数熔断（坑 02/12）
      unreadable++;
      if (unreadable >= 40) {
        throw new Error(`${kind}任务连续 ${unreadable} 次状态缺失或未知，熔断退出`);
      }
    }
    await sleep(pollDelay(attempts));
  }
  throw new Error(`${kind}任务本地轮询守护超时（${Math.round(timeoutMs / 1000)}s，非 PT 服务端上限，可用 task_id 重试取回）`);
}

/** 图片任务轮询（复用 pollTask）。 */
async function pollImageTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs) {
  return pollTask(fetchImpl, `${baseUrl}/v1/tasks/${taskId}`, apiKey, timeoutMs, "图片");
}

/** 视频任务轮询（复用 pollTask）。 */
async function pollVideoTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs) {
  return pollTask(fetchImpl, `${baseUrl}/v1/videos/${taskId}`, apiKey, timeoutMs, "视频");
}

/** 从图片生成响应里提取结果 URL（兼容同步 OpenAI 风格 / 轮询后的多种结构）。 */
function extractImageUrl(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const u = extractImageUrl(item);
      if (u) return u;
    }
    return null;
  }
  if (typeof data !== "object") return null;
  const list = data.data;
  if (Array.isArray(list)) {
    for (const item of list) {
      const u = item && (item.url || item.image_url);
      if (typeof u === "string" && /^https?:\/\//.test(u)) return u;
    }
  }
  const candidates = [
    data.url,
    data.image_url,
    data.output && data.output.url,
    data.result && data.result.url,
    Array.isArray(data.images) && data.images[0] && data.images[0].url,
  ];
  for (const u of candidates) {
    if (typeof u === "string" && /^https?:\/\//.test(u)) return u;
  }
  // 递归兜底（坑 01：兼容 data/result/task 等包裹结构）
  const urls = [];
  collectHttpUrls(data, urls);
  return urls[0] || null;
}

/** 从视频生成响应里提取结果 URL（坑 01：优先常见结果字段，再递归兜底）。 */
function extractVideoUrl(data) {
  if (!data) return null;
  const preferred = (data.metadata && data.metadata.url)
    || data.video_url
    || (data.content && data.content.video_url)
    || data.url;
  if (typeof preferred === "string" && /^https?:\/\//.test(preferred)) return preferred;
  const urls = [];
  collectHttpUrls(data, urls);
  return urls[0] || null;
}

/** 校验输入图片 URL 必须可被 PowerTokens 外部访问（http/https/data:/asset:）。 */
function normalizeInputImageUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "";
  if (/^(https?:\/\/|data:|asset:\/\/)/i.test(u)) return u;
  throw new Error(
    `inputImageUrl 必须是可公网访问的 URL（http/https）或 data:/asset: 引用，当前值无法被 PowerTokens 外链访问：${u}`
  );
}

/**
 * 把风格预设模板渲染成最终 prompt。
 *  - 单一占位符模板（如「城市冰箱贴」的 {城市名称}）→ 用用户 prompt 填充占位符；
 *  - 多占位符 / 无占位符模板 → 保留模板原文，用户 prompt 作为「补充内容」追加。
 * 说明：模板来自 Nano Banana 提示词（Apache-2.0，见 presets.cjs / NOTICE），效果在 PT 模型上需实测。
 */
function renderStylePrompt(preset, userPrompt) {
  const tpl = String((preset && preset.template) || "").trim();
  const p = String(userPrompt || "").trim();
  const placeholders = [...new Set(tpl.match(/\{[^{}]+\}/g) || [])];
  if (placeholders.length === 1 && p) {
    return tpl.split(placeholders[0]).join(p);
  }
  if (p) {
    return `${tpl}\n\n补充内容：${p}`;
  }
  return tpl;
}

/**
 * 从原始 prompt 文本里解析媒体生成参数（尺寸 / 视频分辨率 / 时长 / 张数）。
 * 设计原则：只认「带分隔符或明确单位」的写法，避免误伤年份、版本号、随机数字。
 *   - 尺寸（图）：1024x1024 / 1024*768 / 1024×1024 / 1024 X 768（两段均 2~4 位正整数，≤4096）
 *   - 视频分辨率：1080p / 720p / 4k / 2160p（统一归并为 1080P / 720P；PT 视频端点仅支持这两档）
 *   - 视频时长：10s / 10秒 / 10 seconds / 时长10（正整数 + 单位）
 *   - 张数（图）：n=2 / 数量2 / 2张（明确标记，避免误伤）
 * 解析不到则返回对应字段 undefined，由调用方继续走兜底默认值（绝不静默覆盖合法值）。
 * @param {string} prompt
 * @returns {{ size?: string, resolution?: "1080P"|"720P", duration?: number, n?: number }}
 */
function parseMediaParams(prompt) {
  const p = String(prompt || "");
  const out = {};

  // 尺寸（图）：带 x / × / * / 空格 分隔的两段数字（年份「2024」无分隔符，不会被误判）
  const sizeM = p.match(/(?:^|[^0-9])([1-9]\d{1,3})\s*[x×*]\s*([1-9]\d{1,3})(?=[^0-9]|$)/i);
  if (sizeM) {
    const w = Number(sizeM[1]), h = Number(sizeM[2]);
    if (w >= 16 && w <= 4096 && h >= 16 && h <= 4096) out.size = `${w}x${h}`;
  }

  // 视频分辨率：1080p / 4k / 2160p → 1080P；720p / hd → 720P
  const low = p.toLowerCase();
  if (/\b(1080p?|4k|2160p?|qhd)\b/.test(low)) out.resolution = "1080P";
  else if (/\b(720p?|hd)\b/.test(low)) out.resolution = "720P";

  // 视频时长：数字 + s / 秒 / sec / seconds（带单位才认，避免「10stars」之类误判）
  // ASCII 单位用 (?![a-z]) 防「10stars」；CJK「秒」直接匹配（无词边界问题）
  const durM = p.match(/\b(\d{1,3})\s*(?:s|sec|seconds|second)(?![a-z])|(\d{1,3})\s*秒/i);
  if (durM) {
    const d = Number(durM[1] != null ? durM[1] : durM[2]);
    if (d >= 1 && d <= 120) out.duration = d;
  }

  // 张数（图）：n=数字 / 数量数字 / 数字+张（明确标记，避免误伤；\bn 防「version=2」误判）
  const nM = p.match(/(?:\bn\s*=\s*|数量\s*)(\d{1,2})/i) || p.match(/(\d{1,2})\s*张/);
  if (nM) {
    const n = Number(nM[1]);
    if (n >= 1 && n <= 9) out.n = n;
  }

  return out;
}

/**
 * PT Seedream（文生图 / 图生图）对图片尺寸有最低像素要求：实测低于
 * 1920×1920（= 3686400 像素）会直接 400 InvalidParameter。
 * 这里加一道护栏：无论尺寸来自 prompt 解析还是显式 opts.size，只要像素数低于
 * 下限就统一回退到 2048x2048，避免直接打 PT 触发 400。
 * 返回 { size, adjusted, reason }。
 */
const MIN_IMAGE_PIXELS = 3686400; // 1920 × 1920

function enforceMinImageSize(size) {
  const raw = String(size || "").trim();
  const m = raw.match(/^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/i);
  if (!m) {
    return { size: "2048x2048", adjusted: true, reason: `尺寸「${raw || "空"}」无法识别，已回退默认 2048x2048` };
  }
  const w = Number(m[1]), h = Number(m[2]);
  if (w * h < MIN_IMAGE_PIXELS) {
    return {
      size: "2048x2048",
      adjusted: true,
      reason: `尺寸 ${w}x${h} 低于 PT 最低要求（${MIN_IMAGE_PIXELS} 像素 ≈ 1920×1920），已回退 2048x2048`,
    };
  }
  return { size: `${w}x${h}`, adjusted: false, reason: "" };
}

/**
 * media.route 主入口：按 taskType 路由到 PowerTokens 生成，返回结果 URL。
 * @param {Object} context 执行上下文（shell 层为 {userId, tenantId, workspaceId}；DSH 层可空）
 * @param {Object} args    { taskType, prompt, inputImageUrl?, stylePreset?, size?, resolution?, duration?, n? }
 * @param {Object} opts    { apiKey?, baseUrl?, fetchImpl?, timeoutMs?, size?, resolution?, duration?, n?,
 *   onExternalIntent?(metadata), onExternalTaskId?({ ...metadata, taskId }),
 *   onExternalResult?({ ...metadata, outcome, providerStatus, hasResult }) }
 *   Lifecycle callbacks are awaited; metadata contains route identifiers only (no prompt, URLs, or key).
 */
async function callMediaRoute(context, args = {}, opts = {}) {
  const hasResolvedRoute = Object.hasOwn(opts, "resolvedRoute");
  if (opts.requireResolvedRoute === true && !hasResolvedRoute) throw routeError("MEDIA_ROUTE_REQUIRED");
  const routing = hasResolvedRoute
    ? validateResolvedMediaRoute(opts.resolvedRoute, args && args.taskType)
    : resolveRouting(args && args.taskType);
  if (hasResolvedRoute && ["model", "modelId", "provider", "endpoint", "baseUrl", "resolvedRoute"].some((key) => Object.hasOwn(args, key))) {
    throw routeError("MEDIA_ROUTE_ARGUMENT_OVERRIDE");
  }
  if (hasResolvedRoute && ["pt-python-video-v1", "pt-python-seedance-v1"].includes(routing.adapterId)) {
    return require("../../shell/media/ptvideo-executor.cjs").executePtVideoRoute(routing, args, { ...opts, parsedParams: parseMediaParams(args?.prompt) });
  }
  let prompt = String((args && args.prompt) || "").trim();

  const apiKey = (opts && opts.apiKey) || process.env.POWERTOKENS_API_KEY || "";
  if (!apiKey) throw new Error("缺少 PowerTokens API Key（请先保存 PT key / 注入 POWERTOKENS_API_KEY）");

  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前环境不支持 fetch");

  let inputImageUrl = "";
  if (routing.needsImage) {
    inputImageUrl = normalizeInputImageUrl(args && (args.inputImageUrl || args.imageUrl));
    if (!inputImageUrl) throw new Error(`${routing.label} 需要 inputImageUrl（输入图片 URL）`);
  } else if (args && args.inputImageUrl) {
    // 非强制任务若传了图片也一并规范化（不做强制要求）
    inputImageUrl = normalizeInputImageUrl(args.inputImageUrl);
  }

  // 风格预设（可选加分项）：仅图片方向（文生图 / 图生图），视频两类不支持。
  if (args && args.stylePreset) {
    const preset = getStylePreset(args.stylePreset);
    if (!preset) {
      throw new Error(`未知的 stylePreset "${args.stylePreset}"，可选：${listStylePresets().map((p) => p.id).join(", ")}`);
    }
    if (routing.kind !== "image") {
      throw new Error("stylePreset 仅支持文生图 / 图生图（图片方向），不支持视频任务");
    }
    if (preset.needsImage && !inputImageUrl) {
      throw new Error(`stylePreset「${preset.name}」需要输入图片（inputImageUrl）`);
    }
    prompt = renderStylePrompt(preset, prompt);
  }

  if (!prompt) throw new Error("prompt 不能为空");

  const baseUrl = String((opts && opts.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, "");
  // 本地轮询守护超时（坑 07：非 PT 服务端上限；视频异步生成无硬上限，给足本地守护窗口）
  const timeoutMs = (opts && opts.timeoutMs) || (routing.kind === "image" ? 120000 : 3600000);
  const startedAt = Date.now();

  // Lifecycle metadata is intentionally limited to routing identity. Never pass
  // prompt, image URLs, API credentials, request bodies, or generated result URLs.
  const externalMetadata = Object.freeze({
    operation: "media.generate",
    provider: routing.provider,
    taskType: routing.taskType,
    model: routing.model,
    kind: routing.kind,
    endpoint: routing.path || (routing.kind === "image" ? "/v1/images/generations" : "/v1/videos"),
  });
  const invokeLifecycle = async (name, payload) => {
    const callback = opts && opts[name];
    if (callback === undefined) return;
    if (typeof callback !== "function") throw new TypeError(`${name} must be a function`);
    try {
      await callback(payload);
    } catch (cause) {
      const error = new Error(`External lifecycle callback failed: ${name}`, { cause });
      error.code = `EXTERNAL_${name.replace(/^onExternal/, "").replace(/[A-Z]/g, (letter) => "_" + letter).replace(/^_/, "").toUpperCase()}_CALLBACK_FAILED`;
      error.lifecycleCallback = name;
      throw error;
    }
  };
  for (const name of ["onExternalIntent", "onExternalTaskId", "onExternalResult"]) {
    if (opts?.[name] !== undefined && typeof opts[name] !== "function") throw new TypeError(`${name} must be a function`);
  }

  // 上游解析：从 prompt 提取尺寸/分辨率/时长/张数（有合法解析值就准备用，无值走兜底）
  const parsed = parseMediaParams(prompt);

  let url = null;
  let taskId = null;
  let rawSize = null;
  let sizeGuard = null;
  if (routing.kind === "image") {
    // size：显式 opts.size > 解析 parsed.size > 兜底 2048x2048
    rawSize = (opts && opts.size) || parsed.size || "2048x2048";
    // 最低像素护栏：PT Seedream 低于 1920×1920（3686400 px）会 400，统一回退 2048x2048
    // The legacy Seedream constraint is not evidence about a dynamically
    // qualified model. Dynamic adapters preserve explicit dimensions instead.
    if (hasResolvedRoute) {
      const match = String(rawSize).match(/^(\d{2,4})[x×*](\d{2,4})$/i);
      if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) throw routeError("MEDIA_SIZE_INVALID");
      sizeGuard = { size: `${Number(match[1])}x${Number(match[2])}`, adjusted: false, reason: "" };
    } else sizeGuard = enforceMinImageSize(rawSize);
    if (sizeGuard.adjusted) console.warn("[media] " + sizeGuard.reason);
    const body = {
      model: routing.model,
      prompt,
      size: sizeGuard.size,
      // n：显式 opts.n > 解析 parsed.n > 兜底 1
      n: (opts && opts.n) || parsed.n || 1,
    };
    if(opts.sequentialImageGeneration!==undefined&&opts.sequentialImageGeneration!=="disabled")throw routeError("MEDIA_SEQUENCE_POLICY_INVALID");
    if(opts.sequentialImageGeneration==="disabled"&&routing.model==="seedream-5-0-260128")body.sequential_image_generation="disabled";
    if (inputImageUrl) body.image = inputImageUrl;
    await invokeLifecycle("onExternalIntent", externalMetadata);
    let data = await postJson(fetchImpl, `${baseUrl}/v1/images/generations`, body, apiKey);
    if (FAIL_STATUSES.has(readStatus(data).toLowerCase())) throw routeError("EXTERNAL_PROVIDER_FAILED");
    taskId = data && (data.task_id || (data.data && data.data.task_id));
    if (taskId) {
      await invokeLifecycle("onExternalTaskId", { ...externalMetadata, taskId });
      data = await pollImageTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs);
    }
    url = PENDING_STATUSES.has(readStatus(data).toLowerCase()) ? null : extractImageUrl(data);
    if (!taskId && url) {
      await invokeLifecycle("onExternalResult", { ...externalMetadata, outcome: "succeeded", providerStatus: "succeeded", hasResult: true });
    }
  } else {
    // 分辨率：显式 opts.resolution > 解析 parsed.resolution > 兜底 720P（统一归一 1080P/720P）
    const rawResolution = (opts && opts.resolution) || parsed.resolution;
    const resolutionLabel = rawResolution
      ? (/1080|4k|2160/i.test(String(rawResolution)) ? "1080P" : "720P")
      : "720P";
    const body = {
      model: routing.model,
      prompt,
      // seconds：显式 opts.duration > 解析 parsed.duration > 兜底 5
      seconds: String((opts && opts.duration) || parsed.duration || 5),
      size: resolutionLabel,
    };
    if(opts.ratio!==undefined){
      if(!["adaptive","16:9","4:3","1:1","3:4","9:16"].includes(opts.ratio))throw routeError("MEDIA_RATIO_INVALID");
      body.ratio=opts.ratio;
    }
    if (inputImageUrl) body.media = [{ type: "first_frame", url: inputImageUrl }];
    await invokeLifecycle("onExternalIntent", externalMetadata);
    const data = await postJson(fetchImpl, `${baseUrl}/v1/videos`, body, apiKey);
    if (FAIL_STATUSES.has(readStatus(data).toLowerCase())) throw routeError("EXTERNAL_PROVIDER_FAILED");
    taskId = data && (data.task_id || data.id);
    if (taskId) await invokeLifecycle("onExternalTaskId", { ...externalMetadata, taskId });
    const result = taskId ? await pollVideoTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs) : data;
    url = PENDING_STATUSES.has(readStatus(result).toLowerCase()) ? null : extractVideoUrl(result);
    if (!taskId && url) {
      await invokeLifecycle("onExternalResult", { ...externalMetadata, outcome: "succeeded", providerStatus: "succeeded", hasResult: true });
    }
  }

  if (!url) {
    const error = new Error("PowerTokens returned no result URL");
    error.code = taskId ? "EXTERNAL_RESULT_URL_MISSING" : "EXTERNAL_SUBMISSION_OUTCOME_UNKNOWN";
    throw error;
  }

  return {
    taskType: routing.taskType,
    label: routing.label,
    model: routing.model,
    provider: routing.provider,
    kind: routing.kind,
    url,
    elapsedMs: Date.now() - startedAt,
    // 图片尺寸被护栏回退时透出提示（前端可展示给用户）
    sizeAdjusted: sizeGuard && sizeGuard.adjusted
      ? { from: rawSize, to: sizeGuard.size, reason: sizeGuard.reason }
      : undefined,
  };
}

module.exports = {
  MEDIA_ADAPTERS,
  validateResolvedMediaRoute,
  MODEL_ROUTING,
  TASK_TYPES,
  resolveRouting,
  callMediaRoute,
  parseMediaParams,
  enforceMinImageSize,
  MIN_IMAGE_PIXELS,
  renderStylePrompt,
  extractImageUrl,
  extractVideoUrl,
  DEFAULT_BASE_URL,
};
