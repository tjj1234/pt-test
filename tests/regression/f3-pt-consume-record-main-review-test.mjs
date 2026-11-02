import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve('.');
const source = path.join(root, 'shell/usage/pt-consume-record-r2-candidate.cjs');
const patch = path.join(root, 'docs/refactor/candidates/pt-consume-record-r2-main-review-20261029.patch');
const originalTests = path.join(root, 'tests/regression/f3-pt-consume-record-r2-candidate-test.mjs');

test('F3 R2 main overlay bounds UTF-8 work and retains all original 40 cases', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-pt-consume-review-'));
  try {
    const modulePath = path.join(temp, 'pt-consume-record-r2-candidate.cjs');
    fs.copyFileSync(source, modulePath);
    const applied = spawnSync('patch', ['-p1', '-d', temp, '-i', patch], {encoding: 'utf8'});
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const relocated = fs.readFileSync(originalTests, 'utf8').replace(
      '../../shell/usage/pt-consume-record-r2-candidate.cjs', pathToFileURL(modulePath).href);
    assert.notEqual(relocated, fs.readFileSync(originalTests, 'utf8'));
    const testPath = path.join(temp, 'r2-cases.mjs');
    fs.writeFileSync(testPath, relocated);
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const suite = spawnSync(process.execPath, ['--test', testPath], {encoding:'utf8', timeout:10000, env});
    assert.equal(suite.status, 0, suite.stderr + suite.stdout);
    assert.match(suite.stdout + suite.stderr, /pass 40/);

    const require = createRequire(import.meta.url);
    const {normalizePtConsumeRecord} = require(modulePath);
    const huge = 'x'.repeat(10 * 1024 * 1024);
    let scannedHuge = false;
    const original = Buffer.byteLength;
    try {
      Buffer.byteLength = function(value, encoding) {
        if (value === huge) scannedHuge = true;
        return original.call(this, value, encoding);
      };
      const record = {
        consume_id:'c', request_id:'r', endpoint:'e', provider_name:'p', model_id:'m',
        model_name:huge, status:'succeeded', consume_time:1774684800,
        request_type:'text', quota:0, usage:{},
        billing:{pricing_mode:'tiered', billing_unit:'per_tokens', unit_size:1,
          quota_per_unit:0, items:[], total_quota:0, original_quota:0,
          discount_quota:0, final_quota:0},
      };
      assert.throws(() => normalizePtConsumeRecord(record), {code:'PT_CONSUME_RECORD_INVALID'});
      assert.equal(scannedHuge, false, 'overlong value must be rejected before UTF-8 byte scan');
    } finally {
      Buffer.byteLength = original;
    }
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
