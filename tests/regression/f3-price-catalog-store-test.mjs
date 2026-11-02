import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { open, migrate } from '../../shell/db.cjs';
import { createTextPriceCatalogStore } from '../../shell/usage/price-catalog-store.cjs';
import { createModelIntentHandler } from '../../shell/usage/model-intent-handler.cjs';

const snapshot = (overrides = {}) => ({ sourceUrl: 'https://powertokens.ai/pricing', version: 'fixture-v1',
  model: 'fixture-model', capturedAt: '2020-01-01T00:00:00Z', effectiveFrom: '2020-01-01T00:00:00Z',
  effectiveUntil: null, currency: 'USD', inputUsdPerMillion: 1, outputUsdPerMillion: 2,
  cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 1, ...overrides });

test('reviewed price captures persist immutably, select as of recording, and reopen', async t => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-price-catalog-'));
  let connection = await open({ dataDir: directory });
  t.after(async () => { await connection.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await migrate(connection.db, path.resolve('shell/db-migrations'));
  let store = createTextPriceCatalogStore(connection.db);
  const input = { reviewed: true, sourceEvidence: 'Fixture public pricing capture; not a real price.', snapshots: [snapshot()] };
  const first = await store.importCatalog(input);
  assert.deepEqual(await store.importCatalog(input), first, 'identical re-import retains the original timestamp');
  const before = await store.selectAt({ model: 'fixture-model', requestedAt: new Date(Date.parse(first.recordedAt) - 1).toISOString() });
  assert.equal(before.snapshot, null, 'a later capture is never applied retroactively');
  const selected = await store.selectAt({ model: 'fixture-model', requestedAt: first.recordedAt });
  assert.equal(selected.catalogId, first.catalogId);
  assert.equal(selected.snapshot.inputUsdPerMillion, 1);
  const second = await store.importCatalog({ ...input, snapshots: [snapshot({ version: 'fixture-v2', inputUsdPerMillion: 3 })] });
  assert.notEqual(second.catalogId, first.catalogId);
  assert.equal(Number((await connection.db.query('SELECT count(*) AS count FROM text_price_catalogs')).rows[0].count), 2);
  assert.equal(selected.snapshot.inputUsdPerMillion, 1, 'an already bound snapshot retains its price');
  const events = [];
  const handler = createModelIntentHandler({ priceStore: store, selectedModel: 'fixture-model', emit: async (...event) => events.push(event) });
  const intent = { requestId: '11111111-1111-4111-8111-111111111111',
    args: { model: 'fixture-model', provider: 'fixture', turn: 1, step: 1, maxTokens: 128 } };
  assert.deepEqual(await handler.handle(intent), { recorded: true });
  await handler.handle(intent);
  assert.equal(events.length, 1, 'duplicate RPC acknowledgements cannot create a second intent');
  assert.equal(events[0][1].price.catalogId, second.catalogId);
  assert.equal(events[0][1].price.snapshot.inputUsdPerMillion, 3);
  await assert.rejects(handler.handle({ ...intent, requestId: '22222222-2222-4222-8222-222222222222', args: { ...intent.args, model: 'other-model' } }), { code: 'MODEL_INTENT_INVALID' });
  await assert.rejects(store.importCatalog({ ...input, reviewed: false }), { code: 'PRICE_CATALOG_REVIEW_REQUIRED' });
  await assert.rejects(store.importCatalog({ ...input, snapshots: [snapshot(), snapshot({ version: 'overlap' })] }), { code: 'PRICE_CATALOG_OVERLAPPING' });
  await assert.rejects(store.importCatalog({ ...input, snapshots: [snapshot({ capturedAt: '2099-01-01T00:00:00Z' })] }), { code: 'PRICE_CATALOG_FUTURE_CAPTURE' });
  await connection.close();
  const inputFile = path.join(directory, 'import-fixture.json');
  fs.writeFileSync(inputFile, JSON.stringify({ sourceEvidence: input.sourceEvidence, snapshots: input.snapshots }));
  const command = path.resolve('scripts/northstar-price-catalog.cjs');
  const denied = spawnSync(process.execPath, [command, 'import', '--db-dir', directory, '--input', inputFile, '--offline'], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).code, 'PRICE_CATALOG_REVIEW_REQUIRED');
  const imported = spawnSync(process.execPath, [command, 'import', '--db-dir', directory, '--input', inputFile, '--offline', '--reviewed'], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).catalogId, first.catalogId);
  connection = await open({ dataDir: directory });
  store = createTextPriceCatalogStore(connection.db);
  const reopened = await store.selectAt({ model: 'fixture-model', requestedAt: second.recordedAt });
  assert.equal(reopened.catalogId, second.catalogId);
  assert.equal(reopened.snapshot.inputUsdPerMillion, 3);
});
