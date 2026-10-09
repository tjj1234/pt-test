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
  });
  if (!res.ok) {
    throw new Error(`PowerTokens API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function getJson(fetchImpl, url, apiKey) {
  const res = await fetchImpl(url, { headers: authHeaders(apiKey) });
  if (!res.ok) {
    throw new Error(`PowerTokens API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** 指数退避的轮询间隔（与 CLI 一致：2s 起步，上限 30s）。 */
function pollDelay(attempts) {
  return Math.min(2000 * Math.pow(2, Math.min(attempts, 4)), 30000);
}

/** 图片任务轮询：GET /v1/tasks/{taskId}，成功状态 completed/succeeded/success。 */
async function pollImageTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const data = await getJson(fetchImpl, `${baseUrl}/v1/tasks/${taskId}`, apiKey);
    const status = data && (data.status || (data.data && data.data.status));
    if (status === "completed" || status === "succeeded" || status === "success") return data;
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error((data && (data.error || data.message)) || "图片任务失败");
    }
    await sleep(pollDelay(attempts));
  }
  throw new Error(`图片任务超时（${Math.round(timeoutMs / 1000)}s）`);
}

/** 视频任务轮询：GET /v1/videos/{taskId}，成功状态 completed/succeeded。 */
async function pollVideoTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const data = await getJson(fetchImpl, `${baseUrl}/v1/videos/${taskId}`, apiKey);
    const status = data && data.status;
    if (status === "completed" || status === "succeeded") return data;
    if (status === "failed" || status === "error" || status === "cancelled" || status === "expired") {
      throw new Error((data && ((data.error && (data.error.message || data.error)) || data.message)) || "视频任务失败");
    }
    await sleep(pollDelay(attempts));
  }
  throw new Error(`视频任务超时（${Math.round(timeoutMs / 1000)}s）`);
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
  return null;
}

/** 从视频生成响应里提取结果 URL（与 CLI pollVideoTask 一致）。 */
function extractVideoUrl(data) {
  if (!data) return null;
  const u = (data.metadata && data.metadata.url) || data.url || data.video_url || (data.content && data.content.video_url);
  return typeof u === "string" && /^https?:\/\//.test(u) ? u : null;
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
 * media.route 主入口：按 taskType 路由到 PowerTokens 生成，返回结果 URL。
 * @param {Object} context 执行上下文（shell 层为 {userId, tenantId, workspaceId}；DSH 层可空）
 * @param {Object} args    { taskType, prompt, inputImageUrl? }
 * @param {Object} opts    { apiKey?, baseUrl?, fetchImpl?, timeoutMs?, size?, duration? }
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
  const timeoutMs = (opts && opts.timeoutMs) || (routing.kind === "image" ? 120000 : 900000);
  const startedAt = Date.now();

  let url = null;
  if (routing.kind === "image") {
    const body = {
      model: routing.model,
      prompt,
      size: (opts && opts.size) || "2048x2048",
      n: 1,
    };
    if (inputImageUrl) body.image = inputImageUrl;
    let data = await postJson(fetchImpl, `${baseUrl}/v1/images/generations`, body, apiKey);
    const taskId = data && (data.task_id || (data.data && data.data.task_id));
    if (taskId) data = await pollImageTask(fetchImpl, baseUrl, taskId, apiKey, timeoutMs);
    url = extractImageUrl(data);
  } else {
    const body = {
      model: routing.model,
      prompt,
      seconds: String((opts && opts.duration) || 5),
      size: (opts && opts.resolution && String(opts.resolution).includes("1080")) ? "1080P" : "720P",
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
  renderStylePrompt,
  extractImageUrl,
  extractVideoUrl,
  DEFAULT_BASE_URL,
};
