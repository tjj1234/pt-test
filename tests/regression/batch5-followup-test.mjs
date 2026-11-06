import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('Bug-2.6: Toolbar button aria-pressed active styling is present in styles.css', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'shell/public/styles.css'), 'utf8');
  assert.match(css, /\.toolbar-btn\[aria-pressed="true"\]/);
  assert.match(css, /border-color:\s*var\(--brand\)/);
  assert.match(css, /background:\s*var\(--bg-soft\)/);
});

test('Bug-2.8: Memory scope checks activeId, guards against missing conversationId, and prevents silent scope expansion', async () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'shell/public/app.js'), 'utf8');
  assert.match(appJs, /memScope\.querySelector\('option\[value="conversation"\]'\)/);
  assert.match(appJs, /convOpt\.disabled\s*=\s*true/);
  assert.match(appJs, /convOpt\.textContent\s*=\s*"当前对话范围（请先选择对话）"/);
  // Verify strict avoidance of silent scope mutation to "user"
  assert.doesNotMatch(appJs, /if\s*\(memScope\.value\s*===\s*"conversation"\)\s*memScope\.value\s*=\s*"user"/);
  assert.match(appJs, /scopeVal\s*===\s*"conversation"\s*&&\s*!state\.activeId/);
});

test('Bug-2.4: Chat submission maps SKILL_NOT_AVAILABLE with friendly notice, marks unavailable without silent unbinding', async () => {
  const serverCode = fs.readFileSync(path.join(ROOT, 'shell/server.cjs'), 'utf8');
  assert.match(serverCode, /error\.code\s*===\s*"SKILL_NOT_AVAILABLE"/);
  assert.match(serverCode, /所选技能版本已禁用或无法验证/);

  const appJs = fs.readFileSync(path.join(ROOT, 'shell/public/app.js'), 'utf8');
  assert.match(appJs, /j\.code\s*===\s*"SKILL_NOT_AVAILABLE"/);
  // Verify that runChat marks unavailable rather than wiping state.skillSelection directly
  assert.match(appJs, /state\.skillSelection\.unavailable\s*=\s*true/);
  assert.doesNotMatch(appJs, /state\.skillSelection\.unavailable\s*=\s*true[\s\S]{1,100}state\.skillSelection\s*=\s*null/);
  assert.match(appJs, /已失效\/不可用/);
  assert.match(appJs, /点击「移除」解绑该技能/);
});
