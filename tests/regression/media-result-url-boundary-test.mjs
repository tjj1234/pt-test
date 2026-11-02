import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { callMediaRoute, extractImageUrl, extractVideoUrl } = require('../../business/media/powertokens.cjs');
const response = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('result extraction ignores control, input and error links', () => {
  const control = {
    status_url: 'https://api.example.test/v1/videos/task-1',
    input: { url: 'https://example.test/source.png' },
    error: { url: 'https://example.test/help' },
  };
  assert.equal(extractImageUrl(control), null);
  assert.equal(extractVideoUrl(control), null);
  assert.equal(extractImageUrl({ result: { images: [{ image_url: 'https://cdn.example.test/out.png' }] } }), 'https://cdn.example.test/out.png');
  assert.equal(extractVideoUrl({ result: { videos: [{ video_url: 'https://cdn.example.test/out.mp4' }] } }), 'https://cdn.example.test/out.mp4');
});

test('failed video poll cannot become success through a result URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url));
    if (options.method === 'POST') return response({ task_id: 'task-1' });
    return response({ status: 'failed', video_url: 'https://cdn.example.test/stale.mp4', status_url: 'https://api.example.test/v1/videos/task-1' });
  };
  await assert.rejects(callMediaRoute({}, { taskType: 'text2video', prompt: 'test' }, { apiKey: 'fixture', fetchImpl }), /任务失败/);
  assert.equal(calls.length, 2);
});

test('completed video task with only a status URL has no result', async () => {
  const fetchImpl = async (_url, options = {}) => options.method === 'POST'
    ? response({ task_id: 'task-2' })
    : response({ status: 'completed', status_url: 'https://api.example.test/v1/videos/task-2' });
  await assert.rejects(callMediaRoute({}, { taskType: 'text2video', prompt: 'test' }, { apiKey: 'fixture', fetchImpl }), { code: 'EXTERNAL_RESULT_URL_MISSING' });
});

test('failed synchronous image response cannot become success through an asset URL', async () => {
  await assert.rejects(callMediaRoute({}, { taskType: 'text2image', prompt: 'test' }, {
    apiKey: 'fixture', fetchImpl: async () => response({ status: 'failed', data: [{ url: 'https://cdn.example.test/stale.png' }] }),
  }), { code: 'EXTERNAL_PROVIDER_FAILED' });
});
