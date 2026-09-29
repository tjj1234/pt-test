import { writeSync } from "node:fs";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

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
        const name = stepNames.get(msg.callId) || "tool";
        const content = msg.content;
        const text = Array.isArray(content) ? content.map((b) => (b && b.text) || "").join("") : String(content == null ? "" : content);
        emit({ type: "step", sessionId: sid, name, result: truncate(text, 400), isError: msg.isError === true });
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
            },
          });
          await agent.whenIdle();
          rec = { agent };
          agentMap.set(sid, rec);
          sessionKey.set(agent.session, sid);
        }

        const agent = rec.agent;
        const firstSeq = agent.session.seq;
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
