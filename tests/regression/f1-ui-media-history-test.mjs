import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from '../helpers/app-harness.mjs';

function textTree(node) {
  return [node?.textContent || '', ...(node?.children || []).flatMap(textTree)].join(' ');
}

test('reopened media history keeps useful status without exposing tool arguments or result URLs', async () => {
  const messages = [
    { role: 'assistant', text: '视频完成', media: [{ type: 'video', url: 'https://cdn.example.test/generated.mp4' }], steps: [
      { name: 'media_route', args: JSON.stringify({ taskType: 'text2video', prompt: 'PRIVATE_VIDEO_PROMPT', inputImageUrl: 'https://private.example.test/source.png' }) },
      { name: 'media_route', result: 'https://private.example.test/raw-tool-result.mp4', isError: false },
    ] },
    { role: 'assistant', text: '图片处理未完成', steps: [
      { name: 'media.route', args: JSON.stringify({ taskType: 'image2image', prompt: 'PRIVATE_IMAGE_PROMPT' }) },
      { name: 'media.route', result: 'PRIVATE_PROVIDER_ERROR', isError: true },
    ] },
  ];
  const app = await bootApp({ conversations: { A: { id: 'A', title: 'media', msgCount: 2, archived: false, messages } } });
  app.run('window.__mediaSeen = []; window.renderMediaInto = function (_bubble, media) { window.__mediaSeen.push(media); return true; }');
  await app.awaitRun("openConversation('A')");
  const rendered = textTree(app.el('chat'));
  const seenMedia = app.run('window.__mediaSeen');
  assert.equal(seenMedia.length, 1, 'history still passes assistant media to the renderer');
  assert.equal(seenMedia[0][0].url, 'https://cdn.example.test/generated.mp4', 'successful generated URL stays available to the media renderer');
  assert.match(rendered, /正在生成视频/);
  assert.match(rendered, /正在生成图片/);
  assert.match(rendered, /图片处理未完成，外部任务状态可能未确认/);
  assert.match(rendered, /过程 · 1 步/, 'successful completion is suppressed from the visible step count');
  assert.match(rendered, /过程 · 2 步/, 'failed completion remains visible for review');
  for (const secret of ['PRIVATE_VIDEO_PROMPT', 'PRIVATE_IMAGE_PROMPT', 'PRIVATE_PROVIDER_ERROR', 'raw-tool-result.mp4', 'media_route', 'media.route']) {
    assert.ok(!rendered.includes(secret), `${secret} must not be shown in history`);
  }
  assert.equal((rendered.match(/视频处理未完成/g) || []).length, 0, 'one message must not inherit another message task type');
});
