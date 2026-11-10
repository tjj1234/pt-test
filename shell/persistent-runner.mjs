import { readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { apply as installAskUserTool } from "@deepseek-ai/dsh-tool-ask-user";
import {installPublishedSkillProvider} from './published-skill-provider.mjs';
import {installNativeContextGateR4} from './dsh-native-context-r4-candidate.mjs';
import {nativeImageMessage} from './native-image-message.mjs';
let withNativeAnalysisExecution=(_active,_execution,next)=>next();
let withNativeWebExecution=(_active,_execution,next)=>next();
let withNativeQuestionExecution = (_active,_execution,next) => next();

const require = createRequire(import.meta.url);
const { createRunBudget } = require("./budget.cjs");
const { collectResponseUsage, collectModelIdentity } = require("./usage.cjs");
const { listStylePresets, stylePresetSummary } = require("./presets.cjs");
// Business executors run in the trusted host through registered RPC handlers.
const crypto = require("node:crypto");

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const HOST_RUN_TOOL_NAMES = new Set(["get_current_time", "media_route", "csv_analyze", "billing_query", "document_export", "analysis_list", "analysis_read", "run_script", "ga_query", "attribution_query", "attribution_quality", "tracking_quality_audit", "skill_resource"]);
const NATIVE_RUN_TOOL_NAMES = new Set(['ask_user_question', 'skill', 'web_search','web_fetch']);
const RUN_TOOL_NAMES = new Set([...HOST_RUN_TOOL_NAMES, ...NATIVE_RUN_TOOL_NAMES]);
const MEDIA_TASK_TYPES = new Set(["text2image", "image2image", "text2video", "image2video"]);
const RUNNER_FAILURE_MESSAGES = Object.freeze({
  UNSUPPORTED_REASONING_EFFORT: 'The selected model does not support this reasoning effort',
  UNKNOWN_MODEL: 'The selected model is absent from the active DSH configuration; operator settings upgrade is required',
  NO_ADAPTER: 'The selected provider has no active DSH adapter',
  INVALID_REQUEST: 'The model adapter rejected the request; diagnostic details were withheld',
  RUN_TOOL_CONTEXT_INVALID: 'The tool request is not bound to the active Run agent and native call record',
  RUN_DURATION_LIMIT: "Run duration limit reached before the agent turn completed",
  RUN_MODEL_CALL_LIMIT: "Run stopped because the model-call budget was exhausted",
  RUN_TOOL_CALL_LIMIT: "Run stopped because the tool-call budget was exhausted",
  RUN_TOOL_NOT_ALLOWED: "Run stopped because this tool is outside the configured scope",
  RUN_MEDIA_TASK_NOT_ALLOWED: "Run stopped because this media task is outside the configured scope",
  RUN_DUPLICATE_TOOL_LIMIT: "Run stopped because the repeated-tool-call budget was exhausted",
  RUN_RETRY_LIMIT: "Run stopped because the retry budget was exhausted",
  RUN_COST_UNKNOWN: "Run stopped because cost evidence was unavailable",
  RUN_COST_LIMIT: "Run stopped because the configured cost limit was reached",
  RUN_CLOCK_UNKNOWN: "Run stopped because the runtime budget clock became unavailable",
  RUN_BUDGET_CONFIG_INVALID: "Run budget configuration is missing or unreadable or invalid",
  NATIVE_SESSION_UNAVAILABLE: 'Saved context is unavailable; retry to rebuild from retained history',
  RUN_CONTEXT_UNAVAILABLE: 'Native context compaction is unavailable',
  RUN_OUTPUT_LIMIT: 'Model request exceeds the configured output limit',
  RUN_NOT_BOUND: 'Model request no longer belongs to the active Run',
  INTENT_AUDIT_FAILED: 'Model intent could not be recorded',
  MISSING_INTENT_RECORDER: 'Durable model intent recording is unavailable',
  RUN_INTERRUPTED: "Run was interrupted because the runner process is shutting down",
  NATIVE_IMAGE_MODEL_UNSUPPORTED: "The selected model route has no verified image input capability",
});

function safeBudgetSummary(active) {
  if (!active) return { configured: null, status: "unavailable", snapshot: null };
  let raw;
  try { raw = active.budget?.snapshot?.(); } catch { raw = null; }
  const snapshot = raw && typeof raw === "object" ? {
    elapsedMs: Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0 ? raw.elapsedMs : null,
    modelCalls: Number.isSafeInteger(raw.modelCalls) && raw.modelCalls >= 0 ? raw.modelCalls : null,
    toolCalls: Number.isSafeInteger(raw.toolCalls) && raw.toolCalls >= 0 ? raw.toolCalls : null,
    retries: Number.isSafeInteger(raw.retries) && raw.retries >= 0 ? raw.retries : null,
    duplicateToolCalls: Number.isSafeInteger(raw.duplicateToolCalls) && raw.duplicateToolCalls >= 0 ? raw.duplicateToolCalls : null,
    // A configured currency cap cannot be reported as known until trusted actual
    // provider cost evidence is available. This runner currently fails closed.
    costStatus: active.limits?.maxCost ? "unknown" : (["unlimited", "unknown", "known"].includes(raw.costStatus) ? raw.costStatus : "unknown"),
    policyStatus: ["configured", "unconfigured"].includes(raw.policyStatus) ? raw.policyStatus : (active.configured ? "configured" : "unconfigured"),
    clockStatus: ["monotonic", "unknown"].includes(raw.clockStatus) ? raw.clockStatus : "unknown",
  } : null;
  return {
    configured: active.configured === true,
    status: active.configured === true ? "configured" : "unconfigured",
    limits: active.limits && typeof active.limits === "object" ? {
      ...Object.fromEntries(
      ["maxDurationMs", "maxModelCalls", "maxToolCalls", "maxToolCallsPerKey", "maxRetries", "maxOutputTokens", "contextModelCalls"]
        .filter((key) => Number.isSafeInteger(active.limits[key]) && (["maxRetries", "maxToolCalls", "maxToolCallsPerKey", "contextModelCalls"].includes(key) ? active.limits[key] >= 0 : active.limits[key] > 0))
        .map((key) => [key, active.limits[key]]),
      ),
      ...(active.limits.maxCost && Number.isFinite(active.limits.maxCost.amount) && active.limits.maxCost.amount >= 0 &&
        typeof active.limits.maxCost.currency === "string" && active.limits.maxCost.currency.trim()
        ? { maxCost: { amount: active.limits.maxCost.amount, currency: active.limits.maxCost.currency.trim() } }
        : {}),
      ...(Number.isSafeInteger(active.maxOutputTokens) && active.maxOutputTokens > 0 ? { maxOutputTokens: active.maxOutputTokens } : {}),
      ...(active.toolPolicy?.allowedTools ? { allowedTools: [...active.toolPolicy.allowedTools] } : {}),
      ...(active.toolPolicy?.allowedMediaTaskTypes ? { allowedMediaTaskTypes: [...active.toolPolicy.allowedMediaTaskTypes] } : {}),
    } : {},
    snapshot,
  };
}

function budgetAdmissionError(code, fallback) {
  return new LlmError(RUNNER_FAILURE_MESSAGES[code] || fallback, code);
}

function loadRunBudgetPolicy(profile = "default") {
  const dshHome = process.env.DSH_HOME;
  if (!dshHome) throw Object.assign(new Error("Run budget configuration root is unavailable"), { code: "RUN_BUDGET_CONFIG_INVALID" });
  const mediaTask = /^(?:skill-)?media:(text2image|image2image|text2video|image2video)$/.exec(profile)?.[1] || null;
  const withSkill=profile==='skill'||profile==='skill-csv'||profile.startsWith('skill-media:');
  if (profile !== "default" && profile!=="billing" && profile!=="documents" && profile!=="analysis" && profile !== "web" && profile !== "questions" && profile !== "csv" && profile!=="skill" && profile!=="skill-csv" && !mediaTask) throw Object.assign(new Error("Run budget profile is invalid"), { code: "RUN_BUDGET_CONFIG_INVALID" });
  const configPath = path.join(dshHome, "profiles", "run-persistent", mediaTask ? (withSkill?"run-budget-skill-media.json":"run-budget-media.json") : profile === "analysis"?"run-budget-analysis.json":profile === "documents"?"run-budget-documents.json":profile === "billing"?"run-budget-billing.json":profile === "web" ? "run-budget-web.json" : profile === "questions" ? "run-budget-questions.json" : profile === "skill" ? "run-budget-skill.json" : profile === "skill-csv" ? "run-budget-skill-csv.json" : profile === "csv" ? "run-budget-csv.json" : "run-budget.json");
  let text;
  try { text = readFileSync(configPath, "utf8"); }
  catch {
    throw Object.assign(new Error("Run budget configuration is missing or unreadable"), { code: "RUN_BUDGET_CONFIG_INVALID" });
  }
  const supported = new Set(["maxDurationMs", "maxModelCalls", "maxToolCalls", "maxToolCallsPerKey", "maxRetries", "maxOutputTokens", "maxCost", "allowedTools", "allowedMediaTaskTypes", "contextModelCalls"]);
  let limits = {};
  if (text !== null) {
    try { limits = JSON.parse(text); } catch {
      throw Object.assign(new Error("Run budget configuration is invalid JSON"), { code: "RUN_BUDGET_CONFIG_INVALID" });
    }
    if (!limits || typeof limits !== "object" || Array.isArray(limits) || !Object.keys(limits).length ||
        Object.keys(limits).some((key) => !supported.has(key))) {
      throw Object.assign(new Error("Run budget configuration must contain supported finite limits"), { code: "RUN_BUDGET_CONFIG_INVALID" });
    }
    for (const [key, value] of Object.entries(limits)) {
      if (key === "allowedTools" || key === "allowedMediaTaskTypes") {
        const known = key === "allowedTools" ? RUN_TOOL_NAMES : MEDIA_TASK_TYPES;
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !known.has(item)) ||
            new Set(value).size !== value.length) {
          throw Object.assign(new Error("Run tool scope must contain known unique names"), { code: "RUN_BUDGET_CONFIG_INVALID" });
        }
        continue;
      }
      if (key === "maxCost") {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            !Number.isFinite(value.amount) || value.amount < 0 ||
            typeof value.currency !== "string" || !value.currency.trim() ||
            Object.keys(value).some((field) => !["amount", "currency"].includes(field))) {
          throw Object.assign(new Error("Run cost limit must contain a finite non-negative amount and currency"), { code: "RUN_BUDGET_CONFIG_INVALID" });
        }
        limits[key] = { amount: value.amount, currency: value.currency.trim() };
        continue;
      }
      const tooLong = key === "maxDurationMs" && value > MAX_TIMER_DELAY_MS;
      const zeroAllowed = ["maxRetries", "maxToolCalls", "maxToolCallsPerKey", "contextModelCalls"].includes(key) && value === 0;
      if (!Number.isSafeInteger(value) || (value <= 0 && !zeroAllowed) || tooLong) {
        throw Object.assign(new Error("Run budget limit is outside its supported range"), { code: "RUN_BUDGET_CONFIG_INVALID" });
      }
    }
  }
  if (mediaTask) {
    // This host-selected profile scopes a single explicitly granted task.
    // Count limits remain the existing Run guard, never a monetary promise.
    if (limits.maxDurationMs !== 180000 || limits.maxOutputTokens !== 512 || limits.maxModelCalls !== (withSkill?5:3) || limits.contextModelCalls !== 1 || limits.maxToolCalls !== (withSkill?3:1) || limits.maxToolCallsPerKey !== 1 || limits.maxRetries !== 0 ||
        limits.maxCost !== undefined || JSON.stringify(limits.allowedTools)!==JSON.stringify(withSkill?['media_route','skill','skill_resource']:['media_route'])) {
      throw Object.assign(new Error("Controlled media policy is invalid"), { code: "RUN_BUDGET_CONFIG_INVALID" });
    }
    limits.allowedMediaTaskTypes = [mediaTask];
  }
  const { maxOutputTokens, allowedTools, allowedMediaTaskTypes, contextModelCalls=0, ...budgetLimits } = limits;
  if(contextModelCalls&&(contextModelCalls>1||contextModelCalls>=(budgetLimits.maxModelCalls||0)))throw budgetAdmissionError('RUN_BUDGET_CONFIG_INVALID');
  if (allowedMediaTaskTypes && (!allowedTools || !allowedTools.includes("media_route"))) {
    throw Object.assign(new Error("Media task scope requires the media tool"), { code: "RUN_BUDGET_CONFIG_INVALID" });
  }
  const toolPolicy = {
    allowedTools: allowedTools === undefined ? null : Object.freeze([...allowedTools]),
    allowedMediaTaskTypes: allowedMediaTaskTypes === undefined ? null : Object.freeze([...allowedMediaTaskTypes]),
  };
  try { return { limits: {...budgetLimits,...(contextModelCalls?{contextModelCalls}:{})}, contextModelCalls, maxOutputTokens, toolPolicy, budget: createRunBudget({ limits: budgetLimits }), configured: true }; }
  catch {
    throw Object.assign(new Error("Run budget configuration is invalid"), { code: "RUN_BUDGET_CONFIG_INVALID" });
  }
}

function canonicalToolKey(name, args) {
  function normalize(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
    }
    throw Object.assign(new Error("Tool arguments cannot be canonicalized"), { code: "TOOL_ARGS_INVALID" });
  }
  let encoded;
  try { encoded = JSON.stringify([name, normalize(args == null ? {} : args)]); }
  catch (error) { throw Object.assign(new Error("Tool arguments cannot be canonicalized"), { code: error?.code || "TOOL_ARGS_INVALID" }); }
  return crypto.createHash("sha256").update(encoded).digest("hex");
}

const STYLE_PRESET_ENUM = listStylePresets().map((p) => p.id);

// 生成图片/视频后，结果已通过 media 字段直接显示在对话里（render() 已让轨迹不显示链接）；
// 但工具原始返回（含 url）仍完整进入模型上下文，模型可能自己复述链接。注入此提示避免重复念 url。
const MEDIA_NO_LINK_NOTE =
  "生成的图片/视频已经直接显示在对话里了，回复里不要再重复粘贴链接，用一句话说明生成完成就行。";

/**
 * persistent-runner —— 常驻 agent 驱动插件（替代 headless 一次性 runner）。
 * 挂载在 dsh-base 上（无 headless），通过 stdin/stdout 走 JSON-lines 协议：
 *   stdin  命令： {"type":"task","sessionId":..,"task":..,"model":..,"first":..}
 *               {"type":"close","sessionId":..}
 *               {"type":"ping"}  /  {"type":"exit"}
 *   stdout 事件： {"type":"ready"} | {"type":"delta","sessionId":..,"text":..}
 *               {"type":"tool_request","requestId":..,"sessionId":..,"name":..,"args":..}
 *   stdin  RPC回包： {"type":"tool_response","requestId":..,"sessionId":..,"ok":..,"result"|"error":..}
 *               {"type":"done","sessionId":..,"ok":..,"text":..,"reason":..,"ms":..}
 *               {"type":"closed","sessionId":..} | {"type":"error",..} | {"type":"pong"}
 * 同一 sessionId 复用同一个 Agent（session 持久 = 轨迹可见）；进程常驻不退出。
 */

const name = "persistent-runner";
const inject = ["agentDefaultModel", "agents", "sessions", "attachments", "userQuestions", "tools", "systemPrompt", "web", "fs", "subprocess", "approval"];
const RPC_PROTOCOL_VERSION = 1;
const RPC_CAPABILITIES = Object.freeze(["task-v1", "tool-rpc-v1", "abort-v1", "model-intent-v1", "model-info-v1", "reasoning-selection-v1", "native-context-v1", "skill-pins-v1"]);
const CONTROL_ERROR_MESSAGES = Object.freeze({
  RUNNER_SETUP_FAILED: "Persistent runner setup failed",
  RUNNER_QUEUE_FAILED: "Parent command could not be processed",
  PARENT_FRAME_INVALID: "Parent frame is not valid JSON",
  PARENT_COMMAND_UNSUPPORTED: "Parent command is not supported",
});

function emitControlError(code, sessionId) {
  emit({ type: "error", ...(sessionId ? { sessionId } : {}), code,
    message: CONTROL_ERROR_MESSAGES[code] || "Persistent runner request failed" });
}

function safeSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function emit(obj) {
  try { writeSync(1, JSON.stringify({ ...obj, protocolVersion: RPC_PROTOCOL_VERSION }) + "\n"); } catch (e) { /* stdout 关闭时忽略 */ }
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
  return { text, reason, usageEvidence: collectResponseUsage(events, firstSeq), modelIdentity: collectModelIdentity(events, firstSeq) };
}

async function guardNativeToolExecution(active, execution, next) {
  const deny=code=>{if(active)active.policyDenied=code;return budgetAdmissionError(code);};
  if (!active?.agent || execution?.agent !== active.agent || !execution?.signal || typeof execution.signal.aborted !== 'boolean') {
    throw deny('RUN_TOOL_CONTEXT_INVALID');
  }
  // Warm agents span multiple Runs. Agent identity alone cannot authorize a
  // delayed call from an earlier Run; require the current native tool/call log.
  const rootCallId = execution.rootCallId || execution.callId;
  if (!rootCallId || !active.stepNames?.has(rootCallId) ||
      (rootCallId === execution.callId && active.stepNames.get(rootCallId) !== execution.name)) {
    throw deny('RUN_TOOL_CONTEXT_INVALID');
  }
  if (active.expired) throw deny('RUN_DURATION_LIMIT');
  if (active.cancelRequested || execution.signal.aborted) throw new LlmError('Run tool request was cancelled', 'RUN_CANCELLED');
  if (!active.budget || active.configured !== true) throw deny('RUN_BUDGET_CONFIG_INVALID');
  // Existing host tool wrappers own their admission and durable RPC. Never
  // debit them twice. All other dispatches must pass the native tool policy.
  if (HOST_RUN_TOOL_NAMES.has(execution.name)) return withNativeAnalysisExecution(active,execution,next);
  if (!NATIVE_RUN_TOOL_NAMES.has(execution.name) || !Array.isArray(active.toolPolicy?.allowedTools) || !active.toolPolicy.allowedTools.includes(execution.name)) {
    throw deny('RUN_TOOL_NOT_ALLOWED');
  }
  if(execution.name==='web_search'&&(!Array.isArray(execution.arguments?.queries)||execution.arguments.queries.length!==1||typeof execution.arguments.queries[0]!=='string'||!execution.arguments.queries[0].trim()||execution.arguments.queries[0].length>512))throw budgetAdmissionError('WEB_INPUT_INVALID');
  if(execution.name==='ask_user_question'&&active.preflightQuestion)await active.preflightQuestion(execution);
  if(active.cancelRequested||active.expired||execution.signal.aborted)throw budgetAdmissionError('RUN_CANCELLED');
  const admission = active.budget.admit({type: 'tool', key: canonicalToolKey(execution.name, execution.arguments)});
  if (!admission.allowed) {
    if (admission.code === 'RUN_DURATION_LIMIT') active.expire?.();
    throw deny(admission.code);
  }
  try { return await withNativeQuestionExecution(active,execution,()=>withNativeWebExecution(active,execution,next)); }
  finally { admission.settle(); }
}

function apply(ctx,compositionOptions={}) {
  let setupStage="initial";
  (async () => {
    await ctx.get("loader")?.await();
    const agents = ctx.get("agents");
    const defaultModel = ctx.get("agentDefaultModel");
    const sessions = ctx.get("sessions");
    if (!agents || !defaultModel || !sessions) {
      emitControlError("RUNNER_SETUP_FAILED");
      return;
    }

    const agentMap = new Map();       // sessionId -> { agent }
    const sessionKey = new Map();     // dsh Session 对象 -> sessionId（流式事件路由）
    const pendingToolRequests = new Map(); // requestId -> { sessionId, resolve, reject }
    const activeTurns = new Map(); // sessionId -> isolated turn context
    let preflightNativeQuestionExecution=async()=>{};
    if(ctx.get("userQuestions")){
    const nativeQuestions = await import('./native-question-provider.mjs');
    withNativeQuestionExecution=nativeQuestions.withNativeQuestionExecution;
    preflightNativeQuestionExecution=async (active,execution)=>{
      await requestParentTool(active.sessionId,'northstar.user_question_validate',nativeQuestions.nativeQuestionPreflightArguments(execution));
      if(activeTurns.get(active.sessionId)!==active||active.cancelRequested||active.expired||execution.signal.aborted)throw budgetAdmissionError('RUN_CANCELLED');
    };
    const {installNativeQuestionProvider}=nativeQuestions;
    installAskUserTool(ctx);
    installNativeQuestionProvider(ctx,{
      getActiveTurn:agent=>[...activeTurns.values()].find(turn=>turn.agent===agent),
      ask:(active,args)=>requestParentTool(active.sessionId,'northstar.user_question',args),
    });
    }
    let nativeAnalysis=null;
    if(ctx.get('fs')&&ctx.get('subprocess')&&ctx.get('approval')){
      const provider=await import('./native-analysis-provider.mjs');withNativeAnalysisExecution=provider.withNativeAnalysisExecution;
      nativeAnalysis=provider.installNativeAnalysisProvider(ctx,{getActiveTurn:agent=>[...activeTurns.values()].find(turn=>turn.agent===agent),requestApproval:(active,args)=>requestParentTool(active.sessionId,'northstar.operation_approval',args),consumeApproval:(active,args)=>requestParentTool(active.sessionId,'northstar.operation_approval_consume',args),...(typeof compositionOptions.analysisArgumentsFactory==='function'?{argumentsFactory:compositionOptions.analysisArgumentsFactory}:{})});
    }
    if(ctx.get('web')?.registerFetchProvider){
      setupStage='web-provider-import';
      const nativeWeb=await import('./native-web-provider.mjs');withNativeWebExecution=nativeWeb.withNativeWebExecution;
      setupStage='web-provider-registration';
      nativeWeb.installNativeWebProvider(ctx,{getActiveTurn:agent=>[...activeTurns.values()].find(turn=>turn.agent===agent),request:(active,args)=>requestParentTool(active.sessionId,'northstar.web',args)});
      setupStage='web-tool-import';
      const {applyWebSearchTool,applyWebFetchTool}=await import('@deepseek-ai/dsh-tool-web');
      setupStage='web-search-registration';if(!ctx.tools.get('web_search'))applyWebSearchTool(ctx,5,1,15000,true);
      setupStage='web-fetch-registration';if(!ctx.tools.get('web_fetch'))applyWebFetchTool(ctx,15000,20000);
      setupStage='web-ready';
    }
    const nativeContextGate=installNativeContextGateR4(ctx,{
      getActiveTurn:nativeId=>{const turn=activeTurns.get(String(nativeId).replace(/^session-/,''));return turn?{sessionId:nativeId,runId:turn.runId,tenantId:turn.tenantId,budget:{admit:operation=>{if(turn.auxiliaryAdmissions>=turn.contextModelCalls)return {allowed:false,code:'RUN_MODEL_CALL_LIMIT'};const admission=turn.budget.admit(operation);if(admission.allowed)turn.auxiliaryAdmissions++;return admission;}},cancelRequested:turn.cancelRequested,expired:turn.expired,maxOutputTokens:turn.maxOutputTokens}:null;},
      onAuxiliaryDispatch:binding=>{const active=activeTurns.get(String(binding.sessionId).replace(/^session-/,''));if(active?.runId!==binding.runId)throw budgetAdmissionError('RUN_NOT_BOUND');active.auxiliaryDispatches++;},
      getChatTicket:request=>{const active=activeTurns.get(String(request.sessionId).replace(/^session-/,''));const ticket=active?.chatTicket;if(active)active.chatTicket=null;return ticket;},
      recordModelIntent:async intent=>{
        const sid=String(intent.sessionId).replace(/^session-/,'');const active=activeTurns.get(sid);
        if(!active?.recordModelIntents)throw budgetAdmissionError('MISSING_INTENT_RECORDER');
        await requestParentTool(sid,'northstar.model_request_intent',{provider:intent.provider,model:intent.model,purpose:'compaction',turn:active.requestTurn||0,step:active.requestStep||0,maxTokens:intent.maxTokens||null});
      },
    });
    const publishedSkillProvider=installPublishedSkillProvider(ctx,{
      getActiveTurn:agent=>[...activeTurns.values()].find(turn=>turn.agent===agent),
      readRelease:(active,releaseId)=>requestParentTool(active.sessionId,'northstar.skill_snapshot',{releaseId}),
    });
    const sessionQueues = new Map(); // sessionId -> FIFO task/close chain
    let shutdownRequested = false;
    let shutdownPromise = null;

    function registerRunTool(agentCtx, sessionId, name, definition) {
      // Persistent agents outlive one Run budget. Register the tool once and
      // apply the current turn's limits at execution, so a later explicitly
      // configured Run can use it without losing conversation history.
      const execute = definition.execute;
      if (typeof execute !== "function") throw new TypeError("Run tool requires an execute function");
      const wrapped = {
        ...definition,
        async execute(...args) {
          const active = activeTurns.get(sessionId);
          const deny=code=>{if(active)active.policyDenied=code;return budgetAdmissionError(code);};
          if (!active?.budget || active.configured !== true) {
            throw deny("RUN_BUDGET_CONFIG_INVALID", "Run tool budget is unavailable");
          }
          if (active.toolPolicy?.allowedTools && !active.toolPolicy.allowedTools.includes(name)) {
            throw deny("RUN_TOOL_NOT_ALLOWED", "Run tool is outside the configured scope");
          }
          if (name === "media_route" && active.toolPolicy?.allowedMediaTaskTypes &&
              !active.toolPolicy.allowedMediaTaskTypes.includes(args[0]?.taskType)) {
            throw deny("RUN_MEDIA_TASK_NOT_ALLOWED", "Run media task is outside the configured scope");
          }
          if (name === "get_current_time") {
            return await execute.apply(this, args);
          }
          const admission = active.budget.admit({ type: "tool", key: canonicalToolKey(name, args[0]) });
          if (!admission.allowed) {
            if (admission.code === "RUN_DURATION_LIMIT") active.expire?.();
            throw deny(admission.code, "Run tool admission was denied by the configured budget");
          }
          try { return await execute.apply(this, args); }
          finally { admission.settle(); }
        },
      };
      agentCtx.tools.register(defineTool(wrapped));
    }

    function rejectToolRequests(sessionId, code, message) {
      for (const [requestId, pending] of [...pendingToolRequests.entries()]) {
        if (sessionId != null && pending.sessionId !== sessionId) continue;
        pendingToolRequests.delete(requestId);
        pending.reject(Object.assign(new Error(message), { code }));
      }
    }

    function requestParentTool(sessionId, name, args) {
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pendingToolRequests.set(requestId, { sessionId, resolve, reject });
        emit({ type: "tool_request", requestId, sessionId, name, args: args == null ? {} : args });
      });
    }

    function handleToolResponse(frame) {
      if (typeof frame.requestId !== "string" || typeof frame.sessionId !== "string") return;
      const pending = pendingToolRequests.get(frame.requestId);
      if (!pending || pending.sessionId !== frame.sessionId) return;
      pendingToolRequests.delete(frame.requestId);
      if (frame.protocolVersion !== RPC_PROTOCOL_VERSION) {
        pending.reject(Object.assign(new Error("Parent RPC protocol version mismatch"), { code: "PROTOCOL_VERSION_MISMATCH" }));
        return;
      }
      if (frame.ok === true) { pending.resolve(frame.result); return; }
      const code = typeof frame.error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(frame.error.code) ? frame.error.code : "TOOL_REQUEST_FAILED";
      const message = typeof frame.error?.message === "string" ? frame.error.message.slice(0, 200) : "Parent tool request failed";
      pending.reject(Object.assign(new Error(message), { code }));
    }

    // 逐字流 + 轨迹：把 assistant 文本增量 / 工具调用路由到对应 sessionId
    ctx.on("session/event", (session, event) => {
      const sid = sessionKey.get(session);
      if (!sid) return;
      const turn = activeTurns.get(sid);
      if(event.type==='compaction/end'&&turn&&!event.data?.error)turn.compactions++;
      if (event.type === "assistant/chunk") {
        const chunk = event.data?.chunk;
        if (chunk?.type === "text-delta" && chunk.text) {
          emit({ type: "delta", sessionId: sid, text: chunk.text });
        }
        return;
      }
      if (event.type === "tool/call") {
        const d = event.data || {};
        if (d.callId && turn) turn.stepNames.set(d.callId, d.name || "tool");
        const args = truncate(JSON.stringify(d.arguments), 200);
        if (d.callId && turn) turn.stepStarted.set(d.callId, { name: d.name || "tool", args, t0: Date.now() });
        emit({ type: "step", sessionId: sid, callId: d.callId, name: d.name || "tool", args, phase: "call" });
        return;
      }
      if (event.type === "tool/result") {
        const d = event.data || {};
        const msg = d.message || {};
        const callId = msg.source && msg.source.callId;
        const started = callId && turn ? turn.stepStarted.get(callId) : null;
        const name = (started && started.name) || (callId && turn ? turn.stepNames.get(callId) : null) || "tool";
        let text = "";
        let isError = false;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          if (!b || b.type !== "tool-result") continue;
          text = Array.isArray(b.content) ? b.content.map((c) => (c && c.text) || "").join("") : String(b.content == null ? "" : b.content);
          if (b.isError === true) isError = true;
        }
        const durationMs = started ? (Date.now() - started.t0) : null;
        const modelName = (name === "media_route" || name === "media.route") ? turn?.lastMediaRouteModel ?? null : null;
        emit({ type: "step", sessionId: sid, callId, name, args: started ? started.args : undefined, result: truncate(text, 400), isError, durationMs, modelName, phase: "result" });
        if (callId && turn) turn.stepStarted.delete(callId);
        return;
      }
    });

    // Metadata uses the installed LLM service only; never creates an Agent/task.
    let metadataBusy = false;
    async function handleModelInfo(cmd) {
      const requestId = safeSessionId(cmd.requestId);
      if (!requestId) return;
      const reply = (value) => emit({ type: "model_info", requestId, ...value });
      if (typeof cmd.provider !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(cmd.provider)
          || typeof cmd.model !== "string" || !/^[A-Za-z0-9_./:@+-]{1,256}$/.test(cmd.model)) {
        reply({ ok: false, code: "MODEL_INFO_INVALID" }); return;
      }
      if (metadataBusy) { reply({ ok: false, code: "MODEL_INFO_BUSY" }); return; }
      metadataBusy = true;
      try {
        const info = await ctx.get("llm").resolveModelInfo(cmd.provider, cmd.model);
        const entries = info?.reasoning?.efforts;
        const efforts = [];
        if (entries !== undefined) {
          if (!Array.isArray(entries) || entries.length > 16) throw new Error();
          for (const entry of entries) {
            if (typeof entry?.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id)
                || typeof entry.name !== "string" || entry.name.length > 128
                || efforts.some((item) => item.id === entry.id)) throw new Error();
            efforts.push({ id: entry.id, name: entry.name });
          }
        }
        const defaultEffort = info?.reasoning?.defaultEffort;
        if (defaultEffort !== undefined && !efforts.some((item) => item.id === defaultEffort)) throw new Error();
        reply({ ok: true, provider: cmd.provider, model: cmd.model, efforts,
          ...(defaultEffort === undefined ? {} : { defaultEffort }) });
      } catch {
        reply({ ok: false, code: "MODEL_INFO_UNAVAILABLE" });
      } finally { metadataBusy = false; }
    }

    async function handleTask(cmd) {
      if (cmd.protocolVersion !== RPC_PROTOCOL_VERSION || typeof cmd.sessionId !== "string"
          || !cmd.sessionId.trim() || typeof cmd.task !== "string" || !cmd.task.trim()
          || typeof cmd.tenantId !== "string" || !cmd.tenantId.trim()
          || (cmd.model != null && typeof cmd.model !== "string")
          || (cmd.reasoningEffort !== undefined && (typeof cmd.reasoningEffort !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cmd.reasoningEffort)))
          || (cmd.resume!==undefined&&typeof cmd.resume!=='boolean')
          || (cmd.compact!==undefined&&typeof cmd.compact!=='boolean')
          || (cmd.runId!==undefined&&(typeof cmd.runId!=='string'||!cmd.runId.trim()||cmd.runId.length>128))
          || (cmd.recordModelIntents !== undefined && typeof cmd.recordModelIntents !== "boolean")
          || (cmd.budgetProfile !== undefined && !["csv","skill","skill-csv","questions","web","billing","documents","analysis"].includes(cmd.budgetProfile) && !/^(?:skill-)?media:(text2image|image2image|text2video|image2video)$/.test(cmd.budgetProfile))) {
        emit({ type: "error", sessionId: safeSessionId(cmd.sessionId),
          code: cmd.protocolVersion !== RPC_PROTOCOL_VERSION ? "PROTOCOL_VERSION_MISMATCH" : "TASK_FRAME_INVALID",
          message: "Parent task frame is invalid" });
        return;
      }
      const sid = String(cmd.sessionId || "").trim();
      const task = String(cmd.task || "").trim();
      if (!sid) { emit({ type: "done", sessionId: sid, ok: false, error: "缺 sessionId" }); return; }
      if (!task) { emit({ type: "done", sessionId: sid, ok: false, error: "任务不能为空" }); return; }
      const t0 = Date.now();
      const turn = {
        sessionId: sid,
        runId:typeof cmd.runId==='string'&&cmd.runId.trim()?cmd.runId:crypto.randomUUID(),
        compactions:0,
        auxiliaryDispatches:0,
        auxiliaryAdmissions:0,
        primaryModelCalls:0,
        preflightQuestion:execution=>preflightNativeQuestionExecution(turn,execution),
        analysisWorkspace:cmd.budgetProfile==='analysis'?cmd.analysisWorkspace:null,
        pinnedSkills:cmd.pinnedSkills||{skills:[]},
        recordModelIntents: cmd.recordModelIntents === true,
        tenantId: String(cmd.tenantId || "").trim(),
        mediaRouteResults: [],
        lastMediaRouteModel: null,
        reportResults: [],
        stepNames: new Map(),
        stepStarted: new Map(),
        agent: null,
        cancelRequested: false,
        cancelOrigin: null,
      };

      let rec = agentMap.get(sid);
      turn.requiresImage = Boolean(rec?.hasNativeImages || (Array.isArray(cmd.inputImages) && cmd.inputImages.length));
      let durationTimer = null;
      let activeBudget = null;
      let firstSeq = null;
      let turnDispatched = false;
      const collectTurnUsage=()=>{
        const events=rec?.agent?.session?.events||[],evidence=collectResponseUsage(events,firstSeq??0);
        const recorded=events.filter(event=>event.seq>=(firstSeq??0)&&event.type==='compaction/summary'&&event.data?.llmStreamCall===true).length;
        if(turn.auxiliaryDispatches>recorded){evidence.unrecordedAuxiliaryCalls=turn.auxiliaryDispatches-recorded;evidence.coverage='partial';evidence.totalSemantics='unknown';if(evidence.usage)evidence.usage=Object.fromEntries(Object.keys(evidence.usage).map(key=>[key,null]));}
        return evidence;
      };
      activeTurns.set(sid, turn);
      try {
        const defaults = defaultModel.currentSelection();
        const selection = rec?.modelSelection || { current: { provider: cmd.provider || defaults.provider, model: cmd.model || defaults.model }, assembled: void 0 };
        // The model-selection hooks are installed once per persistent agent;
        // update their shared ref before each followup so a reused session can
        // honor the model selected for this task.
        const nextSelection = { provider: cmd.provider || defaults.provider, model: cmd.model || defaults.model,
          ...(cmd.reasoningEffort === undefined ? {} : {reasoningEffort:cmd.reasoningEffort}) };
        const policy = loadRunBudgetPolicy(cmd.budgetProfile || "default");
        activeBudget = {
          budget: policy?.budget || null,
          configured: policy?.configured === true,
          contextModelCalls:policy?.contextModelCalls||0,
          borrowUnusedContextSlot:cmd.budgetProfile==='questions',
          limits: policy?.limits || {},
          toolPolicy: policy?.toolPolicy || null,
          maxOutputTokens: Number.isSafeInteger(policy?.maxOutputTokens) ? policy.maxOutputTokens : null,
          expired: false,
          expire: () => {
            if (activeBudget.expired) return;
            activeBudget.expired = true;
            rejectToolRequests(sid, "RUN_DURATION_LIMIT", "Run duration limit reached");
            turn.cancelRequested = true;
            turn.preflightController?.abort();
            turn.cancelOrigin = "timeout";
            if (turn.agent) { try { turn.agent.cancel({ kind: "hook" }); } catch { /* preserve timeout outcome */ } }
          },
        };
        Object.assign(turn, activeBudget);
        activeTurns.set(sid, turn);
        if (policy?.limits.maxDurationMs != null) {
          durationTimer = setTimeout(() => activeBudget.expire(), policy.limits.maxDurationMs);
        }
        if (cmd.reasoningEffort !== undefined) {
          turn.preflightController = new AbortController();
          await ctx.get("llm").resolveCallConfig(nextSelection,turn.preflightController.signal);
        }
        if (turn.cancelRequested || activeBudget.expired) throw new LlmError("Run canceled before selection",activeBudget.expired ? "RUN_DURATION_LIMIT" : "RUN_CANCELLED");
        selection.current = nextSelection;
        selection.assembled = void 0;
        if (!rec) {
          const provider = selection.current.provider;
          const model = selection.current.model;
          const creationOptions={
            sessionId: SessionId("session-" + sid),
            meta: { cwd: process.cwd() },
            agentOptions: { provider, model, ...(activeBudget.maxOutputTokens ? { maxTokens: activeBudget.maxOutputTokens } : {}) },
            setup: (agentCtx) => {
              // Native DSH tools traverse this seam too. Binding is by the
              // live Agent object, not a caller-supplied session/Run string.
              agentCtx.on('tools/execute', (execution, next) => guardNativeToolExecution(activeTurns.get(sid), execution, next));
              // Admit each model request before the adapter can send it. A
              // configured cost cap without trusted estimate evidence fails closed.
              agentCtx.on("agent/request", async (_payload, next) => {
                const active = activeTurns.get(sid);
                if (!active?.budget || active.configured !== true) {
                  throw budgetAdmissionError("RUN_BUDGET_CONFIG_INVALID", "Run model budget is unavailable");
                }
                if(active.policyDenied)throw budgetAdmissionError(active.policyDenied);
                if(active.contextModelCalls&&!active.borrowUnusedContextSlot&&active.primaryModelCalls>=active.limits.maxModelCalls-active.contextModelCalls)throw budgetAdmissionError('RUN_MODEL_CALL_LIMIT');
                const admission = active.budget.admit({ type: "model" });
                if (!admission.allowed) {
                  if (admission.code === "RUN_DURATION_LIMIT") active.expire?.();
                  throw budgetAdmissionError(admission.code, "Run model request was denied by the configured budget");
                }
                active.primaryModelCalls++;
                try {
                  const config = { ...await next() };
                  if(active.requiresImage){
                    const info=await ctx.get('llm').resolveModelInfo(config.provider,config.model);
                    if(!info.inputModalities?.includes('image'))throw budgetAdmissionError('NATIVE_IMAGE_MODEL_UNSUPPORTED');
                    active.nativeImageCapabilityChecked=true;
                  }
                  // Agent instances survive multiple Run policies. Apply this
                  // turn's output bound to the actual provider request too.
                  if (Number.isSafeInteger(active.maxOutputTokens)) config.maxTokens = active.maxOutputTokens;
                  else delete config.maxTokens;
                  if (activeTurns.get(sid)?.recordModelIntents) {
                    await requestParentTool(sid, "northstar.model_request_intent", {
                      model: config.model, provider: config.provider,
                      turn: _payload.turn, step: _payload.step,
                      maxTokens: Number.isSafeInteger(config.maxTokens) ? config.maxTokens : null,
                    });
                  }
                  if(activeTurns.get(sid)!==active||active.cancelRequested||active.expired||_payload.signal?.aborted)throw budgetAdmissionError('RUN_CANCELLED');
                  active.requestTurn=_payload.turn;active.requestStep=_payload.step;
                  active.chatTicket=nativeContextGate.ticketManager.issueTicket({sessionId:'session-'+sid,runId:active.runId,provider:config.provider,model:config.model,budgetAdmission:admission});
                  admission.settle();
                  return config;
                } catch (error) {
                  admission.settle();
                  throw error;
                }
              });
              // Cordis waterfalls wrap earlier listeners around later ones.
              // Keep selection inside admission so awaited next() returns the
              // current model before its durable intent is checked by the host.
              installModelSelection(agentCtx, selection);
              // Cap retries requested by any DSH recovery hook. The provider's
              // own retryPolicy is separately set to zero for the controlled trial.
              agentCtx.on("agent/request-error", async (_payload, next) => {
                const action = await next();
                if (action?.kind !== "retry") return action;
                const active = activeTurns.get(sid);
                if (!active?.budget || active.configured !== true) return undefined;
                const admission = active.budget.admit({ type: "retry" });
                if (!admission.allowed) {
                  if (admission.code === "RUN_DURATION_LIMIT") active.expire?.();
                  return undefined;
                }
                admission.settle();
                return action;
              });
              registerRunTool(agentCtx,sid,'skill_resource',{
                name:'skill_resource',description:'Read supporting text files from the exact published Skill release pinned to this Run. This grants no script or system execution.',
                parameters:{releaseId:{type:'string',required:true},paths:{type:'array',required:true,items:{type:'string'}}},
                output:{schema:{type:'object',additionalProperties:false,properties:{skillId:{type:'string'},version:{type:'string'},contentHash:{type:'string'},files:{type:'array',items:{type:'object',additionalProperties:false,properties:{path:{type:'string'},content:{type:'string'}}}}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
                execute:args=>requestParentTool(sid,'northstar.skill_resource',args),
              });
              // M1 探针：注册一个与业务线无关的 demo 工具，验证「对话 → 真实 tool/call → tool/result」链路
              for(const [tool,parameters,description,method]of [
                ['analysis_list',{},'列出本次任务已验证的只读输入文件。','list'],
                ['analysis_read',{name:{type:'string',required:true}},'读取本次任务中的 UTF-8 文本输入文件。','read'],
                ['run_script',{language:{type:'string',required:true,enum:['python']},code:{type:'string',required:true}},'经用户对精确代码批准后执行 Python 只读分析。禁止网络、写文件、派生进程；最多5秒，输出有上限。','run']]){
                registerRunTool(agentCtx,sid,tool,{name:tool,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:args=>{if(!nativeAnalysis)throw Object.assign(Error('Analysis unavailable'),{code:'ISOLATION_BACKEND_UNAVAILABLE'});return nativeAnalysis[method](args);}});
              }
              registerRunTool(agentCtx,sid,'document_export',{
                name:'document_export',description:'生成本次任务的 Word、PDF 或 Excel 文件。传入标题、章节文字和表格；生成结果是可下载文件。仅在用户明确要求生成文件时使用；不执行脚本，不访问外部链接。',
                parameters:{"format": {"type": "string", "required": true, "enum": ["docx", "pdf", "xlsx"]}, "document": {"type": "object", "required": true, "properties": {"title": {"type": "string", "required": true}, "author": {"type": "string"}, "date": {"type": "string"}, "sections": {"type": "array", "items": {"type": "object", "properties": {"heading": {"type": "string"}, "paragraphs": {"type": "array", "items": {"type": "string"}}, "table": {"type": "object", "properties": {"headers": {"type": "array", "items": {"type": "string"}}, "rows": {"type": "array", "items": {"type": "array", "items": {"type": "json"}}}}, "additionalProperties": false}}, "additionalProperties": false}}, "table": {"type": "object", "properties": {"headers": {"type": "array", "items": {"type": "string"}}, "rows": {"type": "array", "items": {"type": "array", "items": {"type": "json"}}}}, "additionalProperties": false}}, "additionalProperties": false}},
                output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
                execute:args=>requestParentTool(sid,'northstar.document_export',args),
              });
              registerRunTool(agentCtx,sid,'billing_query',{
                name:'billing_query',description:'只读查询用户已授权的PT官方账户余额、账单汇总、协议状态或最新消费记录。官方实扣为credits；不自动关联本Run，不换算USD，不发起模型或支付请求。',
                parameters:{kind:{type:'string',required:true,enum:['balance','usage','agreement','latest']},startDate:{type:'string'},endDate:{type:'string'}},
                output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
                execute:args=>requestParentTool(sid,'northstar.billing',args),
              });
              registerRunTool(agentCtx, sid, "get_current_time", {
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
              });

              // media.route：文件路由 skill。按 taskType 选择 PowerTokens 生成模型，
              // 返回结果（图片/视频）URL。DSH 进程已注入 POWERTOKENS_API_KEY。
              registerRunTool(agentCtx, sid, "media_route", {
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
                      // Host-owned local artifact receipt. The native tool SDK
                      // validates output before the Agent can record its media.
                      managed: {
                        type: "object",
                        properties: {
                          rel: { type: "string" },
                          mime: { type: "string" },
                          size: { type: "number" },
                          sha256: { type: "string" },
                        },
                        additionalProperties: false,
                      },
                    },
                    additionalProperties: false,
                  },
                  render: (_args, value) => {
                    // 图片/视频本身已通过 media 字段传给前端渲染，文字里不再重复原始链接，
                    // 避免 AI 把 URL 念出来。只给一句不带链接的简短提示。
                    const label = value && value.label;
                    return [{ type: "text", text: label ? `已生成${label}` : "已生成" }];
                  },
                },
                async execute(args) {
                  // The trusted built-in media tool crosses to the parent so it
                  // can attach durable run identity and budget admission. Keep
                  // the original JSON arguments intact; arbitrary tools cannot
                  // select this fixed RPC name through this code path.
                  const result = await requestParentTool(sid, "media.route", args || {});
                  const turn = activeTurns.get(sid);
                  if (turn && result && result.url) turn.mediaRouteResults.push({ type: result.kind, url: result.url });
                  if (turn) turn.lastMediaRouteModel = result && result.model ? String(result.model) : null;
                  return result;
                },
              });

              registerRunTool(agentCtx, sid, "csv_analyze", {
                name: "csv_analyze",
                description: "仅当用户已上传当前 CSV，且明确给出列号与数据起始行时，对指定列做精确求和、有效数值计数、最小值或最大值。不要猜表头、列号或日期；sourceRef 和 sourceSha256 必须取自当前 CSV 文档元数据。",
                parameters: {
                  sourceRef: { type: "string", required: true },
                  sourceSha256: { type: "string", required: true },
                  operation: { type: "string", enum: ["sum", "count", "min", "max"], required: true },
                  column: { type: "number", required: true },
                  startRow: { type: "number", required: true },
                  outputFormat: {type:"string",enum:["csv","xlsx"],description:"结果文件格式；默认csv，需要Excel结果时选择xlsx。"},
                },
                output: {
                  schema: { type: "object", properties: {
                    kind: { type: "string" }, result: { type: "string" },
                    valueCount: { type: "number" }, source: { type: "object", additionalProperties: true },
                    selection: { type: "object", additionalProperties: true },
                    evidence: { type: "object", additionalProperties: true },
                    artifact: { type: "object", additionalProperties: true },
                  }, additionalProperties: false },
                  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                },
                async execute(args) {
                  return requestParentTool(sid, "csv.analyze", args || {});
                },
              });

              // ga.query：查询已授权 GA4 真实指标，outputType=report，结果透传前端抽屉。
              registerRunTool(agentCtx, sid, "ga_query", {
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
                    // 表格留给抽屉；元信息与指标汇总必须进入模型可见的工具结果。
                    const stats = value && Array.isArray(value.stats) ? value.stats.map((row) => Array.isArray(row) ? row.join(": ") : "").filter(Boolean).join("\n") : "";
                    return [{ type: "text", text: title + meta + (rows ? "；表格 " + rows + " 行" : "") + (stats ? "\n" + stats : "") }];
                  },
                },
                async execute(args) {
                  const turn = activeTurns.get(sid);
                  if (!turn?.tenantId) throw new Error("ga.query 需要 tenantId");
                  const executor = ctx.get("persistentRunnerExecutors")?.gaQuery || ((input) => requestParentTool(sid, "ga.query", input));
                  const report = await executor(args || {}, { tenantId: turn.tenantId });
                  if (turn && report && typeof report === "object") turn.reportResults.push(report);
                  return report;
                },
              });

              // attribution.query：查询归因漏斗/素材表现（真实数据来自业务线只读接口）。
              registerRunTool(agentCtx, sid, "attribution_query", {
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
                  const turn = activeTurns.get(sid);
                  if (!turn?.tenantId) throw new Error("attribution.query 需要 tenantId");
                  const executor = ctx.get("persistentRunnerExecutors")?.attributionQuery || ((input) => requestParentTool(sid, "attribution.query", input));
                  return executor(args || {}, turn.tenantId);
                },
              });

              // attribution.quality：只读分析归因埋点质量，outputType=report，结果透传前端抽屉。
              registerRunTool(agentCtx, sid, "attribution_quality", {
                name: "attribution_quality",
                description: "只读分析当前租户真实归因事件的六类关键事件覆盖率、user_id完整率及已导入sGTM日志的有效ID重复率；返回评分、问题与规则建议。当用户询问归因埋点质量、事件覆盖、数据完整度时使用此工具。对应业务工具「attribution.quality」。",
                parameters: {
                  from: { type: "string", description: "UTC 起始日期 YYYY-MM-DD，默认最近7天，最多31天" },
                  to: { type: "string", description: "UTC 结束日期（含当日）YYYY-MM-DD" },
                },
                output: {
                  schema: { type: "object", additionalProperties: true },
                  render: (_args, value) => {
                    // C3：模型只能拿到「标题 + 评分」这种短摘要，追问扣分项时答不上来。
                    // 这里把报告的关键细节（评分口径、统计、问题清单/影响/建议）一并输出给模型，
                    // 完整 report 仍由 execute 透传给前端抽屉展示。
                    const v = value && typeof value === "object" ? value : {};
                    const title = v.title || "埋点质量分析";
                    const score = v.score && v.score.value != null ? String(v.score.value) : "未评分";
                    const scoreLabel = v.score && v.score.label ? "（" + v.score.label + "）" : "";
                    const stats = Array.isArray(v.stats) ? v.stats.map((r) => Array.isArray(r) ? r.join("：") : String(r)).filter(Boolean).join("；") : "";
                    const rows = v.table && Array.isArray(v.table.rows) ? v.table.rows : [];
                    const issues = rows.map((r) => {
                      if (!Array.isArray(r)) return "";
                      const sev = r[0] ? "[" + r[0] + "] " : "";
                      const problem = r[1] || "";
                      const impact = r[2] ? " — 影响：" + r[2] : "";
                      const advice = r[3] ? " — 建议：" + r[3] : "";
                      return problem ? sev + problem + impact + advice : "";
                    }).filter(Boolean).join("\n");
                    const suggestions = Array.isArray(v.suggestions) ? v.suggestions.filter(Boolean).join("\n") : "";
                    const parts = [title + "；评分 " + score + scoreLabel];
                    if (stats) parts.push("统计：" + stats);
                    if (issues) parts.push("问题清单：\n" + issues);
                    else if (suggestions) parts.push("建议：\n" + suggestions);
                    return [{ type: "text", text: parts.join("\n") }];
                  },
                },
                async execute(args) {
                  const turn = activeTurns.get(sid);
                  if (!turn?.tenantId) throw new Error("attribution.quality 需要 tenantId");
                  const executor = ctx.get("persistentRunnerExecutors")?.attributionQuality || ((input) => requestParentTool(sid, "attribution.quality", input));
                  const report = await executor(args || {}, turn.tenantId);
                  if (turn && report && typeof report === "object") turn.reportResults.push(report);
                  return report;
                },
              });

              // tracking_quality_audit：埋点质量 AI 分析，outputType=report，结果透传前端抽屉。
              registerRunTool(agentCtx, sid, "tracking_quality_audit", {
                name: "tracking_quality_audit",
                description: "只读审计当前工作区的真实事件适配统计，按 Token 业务模板（saas_token_marketplace）返回埋点质量评分、问题列表与整改建议；无数据不评高分。当用户询问埋点质量、事件适配质量、事件 ID / 时间戳兜底情况时使用此工具。对应业务 skill「tracking_quality_audit」。",
                parameters: {
                  template: { type: "string", enum: ["saas_token_marketplace"], description: "业务模板，本期仅支持 saas_token_marketplace" },
                },
                output: {
                  schema: { type: "object", additionalProperties: true },
                  render: (_args, value) => {
                    // C3：同 attribution_quality —— 把扣分项/原因/整改建议带进模型可见结果，
                    // 完整 report 仍由 execute 透传给前端抽屉展示。
                    const v = value && typeof value === "object" ? value : {};
                    const title = v.title || "埋点质量 AI 分析";
                    const score = v.scoreBar && v.scoreBar.value != null ? String(v.scoreBar.value) : "未评分";
                    const scoreLabel = v.scoreBar && v.scoreBar.label ? "（" + v.scoreBar.label + "）" : "";
                    const components = (v.scoreBar && Array.isArray(v.scoreBar.components))
                      ? v.scoreBar.components.map((c) => c && c.label ? c.label + " 扣 " + (c.deduction == null ? "—" : c.deduction) : "").filter(Boolean).join("；")
                      : "";
                    const rows = v.issuesTable && Array.isArray(v.issuesTable.rows) ? v.issuesTable.rows : [];
                    const issues = rows.map((r) => {
                      if (!r || typeof r !== "object") return "";
                      const sev = r.severity ? "[" + r.severity + "] " : "";
                      const t = r.title || "";
                      const impact = r.impact ? " — 影响：" + r.impact : "";
                      return t ? sev + t + impact : "";
                    }).filter(Boolean).join("\n");
                    const recs = Array.isArray(v.recommendations)
                      ? v.recommendations.map((r) => r && r.action ? (r.priority ? "[" + r.priority + "] " : "") + r.action : "").filter(Boolean).join("\n")
                      : "";
                    const parts = [title + "；评分 " + score + scoreLabel];
                    if (components) parts.push("扣分项：" + components);
                    if (issues) parts.push("问题：" + issues);
                    if (recs) parts.push("整改建议：" + recs);
                    return [{ type: "text", text: parts.join("\n") }];
                  },
                },
                async execute(args) {
                  const turn = activeTurns.get(sid);
                  if (!turn?.tenantId) throw new Error("tracking_quality_audit 需要 tenantId");
                  const executor = ctx.get("persistentRunnerExecutors")?.trackingQualityAudit || (() => requestParentTool(sid, "tracking_quality_audit", args || {}));
                  const report = await executor(turn.tenantId);
                  if (turn && report && typeof report === "object") turn.reportResults.push(report);
                  return report;
                },
              });
            },
          };
          let handle;try{handle=cmd.resume===true?await agents.resume({...creationOptions,resumeSessionId:creationOptions.sessionId}):await agents.create(creationOptions);}catch(error){if(cmd.resume===true)throw budgetAdmissionError('NATIVE_SESSION_UNAVAILABLE');throw error;}const {agent}=handle;
          await agent.whenIdle();
          rec = { agent, handle, modelSelection: selection, hasNativeImages: cmd.resume===true && agent.session.deriveMessages().some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='image')) };
          turn.requiresImage = Boolean(turn.requiresImage || rec.hasNativeImages);
          agentMap.set(sid, rec);
          sessionKey.set(agent.session, sid);
          turn.agent = agent;
          if (activeBudget.expired || turn.cancelRequested) { try { agent.cancel({ kind: activeBudget.expired || turn.cancelOrigin === "shutdown" ? "hook" : "user" }); } catch { /* preserve timeout outcome */ } }
        }

        const agent = rec.agent;
        turn.agent = agent;
        if(ctx.get('userQuestions')){
          rec.questionMaskDispose?.();
          const visibleTools=new Set(turn.toolPolicy?.allowedTools||['get_current_time']);
          rec.questionMaskDispose=agent.ctx.tools.restrict({deny:[...RUN_TOOL_NAMES].filter(name=>!visibleTools.has(name))});
        }
        publishedSkillProvider.invalidate();
        firstSeq = agent.session.seq;
        if (activeBudget.expired) {
          rejectToolRequests(sid, "RUN_DURATION_LIMIT", "Run duration limit reached");
          const usageEvidence = collectResponseUsage(agent.session.events, firstSeq);
          emit({ type: "done", sessionId: sid, ok: false, text: "", canceled: true, stopReason: "timeout", error: "Run duration limit reached", usage: usageEvidence.usage, usageEvidence, modelIdentity: collectModelIdentity(agent.session.events, firstSeq), budget: safeBudgetSummary(activeBudget), ms: Date.now() - t0 });
          return;
        }
        if (turn.cancelRequested) {
          const usageEvidence = collectResponseUsage(agent.session.events, firstSeq);
          const shutdown = turn.cancelOrigin === "shutdown";
          emit({ type: "done", sessionId: sid, ok: false, code: shutdown ? "RUN_INTERRUPTED" : "RUN_CANCELLED", error: shutdown ? RUNNER_FAILURE_MESSAGES.RUN_INTERRUPTED : "Run was cancelled by the parent request", text: "", canceled: !shutdown, reason: shutdown ? "shutdown" : "user", usage: usageEvidence.usage, usageEvidence, modelIdentity: collectModelIdentity(agent.session.events, firstSeq), budget: safeBudgetSummary(activeBudget), ms: Date.now() - t0 });
          return;
        }
        if(cmd.compact===true){
          const compaction=ctx.get('compaction');if(!compaction)throw budgetAdmissionError('RUN_CONTEXT_UNAVAILABLE');
          turn.preflightController ||= new AbortController();
          const result=await compaction.compactNow(agent,turn.preflightController.signal);
          await sessions.flush(agent.session);
          const usageEvidence=collectTurnUsage();
          emit({type:'done',sessionId:sid,ok:true,text:result?'上下文已压缩，摘要已保存，可继续对话。':'当前没有可压缩的历史。',usage:usageEvidence.usage,usageEvidence,modelIdentity:collectModelIdentity(agent.session.events,firstSeq),context:{kind:'dsh-native-context-v1',compactions:result?1:0,manual:true,resumed:cmd.resume===true},budget:safeBudgetSummary(activeBudget),ms:Date.now()-t0});
          return;
        }
        const userMessage = await nativeImageMessage({attachments:ctx.get('attachments'),
          text:task + "\n\n[系统提示] " + MEDIA_NO_LINK_NOTE, images:cmd.inputImages ?? []});
        turn.newNativeImageCount=userMessage.content.filter(block=>block.type==='image').length;
        if(turn.cancelRequested||activeBudget.expired)throw new LlmError('Run cancelled before image dispatch',activeBudget.expired?'RUN_DURATION_LIMIT':'RUN_CANCELLED');
        turnDispatched = true;
        agent.followup(userMessage);
        if(userMessage.content.some(block=>block.type==='image'))rec.hasNativeImages=true;
        await agent.whenIdle();
        await sessions.flush(agent.session);
        const outcome = summarize(agent.session.events, firstSeq);
        outcome.usageEvidence=collectTurnUsage();outcome.usage=outcome.usageEvidence.usage;
        rejectToolRequests(sid, "TASK_FINISHED", "DSH task finished before the parent response arrived");
        const stopRequested = activeBudget.expired || turn.cancelOrigin === "user" || ["user", "parent"].includes(outcome.reason?.kind);
        let failure = null;
        if (activeBudget.expired) {
          failure = { code: "RUN_DURATION_LIMIT", message: RUNNER_FAILURE_MESSAGES.RUN_DURATION_LIMIT };
        } else if (turn.cancelOrigin === "shutdown") {
          failure = { code: "RUN_INTERRUPTED", message: RUNNER_FAILURE_MESSAGES.RUN_INTERRUPTED };
        } else if (turn.cancelOrigin === "user" || ["user", "parent"].includes(outcome.reason?.kind)) {
          const by = turn.cancelOrigin === "user" ? "parent request" : outcome.reason.kind;
          failure = { code: "RUN_CANCELLED", message: "Agent turn was cancelled (" + by + ")" };
        } else if(turn.policyDenied){failure={code:turn.policyDenied,message:RUNNER_FAILURE_MESSAGES[turn.policyDenied]||'Run tool admission was denied'};
        } else if (RUNNER_FAILURE_MESSAGES[outcome.reason?.error?.code]) {
          const code = outcome.reason.error.code;
          failure = { code, message: RUNNER_FAILURE_MESSAGES[code] };
        } else if (outcome.reason?.kind === "aborted") {
          failure = {
            code: "AGENT_TURN_ABORTED",
            message: "Agent turn aborted by the runtime or upstream service; diagnostic details were withheld",
          };
        } else if (outcome.reason?.kind === "hook") {
          failure = { code: "AGENT_HOOK_ABORTED", message: "Agent turn was interrupted by a runtime hook" };
        } else if (outcome.reason?.kind !== "completed") {
          failure = {
            code: "AGENT_TURN_INCOMPLETE",
            message: "Agent turn ended without completion (reason=" + String(outcome.reason?.kind || "unknown").slice(0, 80) + ")",
          };
          if (agent.phase?.kind !== "idle") {
            try { sessionKey.delete(agent.session); } catch {}
            try { await rec?.handle?.dispose?.(); } catch {}
            agentMap.delete(sid);
          }
        } else if (!outcome.text.trim()) {
          failure = { code: "EMPTY_ASSISTANT_RESPONSE", message: "Agent turn completed without producing assistant text" };
        }
        emit({
          type: "done", sessionId: sid,
          ok: failure === null,
          code: failure?.code,
          error: failure?.message,
          text: outcome.text,
          media: turn.mediaRouteResults.length ? turn.mediaRouteResults : null,
          report: turn.reportResults.length ? turn.reportResults : null,
          usage: outcome.usageEvidence.usage,
          usageEvidence: outcome.usageEvidence,
          modelIdentity: outcome.modelIdentity,
          context:{kind:'dsh-native-context-v1',compactions:turn.compactions,manual:false,resumed:cmd.resume===true},
          imageInput: {kind:'dsh-native-images-v1',newImageCount:turn.newNativeImageCount||0,
            capabilityChecked:turn.nativeImageCapabilityChecked===true},
          budget: safeBudgetSummary(activeBudget),
          reason: activeBudget.expired ? "timeout" : outcome.reason?.kind ?? null,
          reasonDetail: failure,
          canceled: stopRequested,
          stopReason: activeBudget.expired ? "timeout" : undefined,
          ms: Date.now() - t0,
        });
      } catch (e) {
        if (turnDispatched && rec?.agent?.phase?.kind !== "idle") {
          try { sessionKey.delete(rec?.agent?.session); } catch {}
          try { await rec?.handle?.dispose?.(); } catch {}
        }
        if (turnDispatched && rec?.agent?.phase?.kind !== "idle") agentMap.delete(sid);
        rejectToolRequests(sid, "TASK_FAILED", "DSH task ended before the parent response arrived");
        const usageEvidence = firstSeq == null ? collectResponseUsage([], 0) : collectTurnUsage();
        const code = activeBudget?.expired ? "RUN_DURATION_LIMIT" : turn.cancelOrigin === "shutdown" ? "RUN_INTERRUPTED" : turn.cancelOrigin === "user" ? "RUN_CANCELLED" : (RUNNER_FAILURE_MESSAGES[e?.code] ? e.code : "RUN_TASK_FAILED");
        const error = activeBudget?.expired ? RUNNER_FAILURE_MESSAGES.RUN_DURATION_LIMIT
          : turn.cancelOrigin === "shutdown" ? RUNNER_FAILURE_MESSAGES.RUN_INTERRUPTED
            : turn.cancelOrigin === "user" ? "Run was cancelled by the parent request"
            : (RUNNER_FAILURE_MESSAGES[code] || "Agent task failed before a complete response; diagnostic details were withheld");
        emit({ type: "done", sessionId: sid, ok: false, code, canceled: activeBudget?.expired === true || turn.cancelOrigin === "user", stopReason: activeBudget?.expired ? "timeout" : undefined, error, usage: usageEvidence.usage, usageEvidence, modelIdentity: firstSeq == null ? collectModelIdentity([], 0) : collectModelIdentity(rec?.agent?.session?.events || [], firstSeq), budget: safeBudgetSummary(activeBudget), ms: Date.now() - t0 });
      } finally {
        await publishedSkillProvider.disposeTurn(turn);
        if (durationTimer) clearTimeout(durationTimer);
        if (activeTurns.get(sid) === turn) activeTurns.delete(sid);
      }
    }

    async function handleClose(cmd) {
      const sid = String(cmd.sessionId || "").trim();
      const rec = agentMap.get(sid);
      if (rec) {
        try { await sessions.flush(rec.agent.session); } catch (e) { /* 忽略 */ }
        sessionKey.delete(rec.agent.session);
        try { await rec.handle?.dispose?.(); } catch {}
        agentMap.delete(sid);
      }
      emit({ type: "closed", sessionId: sid });
    }

    /** P1-4：按 sessionId 优雅取消当前 turn（agent.cancel 会中止正在跑的一轮）。 */
    function handleAbort(cmd) {
      const sid = String(cmd.sessionId || "").trim();
      rejectToolRequests(sid, "SESSION_ABORTED", "Parent tool request was cancelled");
      const turn = activeTurns.get(sid);
      if (turn) { turn.cancelRequested = true; turn.cancelOrigin = "user"; turn.preflightController?.abort(); }
      const rec = agentMap.get(sid);
      if (rec) {
        try { rec.agent.cancel({ kind: "user" }); } catch (e) { /* 忽略 */ }
        emit({ type: "aborted", sessionId: sid });
      } else if (turn) {
        emit({ type: "aborted", sessionId: sid });
      } else {
        emit({ type: "aborted", sessionId: sid, note: "no-agent" });
      }
    }

    function shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownRequested = true;
      rejectToolRequests(null, "PROCESS_CLOSED", "DSH process is closing");
      for (const turn of activeTurns.values()) {
        turn.cancelRequested = true;
        turn.preflightController?.abort();
        if (!turn.cancelOrigin) turn.cancelOrigin = "shutdown";
        if (turn.agent) { try { turn.agent.cancel({ kind: "hook" }); } catch { /* continue drain */ } }
      }
      shutdownPromise = (async () => {
        while (sessionQueues.size) {
          await Promise.allSettled([...sessionQueues.values()]);
          await Promise.resolve();
        }
        await Promise.allSettled([...agentMap.values()].map((rec) => sessions.flush(rec.agent.session)));
        emit({ type: "bye" });
        const exit = ctx.get("appExit");
        if (typeof exit === "function") exit(0);
        else process.exit(0);
      })();
      return shutdownPromise;
    }

    function enqueueSessionCommand(cmd) {
      const sid = String(cmd.sessionId || "").trim();
      if (!sid) {
        Promise.resolve().then(() => handleLine(cmd)).catch(() => emitControlError("RUNNER_QUEUE_FAILED"));
        return;
      }
      const prior = sessionQueues.get(sid) || Promise.resolve();
      const current = prior.catch(() => {}).then(() => handleLine(cmd));
      sessionQueues.set(sid, current);
      current.then(
        () => { if (sessionQueues.get(sid) === current) sessionQueues.delete(sid); },
        () => {
          emitControlError("RUNNER_QUEUE_FAILED", safeSessionId(sid));
          if (sessionQueues.get(sid) === current) sessionQueues.delete(sid);
        },
      );
    }

    async function handleLine(cmd) {
      if (cmd.protocolVersion !== RPC_PROTOCOL_VERSION) {
        emit({ type: "error", sessionId: safeSessionId(cmd.sessionId),
          code: "PROTOCOL_VERSION_MISMATCH", message: "Parent protocol version mismatch" });
        return;
      }
      switch (cmd.type) {
        case "task": await handleTask(cmd); return;
        case "close": {
          const sid = String(cmd.sessionId || "").trim();
          rejectToolRequests(sid, "SESSION_CLOSED", "DSH session is closing");
          await handleClose(cmd);
          return;
        }
        default: emitControlError("PARENT_COMMAND_UNSUPPORTED", safeSessionId(cmd.sessionId)); return;
      }
    }

    // stdin line parser; task/close are queued per session, while RPC/abort/control frames stay immediate.
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let cmd;
        try { cmd = JSON.parse(line); } catch { emitControlError("PARENT_FRAME_INVALID"); continue; }
        if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) { emitControlError("PARENT_FRAME_INVALID"); continue; }
        if (shutdownRequested) continue;
        // RPC replies must bypass the task/close queue: handleTask can be awaiting
        // agent.whenIdle(), which itself may be waiting for this exact reply.
        if (cmd.type === "tool_response") { handleToolResponse(cmd); continue; }
        if (cmd.protocolVersion !== RPC_PROTOCOL_VERSION) {
          emit({ type: "error", sessionId: safeSessionId(cmd.sessionId),
            code: "PROTOCOL_VERSION_MISMATCH", message: "Parent protocol version mismatch" });
          continue;
        }
        // P1-4：取消命令立即生效（否则会被当前正在 await whenIdle 的 task 卡住）
        if (cmd.type === "abort") { handleAbort(cmd); continue; }
        if (cmd.type === "close") {
          rejectToolRequests(String(cmd.sessionId || "").trim(), "SESSION_CLOSED", "DSH session is closing");
        }
        if (cmd.type === "describe_model") { void handleModelInfo(cmd); continue; }
        if (cmd.type === "ping") { emit({ type: "pong" }); continue; }
        if (cmd.type === "exit") { void shutdown(); continue; }
        if (cmd.type === "close") rejectToolRequests(String(cmd.sessionId || "").trim(), "SESSION_CLOSED", "DSH session is closing");
        if (cmd.type === "task" || cmd.type === "close") { enqueueSessionCommand(cmd); continue; }
        emitControlError("PARENT_COMMAND_UNSUPPORTED", safeSessionId(cmd.sessionId));
      }
    });
    process.stdin.on("end", () => {
      void shutdown();
    });

    emit({ type: "ready", runner: name, capabilities: RPC_CAPABILITIES });
  })().catch(error => {
    emitControlError("RUNNER_SETUP_FAILED");
    emit({type:'setup_diagnostic',stage:setupStage,reasonCode:/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code||'')?error.code:'UNCLASSIFIED',errorName:error instanceof TypeError?'TypeError':error instanceof SyntaxError?'SyntaxError':'Error',frame:String(error?.stack||'').match(/node_modules\/((?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-]+\/[^)\n]+:[0-9]+:[0-9]+)/)?.[1]||null});
    process.exit(1);
  });
}

export { name, inject, apply, safeBudgetSummary, guardNativeToolExecution };
