import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHostToolHandler } from '../../shell/tasks/host-tool-handler.cjs';
import { csvAnalyzeToolDefinition } from '../../shell/tasks/csv-tool-definition.cjs';

test('F2 CSV RPC requires durable handler, RBAC visibility and schema before source access', async () => {
  const definition = csvAnalyzeToolDefinition();
  let calls = 0;
  const registry = {
    listToolsForWorkspace: async () => [definition],
    validateToolCall: async () => true,
    executeTool: async () => { throw new Error('CSV must not use a generic executor'); },
  };
  const context = { userId: 'user', tenantId: 'tenant', workspaceId: 'ws_tenant' };
  const args = { sourceRef: '/uploads/source.csv', sourceSha256: 'a'.repeat(64), operation: 'sum', column: 1, startRow: 2 };
  const request = { requestId: randomUUID(), name: 'csv.analyze', args };
  const withoutRun = createHostToolHandler({ registry, context });
  await assert.rejects(withoutRun.handle(request), { code: 'RUN_REQUIRED' });

  const csvHandler = { handle: async ({ args: selected }) => { calls++; return { result: '4', selected }; } };
  const host = createHostToolHandler({ registry, context, csvHandler });
  await assert.rejects(host.handle({ ...request, args: { ...args, tenantId: 'attacker' } }), { code: 'TOOL_INPUT_INVALID' });
  assert.equal(calls, 0);
  assert.deepEqual(await host.handle(request), { result: '4', selected: args });
  assert.equal(calls, 1);
  const denied = createHostToolHandler({ registry: { ...registry, listToolsForWorkspace: async () => [] }, context, csvHandler });
  await assert.rejects(denied.handle(request), { code: 'TOOL_PERMISSION_DENIED' });
  assert.equal(calls, 1);
});
