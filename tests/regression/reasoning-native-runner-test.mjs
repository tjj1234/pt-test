import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { normalizeModelIdentity } = require('../../shell/runtime/usage.cjs');
const harness = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(process.env.F1_ROOT, 'shell/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
 '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
 '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
].map(load));
const ctx = new Context();
for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
ctx.provide('loader', { await: async () => {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'identity-fixture', model: 'requested-a' }) });
ctx.provide('appExit', code => process.exit(code));
class FixtureAdapter extends LlmAdapter {
 async resolveModel(provider,model,signal){
  if(model==='slow-model') {console.log(JSON.stringify({type:'metadata_started'}));await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});}
  return {provider,id:model,name:model,inputModalities:['text'],...(model==='requested-a'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}}:{})};
 }
 async *stream(options) {
  const model = String(options.model); console.log(JSON.stringify({type:"fixture_request",model,effort:options.reasoningEffort??null}));
  const answer = { type: 'text', text: 'fixture response for ' + model };
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'block-end', index: 0, block: answer };
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } };
  const response = { kind: 'pi-ai', version: 2, model,
    ...(model === 'requested-a' ? { responseModel: 'provider-reported-a' } : {}) };
  yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response, blocks: [{ type: 'text' }] } };
 }
}
ctx.llm.registerAdapter(['identity-fixture'], new FixtureAdapter());
const { apply } = await import(pathToFileURL(path.join(process.env.F1_PROFILE, 'persistent-runner.mjs')));
apply(ctx);
`;

const wait = async (predicate, label, diagnostics) => {
  const until = Date.now() + 15_000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), label + '\n' + diagnostics());
};

async function runnerFrames(tmp) {
  const home = path.join(tmp, 'runner-home');
  const profile = path.join(home, 'profiles/run-persistent');
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(path.join(root, 'shell/node_modules'), path.join(profile, 'node_modules'), 'dir');
  for (const [source, target] of [
    ['shell/persistent-runner.mjs', 'persistent-runner.mjs'], ['shell/tasks/budget.cjs', 'budget.cjs'],
    ['shell/runtime/usage.cjs', 'usage.cjs'], ['business/media/presets.cjs', 'presets.cjs'],
    ['shell/runtime/native-image-message.mjs', 'native-image-message.mjs'],
    ['shell/runtime/dsh-native-context-r4-candidate.mjs', 'dsh-native-context-r4-candidate.mjs'],
    ['business/attribution/ga-connector/executor.js', 'ga-query-executor.cjs'],
  ]) fs.copyFileSync(path.join(root, source), path.join(profile, target));
  fs.writeFileSync(path.join(profile, 'run-budget.json'), JSON.stringify({
    maxDurationMs: 10_000, maxModelCalls: 1, maxToolCalls: 0, maxToolCallsPerKey: 0, maxRetries: 0,
  }));
  const child = realSpawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DSH_HOME: home, F1_ROOT: root, F1_PROFILE: profile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = []; let stdout = '', stderr = '', closed = false;
  child.once('close', () => { closed = true; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      try { frames.push(JSON.parse(line)); } catch { /* diagnostic noise stays out of assertions */ }
    }
  });
  const diagnostics = () => stderr + '\n' + JSON.stringify(frames);
  await wait(() => frames.some(frame => frame.type === 'ready') || closed, 'runner ready', diagnostics);
  assert.equal(closed, false, diagnostics());
  const send = (model,effort) => child.stdin.write(JSON.stringify({protocolVersion:1,type:'task',sessionId:'same-session',tenantId:'fixture-tenant',provider:'identity-fixture',model,task:'controlled reasoning turn',...(effort===undefined?{}:{reasoningEffort:effort})})+'\n');
  let count=0;
  for(const [model,effort] of [['requested-a','high'],['requested-b',undefined],['requested-a','invalid'],['requested-a','low']]){
   send(model,effort);count++;await wait(()=>frames.filter(f=>f.type==='done').length===count,'native task '+count,diagnostics);
  }
  send('slow-model','high');
  await wait(()=>frames.some(f=>f.type==='metadata_started'),'metadata lookup started',diagnostics);
  child.stdin.write(JSON.stringify({protocolVersion:1,type:'abort',sessionId:'same-session'})+'\n');
  await wait(()=>frames.filter(f=>f.type==='done').length===5,'cancel preflight',diagnostics);
  const done=frames.filter(f=>f.type==='done');
  assert.equal(done[2].code,'UNSUPPORTED_REASONING_EFFORT');assert.equal(done[4].code,'RUN_CANCELLED');
  assert.deepEqual(frames.filter(f=>f.type==='fixture_request').map(f=>[f.model,f.effort]),[['requested-a','high'],['requested-b',null],['requested-a','low']]);
  child.stdin.write(JSON.stringify({ protocolVersion: 1, type: 'exit' }) + '\n');
  await new Promise(resolve => { if (closed) resolve(); else child.once('close', resolve); });
  return done;
}

test('native reasoning rejects unsupported effort atomically and cancels metadata before model dispatch',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'native-reasoning-selection-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const done=await runnerFrames(temp);assert.equal(done[0].ok,true);assert.equal(done[1].ok,true);assert.equal(done[3].ok,true);assert.equal(done[2].budget.snapshot.modelCalls,0);
});
