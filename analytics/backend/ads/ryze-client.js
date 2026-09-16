"use strict";
/**
 * 北极星项目 · 广告归因层 · 单元 2.1 Ryze MCP 只读对接（Node.js + TypeScript）
 *
 * 依据：《北极星开发/2-广告归因/2.1-Ryze-MCP对接.md》
 *   §2   总体架构：后端 MCP Client 位置 + Adapter 统一接口（数据源可切换）
 *   §3.1 凭证边界：我方不持有、不透传用户 Meta/Google 原始广告 Token，只持有「连 Ryze」的 MCP 连接凭证
 *   §4.1 默认拒绝（deny-by-default，三道闸：连接级白名单 → 路由级 → 代码级）
 *   §4.2 启用只读工具 ↔ 数据类别映射（账户/系列/广告组/素材/每日指标）
 *   §4.3 封死写工具（结构上不存在调用）
 *   §4.4 只读但本期不启用（leads/ad library/recommendations/keyword* 一律不启用）
 *   §5   广告数据拉取封装（五类：账户/系列/广告组/素材/每日指标）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. 只读铁律：只读工具集白名单；启停广告/改预算/改出价/删素材 = 全部写操作 = 代码层拦截拒绝（不只是「不调用」）。
 *   2. 不持有、不透传用户原始广告 Token：本 client 只认「我方 ↔ Ryze 的 MCP 连接凭证」，原始广告凭证永远停在 Ryze。
 *   3. 不编造数据：拉不到就是拉不到，返回原始载荷，绝不补数；清洗/标准化交给 2.2 落库单元，本文件不越界。
 *   4. 日志/审计不落 Token 明文，只落指纹（最后 4 位）。
 *
 * 传输说明：Ryze MCP server = https://connector.get-ryze.ai/mcp（远程 MCP，HTTP 传输）。
 *   本文件按 MCP「Streamable HTTP」传输实现（单 POST 端点，JSON-RPC 2.0，响应兼容
 *   application/json 与 text/event-stream 两种返回）。若 Ryze 实际走旧版「HTTP + SSE」
 *   双通道传输，扩展点 = Transport 接口（换一个 transport 实现即可，client 逻辑不动）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RyzeMCPClient = exports.DEFAULT_MCP_PROTOCOL_VERSION = exports.DEFAULT_RYZE_ENDPOINT = exports.DataSourceNotImplementedError = exports.NotInitializedError = exports.McpCallError = exports.UnknownToolDeniedError = exports.WriteToolDeniedError = exports.DISABLED_READ_TOOLS = exports.WRITE_TOOLS = exports.READ_ONLY_TOOLS = void 0;
exports.tokenFingerprint = tokenFingerprint;
exports.createAdsDataSource = createAdsDataSource;
exports.extractText = extractText;
// ===========================================================================
// §1 只读工具集白名单 + 写工具黑名单（§4.1/§4.2/§4.3，唯一权威 = 4.1 §1）
// ===========================================================================
/**
 * 只读工具白名单（连接级第一道闸：白名单外工具不可见、不可调）。
 *
 * Meta（§4.2）：
 *   listAdAccounts            账户
 *   getAccountSummary         花费/点击（account 级）
 *   listCreatives / getCreative  素材
 *   runRawInsights            花费/点击/素材/国家（campaign/adgroup/creative 级）
 *   runGraphRead（只读 GET）   层级/素材/受众定向
 *
 * Google（§4.2）：
 *   listAccessibleCustomers   账户
 *   getAccountSummary         花费/点击/转化（account 级）
 *   getAccountHierarchy       账户层级
 *   runRawGaql（只读 GAQL）    花费/点击/素材（campaign/adgroup/creative 级）
 */
exports.READ_ONLY_TOOLS = new Set([
    // Meta 只读
    "listAdAccounts",
    "getAccountSummary",
    "listCreatives",
    "getCreative",
    "runRawInsights",
    "runGraphRead",
    // Google 只读
    "listAccessibleCustomers",
    "getAccountHierarchy",
    "runRawGaql",
]);
/**
 * 写工具黑名单（代码级第三道闸：写工具结构上不存在调用方法，一旦有调用尝试即拒绝）。
 * 特别点名（§4.3）：启停广告（ACTIVE/PAUSED）、改预算、改出价、删素材 = 全部封死。
 */
exports.WRITE_TOOLS = new Set([
    // Meta 写（§4.3）
    "runGraphWrite", // 含启停/改预算/改出价/删素材等一切 GraphQL mutation
    "runGraphDelete",
    "uploadImageFromUrl",
    // Google 写（§4.3）
    "runRawMutate", // 含启停/改预算/改出价等一切 mutate
    "runRawMutateDelete",
    "runRawCustomAudienceMutate",
    "applyRecommendation", // 可能自动应用改预算/改出价建议
    "dismissRecommendation",
    "uploadImageAsset",
]);
/**
 * 只读但本期不启用（§4.4：隐私/后置边界）。这类工具即便被 server 列出，也视为白名单外拒绝。
 *   listLeadForms / listLeads（含 PII）、searchAdLibrary（竞品情报）、
 *   generateKeyword*、listRecommendations、listConversionActions。
 */
exports.DISABLED_READ_TOOLS = new Set([
    "listLeadForms",
    "listLeads",
    "searchAdLibrary",
    "listRecommendations",
    "listConversionActions",
]);
/** 判定某工具名是否属写工具（大小写不敏感，防御恶意改名绕过）。 */
function isWriteTool(name) {
    const n = name.toLowerCase();
    for (const w of exports.WRITE_TOOLS)
        if (w.toLowerCase() === n)
            return true;
    // 兜底：工具名含显式写意图关键词（启停/预算/出价/删除/上传/变更/创建），即便不在黑名单也拒绝。
    if (/(write|mutate|delete|create|update|remove|upload|apply|dismiss|budget|bid|pause|enable|disable|activate)/i.test(n)) {
        return true;
    }
    return false;
}
/** 判定某工具名是否在只读白名单内。 */
function isReadTool(name) {
    return exports.READ_ONLY_TOOLS.has(name) && !exports.DISABLED_READ_TOOLS.has(name);
}
/** 从 tools/call 的 params 里安全取出工具名（供传输层白名单兜底用）。 */
function toolNameFromCallParams(params) {
    if (params !== null && typeof params === "object") {
        const name = params.name;
        if (typeof name === "string")
            return name;
    }
    return undefined;
}
// ===========================================================================
// §2 错误类型（只读拦截 = 显式异常，而非静默跳过）
// ===========================================================================
/** 写工具调用被拦截（代码级第三道闸）。 */
class WriteToolDeniedError extends Error {
    toolName;
    reason = "write_tool_denied";
    constructor(toolName) {
        super(`拒绝调用写工具「${toolName}」：只读铁律，启停广告/改预算/改出价一律禁止`);
        this.name = "WriteToolDeniedError";
        this.toolName = toolName;
    }
}
exports.WriteToolDeniedError = WriteToolDeniedError;
/** 白名单外/未知工具调用被拦截（连接级第一道闸 + 路由级第二道闸）。 */
class UnknownToolDeniedError extends Error {
    toolName;
    reason = "unknown_tool_denied";
    constructor(toolName) {
        super(`拒绝调用非白名单工具「${toolName}」：只读白名单外一律不可调`);
        this.name = "UnknownToolDeniedError";
        this.toolName = toolName;
    }
}
exports.UnknownToolDeniedError = UnknownToolDeniedError;
/** MCP 层错误（JSON-RPC error 或工具返回 isError）。 */
class McpCallError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = "McpCallError";
        this.code = code;
        this.data = data;
    }
}
exports.McpCallError = McpCallError;
/** 未初始化即调用（正常不应发生：callTool 会懒初始化）。 */
class NotInitializedError extends Error {
    constructor() {
        super("Ryze MCP client 尚未完成 initialize，先调用 connect()");
        this.name = "NotInitializedError";
    }
}
exports.NotInitializedError = NotInitializedError;
/** 预留数据源（官方 API / CSV）尚未实现。 */
class DataSourceNotImplementedError extends Error {
    constructor(dataSource) {
        super(`数据源「${dataSource}」为降级预留，尚未实现；请切换 data_source=ryze`);
        this.name = "DataSourceNotImplementedError";
    }
}
exports.DataSourceNotImplementedError = DataSourceNotImplementedError;
/** 令牌指纹（最后 4 位，对账用，不可还原，§3.3/§3.6）。 */
function tokenFingerprint(token) {
    if (token.length <= 4)
        return "****";
    return `…${token.slice(-4)}`;
}
/** 入参脱敏：递归去掉 key 名含 token/secret/password/authorization/key 的字段值。 */
function sanitizeParams(args) {
    if (Array.isArray(args))
        return args.map(sanitizeParams);
    if (args !== null && typeof args === "object") {
        const out = {};
        for (const [k, v] of Object.entries(args)) {
            if (/(token|secret|password|authorization|apikey|api_key|access_key|refresh_token)/i.test(k)) {
                out[k] = "[REDACTED]";
            }
            else {
                out[k] = sanitizeParams(v);
            }
        }
        return out;
    }
    return args;
}
/** 解析 SSE（text/event-stream）响应：收集所有 data: 行，逐事件解析 JSON。 */
function parseSseBody(text) {
    const events = [];
    let dataLines = [];
    const flush = () => {
        if (dataLines.length === 0)
            return;
        const payload = dataLines.join("\n");
        dataLines = [];
        if (payload.trim() === "")
            return;
        try {
            events.push(JSON.parse(payload));
        }
        catch {
            // 非 JSON 事件（如 ping/注释）忽略
        }
    };
    for (const line of text.split(/\r?\n/)) {
        if (line === "") {
            flush();
        }
        else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // 忽略 event:/id:/retry: 等其它字段
    }
    flush();
    return events;
}
function isJsonRpcResponse(v) {
    if (v === null || typeof v !== "object")
        return false;
    const o = v;
    return o.jsonrpc === "2.0" && ("result" in o || "error" in o || "id" in o);
}
/** 从 HTTP 响应中提取 JSON-RPC 响应（兼容 application/json 与 text/event-stream）。 */
async function extractJsonRpcResponse(res) {
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ct.includes("text/event-stream")) {
        const events = parseSseBody(text);
        for (const ev of events) {
            if (isJsonRpcResponse(ev))
                return ev;
        }
        // 无响应事件（notification 场景）→ null
        return null;
    }
    if (text.trim() === "")
        return null;
    const parsed = JSON.parse(text);
    if (isJsonRpcResponse(parsed))
        return parsed;
    // 某些 server 直接返回 result 体而非完整 JSON-RPC 包 → 包一层
    return { jsonrpc: "2.0", id: null, result: parsed };
}
/**
 * HTTP JSON-RPC 传输（MCP Streamable HTTP）。单 POST 端点，Authorization 注入只在
 * 白名单读工具请求里发生（§4.1 后端硬约束）。
 *
 * 【安全】内部类（不导出）：防止任何导入方 `new HttpJsonRpcTransport(...).request(...)`
 * 绕过 RyzeMCPClient 的只读白名单；且 request 内部对 tools/call 再做一次白名单兜底。
 */
class HttpJsonRpcTransport {
    endpoint;
    accessToken;
    options;
    nextId = 1;
    sessionId;
    constructor(endpoint, accessToken, options = {}) {
        this.endpoint = endpoint;
        this.accessToken = accessToken;
        this.options = options;
    }
    async request(method, params, opts) {
        // 只读铁律传输层兜底（双保险）：即便绕过 RyzeMCPClient 直接持 transport，tools/call 也只能调白名单读工具。
        if (method === "tools/call") {
            const toolName = toolNameFromCallParams(params);
            if (toolName !== undefined) {
                if (isWriteTool(toolName))
                    throw new WriteToolDeniedError(toolName);
                if (!isReadTool(toolName))
                    throw new UnknownToolDeniedError(toolName);
            }
        }
        const { timeoutMs = 30000, fetchImpl = fetch } = this.options;
        const notification = opts?.notification === true;
        const id = this.nextId++;
        // JSON-RPC 通知不带 id（否则会被当作请求等待响应，违反通知语义）
        const body = notification
            ? { jsonrpc: "2.0", method, params }
            : { jsonrpc: "2.0", id, method, params };
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${this.accessToken}`,
        };
        if (this.sessionId)
            headers["Mcp-Session-Id"] = this.sessionId;
        let res;
        try {
            res = await fetchImpl(this.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (err) {
            const code = err?.code;
            if (code === "TimeoutError" || code === "AbortError") {
                throw new McpCallError(-32000, `MCP 请求超时（${timeoutMs}ms）`, err);
            }
            throw new McpCallError(-32000, `MCP 网络错误: ${err.message}`, err);
        }
        const sid = res.headers.get("mcp-session-id");
        if (sid)
            this.sessionId = sid;
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new McpCallError(res.status, `MCP HTTP ${res.status}: ${detail.slice(0, 300)}`);
        }
        // 通知无响应体：发送后不等待、不解析响应，直接返回 null
        if (notification)
            return null;
        const rpc = await extractJsonRpcResponse(res);
        if (rpc && rpc.error) {
            throw new McpCallError(rpc.error.code, rpc.error.message, rpc.error.data);
        }
        if (rpc && rpc.id !== id && rpc.id !== null) {
            // 响应 id 与请求不匹配：按协议异常处理，避免错配结果
            throw new McpCallError(-32603, `MCP 响应 id 不匹配（期望 ${id}，实际 ${String(rpc.id)}）`);
        }
        return rpc;
    }
    close() {
        this.sessionId = undefined;
    }
}
exports.DEFAULT_RYZE_ENDPOINT = "https://connector.get-ryze.ai/mcp";
exports.DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";
class RyzeMCPClient {
    dataSource = "ryze";
    endpoint;
    accessToken;
    platform;
    protocolVersion;
    audit;
    logger;
    transport;
    initialized = false;
    serverInfo;
    /** 工具发现缓存：连接级白名单过滤后的只读工具（写/未知工具在 gate1 即被丢弃，不可见）。 */
    knownTools = [];
    constructor(config) {
        this.endpoint = config.endpoint ?? exports.DEFAULT_RYZE_ENDPOINT;
        this.accessToken = config.accessToken;
        this.platform = config.platform;
        this.protocolVersion = config.protocolVersion ?? exports.DEFAULT_MCP_PROTOCOL_VERSION;
        this.audit = config.audit;
        this.logger = config.logger ?? console;
        this.transport = new HttpJsonRpcTransport(this.endpoint, this.accessToken, {
            timeoutMs: config.timeoutMs,
            fetchImpl: config.fetchImpl,
        });
    }
    /** 令牌指纹（日志/审计对账用，绝不含明文，§3.6）。 */
    get tokenFingerprint() {
        return tokenFingerprint(this.accessToken);
    }
    get isInitialized() {
        return this.initialized;
    }
    get server() {
        return this.serverInfo;
    }
    /** 本连接可见的只读工具清单（已过白名单，写/未知工具不出现）。 */
    get tools() {
        return this.knownTools;
    }
    // -------------------------------------------------------------------------
    // §5.1 连接（initialize + notifications/initialized + 工具发现）
    // -------------------------------------------------------------------------
    /** 建立 MCP 会话：initialize → notifications/initialized → tools/list（白名单过滤）。 */
    async connect() {
        const initResp = await this.transport.request("initialize", {
            protocolVersion: this.protocolVersion,
            capabilities: {},
            clientInfo: { name: "beijixing-backend", version: "0.1.0" },
        });
        if (!initResp || !initResp.result) {
            throw new McpCallError(-32603, "MCP initialize 未返回 result");
        }
        this.serverInfo = initResp.result;
        // notifications/initialized（无响应，通知 server 客户端已就绪）
        await this.transport.request("notifications/initialized", undefined, { notification: true });
        this.initialized = true;
        await this.refreshTools();
        this.logger.info({
            endpoint: this.endpoint,
            platform: this.platform,
            server: this.serverInfo.serverInfo?.name,
            protocolVersion: this.serverInfo.protocolVersion,
            tokenFingerprint: this.tokenFingerprint,
            readTools: this.knownTools.map((t) => t.name),
        }, "Ryze MCP 只读 client 已连接");
    }
    /** 工具发现：tools/list → 只读白名单过滤（gate1：白名单外不可见、不可调）。 */
    async refreshTools() {
        const resp = await this.transport.request("tools/list");
        const result = (resp?.result ?? {});
        const all = Array.isArray(result.tools) ? result.tools : [];
        // 连接级第一道闸：只保留只读白名单内的工具；写工具、本期禁用工具、未知新工具一律丢弃
        this.knownTools = all.filter((t) => isReadTool(t.name));
    }
    /** 公开工具发现入口（返回只读白名单内的工具，供上层/DSH 复用同一白名单）。 */
    async listTools() {
        await this.ensureConnected();
        await this.refreshTools();
        return this.knownTools;
    }
    /** 懒初始化：首次调用工具时若未 connect，则自动 connect。 */
    async ensureConnected() {
        if (!this.initialized)
            await this.connect();
    }
    // -------------------------------------------------------------------------
    // §5.2 白名单工具调用（route-level + code-level 双闸拦截）
    // -------------------------------------------------------------------------
    /**
     * 调用只读工具（唯一工具调用出口，§4.1 三道闸在此收口）：
     *   ① 写工具 → 直接抛 WriteToolDeniedError（代码级拦截，不发出任何网络请求）；
     *   ② 白名单外/本期禁用 → 抛 UnknownToolDeniedError（连接级 + 路由级）；
     *   ③ 只读工具 → 走 transport 调 tools/call。
     * 每次调用（成功/失败/拒绝）都落一条审计（§7）。
     */
    async callTool(toolName, args) {
        const started = Date.now();
        const emitAudit = (status, extra) => {
            if (!this.audit)
                return;
            const entry = {
                tool_name: toolName,
                tool_action: "read",
                status,
                data_source: "ryze",
                duration_ms: Date.now() - started,
                params_sanitized: args === undefined ? undefined : JSON.stringify(sanitizeParams(args)),
                ...extra,
            };
            void Promise.resolve(this.audit(entry)).catch(() => {
                /* 审计失败不阻断主流程 */
            });
        };
        // 代码级第三道闸：写工具 = 结构上不存在调用方法（先于任何网络请求拦截）
        if (isWriteTool(toolName)) {
            emitAudit("denied", { tool_action: "deny", error_code: "write_tool_denied" });
            this.logger.error({ toolName, tokenFingerprint: this.tokenFingerprint }, "WRITE_TOOL_DENIED");
            throw new WriteToolDeniedError(toolName);
        }
        // 连接级第一道闸 + 路由级第二道闸：非白名单/本期禁用工具不可调
        if (!isReadTool(toolName)) {
            emitAudit("denied", { tool_action: "deny", error_code: "unknown_tool_denied" });
            this.logger.warn({ toolName, tokenFingerprint: this.tokenFingerprint }, "UNKNOWN_TOOL_DENIED");
            throw new UnknownToolDeniedError(toolName);
        }
        await this.ensureConnected();
        try {
            const resp = await this.transport.request("tools/call", { name: toolName, arguments: args });
            const result = (resp?.result ?? {});
            if (result.isError === true) {
                // 工具自报失败：统一抛 McpCallError，由下方 catch 落「fail」审计（避免重复计数）
                throw new McpCallError(-32001, `工具「${toolName}」返回 isError`, result);
            }
            emitAudit("success", { result_summary: summarizeResult(result) });
            return result;
        }
        catch (err) {
            const code = err instanceof McpCallError
                ? err.code === -32001
                    ? "tool_is_error"
                    : String(err.code)
                : "unknown";
            emitAudit("fail", {
                error_code: code,
                result_summary: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }
    // -------------------------------------------------------------------------
    // §5.3 五类广告数据拉取封装（账户/系列/广告组/素材/每日指标，§5.1/§4.2）
    // -------------------------------------------------------------------------
    /** ① 账户：Meta=listAdAccounts / Google=listAccessibleCustomers。 */
    async listAccounts() {
        const tool = this.platform === "meta" ? "listAdAccounts" : "listAccessibleCustomers";
        const raw = await this.callTool(tool, {});
        return { toolName: tool, category: "account", dataSource: "ryze", raw };
    }
    /** ② 系列（campaign）：Meta=runGraphRead(GET) / Google=getAccountHierarchy。 */
    async listCampaigns(accountId) {
        const tool = this.platform === "meta" ? "runGraphRead" : "getAccountHierarchy";
        const raw = await this.callTool(tool, this.hierarchyArgs(accountId));
        return { toolName: tool, category: "campaign", dataSource: "ryze", raw };
    }
    /** ③ 广告组（ad set / ad group 统一中间层）：与系列同源，层级下钻。 */
    async listAdGroups(accountId, campaignId) {
        const tool = this.platform === "meta" ? "runGraphRead" : "getAccountHierarchy";
        const raw = await this.callTool(tool, this.hierarchyArgs(accountId, campaignId));
        return { toolName: tool, category: "adgroup", dataSource: "ryze", raw };
    }
    /** ④ 素材（creative）：Meta=listCreatives / Google=runRawGaql(asset)。 */
    async listCreatives(accountId) {
        const tool = this.platform === "meta" ? "listCreatives" : "runRawGaql";
        const raw = await this.callTool(tool, this.creativeArgs(accountId));
        return { toolName: tool, category: "creative", dataSource: "ryze", raw };
    }
    /** ⑤ 每日指标：Meta=getAccountSummary/runRawInsights / Google=getAccountSummary/runRawGaql。 */
    async getDailyMetrics(query) {
        const tool = this.metricsTool(query.level ?? "account");
        const raw = await this.callTool(tool, this.metricsArgs(query));
        return { toolName: tool, category: "daily_metric", dataSource: "ryze", raw };
    }
    /** 层级拉取入参（按平台拼参；原始账户前缀由 platform 补回，§6.2 去前缀规则的对偶）。 */
    hierarchyArgs(accountId, campaignId) {
        if (this.platform === "google") {
            // getAccountHierarchy：以 customer id 为入口
            return accountId ? { customerId: this.withPlatformPrefix(accountId) } : {};
        }
        // Meta runGraphRead：只读 GET（query 由上层以只读意图传入；写意图走 runGraphWrite，已被黑名单封死）
        const params = {};
        if (accountId)
            params.accountId = this.withPlatformPrefix(accountId);
        if (campaignId)
            params.campaignId = campaignId;
        return params;
    }
    /** 素材拉取入参。 */
    creativeArgs(accountId) {
        if (this.platform === "google") {
            // runRawGaql(asset)：GAQL 只读查询素材资源
            return { query: "SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.name FROM ad_group_ad", customerId: accountId ? this.withPlatformPrefix(accountId) : undefined };
        }
        const params = {};
        if (accountId)
            params.accountId = this.withPlatformPrefix(accountId);
        return params;
    }
    /** 每日指标工具选择（account 级走 summary，campaign/adgroup/creative 级走明细）。 */
    metricsTool(level) {
        if (level === "account")
            return "getAccountSummary";
        return this.platform === "meta" ? "runRawInsights" : "runRawGaql";
    }
    /** 每日指标入参（§5.2/§6.2：Google 统一 customerId，Meta 用 accountId；非 account 级需带 query）。 */
    metricsArgs(query) {
        if (this.platform === "google") {
            // Google 统一 customerId 命名（与 hierarchyArgs/creativeArgs 一致，§4.2）
            const base = {
                customerId: this.withPlatformPrefix(query.accountId),
                dateStart: query.dateStart,
                dateEnd: query.dateEnd,
            };
            if (query.level && query.level !== "account") {
                // runRawGaql：必须带只读 GAQL 查询串（编排层可覆盖，缺省用内置只读模板）
                return {
                    ...base,
                    query: query.query ?? this.defaultGaqlMetricsQuery(query),
                    entityId: query.entityId,
                    level: query.level,
                };
            }
            // account 级走 getAccountSummary
            return base;
        }
        // Meta：accountId 命名（act_ 前缀）
        const base = {
            accountId: this.withPlatformPrefix(query.accountId),
            dateStart: query.dateStart,
            dateEnd: query.dateEnd,
        };
        if (query.level && query.level !== "account") {
            return { ...base, level: query.level, entityId: query.entityId };
        }
        return base;
    }
    /** 内置只读 GAQL metrics 模板（非 account 级 runRawGaql 缺省查询，字段对齐 §6.2）。 */
    defaultGaqlMetricsQuery(query) {
        const level = query.level ?? "campaign";
        const from = level === "campaign"
            ? "campaign"
            : level === "adgroup"
                ? "ad_group"
                : level === "creative"
                    ? "ad_group_ad"
                    : "campaign";
        const select = level === "creative"
            ? "ad_group_ad.ad.resource_name, ad_group_ad.ad.name"
            : `${from}.resource_name, ${from}.name`;
        const where = [];
        if (query.dateStart && query.dateEnd) {
            where.push(`segments.date BETWEEN '${query.dateStart}' AND '${query.dateEnd}'`);
        }
        const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
        return (`SELECT ${select}, metrics.cost_micros, metrics.impressions, metrics.clicks, ` +
            `metrics.conversions, segments.date FROM ${from}${whereClause}`);
    }
    /** 平台前缀补回（§6.2 去前缀规则的对偶：裸 id ↔ act_/customers/）。 */
    withPlatformPrefix(bareId) {
        if (this.platform === "meta") {
            return bareId.startsWith("act_") ? bareId : `act_${bareId}`;
        }
        return bareId.includes("/") ? bareId : `customers/${bareId}`;
    }
    /** 关闭客户端（释放会话；历史已拉取数据不受影响）。 */
    close() {
        this.transport.close();
        this.initialized = false;
    }
}
exports.RyzeMCPClient = RyzeMCPClient;
/** 预留数据源桩：接口齐备，但每个方法都明确抛「尚未实现」，不静默降级、不编造数据。 */
class ReservedDataSource {
    dataSource;
    platform;
    constructor(dataSource, platform) {
        this.dataSource = dataSource;
        this.platform = platform;
    }
    notImpl() {
        // 返回 rejected Promise（而非同步 throw），严格符合 Promise<PullResult> 签名
        return Promise.reject(new DataSourceNotImplementedError(this.dataSource));
    }
    listAccounts() { return this.notImpl(); }
    listCampaigns() { return this.notImpl(); }
    listAdGroups() { return this.notImpl(); }
    listCreatives() { return this.notImpl(); }
    getDailyMetrics() { return this.notImpl(); }
}
/**
 * 数据源工厂（§2）：data_source 切换只改配置。
 *   ryze          → RyzeMCPClient（默认，已实现）
 *   meta_official → 预留（官方 API 后置备选）
 *   csv           → 预留（CSV 导入降级）
 */
function createAdsDataSource(config) {
    if (config.dataSource === "ryze") {
        return new RyzeMCPClient(config);
    }
    return new ReservedDataSource(config.dataSource, config.platform);
}
// ===========================================================================
// §7 工具函数
// ===========================================================================
/** 从 MCP 结果里提取纯文本内容（content 块中 text 类型拼接）。 */
function extractText(result) {
    const parts = [];
    for (const block of result.content ?? []) {
        if (block && block.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
        }
    }
    return parts.join("\n");
}
/** 结果摘要（审计用，不落完整载荷，§7.1）。 */
function summarizeResult(result) {
    const text = extractText(result);
    const n = result.content?.length ?? 0;
    return `content_blocks=${n}, text_chars=${text.length}`;
}
//# sourceMappingURL=ryze-client.js.map