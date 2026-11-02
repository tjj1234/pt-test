// Isolated browser fixture for F1 history rendering; no PT API calls or production service.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicRoot = path.join(root, 'shell/public');
const imagePath = path.join(root, 'docs/refactor/evidence/assets/f1-pt-t2i-20261024.jpg');
const runId = '11111111-2222-4333-8444-555555555555';
const conversation = { id: 'f1-browser-fixture', title: 'F1 图片和运行核对', msgCount: 2, archived: false, updated_at: new Date().toISOString(), messages: [
  { role: 'assistant', text: '本地历史图片', ts: new Date().toISOString(), runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', media: [{ type: 'image', url: '/fixture-success.jpg' }] },
  { role: 'assistant', text: '视频处理未完成', ts: new Date().toISOString(), runId },
] };
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/api/conversations') return json(res, { ok: true, conversations: [conversation] });
  if (p === '/api/conversations/' + conversation.id) return json(res, { ok: true, conversation });
  if (p === '/api/runs/' + runId) return json(res, { ok: true,
    run: { runId, state: 'failed', request: { prompt: 'PRIVATE_PROMPT_MUST_NOT_RENDER' } },
    externalOperations: { operations: [{ status: 'manual_check', taskId: null, lastQuery: { response: 'PRIVATE_PROVIDER_BODY_MUST_NOT_RENDER' } }] },
  });
  if (p === '/api/auth/me') return json(res, { ok: true, user: { username: 'fixture' } });
  if (p === '/api/auth/key') return json(res, { ok: true, key: { key_last4: '0000' } });
  if (p === '/api/skills') return json(res, { ok: true, skills: [] });
  if (p === '/api/status') return json(res, { ok: true, dashboardOk: true });
  if (p === '/api/models') return json(res, { ok: true, models: [] });
  if (p.startsWith('/api/')) return json(res, { ok: false, error: 'Fixture route unavailable' }, 404);
  let file = null;
  if (p === '/') file = path.join(publicRoot, 'index.html');
  else if (p === '/fixture-success.jpg') file = imagePath;
  else if (/^\/assets\/[a-zA-Z0-9._-]+$/.test(p)) file = path.join(publicRoot, path.basename(p));
  if (!file) { res.writeHead(404); res.end(); return; }
  try { const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': p === '/fixture-success.jpg' ? 'image/jpeg' : types[path.extname(file)] || 'application/octet-stream' }); res.end(bytes); }
  catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`F1_BROWSER_FIXTURE_PORT=${server.address().port}\n`));
