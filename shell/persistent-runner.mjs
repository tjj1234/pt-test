import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

// media.route 依赖的 PowerTokens 调用层：makeProfile() 会把
// business/media/powertokens.cjs 复制到本插件同目录，这里按相对路径引用。
const require = createRequire(import.meta.url);
const { callMediaRoute } = require("./powertokens.cjs");
const { listStylePresets, stylePresetSummary } = require("./presets.cjs");
// ga.query 依赖的 GA4 连接器 executor（自包含：仅 node:http/node:crypto），
// makeProfile() 会把 business/attribution/ga-connector/executor.js 复制为
// 同目录 ga-query-executor.cjs，这里按相对路径引用。
const { buildGaQueryExecutor } = require("./ga-query-executor.cjs");
const http = require("node:http");
const crypto = require("node:crypto");

const STYLE_PRESET_ENUM = listStylePresets().map((p) => p.id);

// ga.query executor 依赖 { internalKey, dashPort } 与可信 tenantId：
// 由 dsh-adapter 在 spawn 前注入 DASH_PORT / PT_DASH_INTERNAL_KEY 到进程 env，
// tenantId 由每条 task 命令携带（见 handleTask）。此处仅构造一次。
const gaQueryExecutor = buildGaQueryExecutor({
  internalKey: process.env.PT_DASH_INTERNAL_KEY || "",
  dashPort: Number(process.env.DASH_PORT || 0),
});

const computeAnalyticsToken = (internalKey, tenantId) =>
  crypto.createHmac("sha256", internalKey).update(String(tenantId)).digest("hex");

// 把 from/to 归一化为后端 parseFunnelParams 期望的 epoch 毫秒：
// 接受 YYYY-MM-DD（转当天起止）或已是纯数字的 epoch 毫秒；其它原样透传交给后端 400。
function normalizeEpochBoundary(v, isEnd) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return s;
  if (/^\d+$/.test(s)) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const dayStart = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return String(isEnd ? dayStart + 86400000 - 1 : dayStart);
}

// attribution.query 真实 executor：GET /api/attribution/funnel（带 HMAC Authorization）。
function attributionQuery(args, tenantId) {
  const internalKey = process.env.PT_DASH_INTERNAL_KEY || "";
  const dashPort = Number(process.env.DASH_PORT || 0);
  const normalized = Object.assign({}, args || {});
  if (normalized.from != null && normalized.from !== "") normalized.from = normalizeEpochBoundary(normalized.from, false);
  if (normalized.to != null && normalized.to !== "") normalized.to = normalizeEpochBoundary(normalized.to, true);
  return new Promise((resolve, reject) => {
    const qs = Object.keys(normalized)
      .filter((k) => normalized[k] != null && normalized[k] !== "")
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(normalized[k])))
      .join("&");
    const path = "/api/attribution/funnel" + (qs ? "?" + qs : "");
    const req = http.request({
      host: "127.0.0.1",
      port: dashPort,
      path,
      method: "GET",
      headers: { authorization: "Bearer " + computeAnalyticsToken(internalKey, tenantId), accept: "application/json" },
    }, (res) => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("attribution.query 返回非 JSON")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("attribution.query 超时")));
    req.end();
  });
}

/**
 * persistent-runner —— 常驻 agent 驱动插件（替代 headless 一次性 runner）。
 * 挂载在 dsh-base 上（无 headless），通过 stdin/stdout 走 JSON-lines 协议：
 *   stdin  命令： {"type":"task","sessionId":..,"task":..,"model":..,"first":..}
 *               {"type":"close","sessionId":..}
 *               {"type":"ping"}  /  {"type":"exit"}
 *   stdout 事件： {"type":"ready"} | {"type":"delta","sessionId":..,"text":..}
 *               {"type":"done","sessionId":..,"ok":..,"text":..,"reason":..,"ms":..}
 *               {"type":"closed","sessionId":..} | {"type":"error",..} | {"type":"pong"}
 * 同一 sessionId 复用同一个 Agent（session 持久 = 轨迹可见）；进程常驻不退出。
 */

const name = "persistent-runner";
const inject = ["agentDefaultModel", "agents", "sessions"];

function emit(obj) {
  try { writeSync(1, JSON.stringify(obj) + "\n"); } catch (e) { /* stdout 关闭时忽略 */ }
}

/** 截断超长文本（轨迹展示用）。 */
function truncate(s, max) {
  const t = String(s == null ? "" : s);
  return t.length > max ? t.slice(0, max) + "…(截断)" : t;
}

/** 汇总一次 turn（seq >= firstSeq 的事件）里的最后一段 assistant 文本 + 结束原因。 */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") { started = true; continue; }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data?.message?.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text).join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data?.reason;
  }
  return { text, reason };
}

function apply(ctx) {
  (async () => {
    await ctx.get("loader")?.await();
    const agents = ctx.get("agents");
    const defaultModel = ctx.get("agentDefaultModel");
    const sessions = ctx.get("sessions");
    if (!agents || !defaultModel || !sessions) {
      emit({ type: "error", message: "persistent-runner: 核心服务缺失（agents/sessions/agentDefaultModel）" });
      return;
    }

    const agentMap = new Map();       // sessionId -> { agent }
    const sessionKey = new Map();     // dsh Session 对象 -> sessionId（流式事件路由）
    const stepNames = new Map();      // callId -> 工具名（tool/result 时回填名字）
    let lastMediaRouteResult = null;  // 本 turn 最近一次 media.route 的结构化结果 { type, url }
    let currentTenantId = "";         // 本 turn 租户上下文（cmd.tenantId 注入，供 ga.query / attribution.query）
    let lastReport = null;            // 本 turn 最近一次 ga.query 返回的 report（outputType=report，透传前端抽屉）

    // 逐字流 + 轨迹：把 assistant 文本增量 / 工具调用路由到对应 sessionId
    ctx.on("session/event", (session, event) => {
      const sid = sessionKey.get(session);
      if (!sid) return;
      if (event.type === "assistant/chunk") {
        const chunk = event.data?.chunk;
        if (chunk?.type === "text-delta" && chunk.text) {
          emit({ type: "delta", sessionId: sid, text: chunk.text });
        }
        return;
      }
      if (event.type === "tool/call") {
        const d = event.data || {};
        if (d.callId) stepNames.set(d.callId, d.name || "tool");
        emit({ type: "step", sessionId: sid, name: d.name || "tool", args: truncate(JSON.stringify(d.arguments), 200) });
        return;
      }
      if (event.type === "tool/result") {
        const d = event.data || {};
        const msg = d.message || {};
        const callId = msg.source && msg.source.callId;
        const name = stepNames.get(callId) || "tool";
        let text = "";
        let isError = false;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          if (!b || b.type !== "tool-result") continue;
          text = Array.isArray(b.content) ? b.content.map((c) => (c && c.text) || "").join("") : String(b.content == null ? "" : b.content);
          if (b.isError === true) isError = true;
        }
        emit({ type: "step", sessionId: sid, name, result: truncate(text, 400), isError });
        return;
      }
    });

    async function handleTask(cmd) {
      const sid = String(cmd.sessionId || "").trim();
      const task = String(cmd.task || "").trim();
      if (!sid) { emit({ type: "done", sessionId: sid, ok: false, error: "缺 sessionId" }); return; }
      if (!task) { emit({ type: "done", sessionId: sid, ok: false, error: "任务不能为空" }); return; }
      const t0 = Date.now();
      currentTenantId = String(cmd.tenantId || "").trim();

      let rec = agentMap.get(sid);
      try {
        if (!rec) {
          const selection = defaultModel.currentSelection();
          const provider = cmd.provider || selection.provider;
          const model = cmd.model || selection.model;
          const { agent } = await agents.create({
            sessionId: SessionId("session-" + sid),
            meta: { cwd: process.cwd() },
            agentOptions: { provider, model },
            setup: (agentCtx) => {
              installModelSelection(agentCtx, { current: { provider, model }, assembled: void 0 });
              // M1 探针：注册一个与业务线无关的 demo 工具，验证「对话 → 真实 tool/call → tool/result」链路
              agentCtx.tools.register(defineTool({
                name: "get_current_time",
                description: "返回当前精确时间、本地日期和星期几。当用户询问「现在几点 / 今天日期 / 今天星期几 / 当前时间」时使用此工具。",
                parameters: {},
                output: {
                  schema: {
                    type: "object",
                    properties: {
                      now: { type: "string", description: "ISO 8601 UTC 时间" },
                      localDate: { type: "string", description: "本地日期 YYYY-MM-DD" },
                      weekday: { type: "string", description: "本地星期几（如 星期六）" },
                    },
                    additionalProperties: false,
                  },
                  render: (_args, value) => {
                    const parts = [value.localDate, value.weekday, value.now].filter((v) => v);
                    return [{ type: "text", text: parts.join(" ") }];
                  },
                },
                async execute() {
                  // 服务端直接算好「本地日期 + 星期几」返回，避免模型拿 UTC 时间戳自行心算星期
                  // 导致时区/星期换算错误（此前「今天星期几」答错的根因）。
                  const d = new Date();
                  const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
                  const pad = (n) => String(n).padStart(2, "0");
                  const localDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                  return { now: d.toISOString(), localDate, weekday: WEEKDAYS[d.getDay()] };
                },
              }));

              // media.route：文件路由 skill。按 taskType 选择 PowerTokens 生成模型，
              // 返回结果（图片/视频）URL。DSH 进程已注入 POWERTOKENS_API_KEY。
              agentCtx.tools.register(defineTool({
                name: "media_route",
                description:
                  "根据用户上传的图片和文字描述，选择 PowerTokens 里合适的生成模型（文生图/图生图/文生视频/图生视频），生成并返回结果图片或视频的 URL。" +
                  "当用户说「生成一张图 / 把这张图改成… / 做成视频 / 生成一段视频 / 用这张图生成视频」等时使用此工具。对应业务 skill「media.route」。",
                parameters: {
                  taskType: {
                    type: "string",
                    enum: ["text2image", "image2image", "text2video", "image2video"],
                    description: "生成任务类型：text2image 文生图 / image2image 图生图 / text2video 文生视频 / image2video 图生视频",
                    required: true,
                  },
                  prompt: { type: "string", description: "生成提示词（描述要生成的画面 / 视频内容）", required: true },
                  inputImageUrl: {
                    type: "string",
                    description: "可选：输入图片的可公网访问 URL（http/https）或 data:image/...;base64 数据 URL。图生图 / 图生视频必填。",
                  },
                  stylePreset: {
                    type: "string",
                    enum: STYLE_PRESET_ENUM,
                    description:
                      "可选：风格预设模板 id，仅适用于文生图(text2image)/图生图(image2image)，不支持视频。选择后按模板提示词套路生成，占位符内容写进 prompt；需上传参考图的模板必须同时传 inputImageUrl。可选：\n" +
                      stylePresetSummary(),
                  },
                },
                output: {
                  schema: {
                    type: "object",
                    properties: {
                      taskType: { type: "string" },
                      label: { type: "string" },
                      model: { type: "string" },
                      provider: { type: "string" },
                      kind: { type: "string" },
                      url: { type: "string" },
                      elapsedMs: { type: "number" },
                    },
                    additionalProperties: false,
                  },
                  render: (_args, value) => {
                    const url = value && value.url;
                    const label = value && value.label;
                    return [{ type: "text", text: url ? `已生成${label || ""}，结果地址：${url}` : JSON.stringify(value) }];
                  },
                },
                async execute(args) {
                  const result = await callMediaRoute({}, args || {});
                  lastMediaRouteResult = result && result.url ? { type: result.kind, url: result.url } : null;
                  return result;
                },
              }));

              // ga.query：查询已授权 GA4 真实指标，outputType=report，结果透传前端抽屉。
              agentCtx.tools.register(defineTool({
                name: "ga_query",
                description: "查询已授权 GA4 property 的真实指标。metrics/dimensions 使用 GA4 API 名称；dateRange 使用 YYYY-MM-DD、today、yesterday 或 NdaysAgo；用户要求整理成表格时设置 format=table。对应业务工具「ga.query」。",
                parameters: {
                  metrics: { type: "array", items: { type: "string" }, required: true },
                  dimensions: { type: "array", items: { type: "string" } },
                  dateRange: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      startDate: { type: "string", required: true },
                      endDate: { type: "string", required: true },
                    },
                    required: true,
                  },
                  format: { type: "string", enum: ["summary", "table"] },
                },
                output: {
                  schema: { type: "object", additionalProperties: true },
                  render: (_args, value) => {
                    const title = value && value.title ? value.title : "GA 查询结果";
                    const meta = value && value.meta ? "（" + value.meta + "）" : "";
                    const rows = value && value.table && Array.isArray(value.table.rows) ? value.table.rows.length : 0;
                    return [{ type: "text", text: title + meta + (rows ? "；表格 " + rows + " 行" : "") }];
                  },
                },
                async execute(args) {
                  if (!currentTenantId) throw new Error("ga.query 需要 tenantId");
                  const report = await gaQueryExecutor(args || {}, { tenantId: currentTenantId });
                  lastReport = report && typeof report === "object" ? report : null;
                  return report;
                },
              }));

              // attribution.query：查询归因漏斗/素材表现（真实数据来自业务线只读接口）。
              agentCtx.tools.register(defineTool({
                name: "attribution_query",
                description: "查询指定时间范围内的归因漏斗和素材表现。当用户询问广告归因、转化漏斗、素材投放效果、各平台/国家表现时使用此工具。对应业务工具「attribution.query」。",
                parameters: {
                  from: { type: "string", description: "起始日期 YYYY-MM-DD", required: true },
                  to: { type: "string", description: "结束日期 YYYY-MM-DD", required: true },
                  platform: { type: "string", enum: ["google", "meta", "x"], description: "可选：投放平台" },
                  country: { type: "string", description: "可选：国家/地区代码" },
                },
                output: {
                  schema: { type: "object", additionalProperties: true },
                  render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
                },
                async execute(args) {
                  if (!currentTenantId) throw new Error("attribution.query 需要 tenantId");
                  return attributionQuery(args || {}, currentTenantId);
                },
              }));
            },
          });
          await agent.whenIdle();
          rec = { agent };
          agentMap.set(sid, rec);
          sessionKey.set(agent.session, sid);
        }

        const agent = rec.agent;
        const firstSeq = agent.session.seq;
        lastMediaRouteResult = null;
        lastReport = null;
        agent.followup(createUserMessage({
          content: [{ type: "text", text: task }],
          source: { kind: "user" },
        }));
        await agent.whenIdle();
        await sessions.flush(agent.session);
        const outcome = summarize(agent.session.events, firstSeq);
        emit({
          type: "done", sessionId: sid,
          ok: outcome.reason?.kind === "completed" || outcome.text !== "",
          text: outcome.text,
          media: lastMediaRouteResult ? [lastMediaRouteResult] : null,
          report: lastReport,
          reason: outcome.reason?.kind ?? null,
          reasonDetail: outcome.reason?.error ? { code: outcome.reason.error.code, message: outcome.reason.error.message } : null,
          canceled: !!(outcome.reason && (outcome.reason.kind === "user" || outcome.reason.kind === "parent" || outcome.reason.kind === "hook")),
          ms: Date.now() - t0,
        });
      } catch (e) {
        emit({ type: "done", sessionId: sid, ok: false, error: String(e && e.message || e), ms: Date.now() - t0 });
      }
    }

    async function handleClose(cmd) {
      const sid = String(cmd.sessionId || "").trim();
      const rec = agentMap.get(sid);
      if (rec) {
        try { await sessions.flush(rec.agent.session); } catch (e) { /* 忽略 */ }
        sessionKey.delete(rec.agent.session);
        agentMap.delete(sid);
      }
      emit({ type: "closed", sessionId: sid });
    }

    /** P1-4：按 sessionId 优雅取消当前 turn（agent.cancel 会中止正在跑的一轮）。 */
    function handleAbort(cmd) {
      const sid = String(cmd.sessionId || "").trim();
      const rec = agentMap.get(sid);
      if (rec) {
        try { rec.agent.cancel({ kind: "user" }); } catch (e) { /* 忽略 */ }
        emit({ type: "aborted", sessionId: sid });
      } else {
        emit({ type: "aborted", sessionId: sid, note: "no-agent" });
      }
    }

    function shutdown() {
      emit({ type: "bye" });
      const exit = ctx.get("appExit");
      if (typeof exit === "function") exit(0);
      else process.exit(0);
    }

    async function handleLine(cmd) {
      switch (cmd.type) {
        case "task": await handleTask(cmd); return;
        case "close": await handleClose(cmd); return;
        default: emit({ type: "error", message: "unknown cmd: " + cmd.type }); return;
      }
    }

    // stdin 顺序消费（task/close 排队；abort/ping/exit 立即处理，不被运行中的 task 阻塞）
    let buf = "";
    let queue = Promise.resolve();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let cmd;
        try { cmd = JSON.parse(line); } catch (e) { emit({ type: "error", message: "bad json: " + line }); continue; }
        // P1-4：取消命令立即生效（否则会被当前正在 await whenIdle 的 task 卡住）
        if (cmd.type === "abort") { handleAbort(cmd); continue; }
        if (cmd.type === "ping") { emit({ type: "pong" }); continue; }
        if (cmd.type === "exit") { shutdown(); continue; }
        queue = queue.then(() => handleLine(cmd)).catch((e) => emit({ type: "error", message: String(e && e.message || e) }));
      }
    });
    process.stdin.on("end", () => { queue.then(() => shutdown()); });

    emit({ type: "ready" });
  })().catch((e) => {
    emit({ type: "error", message: String(e && e.message || e) });
    process.exit(1);
  });
}

export { name, inject, apply };
