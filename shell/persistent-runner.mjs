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

const STYLE_PRESET_ENUM = listStylePresets().map((p) => p.id);

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
                description: "返回当前精确时间（ISO 8601 字符串）。当用户询问「现在几点 / 当前时间」时使用此工具。",
                parameters: {},
                output: {
                  schema: { type: "object", properties: { now: { type: "string" } }, additionalProperties: false },
                  render: (_args, value) => [{ type: "text", text: String(value.now) }],
                },
                async execute() {
                  return { now: new Date().toISOString() };
                },
              }));

              // media.route：文件路由 skill。按 taskType 选择 PowerTokens 生成模型，
              // 返回结果（图片/视频）URL。DSH 进程已注入 POWERTOKENS_API_KEY。
              agentCtx.tools.register(defineTool({
                name: "media.route",
                description:
                  "根据用户上传的图片和文字描述，选择 PowerTokens 里合适的生成模型（文生图/图生图/文生视频/图生视频），生成并返回结果图片或视频的 URL。" +
                  "当用户说「生成一张图 / 把这张图改成… / 做成视频 / 生成一段视频 / 用这张图生成视频」等时使用此工具。",
                parameters: {
                  type: "object",
                  properties: {
                    taskType: {
                      type: "string",
                      enum: ["text2image", "image2image", "text2video", "image2video"],
                      description: "生成任务类型：text2image 文生图 / image2image 图生图 / text2video 文生视频 / image2video 图生视频",
                    },
                    prompt: { type: "string", description: "生成提示词（描述要生成的画面 / 视频内容）" },
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
                  required: ["taskType", "prompt"],
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
