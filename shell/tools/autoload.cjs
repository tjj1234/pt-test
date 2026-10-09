"use strict";
/**
 * shell/tools/autoload.cjs —— 业务工具通用加载入口
 * ============================================================================
 * 背景：server.cjs 启动时原本手写一段 registerTool({...}) 注册单个 demo 工具，
 * 没有「扫描业务线导出了哪些工具、挨个自动注册」的通用机制，导致 attribution.query
 * 等早已完成的业务工具从未进入对话调用链路。
 *
 * loadBusinessTools() 遍历业务线模块公开导出的工具定义，逐一产出
 * { definition, execute }，由 server.cjs 循环调用 registerTool()。
 *
 * 红线（同 M1/M3）：
 *   - 只读业务线模块公开导出（xxxToolDefinition()），不 import 内部实现；
 *   - 不改 business/ 下任何文件；
 *   - 真实数据必须来自内部 HTTP 调用业务线只读接口，绝不新建空 store/adapter。
 * ============================================================================
 */

const http = require("node:http");
const crypto = require("node:crypto");

/**
 * 计算租户的 HMAC 分析 token，与 shell 反代 / workspace-enabled-status.cjs 规则一致：
 *   sha256(tenantId) with key = PT_DASH_INTERNAL_KEY
 */
function computeAnalyticsToken(internalKey, tenantId) {
  return crypto.createHmac("sha256", internalKey).update(String(tenantId)).digest("hex");
}

/** 内部 HTTP GET（只读），返回 { statusCode, body }，供 executor 取真实数据。 */
function internalGet({ internalKey, dashPort, tenantId, path, query = {}, host = "127.0.0.1", timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(query)
      .filter((k) => query[k] != null && query[k] !== "")
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(query[k])))
      .join("&");
    const fullPath = qs ? path + "?" + qs : path;
    const token = computeAnalyticsToken(internalKey, tenantId);
    const req = http.request({
      host,
      port: dashPort,
      path: fullPath,
      method: "GET",
      headers: {
        host: host + ":" + dashPort,
        authorization: "Bearer " + token,
        accept: "application/json",
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("业务线接口超时"), { code: "TIMEOUT" })));
    req.end();
  });
}

/** 解析内部接口返回体；非 2xx 或非 JSON 时抛带上下文的错误。 */
function unwrapResponse(resp, toolName) {
  let payload = null;
  try { payload = JSON.parse(resp.body); } catch (e) { payload = null; }
  if (!resp.statusCode || resp.statusCode < 200 || resp.statusCode >= 300) {
    const detail = payload && payload.error && (payload.error.message || payload.error.code);
    const msg = detail || ("HTTP " + resp.statusCode);
    throw Object.assign(new Error(toolName + " 查询失败：" + msg), { code: "BUSINESS_API_ERROR", statusCode: resp.statusCode });
  }
  if (payload == null) {
    throw Object.assign(new Error(toolName + " 返回了非 JSON 数据"), { code: "BAD_RESPONSE" });
  }
  return payload;
}

/** attribution.query 真实 executor：调 A19 只读接口 GET /api/attribution/funnel。 */
function buildAttributionQueryExecutor({ internalKey, dashPort }) {
  return async function attributionQueryExecutor(args, context) {
    const tenantId = context && context.tenantId;
    if (!tenantId) throw new Error("attribution.query 需要 tenantId");
    const resp = await internalGet({
      internalKey,
      dashPort,
      tenantId,
      path: "/api/attribution/funnel",
      query: {
        from: args && args.from,
        to: args && args.to,
        granularity: args && args.granularity,
        platform: args && args.platform,
        country: args && args.country,
        conversion_window_days: args && args.conversion_window_days,
        limit: args && args.limit,
      },
    });
    return unwrapResponse(resp, "attribution.query");
  };
}

/** media.route 真实 executor：按 taskType 路由到 PowerTokens 生成，返回结果 URL。 */
function buildMediaRouteExecutor() {
  const media = require("../../business/media/index.js");
  return async function mediaRouteExecutor(args, context) {
    return media.callMediaRoute(context, args || {});
  };
}

/** 按 "." 路径读取对象上的公开导出（如 "registry.attributionToolDefinition"）。 */
function resolvePath(obj, pathStr) {
  return String(pathStr).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/**
 * 业务工具清单：每个 provider 描述一条「业务线公开导出的工具」如何被加载。
 *   - modulePath        业务线模块公开入口（相对本文件）
 *   - definitionGetter  模块上导出的 xxxToolDefinition 路径
 *   - buildExecutor     shell 侧真实 executor 工厂（真实数据走内部 HTTP）
 *
 * 约定「业务线导出什么就注册什么」：若 definitionGetter 尚未导出（例如某业务分支
 * 尚未合入 main），则跳过并记日志，等分支合入后自动生效，无需再改 shell。
 */
const PROVIDERS = [
  {
    modulePath: "../../business/attribution/index.js",
    definitionGetter: "registry.attributionToolDefinition",
    buildExecutor: buildAttributionQueryExecutor,
  },
  {
    modulePath: "../../business/media/index.js",
    definitionGetter: "registry.mediaRouteToolDefinition",
    buildExecutor: buildMediaRouteExecutor,
  },
];

/**
 * 加载业务线工具：返回 [{ definition, execute }]。
 * 调用方（server.cjs）循环 registerTool({ ...definition, execute })。
 */
function loadBusinessTools(opts = {}) {
  const { internalKey, dashPort, log = null } = opts;
  const loaded = [];
  for (const provider of PROVIDERS) {
    let mod = null;
    try {
      mod = require(provider.modulePath);
    } catch (e) {
      if (log) log.warn("autoload_require_failed", { module: provider.modulePath, error: String(e && e.message ? e.message : e) });
      continue;
    }
    const getter = resolvePath(mod, provider.definitionGetter);
    if (typeof getter !== "function") {
      if (log) log.info("autoload_skip_not_exported", { module: provider.modulePath, getter: provider.definitionGetter });
      continue;
    }
    const definition = getter();
    const execute = provider.buildExecutor({ internalKey, dashPort });
    loaded.push({ definition, execute });
  }
  return loaded;
}

/**
 * 业务线「约束」（工程铁律）来源：只读业务线模块公开导出，不在 shell 写死。
 * 每条 provider 描述：从哪个业务线模块的哪个公开导出读取约束文本。
 * 约束以 string[] 返回（对象取 values，数组取元素，字符串拆单条）。
 */
const CONSTRAINT_PROVIDERS = [
  {
    modulePath: "../../business/attribution/index.js",
    constraintsGetter: "INVARIANTS",
  },
];

/**
 * 加载业务线约束：返回 string[]（工程铁律），供 M4 系统提示【约束】段动态拼接。
 */
function loadBusinessConstraints(opts = {}) {
  const { log = null } = opts;
  const constraints = [];
  for (const provider of CONSTRAINT_PROVIDERS) {
    let mod = null;
    try {
      mod = require(provider.modulePath);
    } catch (e) {
      if (log) log.warn("constraints_require_failed", { module: provider.modulePath, error: String(e && e.message ? e.message : e) });
      continue;
    }
    const raw = resolvePath(mod, provider.constraintsGetter);
    if (raw == null) {
      if (log) log.info("constraints_skip_not_exported", { module: provider.modulePath, getter: provider.constraintsGetter });
      continue;
    }
    const values = Array.isArray(raw) ? raw : (typeof raw === "object" ? Object.values(raw) : [raw]);
    for (const v of values) {
      const s = String(v == null ? "" : v).trim();
      if (s) constraints.push(s);
    }
  }
  return constraints;
}

module.exports = {
  loadBusinessTools,
  loadBusinessConstraints,
  computeAnalyticsToken,
  internalGet,
  unwrapResponse,
};
