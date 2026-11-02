import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const probe = path.resolve('scripts/northstar-catalog-cache-shape.cjs');
const { MAX_FILES, MAX_BYTES } = require(probe);
const filename = number => 'model-catalog-' + number.toString(16).padStart(64, '0') + '.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function setup(t) { const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'catalog-shape-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const run = dir => spawnSync(process.execPath, [probe, '--cache-dir', dir], { encoding: 'utf8' });

test('shape probe diagnoses old rich records without leaking values or changing cache bytes/mtime', t => {
  const dir = setup(t), secret = 'DO_NOT_EMIT_credential_scope_model_value';
  const models = [
    { id: secret, capabilityRevision: secret, tasks: { textChat: { value: true } }, inputModalities: { value: ['text'] }, outputModalities: { value: null }, endpoints: { value: ['openai'] }, adaptations: {}, verifications: {}, localPolicy: null },
    { id: secret, capabilityRevision: secret, ptEndpointTasks: null, endpoints: [], inputModalities: {}, outputModalities: { value: secret }, tasks: { textChat: { value: secret }, toolCalling: null }, adaptations: null, verifications: [], localPolicy: { enabled: secret } },
    { id: secret, capabilityRevision: secret, ptEndpointTasks: { value: [secret] }, endpoints: { value: null }, inputModalities: { value: null }, outputModalities: { value: [] }, tasks: null, localPolicy: { enabled: false, source: secret, version: secret } },
  ];
  const file = path.join(dir, filename(1));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, scopeId: secret, snapshot: { scopeId: secret, models } }));
  fs.writeFileSync(file, bytes); const before = fs.statSync(file);
  const response = run(dir); assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout.includes(secret), false); assert.equal(response.stdout.includes(dir), false); assert.equal(response.stdout.includes(filename(1)), false);
  const result = JSON.parse(response.stdout), row = result.files[0];
  assert.equal(result.counts.envelopeValid, 1); assert.equal(row.records, 3); assert.equal(row.sha256, sha(bytes)); assert.equal(row.bytes, bytes.length);
  assert.equal(row.fields.ptEndpointTasks.missing, 1); assert.equal(row.fields.ptEndpointTasks.null, 1);
  assert.equal(row.fields.endpoints.invalidWrapper, 1); assert.equal(row.fields.inputModalities.valueMissing, 1); assert.equal(row.fields.outputModalities.valueWrongType, 1);
  assert.equal(row.fields.tasks.null, 1); assert.equal(row.fields.tasks.facts.textChat.valueWrongType, 1); assert.equal(row.fields.tasks.facts.textChat.missing, 1);
  assert.equal(row.fields.tasks.facts.toolCalling.null, 1); assert.equal(row.fields.localPolicy.valueWrongType, 1);
  assert.equal(row.fields.adaptations.null, 1); assert.equal(row.fields.verifications.invalidWrapper, 1);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});

test('shape probe bounds symlinks, malformed JSON, oversized files and scan count', t => {
  const dir = setup(t), outside = path.join(dir, 'private-secret'); fs.writeFileSync(outside, 'NO_RAW_CONTENT');
  fs.symlinkSync(outside, path.join(dir, filename(1)));
  fs.writeFileSync(path.join(dir, filename(2)), 'BAD_JSON_NO_RAW_CONTENT');
  const oversized = path.join(dir, filename(3)); const fd = fs.openSync(oversized, 'w'); fs.ftruncateSync(fd, MAX_BYTES + 1); fs.closeSync(fd);
  fs.mkdirSync(path.join(dir, filename(4)));
  const result = run(dir); assert.equal(result.status, 0); assert.equal(result.stdout.includes('NO_RAW_CONTENT'), false);
  const output = JSON.parse(result.stdout); assert.equal(output.counts.symlink, 1); assert.equal(output.counts.parseError, 1); assert.equal(output.counts.oversized, 1); assert.equal(output.counts.nonRegular, 1); assert.equal(output.counts.scanned, 1);
  assert.deepEqual(fs.readFileSync(outside, 'utf8'), 'NO_RAW_CONTENT');
  const bounded = setup(t);
  for (let i = 0; i < MAX_FILES + 4; i++) fs.writeFileSync(path.join(bounded, filename(i)), '{}');
  const summary = JSON.parse(run(bounded).stdout); assert.equal(summary.counts.limitReached, true); assert.equal(summary.counts.scanned, MAX_FILES); assert.equal(summary.counts.matching, MAX_FILES + 1);
  const invalid = spawnSync(process.execPath, [probe, '--cache-dir', 'relative-secret'], { encoding: 'utf8' }); assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr, '{"error":"PROBE_FAILED"}\n');
});
