"use strict";
/**
 * 北极星项目 · 广告归因层 · 单元 4.1（返工）后端 MCP 只读代理
 *
 * 依据：《北极星开发/4-DSH-AI/4.1-Ryze-MCP配置.md》§1（默认拒绝 deny-by-default）
 *       《北极星开发/2-广告归因/2.1-Ryze-MCP对接.md》§4（三道闸）
 *
 * 返工背景（验收不通过根因）：
 *   DSH 原生 @deepseek-ai/dsh-mcp-client 会「无条件注册」Ryze 返回的全部工具，
 *   且 tools/call 是「直连 Ryze 端点」，不经后端——后端 2.1 的 WriteToolDeniedError
 *   根本拦不到 DSH 这条通道。因此只靠 DSH 侧配置的三张表是纸面合规，没有闭环。
 *
 * 本文件 = 后端 MCP 代理端点（Streamable HTTP），把白名单收到「执行层」这一处：
 *   - DSH 连的是「我方代理端点」，不再直连 Ryze。
 *   - tools/list：拉 Ryze 全量工具 → 按 2.1 白名单裁剪 → 只返回白名单内工具。
 *     （写工具 / 本期禁用工具 / 未知新工具「结构上不出现在列表里」，模型不可见）
 *   - tools/call：二次校验工具名（白名单外 → 直接返回 JSON-RPC error，绝不转发）。
 *   - 转发复用 2.1 的 RyzeMCPClient（它内部还有三道闸，双保险）。
 *
 * 凭证边界（§凭证落点）：
 *   - 上游（代理 → Ryze）：代理持有「我方 ↔ Ryze 的 MCP 连接凭证」RYZE_MCP_TOKEN，
 *     注入到 RyzeMCPClient.accessToken。
 *   - 下游（DSH → 代理）：DSH 持有「我方代理的凭证」PT_MCP_PROXY_TOKEN，
 *     代理按 Authorization: Bearer <token> 常量时间比对鉴权。
 *   - 两把钥匙互不相同、互不混用；原始 Meta/Google 广告 Token 永远停在 Ryze。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMCPProxyServer = buildMCPProxyServer;
exports.createRyzeUpstream = createRyzeUpstream;
exports.createRyzeUpstreamFromEnv = createRyzeUpstreamFromEnv;
exports.startMCPProxyServer = startMCPProxyServer;
exports.registerProxyShutdown = registerProxyShutdown;
const fastify_1 = __importDefault(require("fastify"));
const node_crypto_1 = require("node:crypto");
const ryze_client_1 = require("./ryze-client");
// ===========================================================================
// §0 只读判定（镜像 ryze-client.ts 模块内 isWriteTool / isReadTool）
//    —— 唯一权威仍是 ryze-client.ts 导出的三个常量，此处只做同逻辑的「执行层闸门」。
// ===========================================================================
/**
 * 写工具判定（含关键词启发兜底），与 ryze-client.ts 的 isWriteTool 逐字一致。
 * 启停(ACTIVE/PAUSED)/改预算/改出价/删素材等全部写意图在此拦截。
 */
function isWriteTool(name) {
    const n = name.toLowerCase();
    for (const w of ryze_client_1.WRITE_TOOLS)
        if (w.toLowerCase() === n)
            return true;
    // 兜底：工具名含显式写意图关键词（即便不在 WRITE_TOOLS 黑名单）也拒绝。
    if (/(write|mutate|delete|create|update|remove|upload|apply|dismiss|budget|bid|pause|enable|disable|activate)/i.test(n)) {
        return true;
    }
    return false;
}
/** 只读白名单判定（白名单内 && 不在本期禁用清单），与 ryze-client.ts 的 isReadTool 一致。 */
function isReadTool(name) {
    return ryze_client_1.READ_ONLY_TOOLS.has(name) && !ryze_client_1.DISABLED_READ_TOOLS.has(name);
}
function jsonRpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message, data) {
    const error = {
        code,
        message,
    };
    if (data !== undefined)
        error.data = data;
    return { jsonrpc: "2.0", id, error };
}
/** 从 body 里尽量取出一个合法 JSON-RPC 请求；不合法返回 null。 */
function parseJsonRpcRequest(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return null;
    }
    const o = body;
    if (o.jsonrpc !== "2.0" || typeof o.method !== "string")
        return null;
    return {
        jsonrpc: o.jsonrpc,
        id: o.id,
        method: o.method,
        params: o.params,
    };
}
/** 从 tools/call 的 params 里安全取出工具名。 */
function toolNameFromParams(params) {
    if (params !== null && typeof params === "object") {
        const name = params.name;
        if (typeof name === "string" && name.length > 0)
            return name;
    }
    return undefined;
}
/** 从 tools/call 的 params 里取出 arguments（未传则 undefined）。 */
function argsFromParams(params) {
    if (params !== null && typeof params === "object") {
        return params.arguments;
    }
    return undefined;
}
// ===========================================================================
// §3 鉴权（下游 DSH → 代理）：常量时间比对，避免时序侧信道
// ===========================================================================
/** 从 Authorization 头取出 Bearer token（缺失/格式错返回 undefined）。 */
function bearerToken(request) {
    const h = request.headers.authorization;
    const raw = Array.isArray(h) ? h[0] : h;
    if (!raw)
        return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(raw);
    return m ? m[1].trim() : undefined;
}
/** 常量时间比较（SHA-256 两边对齐长度）。expected 为空 = fail-closed。 */
function constantTimeSecretMatches(provided, expected) {
    if (!expected)
        return false;
    const a = (0, node_crypto_1.createHash)("sha256").update(provided, "utf8").digest();
    const b = (0, node_crypto_1.createHash)("sha256").update(expected, "utf8").digest();
    return (0, node_crypto_1.timingSafeEqual)(a, b);
}
/**
 * 构建 MCP 只读代理服务。路由：POST /mcp/ryze（GET/DELETE 显式 405，
 * 好让 DSH 的 StreamableHTTPClientTransport 跳过 GET-SSE 探测、不误报错）。
 */
function buildMCPProxyServer(options) {
    const { upstream, proxyToken, audit, logger = true } = options;
    const app = (0, fastify_1.default)({ logger });
    // GET：DSH 的 StreamableHTTP transport 会先探测 GET SSE；本代理不支持，405 表示「无 SSE 流」。
    app.get("/mcp/ryze", async (_req, reply) => reply.status(405).send());
    // DELETE：会话终止，本代理无状态，405 表示不支持显式会话终止。
    app.delete("/mcp/ryze", async (_req, reply) => reply.status(405).send());
    app.post("/mcp/ryze", async (request, reply) => {
        // ① 鉴权：DSH 必须带对代理凭证，否则 401（不落 JSON-RPC，避免泄露内部结构）。
        const provided = bearerToken(request);
        if (!provided || !constantTimeSecretMatches(provided, proxyToken)) {
            request.log.warn("mcp-proxy unauthorized");
            return reply.status(401).send();
        }
        // ② 解析 JSON-RPC 请求。
        const req = parseJsonRpcRequest(request.body);
        if (!req) {
            return reply
                .type("application/json")
                .send(jsonRpcError(null, -32600, "invalid request (expect JSON-RPC 2.0)"));
        }
        const id = req.id ?? null;
        const method = req.method;
        // ③ 通知（无 id）：只有 notifications/initialized 有意义，202 无响应体。
        if (req.id === undefined || req.id === null) {
            return reply.status(202).send();
        }
        // ④ 分发。
        switch (method) {
            case "initialize": {
                return reply.send(jsonRpcResult(id, {
                    protocolVersion: ryze_client_1.DEFAULT_MCP_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: "beijixing-mcp-proxy", version: "0.1.0" },
                }));
            }
            case "tools/list": {
                // 上游拉工具 → 代理「执行层」再按 2.1 白名单独立过滤（deny-by-default）。
                // 即便上游（真实 RyzeMCPClient.listTools 已过滤）再过滤一次也幂等；
                // 这一层是代理自己的闸门，绝不依赖上游是否过滤 —— 白名单只在这一处收口。
                const all = await upstream.listTools();
                const tools = all.filter((t) => isReadTool(t.name));
                return reply.send(jsonRpcResult(id, { tools }));
            }
            case "tools/call": {
                const toolName = toolNameFromParams(req.params);
                if (toolName === undefined) {
                    return reply.send(jsonRpcError(id, -32602, "tools/call missing tool name"));
                }
                // 执行层第一道闸：写工具直接拒，绝不转发（即便上游 double 被绕过，这里也拦死）。
                if (isWriteTool(toolName)) {
                    void Promise.resolve(audit?.({ tool_name: toolName, tool_action: "deny", reason: "write_tool_denied", at: Date.now() })).catch(() => { });
                    request.log.warn({ toolName, reason: "write_tool_denied" }, "MCP_PROXY_WRITE_DENIED");
                    return reply.send(jsonRpcError(id, -32601, `write tool denied: ${toolName}（只读铁律：不启停/改预算/改出价/删素材）`, {
                        code: "write_tool_denied",
                        tool: toolName,
                    }));
                }
                // 执行层第二道闸：白名单外 / 本期禁用工具直接拒，绝不转发。
                if (!isReadTool(toolName)) {
                    void Promise.resolve(audit?.({ tool_name: toolName, tool_action: "deny", reason: "unknown_tool_denied", at: Date.now() })).catch(() => { });
                    request.log.warn({ toolName, reason: "unknown_tool_denied" }, "MCP_PROXY_UNKNOWN_DENIED");
                    return reply.send(jsonRpcError(id, -32601, `tool not allowed: ${toolName}（只读白名单外不可调）`, {
                        code: "unknown_tool_denied",
                        tool: toolName,
                    }));
                }
                // 白名单内只读工具 → 转发（RyzeMCPClient.callTool 内部还会再过三道闸，双保险）。
                try {
                    const result = await upstream.callTool(toolName, argsFromParams(req.params));
                    return reply.send(jsonRpcResult(id, result));
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    request.log.error({ toolName, err }, "mcp-proxy upstream call failed");
                    return reply.send(jsonRpcError(id, -32603, `upstream call failed: ${message}`));
                }
            }
            default: {
                // 白名单外的「方法」= 不存在。fail-closed。
                return reply.send(jsonRpcError(id, -32601, `method not found: ${method}`));
            }
        }
    });
    return app;
}
/**
 * 用 2.1 的 RyzeMCPClient 建上游（复用其三道闸）。
 * platform 只影响 2.1 的五类拉取封装（账户/系列/…），代理只做「发现 + 转发」，
 * 与平台无关，故固定 meta 即可；白名单过滤在 refreshTools 用的是全局 READ_ONLY_TOOLS。
 */
function createRyzeUpstream(options) {
    return new ryze_client_1.RyzeMCPClient({
        endpoint: options.endpoint ?? ryze_client_1.DEFAULT_RYZE_ENDPOINT,
        accessToken: options.accessToken,
        platform: "meta",
        timeoutMs: options.timeoutMs,
        logger: options.logger,
    });
}
/** 从环境变量 RYZE_MCP_TOKEN 建上游；未设置则 fail-fast（不静默降级为无凭证）。 */
function createRyzeUpstreamFromEnv(options) {
    const token = process.env.RYZE_MCP_TOKEN;
    if (!token) {
        throw new Error("RYZE_MCP_TOKEN 未设置：代理必须持有「我方 ↔ Ryze 的 MCP 连接凭证」才能转发只读工具");
    }
    return createRyzeUpstream({
        accessToken: token,
        endpoint: options?.endpoint,
        timeoutMs: options?.timeoutMs,
        logger: options?.logger,
    });
}
/** 构建并监听，返回已启动服务与关闭句柄。 */
async function startMCPProxyServer(options) {
    const app = buildMCPProxyServer(options);
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? 3001);
    await app.listen({ port, host });
    return {
        app,
        address: `${host}:${port}`,
        close: () => app.close(),
    };
}
/** 优雅关闭：监听 SIGINT/SIGTERM，先关闭再退出。 */
function registerProxyShutdown(close) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            void Promise.resolve(close()).finally(() => process.exit(0));
        });
    }
}
//# sourceMappingURL=mcp-proxy.js.map