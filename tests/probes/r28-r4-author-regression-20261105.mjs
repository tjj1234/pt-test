import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const require = createRequire(path.join(root, 'shell/package.json'));

const load = name => import(pathToFileURL(require.resolve(name)));

test('R4-RUNNER-RECOVERY: real SDK session recovers after actual turn failure and preserves session state', async () => {
  const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
  ].map(load));

  const ctx = new Context();
  for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) {
    await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
  }

  let shouldFailStream = false;
  let callCount = 0;

  class ResilientAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'] };
    }
    async *stream(options) {
      callCount++;
      if (shouldFailStream) {
        throw new Error('transient_provider_stream_failure');
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'response for ' + options.model } };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 10 } };
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: { response: { kind: 'pi-ai', version: 2, model: options.model }, blocks: [{ type: 'text' }] }
      };
    }
  }

  ctx.llm.registerAdapter(['resilient-fixture'], new ResilientAdapter());

  const handle = await ctx.agents.create({
    sessionId: 'session-r4-recovery-probe',
    agentOptions: { provider: 'resilient-fixture', model: 'resilient-model' }
  });
  const agent = handle.agent;

  // Turn 1: Legitimate turn -> SUT succeeds
  agent.followup({ role: 'user', content: [{ type: 'text', text: 'turn 1' }] });
  await agent.whenIdle();
  assert.equal(callCount, 1);
  assert.equal(agent.phase.kind, 'idle');

  // Turn 2: Actual failure (e.g. stream crash) -> turn ends with failure, agent phase returns to idle
  shouldFailStream = true;
  agent.followup({ role: 'user', content: [{ type: 'text', text: 'turn 2 failing' }] });
  await agent.whenIdle();
  assert.equal(callCount, 2);
  assert.equal(agent.phase.kind, 'idle', 'Agent loop must settle into idle after turn error');

  // Turn 3: Followup legal turn in same session -> agent recovers natively without recreate
  shouldFailStream = false;
  agent.followup({ role: 'user', content: [{ type: 'text', text: 'turn 3 recovery' }] });
  await agent.whenIdle();
  assert.equal(callCount, 3);
  assert.equal(agent.phase.kind, 'idle');
  const messages = agent.session.deriveMessages();
  assert.ok(messages.length >= 3, 'Session must retain history across turns');

  // Clean disposal
  await handle.dispose();
});

test('R4-MODEL-LABEL: UI model tags distinguish kinds, video chat disabled notice, and vision tag without click promise', async () => {
  const fs = await import('node:fs');
  const appJs = fs.readFileSync(path.join(root, 'shell/public/app.js'), 'utf8');

  // 1. Verify modelKindLabel is reused
  assert.match(appJs, /const kindPrefix = cap\.chat === false \? modelKindLabel\(cap\.kind\) \+ " · " : "";/);
  
  // 2. Verify disabled options do NOT include false click promise
  assert.doesNotMatch(appJs, /点击切换生成模式/);

  // 3. Verify video, image, audio kind label mappings exist
  assert.match(appJs, /if \(kind === "video"\) return "视频生成";/);
  assert.match(appJs, /if \(kind === "image"\) return "图片生成";/);
  assert.match(appJs, /if \(kind === "audio"\) return "语音生成";/);

  // 4. Verify vision support tag logic
  assert.match(appJs, /const isVision = m\.id === "qwen3\.8-flash" \|\|/);
  assert.match(appJs, /支持图片理解/);
});
