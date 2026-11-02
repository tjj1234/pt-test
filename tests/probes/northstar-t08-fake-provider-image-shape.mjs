/**
 * T08 no-paid-call probe: real DSH SDK + deterministic in-process provider.
 * Mirrors persistent-runner.mjs's production followup envelope and the current
 * imageNote data-URL text shape. It does not start the shell server or PT.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'shell/package.json'));
const load = async (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)));
const deadline = (promise) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timed out')), 10000); }),
  ]).finally(() => clearTimeout(timer));
};

const [{ Context }, { default: Agents }, { default: Sessions, SessionId }, { default: Llm, LlmAdapter, createUserMessage }, { default: Prompt }, { default: Tools }, { default: Loop }] =
  await Promise.all(['cordis', 'dsh-agent', 'dsh-session', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop'].map(load));

const ctx = new Context();
const fibers = [];
let handle;
try {
  for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) {
    const fiber = ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
    fibers.push(fiber);
    await fiber;
  }

  const captured = [];
  class CaptureProvider extends LlmAdapter {
    async *stream(options) {
      captured.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'captured locally' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const unregister = ctx.llm.registerAdapter(['t08-capture'], new CaptureProvider());
  handle = await ctx.agents.create({
    sessionId: SessionId('t08-image-shape'),
    meta: { cwd: root },
    agentOptions: { provider: 't08-capture', model: 'fixture-text-only' },
  });

  // persistent-runner.mjs calls createUserMessage with exactly this one text
  // content block. The marker/data URL reproduces server.cjs imageNote's form.
  const marker = 'data:image/png;base64,iVBORw0KGgo= T08_SYNTHETIC_IMAGE';
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: '用户上传图片，请按需使用。\n' + marker }],
    source: { kind: 'user' },
  }));
  await deadline(handle.agent.whenIdle());

  assert.equal(captured.length, 1, 'one fake provider request was captured');
  const messages = captured[0].messages;
  const user = [...messages].reverse().find((message) => message.role === 'user');
  assert.ok(user, 'provider request contains the user message');
  assert.deepEqual(user.content.map((block) => block.type), ['text']);
  assert.match(user.content[0].text, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.equal(user.content.some((block) => block.type === 'image'), false);
  unregister();
  console.log(JSON.stringify({
    status: 'PASS',
    paidCalls: 0,
    provider: 'in-process deterministic capture adapter',
    requestContentTypes: user.content.map((block) => block.type),
    imageDataUrlPresentAsText: true,
    imageModalityPresent: false,
    boundary: 'real DSH SDK projection of production followup envelope; server upload-to-imageNote assembly and live PT route are not exercised',
  }, null, 2));
} finally {
  if (handle) await handle.dispose();
  for (const fiber of fibers.reverse()) await fiber.dispose();
}
