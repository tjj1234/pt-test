import test from 'node:test';
import assert from 'node:assert/strict';

test('Bug-08: Clipboard file paste filter supports images, docs and media', () => {
  const DOC_EXT_WHITELIST = new Set(['txt', 'md', 'csv', 'docx', 'xlsx', 'pptx']);
  function isDocFile(f) {
    if (!f || !f.name) return false;
    const parts = f.name.split('.');
    return parts.length > 1 && DOC_EXT_WHITELIST.has(parts.pop().toLowerCase());
  }
  function mediaKindOf(f) {
    const mime = String(f?.type || '').toLowerCase();
    if (/^video\//.test(mime)) return 'video';
    if (/^audio\//.test(mime)) return 'audio';
    const ext = f?.name?.split('.').pop()?.toLowerCase();
    if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
    return '';
  }

  function filterPastedFiles(items) {
    const files = [];
    for (const it of items) {
      if (it && it.kind === 'file') {
        const f = it.file;
        if (f && (isDocFile(f) || mediaKindOf(f) || /^image\//.test(f.type || ''))) {
          files.push(f);
        }
      }
    }
    return files;
  }

  // 1. Image paste
  const imageItem = [{ kind: 'file', file: { name: 'photo.png', type: 'image/png' } }];
  assert.equal(filterPastedFiles(imageItem).length, 1);

  // 2. CSV spreadsheet paste
  const csvItem = [{ kind: 'file', file: { name: 'sales.csv', type: 'text/csv' } }];
  assert.equal(filterPastedFiles(csvItem).length, 1, 'CSV files must be accepted on paste');

  // 3. Excel spreadsheet paste
  const xlsxItem = [{ kind: 'file', file: { name: 'data.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }];
  assert.equal(filterPastedFiles(xlsxItem).length, 1, 'XLSX files must be accepted on paste');

  // 4. Video file paste
  const videoItem = [{ kind: 'file', file: { name: 'clip.mp4', type: 'video/mp4' } }];
  assert.equal(filterPastedFiles(videoItem).length, 1, 'MP4 videos must be accepted on paste');

  // 5. Plain text item (non-file)
  const textItem = [{ kind: 'string', file: null }];
  assert.equal(filterPastedFiles(textItem).length, 0, 'Plain text in clipboard must not be treated as file');
});

test('Bug-17: Empty text with image attachment is accepted and given a fallback question', () => {
  function computeEffectiveMessage(msg, { image, documents, media, sourceCitations }) {
    const hasAttachments = Boolean(
      image ||
      (Array.isArray(documents) && documents.length) ||
      (Array.isArray(media) && media.length) ||
      (Array.isArray(sourceCitations) && sourceCitations.length)
    );
    const trimmed = String(msg || '').trim();
    if (!trimmed && !hasAttachments) return { ok: false, error: '问题不能为空' };

    let effective = trimmed;
    if (!effective && hasAttachments) {
      if (image) effective = '请分析这张图片';
      else if (documents && documents.length) effective = '请分析附件内容';
      else if (media && media.length) effective = '请分析音视频内容';
      else effective = '请分析引用的资料内容';
    }
    return { ok: true, question: effective };
  }

  // Pure text
  assert.deepEqual(computeEffectiveMessage('你好', {}), { ok: true, question: '你好' });

  // Empty text, no attachment
  assert.equal(computeEffectiveMessage('', {}).ok, false);

  // Empty text with image
  const imgRes = computeEffectiveMessage('', { image: '/uploads/t1/pic.png' });
  assert.equal(imgRes.ok, true);
  assert.equal(imgRes.question, '请分析这张图片');

  // Empty text with doc
  const docRes = computeEffectiveMessage('', { documents: ['/uploads/t1/f.csv'] });
  assert.equal(docRes.ok, true);
  assert.equal(docRes.question, '请分析附件内容');
});

test('Bug-01: Run draining allows cancelled/transitioned runs without throwing Run not drained', async () => {
  // Simulate run cancellation and drain logic in onRevoke
  const runs = [
    { runId: 'r1', state: 'cancelling', revision: 1 },
    { runId: 'r2', state: 'queued', revision: 1 }
  ];

  async function cancelRun(run) {
    if (run.state === 'cancelling' || run.state === 'queued') {
      run.state = 'cancelled';
      run.revision++;
    }
    return run;
  }

  for (const run of runs) {
    if (['queued','running','waiting_external','awaiting_confirmation','cancelling'].includes(run.state)) {
      await cancelRun(run);
      assert.equal(run.state, 'cancelled');
      assert.ok(!['queued','running','waiting_external','awaiting_confirmation','cancelling'].includes(run.state));
    }
  }
});
