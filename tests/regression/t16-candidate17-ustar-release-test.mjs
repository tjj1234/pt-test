import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archivePath = path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-17.tar.gz');
const unitPath = path.join(root, 'release-artifacts/northstar-shell-candidate-17.service');
const archiveSha256 = '480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964';
const unitSha256 = 'a5abf2112af069331c621232ea50033c0b30e5ef08ff50280bf0b15dd0fb8869';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function field(header, start, end) {
  const stop = header.indexOf(0, start);
  return header.subarray(start, stop < 0 || stop >= end ? end : stop).toString('utf8');
}

function octal(header, start, end) {
  const raw = header.subarray(start, end).toString('ascii').replace(/\0.*$/, '').trim();
  assert.match(raw, /^[0-7]*$/, `invalid tar octal field at ${start}`);
  return raw ? Number.parseInt(raw, 8) : 0;
}

function inspectUstar(gzipBytes) {
  const tar = zlib.gunzipSync(gzipBytes);
  const entries = [];
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      ended = true;
      break;
    }
    assert.equal(field(header, 257, 263), 'ustar', `non-USTAR header at byte ${offset}`);
    const storedChecksum = octal(header, 148, 156);
    let actualChecksum = 0;
    for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(actualChecksum, storedChecksum, `tar header checksum mismatch at byte ${offset}`);
    const type = String.fromCharCode(header[156] || 48);
    assert.ok(type === '0' || type === '5', `unexpected tar entry type ${JSON.stringify(type)}`);
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 500);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = octal(header, 124, 136);
    entries.push({ name: fullName, type, size, data: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(ended, 'tar stream must have a zero-block terminator');
  return entries;
}

test('candidate-17 package and unit remain the reviewed immutable release pair', () => {
  const archive = fs.readFileSync(archivePath);
  const unit = fs.readFileSync(unitPath);
  assert.equal(sha256(archive), archiveSha256);
  assert.equal(sha256(unit), unitSha256);
  assert.match(unit.toString('utf8'), /controlled-trial-20261022-candidate-17/);
});

test('candidate-17 is plain USTAR with the complete expected migration set and no forbidden paths', () => {
  const entries = inspectUstar(fs.readFileSync(archivePath));
  const names = entries.map(entry => entry.name);
  assert.equal(entries.length, 318);
  assert.equal(new Set(names).size, names.length, 'archive member names must be unique');
  assert.equal(names.filter(name => name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..') || name.includes('\\') || name.includes('\0')).length, 0);
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 19);
  assert.equal(names.filter(name => /(^|\/)\._/.test(name) || /(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  assert.ok(names.includes('shell/runtime/dsh-release-manifest.json'));
  assert.ok(names.includes('shell/db-migrations/018_conversation_model_preference.sql'));
});

test('critical source and lockfile bytes match the immutable candidate-17 snapshot', () => {
  const archive = fs.readFileSync(archivePath);
  const entries = new Map(inspectUstar(archive).map(entry => [entry.name, entry.data]));
  const reviewedHashes = {
    'shell/server.cjs': 'c40fdf15222b7119a258c94fcb2efb07a85abe7e64103dc01faa08dd17aa064b',
    'shell/public/app.js': '3509aa7cc48dc84514eada569d6c16f20f0876d16b72bd990a96ff0e04b5ddff',
    'shell/package-lock.json': '96c89082800cc682307a61436d115f5d080bb40a6f3c53a08c0478023fc993f3',
    'analytics/package-lock.json': '7ba7d25c51f71024a302d1c0a3ea64489510b87875355cba207c35b25dd1ae04',
    'business/attribution/package-lock.json': '49944f7144baf429d5f827744bb519bdba972f96f02fef7ef31d12f642aa8d22',
  };
  for (const [name, expected] of Object.entries(reviewedHashes)) {
    const data = entries.get(name);
    assert.ok(data?.length, `${name} is present in candidate-17`);
    assert.equal(sha256(data), expected, `${name} matches its reviewed candidate-17 byte hash`);
  }
});
