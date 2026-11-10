import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('Batch 3 / Bug-02: Source retrieval panel has explicit close/dismiss button restoring normal chat', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'shell/public/index.html'), 'utf8');
  assert.match(html, /id="sourcePanel"/);
  assert.match(html, /id="sourcePanelClose"/);
  assert.match(html, /class="source-panel-close"/);

  const css = fs.readFileSync(path.join(ROOT, 'shell/public/styles.css'), 'utf8');
  assert.match(css, /#sourcePanel summary/);
  assert.match(css, /\.source-panel-close/);
  assert.match(css, /#sourceBtn\[aria-pressed="true"\]/);

  const appJs = fs.readFileSync(path.join(ROOT, 'shell/public/app.js'), 'utf8');
  assert.match(appJs, /function closeSourcePanel\(\)/);
  assert.match(appJs, /panel\.hidden\s*=\s*true/);
  assert.match(appJs, /panel\.open\s*=\s*false/);
  assert.match(appJs, /clearSourceCitations\(\)/);
  assert.match(appJs, /sourceClose\.addEventListener\(['"]click['"]/);
  // Verify toggle functionality on sourceButton
  assert.match(appJs, /!panel\.hidden\s*&&\s*panel\.open/);
});
