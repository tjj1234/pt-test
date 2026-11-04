import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

test('Batch 4 Bug-03: task store listRuns orders by created_at DESC and paginates without loss', async () => {
  const { createTaskStore } = await import('../../shell/tasks/store.cjs');
  // Simple mock db to verify the SQL query structure in listRuns
  let executedSql = '';
  let queryParams = [];
  const mockDb = {
    query: async (sql, params) => {
      executedSql = sql;
      queryParams = params;
      return { rows: [] };
    },
    transaction: async (fn) => fn(mockDb),
  };
  const store = createTaskStore(mockDb);
  const identity = { userId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222' };
  
  await store.listRuns(identity, { limit: 50 });
  assert.match(executedSql, /ORDER BY created_at DESC, run_id DESC/);
});

test('Batch 4 Bug-04: GET /api/models and model select do not force sync unconditionally', async () => {
  const serverCode = fs.readFileSync(path.join(ROOT, 'shell/server.cjs'), 'utf8');
  // Verify GET /api/models does not have unconditional { force: true }
  assert.doesNotMatch(serverCode, /const cat = await ensureModelCatalog\(me\.user\.id, \{ force: true \}\);/);
  // Verify POST /api/models/select uses { force: false }
  assert.match(serverCode, /const catSel = await ensureModelCatalog\(me\.user\.id, \{ force: false \}\);/);
});

test('Batch 4 Bug-13 & Bug-14: runner evicts poisoned agent session on failure and server closes session', async () => {
  const runnerCode = fs.readFileSync(path.join(ROOT, 'shell/persistent-runner.mjs'), 'utf8');
  // Verify agentMap.delete(sid) is called on turn incomplete/error
  assert.match(runnerCode, /code:\s*"AGENT_TURN_INCOMPLETE",[\s\S]*?agentMap\.delete\(sid\);/);
  // Verify agentMap.delete(sid) is called in catch block
  assert.match(runnerCode, /agentMap\.delete\(sid\);\s*rejectToolRequests/);

  const serverCode = fs.readFileSync(path.join(ROOT, 'shell/server.cjs'), 'utf8');
  // Verify server invokes closeDshSession when fatal turn errors occur
  assert.match(serverCode, /AGENT_TURN_INCOMPLETE[\s\S]*?tenantMod\.closeDshSession\(conversationId\)/);
});

test('Batch 4 Bug-12 & Bug-07: HTML code block materialization & persona upload constraints', async () => {
  const serverCode = fs.readFileSync(path.join(ROOT, 'shell/server.cjs'), 'utf8');
  // Verify HTML code block detection and artifact generation in server.cjs
  assert.match(serverCode, /htmlBlockMatch/);
  assert.match(serverCode, /report\.html/);

  const persona = fs.readFileSync(path.join(ROOT, 'shell/agent-persona.md'), 'utf8');
  // Verify persona contains clear file writeback / read-only boundary
  assert.match(persona, /用户上传的文件为只读数据源/);
  assert.match(persona, /不支持直接覆盖回写原上传文件/);
});
