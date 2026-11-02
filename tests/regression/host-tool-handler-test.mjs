import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const permissions = require('../../shell/permissions/index.cjs');
const registry = require('../../shell/tools/registry.cjs');
const { mediaRouteToolDefinition } = require('../../business/media/registry/tool.js');
const { attributionToolDefinition } = require('../../business/attribution/registry/tool.js');
const { createHostToolHandler } = require('../../shell/tasks/host-tool-handler.cjs');

test('host tool RPC enforces registered schema and trusted RBAC before routing', async () => {
  const roles = new Map([['owner-user', 'owner'], ['viewer-user', 'viewer']]);
  permissions.setDb({ query: async (_sql, values) => ({ rows: roles.has(values[0]) ? [{ role: roles.get(values[0]) }] : [] }) });
  let mediaCalls = 0, readCalls = 0, observedContext = null;
  try {
    registry.registerTool({ ...mediaRouteToolDefinition(), execute: async () => { throw new Error('media registry executor must never bypass Run handler'); } });
    registry.registerTool({ ...attributionToolDefinition(), execute: async (_args, context) => { readCalls++; observedContext = context; return { report: 'controlled' }; } });
    const mediaHandler = { handle: async (request) => { mediaCalls++; return { accepted: true, args: request.args }; }, drain: async () => {} };
    const ownerContext = { userId: 'owner-user', tenantId: 'tenant-owner', workspaceId: 'ws_tenant-owner' };
    const ownerHost = createHostToolHandler({ registry, context: ownerContext, mediaHandler });
    const requestId = randomUUID();

    await assert.rejects(ownerHost.handle({ requestId, name: 'media.route', args: { taskType: 'not-a-task', prompt: 'fixture' } }), { code: 'TOOL_INPUT_INVALID' });
    await assert.rejects(ownerHost.handle({ requestId, name: 'media.route', args: { taskType: 'text2image', prompt: 'fixture', tenantId: 'tenant-attacker' } }), { code: 'TOOL_INPUT_INVALID' }, 'identity fields outside the actual schema are rejected');
    assert.equal(mediaCalls, 0, 'invalid schema/identity args never enter paid handler');

    const mediaResult = await ownerHost.handle({ requestId, name: 'media.route', args: { taskType: 'text2image', prompt: 'fixture' } });
    assert.deepEqual(mediaResult, { accepted: true, args: { taskType: 'text2image', prompt: 'fixture' } });
    assert.equal(mediaCalls, 1);

    await assert.rejects(ownerHost.handle({ requestId: randomUUID(), name: 'attribution.query', args: { from: '2026-10-01', to: '2026-10-02', userId: 'attacker' } }), { code: 'TOOL_INPUT_INVALID' });
    assert.equal(readCalls, 0, 'unsupported read-tool fields are rejected before executor');
    assert.deepEqual(observedContext, null);
    const cleanRead = await ownerHost.handle({ requestId: randomUUID(), name: 'attribution.query', args: { from: '2026-10-01', to: '2026-10-02' } });
    assert.deepEqual(cleanRead, { report: 'controlled' });
    assert.equal(readCalls, 1);
    assert.deepEqual(observedContext, ownerContext, 'registry executor receives only the host-injected identity');

    const viewerContext = { userId: 'viewer-user', tenantId: 'tenant-viewer', workspaceId: 'ws_tenant-viewer' };
    const viewerHost = createHostToolHandler({ registry, context: viewerContext, mediaHandler });
    await assert.rejects(viewerHost.handle({
      requestId: randomUUID(), name: 'media.route', args: { taskType: 'text2image', prompt: 'fixture' },
      userId: ownerContext.userId, tenantId: ownerContext.tenantId, workspaceId: ownerContext.workspaceId,
    }), { code: 'TOOL_PERMISSION_DENIED' });
    await assert.rejects(viewerHost.handle({ requestId: randomUUID(), name: 'arbitrary.tool', args: {} }), { code: 'TOOL_NOT_ALLOWED' });
    assert.equal(mediaCalls, 1, 'unauthorized and unknown calls cannot reach the handler');
    assert.equal(readCalls, 1, 'unauthorized identity cannot execute read tools either');
  } finally {
    permissions.setDb(null);
  }
});
