import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, migrate } from '../../shell/db.cjs';
import { initToolCalls } from '../../shell/tool-calls.cjs';

test('chat usage stores one idempotent row per observed response and preserves unknowns', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-usage-evidence-'));
  const { db, close } = await open({ dataDir });
  t.after(async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await migrate(db, path.resolve('shell/db-migrations'));

  const tenantId = (await db.query("INSERT INTO tenants (name) VALUES ('usage-test') RETURNING id")).rows[0].id;
  const userId = (await db.query(
    "INSERT INTO users (tenant_id,username,email,password_hash,role) VALUES ($1,'usage-test',NULL,'scrypt$test$unused','admin') RETURNING id",
    [tenantId],
  )).rows[0].id;
  const workspaceId = `ws_${tenantId}`;
  const runId = '11111111-1111-4111-8111-111111111111';
  await db.query(
    `INSERT INTO agent_runs (run_id,conversation_id,user_id,tenant_id,workspace_id,contract_version,policy_version,state,idempotency_scope,request_hash,request)
     VALUES ($1,$2,$3,$4,$5,'v1','v1','completed','usage-test-scope','hash','{}'::jsonb)`,
    [runId, '22222222-2222-4222-8222-222222222222', userId, tenantId, workspaceId],
  );

  const toolCalls = await initToolCalls(db);
  const entry = {
    tenantId, userId, workspaceId, model: 'fixture-model', runId,
    usageEvidence: {
      observedResponses: 2,
      coverage: 'partial',
      responses: [
        { responseSeq: 4, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 } },
        { responseSeq: 9, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: 0 } },
      ],
    },
  };
  assert.deepEqual(await toolCalls.logUsage(entry), { inserted: 2, duplicate: 0, observedResponses: 2 });
  assert.deepEqual(await toolCalls.logUsage(entry), { inserted: 0, duplicate: 2, observedResponses: 2 });
  await assert.rejects(
    toolCalls.logUsage({ ...entry, usageEvidence: { ...entry.usageEvidence, responses: [
      { responseSeq: 4, usage: { inputTokens: 101, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 } },
    ] } }),
    { code: 'USAGE_EVIDENCE_CONFLICT' },
    'same Run response sequence with different evidence is rejected rather than silently ignored',
  );
  const rows = (await db.query('SELECT run_id,response_seq,prompt_tokens,completion_tokens,total_tokens,cache_read_tokens,cache_write_tokens,coverage,total_semantics,cost_amount,cost_currency,cost_coverage FROM chat_usage ORDER BY response_seq')).rows;
  assert.equal(rows.length, 2, 'same run/response pair is idempotent');
  assert.equal(rows[0].run_id, runId);
  assert.equal(Number(rows[0].response_seq), 4);
  assert.equal(Number(rows[0].prompt_tokens), 100);
  assert.equal(Number(rows[0].total_tokens), 125);
  assert.equal(rows[0].coverage, 'complete');
  assert.equal(rows[0].total_semantics, 'unknown', 'untrusted fixture totals never acquire the pinned DSH semantic tag');
  assert.equal(rows[0].cost_amount, null);
  assert.equal(rows[0].cost_currency, null);
  assert.equal(rows[0].cost_coverage, 'unknown');
  assert.equal(Number(rows[1].prompt_tokens), 3);
  assert.equal(Number(rows[1].completion_tokens), 4);
  assert.equal(rows[1].total_tokens, null);
  assert.equal(rows[1].coverage, 'partial');
  assert.equal(rows[1].total_semantics, 'unknown');

  await db.query(
    `INSERT INTO agent_run_events (event_id,run_id,seq,event) VALUES ($1,$2,1,$3::jsonb)`,
    ['44444444-4444-4444-8444-444444444444', runId, JSON.stringify({ type: 'state', payload: {
      action: 'model_identity_evidence', coverage: 'partial', responses: [
        { responseSeq: 4, turn: 1, step: 1, configuredModelId: 'fixture-model', providerReportedModelId: 'fixture-upstream' },
        { responseSeq: 9, configuredModelId: 'fixture-model', providerReportedModelId: null },
      ],
    } })],
  );

  const firstPage = await toolCalls.usageByRun({ tenantId, userId, workspaceId, runId, limit: 1 });
  assert.equal(firstPage.responses.length, 1);
  assert.equal(firstPage.responses[0].responseSeq, 4);
  assert.equal(firstPage.responses[0].selectedModel, 'fixture-model');
  assert.equal(firstPage.responses[0].providerReportedModel, 'fixture-upstream');
  assert.equal(firstPage.responses[0].modelIdentityEvidence, 'provider_response_model');
  assert.equal(firstPage.responses[0].cost, null);
  assert.equal(firstPage.responses[0].costCoverage, 'unknown');
  assert.equal(firstPage.hasMore, true);
  const secondPage = await toolCalls.usageByRun({ tenantId, userId, workspaceId, runId, after: firstPage.nextCursor, limit: 1 });
  assert.equal(secondPage.responses[0].responseSeq, 9);
  assert.equal(secondPage.responses[0].cacheReadTokens, null);
  assert.equal(secondPage.responses[0].providerReportedModel, null);
  assert.equal(secondPage.responses[0].modelIdentityEvidence, 'unknown');
  assert.equal(secondPage.hasMore, false);
  const completeExport = await toolCalls.allUsageByRun({ tenantId, userId, workspaceId, runId }, { pageSize: 1 });
  assert.deepEqual(completeExport.map(response => response.responseSeq), [4, 9],
    'complete export crosses a page boundary without dropping or duplicating responses');
  await assert.rejects(toolCalls.allUsageByRun({ tenantId, userId, workspaceId, runId }, { pageSize: 1, maxRows: 1 }),
    { code: 'RUN_USAGE_EXPORT_LIMIT' }, 'export refuses partial output when the cap is exceeded');
  assert.deepEqual((await toolCalls.usageByRun({ tenantId, userId: '33333333-3333-4333-8333-333333333333', workspaceId, runId })).responses, [],
    'another user cannot read the Run usage evidence');
  assert.deepEqual((await toolCalls.usageByRun({ tenantId, userId, workspaceId: 'other-workspace', runId })).responses, [],
    'a workspace mismatch cannot read the Run usage evidence');
  await assert.rejects(toolCalls.usageByRun({ tenantId, userId, workspaceId, runId, after: 1.5 }), { code: 'USAGE_QUERY_INVALID' });

  const summary = await toolCalls.usageSummary({ tenantId, workspaceId, range: 'month' });
  assert.equal(summary.month.count, 2);
  assert.equal(summary.month.promptTokens, 103);
  assert.equal(summary.month.completionTokens, 24);
  assert.equal(summary.month.totalTokens, null);
  assert.equal(summary.month.coverage, 'partial');
  assert.equal(summary.month.totalSemantics, 'unknown');
  assert.equal(summary.month.cost, null);
  assert.equal(summary.month.costCoverage, 'unknown');
  assert.equal(summary.byModel[0].coverage, 'partial');

  const consistent = await toolCalls.logUsage({ ...entry, usageEvidence: { responses: [
    { responseSeq: 10, usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 10 } },
  ] } });
  assert.deepEqual(consistent, { inserted: 1, duplicate: 0, observedResponses: 1 });
  await assert.rejects(toolCalls.logUsage({ ...entry, usageEvidence: { responses: [
    { responseSeq: 11, usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 9 } },
  ] } }), { code: 'USAGE_EVIDENCE_INVALID' }, 'a supplied total must agree with all four complete components');
  await assert.rejects(toolCalls.logUsage({ ...entry, usageEvidence: { responses: [
    { responseSeq: 13, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER } },
  ] } }), { code: 'USAGE_EVIDENCE_INVALID' }, 'overflowing component sums fail closed even when a total is supplied');
  const consistentRow = (await db.query('SELECT total_tokens FROM chat_usage WHERE run_id=$1 AND response_seq=10', [runId])).rows[0];
  assert.equal(Number(consistentRow.total_tokens), 10);
  assert.equal(rows[1].total_tokens, null, 'unknown cache component prevents deriving a total');
  await toolCalls.logUsage({ ...entry, usageEvidence: { responses: [
    { responseSeq: 12, usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: 0, totalTokens: 99 } },
  ] } });
  const upstreamTotalRow = (await db.query('SELECT total_tokens,coverage,total_semantics FROM chat_usage WHERE run_id=$1 AND response_seq=12', [runId])).rows[0];
  assert.equal(Number(upstreamTotalRow.total_tokens), 99, 'an explicit upstream total remains evidence when components are incomplete');
  assert.equal(upstreamTotalRow.coverage, 'partial');
  assert.equal(upstreamTotalRow.total_semantics, 'upstream_reported_unclassified');
  await db.query("UPDATE chat_usage SET total_semantics='legacy_unclassified' WHERE run_id=$1 AND response_seq=10", [runId]);
  const mixedSummary = await toolCalls.usageSummary({ tenantId, workspaceId, range: 'month' });
  assert.equal(mixedSummary.month.totalTokens, null, 'legacy and unclassified records never produce a blended total');
  assert.equal(mixedSummary.month.totalSemantics, 'mixed');
  assert.equal(mixedSummary.month.coverage, 'partial');
  assert.equal(mixedSummary.byModel[0].totalTokens, null);
  assert.equal(mixedSummary.byModel[0].totalSemantics, 'mixed');

  // A separate exact identity and call-time binding can price only this response.
  const identityEvent = (await db.query('SELECT event FROM agent_run_events WHERE run_id=$1 AND seq=1', [runId])).rows[0].event;
  identityEvent.payload.responses[0].providerReportedModelId = 'fixture-model';
  await db.query('UPDATE agent_run_events SET event=$2::jsonb WHERE run_id=$1 AND seq=1', [runId, JSON.stringify(identityEvent)]);
  await db.query("UPDATE chat_usage SET total_semantics='dsh_pi_ai_disjoint_0_1_1_rc_2' WHERE run_id=$1 AND response_seq=4", [runId]);
  const intent = { type: 'state', payload: { action: 'model_request_intent', attemptId: 'fixture-attempt',
    turn: 1, step: 1, selectedModel: 'fixture-model', requestedAt: '2026-10-27T00:00:00Z', price: {
      coverage: 'selected', catalogId: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), snapshot: {
        sourceUrl: 'https://powertokens.ai/pricing', currency: 'USD', model: 'fixture-model', version: 'fixture-v1',
        capturedAt: '2020-01-01T00:00:00Z', effectiveFrom: '2020-01-01T00:00:00Z', effectiveUntil: null,
        inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 1,
      },
    } } };
  await db.query('INSERT INTO agent_run_events(event_id,run_id,seq,event) VALUES ($1,$2,2,$3::jsonb)',
    ['55555555-5555-4555-8555-555555555555', runId, JSON.stringify(intent)]);
  const priced = await toolCalls.usageByRun({ tenantId, userId, workspaceId, runId, limit: 1 });
  assert.equal(priced.responses[0].costCoverage, 'estimated');
  assert.equal(priced.responses[0].costCurrency, 'USD');
  assert.equal(priced.responses[0].cost, 0.0001405);
  assert.equal(priced.responses[0].priceVersion, 'fixture-v1');
  assert.equal(priced.responses[0].costBasis, 'provider_reported_model');
  identityEvent.payload.responses[0].providerReportedModelId = null;
  await db.query('UPDATE agent_run_events SET event=$2::jsonb WHERE run_id=$1 AND seq=1', [runId, JSON.stringify(identityEvent)]);
  const requestedEstimate = await toolCalls.usageByRun({ tenantId, userId, workspaceId, runId, limit: 1 });
  assert.equal(requestedEstimate.responses[0].cost, 0.0001405);
  assert.equal(requestedEstimate.responses[0].costBasis, 'requested_model');
  assert.equal(requestedEstimate.responses[0].providerReportedModel, null);
  assert.equal(requestedEstimate.responses[0].modelIdentityEvidence, 'unknown');
  await db.query('INSERT INTO agent_run_events(event_id,run_id,seq,event) VALUES ($1,$2,3,$3::jsonb)',
    ['66666666-6666-4666-8666-666666666666', runId, JSON.stringify(intent)]);
  const ambiguous = await toolCalls.usageByRun({ tenantId, userId, workspaceId, runId, limit: 1 });
  assert.equal(ambiguous.responses[0].cost, null, 'multiple attempts for the same step never guess a price binding');
  assert.equal(ambiguous.responses[0].costReasonCode, 'REQUEST_INTENT_AMBIGUOUS');

  await assert.rejects(
    toolCalls.logUsage({ ...entry, userId: '33333333-3333-4333-8333-333333333333' }),
    { code: 'RUN_USAGE_IDENTITY_MISMATCH' },
  );
});

test('legacy usage calls accept camel or snake fields and never turn unknown into zero', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-usage-legacy-'));
  const { db, close } = await open({ dataDir });
  t.after(async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await migrate(db, path.resolve('shell/db-migrations'));
  const tenantId = (await db.query("INSERT INTO tenants (name) VALUES ('legacy-usage-test') RETURNING id")).rows[0].id;
  const userId = (await db.query(
    "INSERT INTO users (tenant_id,username,email,password_hash,role) VALUES ($1,'legacy-usage-test',NULL,'scrypt$test$unused','admin') RETURNING id",
    [tenantId],
  )).rows[0].id;
  const workspaceId = `ws_${tenantId}`;
  const toolCalls = await initToolCalls(db);
  await toolCalls.logUsage({ tenantId, userId, workspaceId, model: 'camel', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  await toolCalls.logUsage({ tenantId, userId, workspaceId, model: 'unknown', prompt_tokens: null, completion_tokens: null, total_tokens: null });
  const summary = await toolCalls.usageSummary({ tenantId, workspaceId, range: 'month' });
  assert.equal(summary.month.count, 2);
  assert.equal(summary.month.promptTokens, null);
  assert.equal(summary.month.completionTokens, null);
  assert.equal(summary.month.totalTokens, null);
  assert.equal(summary.month.coverage, 'partial');
  assert.equal(summary.month.cost, null);
  assert.equal(summary.month.costCoverage, 'unknown');
  const pureUnknown = summary.byModel.find((row) => row.model === 'unknown');
  assert.equal(pureUnknown.totalTokens, null);
  assert.equal(pureUnknown.totalSemantics, 'unknown');
  assert.equal(pureUnknown.coverage, 'unknown', 'absence of all component evidence remains unknown, not partial');

  const trustedSemantics = 'dsh_pi_ai_disjoint_0_1_1_rc_2';
  await toolCalls.logUsage({ tenantId, userId, workspaceId, model: 'overflow-model', usageEvidence: {
    totalSemantics: trustedSemantics,
    responses: [{ responseSeq: 1, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  } });
  await toolCalls.logUsage({ tenantId, userId, workspaceId, model: 'overflow-model', usageEvidence: {
    totalSemantics: trustedSemantics,
    responses: [{ responseSeq: 2, usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  } });
  const overflow = (await toolCalls.usageSummary({ tenantId, workspaceId, range: 'month' })).byModel.find((row) => row.model === 'overflow-model');
  assert.equal(overflow.totalTokens, null, 'unsafe aggregate sum is not exposed');
  assert.equal(overflow.totalSemantics, trustedSemantics, 'source semantics remain distinct from aggregate completeness');
  assert.equal(overflow.coverage, 'partial', 'overflow is explicitly incomplete');

  await toolCalls.logUsage({ tenantId, userId, workspaceId, model: 'safe-boundary-model', usageEvidence: {
    totalSemantics: trustedSemantics,
    responses: [{ responseSeq: 3, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  } });
  const safeBoundary = (await toolCalls.usageSummary({ tenantId, workspaceId, range: 'month' })).byModel.find((row) => row.model === 'safe-boundary-model');
  assert.equal(safeBoundary.totalTokens, Number.MAX_SAFE_INTEGER, 'the inclusive safe-integer boundary remains reportable');
  assert.equal(safeBoundary.coverage, 'complete');
});
