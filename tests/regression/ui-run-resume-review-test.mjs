import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../shell/public/app.js', import.meta.url), 'utf8');
// Execute the production runChat and memory functions, with UI rendering/network
// dependencies recorded at their boundary. No rewritten replay implementation.
const memorySource = source.slice(0, source.indexOf('/**\n * 某条对话的结果回来了'));
const epochSource = source.match(/^let conversationLoadSequence = 0;$/m)?.[0];
assert.ok(epochSource, 'include the production navigation epoch in the run context');
const stoppedMessageSource = source.slice(source.indexOf('function stoppedBarText('), source.indexOf('\nfunction stoppedChipText(', source.indexOf('function stoppedBarText(')));
const busySource = source.slice(source.indexOf('function applyComposerState()'), source.indexOf('/** 归档对话只读', source.indexOf('function applyComposerState()')));
const runSource = source.slice(source.indexOf('async function runChat(payload)'), source.indexOf('\nasync function ask(msg)', source.indexOf('async function runChat(payload)')));
const mediaAuthorizationSource = source.slice(source.indexOf('function createMediaAuthorizationPanel('),source.indexOf('async function runChat(payload)'));
function harness(handler, seededStorage = new Map(), { failStorageWrites = false } = {}) {
  const storage = seededStorage, calls = [], rendered = [], artifacts = [], unread = [], keyBubbles = [], stopped = [], notices = [];
  const element = () => ({ querySelector: () => null, remove() {}, focus() {}, appendChild() {}, textContent: '' });
  const context = vm.createContext({
    document: { querySelector: element, createElement: element },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (failStorageWrites) throw new Error('sessionStorage unavailable'); storage.set(key, String(value)); } },
    window: { crypto: { randomUUID: () => 'unique-request' } }, crypto: { randomUUID: () => 'unique-request' }, location: { search: '' },
    TextDecoder, URLSearchParams, Date, console, modelSelect: null,
    clearSourceCitations() {},
    currentModelChat: () => true, thinking: element, formatElapsed: () => '',
    setInterval: () => 1, clearInterval() {}, setTimeout: fn => { queueMicrotask(fn); },
    streamInto: (element, text) => rendered.push({ kind: 'stream', text }),
    renderChat: messages => rendered.push({ kind: 'chat', messages }), renderMessage: message => rendered.push({ kind: 'message', message }),
    refreshList: async () => {}, markUnread: id => unread.push(id),
    pushArtifact: value => artifacts.push(value), mergeArtifacts: values => artifacts.push(...values), openArtifactPane() {},
    showConnecting() {}, showStoppedBar: (reason, upstreamMayStillRun) => stopped.push({ reason, upstreamMayStillRun }), stoppedChipText: () => 'stopped', needKeyBubble: () => keyBubbles.push(true), bubbleSys: text => rendered.push({ kind: 'error', text }), composerNotice: (text, kind) => notices.push({ text, kind }),
    fetch: async (url, options = {}) => { calls.push({ url, method: options.method || 'GET', idempotencyKey: options.headers?.['Idempotency-Key'] || null, body: options.body || null }); return handler(url, options, context); },
  });
  vm.runInContext(memorySource + '\n' + epochSource + '\n' + stoppedMessageSource + '\nfunction isViewing(id) { return !!id && state.activeId === id; }\n' + busySource + mediaAuthorizationSource + runSource, context);
  const evaluate = code => vm.runInContext(code, context);
  evaluate("state.activeId='A'");
  return { context, evaluate, storage, calls, rendered, artifacts, unread, keyBubbles, stopped, notices, busy: evaluate('chatRunsByConversation'), run: payload => context.runChat(payload) };
}
const page = events => ({ ok: true, json: async () => ({ events }) });
const done = { seq: 2, type: 'done', payload: { state: 'completed' } };
const detail = { ok: true, json: async () => ({ conversation: { messages: [{ role: 'assistant', text: 'reply A' }] } }) };
test('sessionStorage failure fails closed before sending a new chat POST', async () => {
  const h = harness(async () => { throw new Error('chat POST must not be reached'); }, new Map(), { failStorageWrites: true });
  await h.run({ conversationId: 'A', question: 'hello' });
  assert.equal(h.calls.length, 0, 'no network request is sent without a durable-in-tab recovery key');
  assert.equal(h.busy.size, 0, 'the conversation remains unlocked');
  assert.match(h.notices.at(-1)?.text || '', /无法保存请求恢复凭据.*这次请求未发送/);
  assert.equal(h.storage.has('ptPendingChatSubmissions.v1'), false);
});
test('a stopped Run with uncertain upstream status gets the explicit AC03 warning', async () => {
  let reads = 0;
  const payload = JSON.stringify({ done: true, stopped: true, stopReason: 'user', messages: [], artifacts: [] });
  const h = harness(async () => ({
    headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null },
    body: { getReader: () => ({ read: async () => {
      if (reads++) return { done: true };
      return { done: false, value: new TextEncoder().encode(`id: 1\ndata: ${payload}\n\n`) };
    } }) },
  }));
  h.evaluate("upstreamMayRunForRuns.add('runA')");
  await h.run({ conversationId: 'A', question: 'cancel external task' });
  assert.deepEqual(h.stopped, [{ reason: 'user', upstreamMayStillRun: true }]);
  assert.equal(h.evaluate("stoppedBarText('user', true)"), '本地任务已停止；上游任务状态未确认，可能仍在运行，请稍后核对结果。');
});
test('ambiguous chat POST retries once with the same idempotency key and exact body', async () => {
  let admissions = 0, attempts = 0, reads = 0;
  const h = harness(async (url, options) => {
    if (url !== '/api/chat') return detail;
    attempts++;
    if (attempts === 1) { admissions++; throw new TypeError('response lost after durable admission'); }
    return {
      headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null },
      body: {
        getReader: () => ({ read: async () => {
          if (reads++) return { done: true };
          return { done: false, value: new TextEncoder().encode('id: 1\ndata: ' + JSON.stringify({ done: true, ok: true, messages: [], artifacts: [] }) + '\n\n') };
        } }),
      },
    };
  });
  await h.run({ conversationId: 'A', question: 'once' });
  assert.equal(attempts, 2);
  assert.equal(admissions, 1, 'same-key replay must attach to one durable admission');
  assert.equal(h.calls[0].idempotencyKey, h.calls[1].idempotencyKey);
  assert.equal(h.calls[0].body, h.calls[1].body);
});
test('page reload recovers uncertain submission by idempotency key using GET only', async () => {
  let postAttempts = 0, lookups = 0, eventReads = 0;
  const first = harness(async url => {
    if (url !== '/api/chat') throw new Error('unexpected request');
    postAttempts++;
    throw new TypeError('response lost before headers');
  });
  await first.run({ conversationId: 'A', question: 'do not persist this prompt' });
  assert.equal(postAttempts, 2, 'existing same-key transport retry remains bounded');
  const pending = JSON.parse(first.storage.get('ptPendingChatSubmissions.v1'));
  assert.equal(pending.length, 1);
  assert.deepEqual(Object.keys(pending[0]).sort(), ['conversationId', 'idempotencyKey']);

  const reloaded = harness(async (url, options) => {
    if (url === '/api/runs/by-idempotency-key') {
      assert.equal(options.method || 'GET', 'GET');
      assert.equal(options.headers['Idempotency-Key'], pending[0].idempotencyKey);
      if (++lookups === 1) return { ok: false, status: 404 };
      if (lookups === 2) return { ok: true, json: async () => ({ runId: 'wrong-conversation-run', conversationId: 'B', state: 'completed' }) };
      return { ok: true, json: async () => ({ runId: 'recovered-run', conversationId: 'A', state: 'completed' }) };
    }
    if (url.startsWith('/api/runs/recovered-run/events?after=0')) {
      eventReads++;
      return page([done]);
    }
    if (url === '/api/conversations/A') return detail;
    throw new Error(`unexpected request ${url}`);
  }, new Map(first.storage));
  await reloaded.evaluate('resumePendingSubmissions()');
  assert.equal(lookups, 3, '404 and a mismatched conversation are treated as unresolved and checked again');
  assert.equal(eventReads, 1);
  assert.equal(reloaded.calls.some(call => call.method === 'POST'), false);
  assert.equal(JSON.parse(reloaded.storage.get('ptPendingChatSubmissions.v1')).length, 0);
  assert.equal(reloaded.storage.get('ptActiveRuns.v1'), '[]');
  assert.equal(reloaded.busy.size, 0);
});
test('refresh resumes remembered run using GET only; transient network exception retries without duplicate POST', async () => {
  let attempts = 0;
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) { if (++attempts === 1) throw new TypeError('offline'); return page([done]); }
    return detail;
  });
  h.evaluate("rememberRun('A','runA')"); await h.run({ conversationId: 'A', resumeRunId: 'runA' });
  assert.equal(attempts, 2); assert.equal(h.calls.some(call => call.method === 'POST'), false); assert.equal(h.evaluate('rememberedRuns().length'), 0); assert.equal(h.busy.size, 0);
});
for (const status of [401, 403, 404]) test(`resume HTTP ${status} clears invalid remembered run without a new POST`, async () => {
  const h = harness(async () => ({ ok: false, status })); h.evaluate("rememberRun('A','runA')");
  await h.run({ conversationId: 'A', resumeRunId: 'runA' });
  assert.equal(h.evaluate('rememberedRuns().length'), 0); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET');
});
for (const status of [429, 503]) test(`temporary HTTP ${status} retries durable replay rather than releasing the active request`, async () => {
  let attempts = 0;
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) return ++attempts === 1 ? { ok: false, status } : page([done]);
    return detail;
  });
  await h.run({ conversationId: 'A', resumeRunId: 'runA' });
  assert.equal(attempts, 2, `HTTP ${status} is transient and must continue GET replay`); assert.equal(h.calls.some(call => call.method === 'POST'), false);
});
test('conversation switch during replay terminal detail fetch cannot render the old conversation', async () => {
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) return page([done]);
    entered(); await gate; return detail;
  });
  const pending = h.run({ conversationId: 'A', resumeRunId: 'runA' }); await enteredPromise;
  h.evaluate("state.activeId='B'"); release(); await pending;
  assert.equal(h.rendered.filter(entry => entry.kind === 'chat').length, 0, 'late A detail must not overwrite visible B'); assert.deepEqual(h.unread, ['A']);
});
test('late original SSE done artifacts from A do not alter the visible B artifact pane', async () => {
  let reads = 0;
  const h = harness(async () => ({ headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null }, body: { getReader: () => ({ read: async () => {
    if (reads++) return { done: true };
    h.evaluate("state.activeId='B'");
    return { done: false, value: new TextEncoder().encode('id: 1\ndata: ' + JSON.stringify({ done: true, ok: true, messages: [], artifacts: [{ id: 'artifact-A' }] }) + '\n\n') };
  } }) } }));
  await h.run({ conversationId: 'A', question: 'once' });
  assert.deepEqual(h.artifacts, [], 'late A terminal artifacts must not enter the B pane'); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('failed historical image replay keeps conversation messages and shows attachment error outside history', async () => {
  const messages = [{ role: 'user', text: '请看这张图', image: '/uploads/tenant/example.png', imageEvidence: { ref: '/uploads/tenant/example.png', sha256: 'a'.repeat(64), size: 4 } }];
  const payload = { done: true, ok: false, code: 'CHAT_ATTACHMENT_CHANGED', error: '图片附件已变化或无法验证，请重新上传后再试。', messages };
  let reads = 0;
  const h = harness(async () => ({
    headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null },
    body: { getReader: () => ({ read: async () => {
      if (reads++) return { done: true };
      return { done: false, value: new TextEncoder().encode('id: 1\ndata: ' + JSON.stringify(payload) + '\n\n') };
    } }) },
  }));
  await h.run({ conversationId: 'A', regenerate: true });
  assert.equal(JSON.stringify(h.rendered.filter(entry => entry.kind === 'chat').map(entry => entry.messages)), JSON.stringify([messages]), 'failed regenerate rerenders the unchanged message history including evidence');
  assert.deepEqual(h.rendered.filter(entry => entry.kind === 'error').map(entry => entry.text), [payload.error], 'attachment error is shown as a separate system prompt');
  assert.deepEqual(h.keyBubbles, [], 'attachment validation failure does not use the PT key prompt');
});

test('failed Run keeps completed and failed tool steps in history before the transient error prompt', async () => {
  const messages = [
    { role: 'user', text: 'run tools' },
    { role: 'assistant', text: '执行未完成。', steps: [
      { name: 'lookup', isError: false, result: 'found' },
      { name: 'write', isError: true, result: 'rejected' },
    ] },
  ];
  const payload = { done: true, ok: false, error: 'Runner failed after tool execution', messages };
  let reads = 0;
  const h = harness(async () => ({
    headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null },
    body: { getReader: () => ({ read: async () => {
      if (reads++) return { done: true };
      return { done: false, value: new TextEncoder().encode('id: 1\ndata: ' + JSON.stringify(payload) + '\n\n') };
    } }) },
  }));
  await h.run({ conversationId: 'A', question: 'run tools' });
  const entries = h.rendered.filter(entry => entry.kind === 'chat' || entry.kind === 'error');
  assert.equal(JSON.stringify(entries[0].messages), JSON.stringify(messages), 'failed terminal history retains both tool outcomes unchanged');
  assert.equal(JSON.stringify(entries[0].messages[1].steps), JSON.stringify(messages[1].steps), 'step success/error states are not rewritten by overall Run failure');
  assert.deepEqual(entries.map(entry => entry.kind), ['chat', 'error'], 'the transient system prompt follows the rendered conversation');
  assert.deepEqual(entries[1], { kind: 'error', text: payload.error }, 'the transient error is outside persisted conversation messages');
  assert.deepEqual(h.keyBubbles, [], 'ordinary Run failure does not use the PT key prompt');
});

test('SSE needKey terminal event keeps its dedicated prompt without duplicate error bubble', async () => {
  const payload = { done: true, ok: false, needKey: true, error: 'missing key', messages: [] };
  let reads = 0;
  const h = harness(async () => ({
    headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null },
    body: { getReader: () => ({ read: async () => {
      if (reads++) return { done: true };
      return { done: false, value: new TextEncoder().encode('id: 1\ndata: ' + JSON.stringify(payload) + '\n\n') };
    } }) },
  }));
  await h.run({ conversationId: 'A', regenerate: true });
  assert.equal(h.keyBubbles.length, 1);
  assert.equal(h.rendered.some(entry => entry.kind === 'error'), false, 'needKey retains its dedicated prompt without duplicate generic error');
});

for (const failure of ['network', '503']) test(`terminal conversation detail ${failure} retries before forgetting durable run`, async () => {
  let attempts = 0, rememberedAtRetry = false;
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) return page([done]);
    if (++attempts === 1) {
      if (failure === 'network') throw new TypeError('offline while fetching terminal detail');
      return { ok: false, status: 503, json: async () => ({ error: 'temporarily unavailable' }) };
    }
    rememberedAtRetry = h.evaluate('rememberedRuns().length') === 1;
    return detail;
  });
  h.evaluate("rememberRun('A','runA')"); await h.run({ conversationId: 'A', resumeRunId: 'runA' });
  assert.equal(attempts, 2, 'terminal detail must be recovered before clearing run memory');
  assert.equal(rememberedAtRetry, true, 'run memory must remain until terminal detail recovers');
  assert.equal(h.rendered.filter(entry => entry.kind === 'chat').length, 1);
  assert.equal(h.evaluate('rememberedRuns().length'), 0); assert.equal(h.calls.some(call => call.method === 'POST'), false);
});
test('an in-flight remembered run owns its conversation and blocks a second create POST', async () => {
  let entered, release;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) { entered(); await gate; return page([done]); }
    return detail;
  });
  const first = h.run({ conversationId: 'A', resumeRunId: 'runA' }); await started;
  await h.run({ conversationId: 'A', question: 'must not create a duplicate' });
  assert.equal(h.busy.has('A'), true); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET');
  release(); await first; assert.equal(h.busy.size, 0);
});
test('durable cursor consumes each delta once while replaying an unconsumed done after detail failure', async () => {
  const cursors = []; let details = 0;
  const events = [{ seq: 1, type: 'delta', payload: { text: 'prefix' } }, done];
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) { const after = Number(new URL(url, 'http://fixture').searchParams.get('after')); cursors.push(after); return page(events.filter(event => event.seq > after)); }
    if (++details === 1) return { ok: false, status: 503 }; return detail;
  });
  await h.run({ conversationId: 'A', resumeRunId: 'runA' });
  assert.deepEqual(cursors, [0, 1]); assert.equal(details, 2);
  assert.deepEqual(h.rendered.filter(entry => entry.kind === 'stream').map(entry => entry.text), ['prefix']);
});
for (const failure of ['network', '503']) test(`production list refresh ${failure} after done cannot replay consumed deltas or rerender terminal detail`, async () => {
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) return page([{ seq: 1, type: 'delta', payload: { text: 'prefix' } }, done]);
    if (url === '/api/conversations') { if (failure === 'network') throw new TypeError('list unavailable'); return { ok: false, status: 503 }; }
    return detail;
  });
  const start = source.indexOf('async function refreshList()');
  vm.runInContext(source.slice(start, source.indexOf('\nlet conversationLoadSequence', start)), h.context);
  h.context.renderList = () => {};
  await h.run({ conversationId: 'A', resumeRunId: 'runA' });
  assert.equal(h.calls.filter(call => call.url.startsWith('/api/runs/')).length, 1);
  assert.equal(h.rendered.filter(entry => entry.kind === 'chat').length, 1);
  assert.deepEqual(h.rendered.filter(entry => entry.kind === 'stream').map(entry => entry.text), ['prefix']);
  assert.equal(h.evaluate('rememberedRuns().length'), 0);
});
test('A to B to A navigation ignores the first A response after the newer A history has rendered', async () => {
  const releases = [];
  const h = harness(async url => {
    if (url === '/api/conversations/A') return new Promise(resolve => releases.push(resolve));
    return { ok: true, json: async () => ({ conversation: { messages: [{ role: 'assistant', text: 'B' }] } }) };
  });
  Object.assign(h.context, { switchView() {}, renderList() {}, setComposerLocked() {}, convIsArchived: () => false, saveRoute() {}, loadModels: async () => {} });
  const start = source.indexOf('async function openConversation(');
  vm.runInContext(source.slice(start, source.indexOf('/** 一条消息都还没有', start)), h.context);
  const first = h.context.openConversation('A');
  await h.context.openConversation('B');
  const second = h.context.openConversation('A');
  releases[1]({ ok: true, json: async () => ({ conversation: { messages: [{ role: 'assistant', text: 'A-new' }] } }) }); await second;
  releases[0]({ ok: true, json: async () => ({ conversation: { messages: [{ role: 'assistant', text: 'A-old' }] } }) }); await first;
  assert.equal(h.rendered.filter(entry => entry.kind === 'chat').at(-1).messages[0].text, 'A-new');
});
test('terminal detail 401/403/404 clears remembered run without retrying or rendering unauthorized history', async () => {
  for (const status of [401, 403, 404]) {
    const h = harness(async url => url.startsWith('/api/runs/') ? page([done]) : { ok: false, status });
    h.evaluate("rememberRun('A','runA')"); await h.run({ conversationId: 'A', resumeRunId: 'runA' });
    assert.equal(h.evaluate('rememberedRuns().length'), 0);
    assert.equal(h.calls.filter(call => call.url.startsWith('/api/runs/')).length, 1);
    assert.equal(h.calls.filter(call => call.url.startsWith('/api/conversations/')).length, 1);
    assert.equal(h.rendered.filter(entry => entry.kind === 'chat').length, 0); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  }
});
for (const channel of ['replay', 'original SSE']) test(`an older open-history response cannot overwrite the same conversation terminal ${channel} result`, async () => {
  let release, details = 0, reads = 0;
  const h = harness(async url => {
    if (url.startsWith('/api/runs/')) return page([done]);
    if (url === '/api/chat') return { headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-agent-run-id' ? 'runA' : null }, body: { getReader: () => ({ read: async () => reads++ ? { done: true } : { done: false, value: new TextEncoder().encode('id: 2\ndata: ' + JSON.stringify({ done: true, ok: true, messages: [{ role: 'assistant', text: 'reply A' }] }) + '\n\n') } }) } };
    if (++details === 1) return new Promise(resolve => { release = resolve; });
    return detail;
  });
  Object.assign(h.context, { switchView() {}, renderList() {}, setComposerLocked() {}, convIsArchived: () => false, saveRoute() {}, loadModels: async () => {} });
  const start = source.indexOf('async function openConversation(');
  vm.runInContext(source.slice(start, source.indexOf('/** 一条消息都还没有', start)), h.context);
  const opening = h.context.openConversation('A');
  await h.run(channel === 'replay' ? { conversationId: 'A', resumeRunId: 'runA' } : { conversationId: 'A', question: 'once' });
  release({ ok: true, json: async () => ({ conversation: { messages: [{ role: 'assistant', text: 'old pre-terminal history' }] } }) }); await opening;
  assert.equal(h.rendered.filter(entry => entry.kind === 'chat').at(-1).messages[0].text, 'reply A');
});
