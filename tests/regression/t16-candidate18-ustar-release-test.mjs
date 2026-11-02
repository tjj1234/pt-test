import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archivePath = path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-18.tar.gz');
const unitPath = path.join(root, 'release-artifacts/northstar-shell-candidate-18.service');
const archiveSha = 'eb6e9cdbc931eafe4d215596b354fc498d283638a99f00f356900ed58de94f37';
const unitSha = 'ed3b4de17f4c27fdf5552ed5b3fdc9730e77ba816e9437851473ee45db70cfa8';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function parseUstar(bytes) {
  const raw = zlib.gunzipSync(bytes);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return entries;
    assert.equal(header.subarray(257, 263).toString('ascii').replace(/\0.*$/, ''), 'ustar');
    const stored = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(actual, stored, 'USTAR header checksum');
    const field = (start, end) => { const n = header.indexOf(0, start); return header.subarray(start, n < 0 || n >= end ? end : n).toString(); };
    const name = field(0, 100);
    const prefix = field(345, 500);
    const full = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 48);
    assert.ok(type === '0' || type === '5');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    entries.set(full, { type, data: raw.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail('missing USTAR terminator');
}

test('candidate-18 frozen release pair matches the published checksums', () => {
  const archive = fs.readFileSync(archivePath);
  const unit = fs.readFileSync(unitPath);
  assert.equal(sha(archive), archiveSha);
  assert.equal(sha(unit), unitSha);
  assert.match(unit.toString(), /controlled-trial-20261022-candidate-18/);
});

test('candidate-18 has 318 safe USTAR members, 19 migrations and no AppleDouble paths', () => {
  const entries = parseUstar(fs.readFileSync(archivePath));
  const names = [...entries.keys()];
  assert.equal(names.length, 318);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.filter(name => name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '.' || part === '..')).length, 0);
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 19);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
});

test('candidate-18 carries the exact runner with unknown counters preserved', () => {
  const entries = parseUstar(fs.readFileSync(archivePath));
  const bundled = entries.get('shell/persistent-runner.mjs')?.data;
  assert.ok(bundled);
  assert.match(bundled.toString(), /raw\.modelCalls >= 0 \? raw\.modelCalls : null/);
});
