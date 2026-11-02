/**
 * Controlled integration probe for the actual DSH CLI/SDK profile and shipped
 * persistent-runner. No HTTP server, credentials, network, or paid model calls.
 * Run: node --test tests/regression/persistent-runner-real-sdk-rpc-probe.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const waitFor = async (predicate, label, timeoutMs = 12000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const sdkHarness = String.raw`
import {createRequire} from 'node:module';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const require=createRequire(path.join(process.env.NORTHSTAR_ROOT,'shell/package.json'));const load=n=>import(pathToFileURL(require.resolve(n)));
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter,CallId},{default:Prompt},{default:Tools},{default:Loop},{applyWebSearchTool}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-tool-web'].map(load));
const ctx=new Context();for(const [plugin,config] of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]} ]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'controlled',model:'fixture-chat'})});ctx.provide('appExit',code=>process.exit(code));
const record=row=>fs.appendFileSync(process.env.NORTHSTAR_CONTROLLED_LLM_LOG,JSON.stringify(row)+'\n');
ctx.provide('web',{search:async(request,signal)=>{if(signal.aborted)throw Error('cancelled');record({kind:'native_provider',query:request.query});return {sources:[{url:'https://fixture.example.test/source',title:'Fixture source',snippet:'Bounded evidence'}],truncated:false};}});
applyWebSearchTool(ctx,3,1,10000,false);
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){if(model==='bad-info')throw Error('private metadata');return {provider,id:model,name:model,inputModalities:['text'],reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}};}
 counts=new Map();
 async *stream(options){const sid=String(options.sessionId),n=(this.counts.get(sid)||0)+1;this.counts.set(sid,n);record({kind:'model',sessionId:sid,n});
 const block=n%2===1?{type:'tool-call',id:CallId('search-'+sid+'-'+n),name:'web_search',arguments:{queries:['controlled fixture']}}:{type:'text',text:'native tool turn ended'};
 yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};}
}
ctx.llm.registerAdapter(['controlled'],new Adapter());
const {apply}=await import(pathToFileURL(path.join(process.env.NORTHSTAR_RUNNER_PROFILE,'persistent-runner.mjs')));apply(ctx);
`;

test("native DSH web_search honors explicit Run admission and warm policy revocation", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-native-tool-gate-"));
  const dshHome = path.join(tmp, "dsh");
  const profile = path.join(dshHome, "profiles", "run-persistent");
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(path.join(root, "shell/node_modules"), path.join(profile, "node_modules"), "dir");
  fs.writeFileSync(path.join(profile, "persistent-runner.mjs"), fs.readFileSync(path.join(root, "shell/persistent-runner.mjs")));
  fs.copyFileSync(path.join(root, "shell/tasks/budget.cjs"), path.join(profile, "budget.cjs"));
  fs.copyFileSync(path.join(root, "shell/runtime/usage.cjs"), path.join(profile, "usage.cjs"));
  fs.copyFileSync(path.join(root, "shell/runtime/native-image-message.mjs"), path.join(profile, "native-image-message.mjs"));
  fs.writeFileSync(path.join(profile, "run-budget.json"), JSON.stringify({ maxDurationMs: 15000, maxModelCalls: 8, maxToolCalls: 8, maxToolCallsPerKey: 4, maxRetries: 0, allowedTools:["web_search"] }));
  fs.copyFileSync(path.join(root, "business/media/presets.cjs"), path.join(profile, "presets.cjs"));
  fs.copyFileSync(path.join(root, "business/attribution/ga-connector/executor.js"), path.join(profile, "ga-query-executor.cjs"));
  const llmLog = path.join(tmp, "llm.jsonl");
  fs.writeFileSync(llmLog, "");

  const child = spawn(process.execPath, ["--input-type=module", "-e", sdkHarness], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, NORTHSTAR_ROOT: root, NORTHSTAR_RUNNER_PROFILE: profile, NORTHSTAR_CONTROLLED_LLM_LOG: llmLog, PT_DASH_INTERNAL_KEY: "", DASH_PORT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const frames = [];
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    let idx;
    while ((idx = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, idx).trim(); output = output.slice(idx + 1);
      try { const frame = JSON.parse(line); if (frame && frame.type) frames.push(frame); } catch { /* DSH startup notices are not runner frames. */ }
    }
  });
  const send = (frame) => child.stdin.write(JSON.stringify({ ...frame, protocolVersion: 1 }) + "\n");
  const rpc = (sid, name) => frames.find((frame) => frame.type === "tool_request" && frame.sessionId === sid && frame.name === name);
  const done = (sid) => frames.find((frame) => frame.type === "done" && frame.sessionId === sid);
  const llmCalls = () => fs.readFileSync(llmLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

  try {
    await waitFor(() => frames.some((frame) => frame.type === "ready"), "real runner ready");
    assert.ok(frames.find(frame=>frame.type==='ready').capabilities.includes('model-info-v1'));
    send({type:'describe_model',requestId:'metadata-1',provider:'controlled',model:'fixture-chat'});
    await waitFor(()=>frames.some(frame=>frame.type==='model_info'&&frame.requestId==='metadata-1'),'native metadata');
    const metadata=frames.find(frame=>frame.type==='model_info'&&frame.requestId==='metadata-1');
    assert.equal(metadata.ok,true);assert.deepEqual(metadata.efforts,[{id:'low',name:'Low'},{id:'high',name:'High'}]);
    assert.equal(metadata.defaultEffort,'low');assert.equal(llmCalls().length,0);
    send({type:'describe_model',requestId:'metadata-2',provider:'controlled',model:'bad-info'});
    await waitFor(()=>frames.some(frame=>frame.type==='model_info'&&frame.requestId==='metadata-2'),'safe metadata error');
    const metadataError=frames.find(frame=>frame.type==='model_info'&&frame.requestId==='metadata-2');
    assert.equal(metadataError.code,'MODEL_INFO_UNAVAILABLE');assert.equal(JSON.stringify(metadataError).includes('private'),false);
    assert.equal(llmCalls().length,0);
    const {guardNativeToolExecution}=await import(pathToFileURL(path.join(profile,'persistent-runner.mjs')));
    const {default:budgetModule}=await import(pathToFileURL(path.join(root,'shell/tasks/budget.cjs')));
    const agent={},signal=new AbortController().signal;
    const state={agent,configured:true,stepNames:new Map([['native-call','web_search'],['blocked-call','bash']]),budget:budgetModule.createRunBudget({limits:{maxToolCalls:2}}),toolPolicy:{allowedTools:['web_search']}};
    const invocation={agent,signal,callId:'native-call',name:'web_search',arguments:{queries:['fixture']}};
    let bodies=0;const body=async()=>{bodies++;return {ok:true};};
    await assert.rejects(guardNativeToolExecution(state,{...invocation,agent:{}},body),{code:'RUN_TOOL_CONTEXT_INVALID'});
    await assert.rejects(guardNativeToolExecution(state,{...invocation,callId:'previous-run-call'},body),{code:'RUN_TOOL_CONTEXT_INVALID'});
    await assert.rejects(guardNativeToolExecution(state,{...invocation,name:'skill'},body),{code:'RUN_TOOL_CONTEXT_INVALID'});
    await assert.rejects(guardNativeToolExecution({...state,cancelRequested:true},invocation,body),{code:'RUN_CANCELLED'});
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(guardNativeToolExecution(state,{...invocation,signal:aborted.signal},body),{code:'RUN_CANCELLED'});
    await assert.rejects(guardNativeToolExecution({...state,expired:true},invocation,body),{code:'RUN_DURATION_LIMIT'});
    await assert.rejects(guardNativeToolExecution({...state,configured:false},invocation,body),{code:'RUN_BUDGET_CONFIG_INVALID'});
    await assert.rejects(guardNativeToolExecution({...state,toolPolicy:{allowedTools:['bash']}},{...invocation,callId:'blocked-call',name:'bash'},body),{code:'RUN_TOOL_NOT_ALLOWED'});
    assert.equal(bodies,0);assert.equal(state.budget.snapshot().toolCalls,0);
    await guardNativeToolExecution(state,invocation,body);assert.equal(bodies,1);assert.equal(state.budget.snapshot().toolCalls,1);
    const zero={...state,budget:budgetModule.createRunBudget({limits:{maxToolCalls:0}})};
    await assert.rejects(guardNativeToolExecution(zero,invocation,body),{code:'RUN_TOOL_CALL_LIMIT'});assert.equal(bodies,1);
    const providerCalls=()=>llmCalls().filter(row=>row.kind==='native_provider');
    const task=sid=>send({type:'task',sessionId:sid,tenantId:'tenant-'+sid,provider:'controlled',model:'fixture-chat',task:'native search request'});
    task('N');await waitFor(()=>done('N'),'explicit native search turn');
    assert.equal(done('N').ok,true,JSON.stringify(done('N')));
    assert.equal(providerCalls().length,1);
    assert.equal(done('N').budget.snapshot.toolCalls,1,'native tool is counted once');
    assert.equal(done('N').budget.snapshot.modelCalls,2);
    assert.ok(frames.some(frame=>frame.type==='step'&&frame.name==='web_search'&&frame.phase==='result'&&!frame.isError));
    fs.writeFileSync(path.join(profile,'run-budget.json'),JSON.stringify({maxDurationMs:15000,maxModelCalls:2,maxToolCalls:1,maxToolCallsPerKey:1,maxRetries:0,allowedTools:[]}));
    task('N');await waitFor(()=>frames.filter(frame=>frame.type==='done'&&frame.sessionId==='N').length===2,'warm native policy revocation');
    assert.equal(providerCalls().length,1,'revoked native search cannot invoke provider');
    const denied=frames.filter(frame=>frame.type==='done'&&frame.sessionId==='N')[1];
    assert.equal(denied.budget.snapshot.toolCalls,0);
    assert.ok(frames.some(frame=>frame.type==='step'&&frame.name==='web_search'&&frame.phase==='result'&&frame.isError));
    send({ type: "exit" }); child.stdin.end();
    await waitFor(() => frames.some((frame) => frame.type === "bye"), "runner shutdown");
  } catch (error) {
    assert.fail(`${error.message}\nrunner stderr:\n${stderr}\nframes:\n${JSON.stringify(frames, null, 2)}`);
  }
});
