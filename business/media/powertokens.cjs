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

async function postJson(fetchImpl, url, body, apiKey) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    // 单个 POST 请求超时（生成接口偶发同步等待较久，给足 3 分钟；防无限挂起）
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    throw new Error(`PowerTokens API ${res.status}: ${await res.text()}`);
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

/** 从任意嵌套结构里递归收集 http/https URL（坑 01：兼容 data/result/task 包裹与别名键）。 */
function collectHttpUrls(node, out) {
  if (!node) return out;
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node)) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectHttpUrls(v, out);
    return out;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) collectHttpUrls(v, out);
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
    const { httpStatus, json, text } = await fetchTaskStatus(fetchImpl, statusUrl, apiKey);

    if (httpStatus === 429) {
      rateLimited++;
      if (rateLimited > 30) throw new Error(`${kind}任务查询连续 ${rateLimited} 次 429 限流，熔断退出`);
      await sleep(Math.min(2000 * Math.pow(2, Math.min(rateLimited, 5)), 60000));
      continue;
    }
    if (httpStatus >= 500) {
      server5xx++;
      if (server5xx >= 8) throw new Error(`${kind}任务查询连续 ${server5xx} 次 5xx（${httpStatus}），熔断退出：${text.slice(0, 300)}`);
      await sleep(pollDelay(attempts));
      continue;
    }
    if (httpStatus !== 200) {
      throw new Error(`${kind}任务查询返回非预期状态 ${httpStatus}：${text.slice(0, 300)}`);
    }

    // 200：重置两个错误计数器（坑 13：查询成功即恢复）
    server5xx = 0;
    rateLimited = 0;

    const data = json;
    const outUrl = kind === "video" ? extractVideoUrl(data) : extractImageUrl(data);
    const status = readStatus(data).toLowerCase();
    if (outUrl) return data;
    if (status && SUCCESS_STATUSES.has(status)) return data;
    if (isProgressComplete(data)) return data;
    if (status && FAIL_STATUSES.has(status)) {
      throw new Error(`${kind}任务失败（status=${status}）：${text.slice(0, 300)}`);
    }

    if (status) {
      // 识别出的进行中状态（running/queued/pending/…）：正常排队，重置「读不出」计数
      unreadable = 0;
    } else {
      // 状态读不出来（200 但无 status/URL/progress）：显式计数熔断（坑 02/12）
      unreadable++;
      if (unreadable >= 40) {
        throw new Error(`${kind}任务连续 ${unreadable} 次读不出有效状态，熔断退出；最后原始响应：${text.slice(0, 500)}`);
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
 * media.route 主入口：按 taskType 路由到 PowerTokens 生成，返回结果 URL。
 * @param {Object} context 执行上下文（shell 层为 {userId, tenantId, workspaceId}；DSH 层可空）
 * @param {Object} args    { taskType, prompt, inputImageUrl?, stylePreset?, size?, resolution?, duration?, n? }
 * @param {Object} opts    { apiKey?, baseUrl?, fetchImpl?, timeoutMs?, size?, resolution?, duration?, n? }
 */
async function callMediaRoute(context, args = {}, opts = {}) {
  const routing = resolveRouting(args && args.taskType);
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

  const baseUrl = (opts && opts.baseUrl) || DEFAULT_BASE_URL;
  // 本地轮询守护超时（坑 07：非 PT 服务端上限；视频异步生成无硬上限，给足本地守护窗口）
  const timeoutMs = (opts && opts.timeoutMs) || (routing.kind === "image" ? 120000 : 3600000);
  const startedAt = Date.now();

  // 上游解析：从 prompt 提取尺寸/分辨率/时长/张数（有合法解析值就准备用，无值走兜底）
  const parsed = parseMediaParams(prompt);

  let url = null;
  if (routing.kind === "image") {
    const body = {
      model: routing.model,
      prompt,
      // size：显式 opts.size > 解析 parsed.size > 兜底 2048x2048
      size: (opts && opts.size) || parsed.size || "2048x2048",
      // n：显式 opts.n > 解析 parsed.n > 兜底 1
      n: (opts && opts.n) || parsed.n || 1,
    };
    if (inputImageUrl) body.image = inputImageUrl;
    let data = await postJson(fetchImpl, `${baseUrl}/v1/images/generations`, body, apiKey);
    const taskId = data && (data.task_id || (data.data && data.data.task_id));
    if (taskId) data = await pollImageTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs);
    url = extractImageUrl(data);
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
    if (inputImageUrl) body.media = [{ type: "first_frame", url: inputImageUrl }];
    const data = await postJson(fetchImpl, `${baseUrl}/v1/videos`, body, apiKey);
    const taskId = data && (data.task_id || data.id);
    url = extractVideoUrl(taskId ? await pollVideoTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs) : data);
  }

  if (!url) throw new Error("PowerTokens 返回里未找到结果 URL");

  return {
    taskType: routing.taskType,
    label: routing.label,
    model: routing.model,
    provider: routing.provider,
    kind: routing.kind,
    url,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = {
  MODEL_ROUTING,
  TASK_TYPES,
  resolveRouting,
  callMediaRoute,
  parseMediaParams,
  renderStylePrompt,
  extractImageUrl,
  extractVideoUrl,
  DEFAULT_BASE_URL,
};
