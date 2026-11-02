import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archive = path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-17.tar.gz');
const expectedArchiveSha256 = '480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964';
const lockfiles = {
  'shell/package-lock.json': '96c89082800cc682307a61436d115f5d080bb40a6f3c53a08c0478023fc993f3',
  'analytics/package-lock.json': '7ba7d25c51f71024a302d1c0a3ea64489510b87875355cba207c35b25dd1ae04',
  'business/attribution/package-lock.json': '49944f7144baf429d5f827744bb519bdba972f96f02fef7ef31d12f642aa8d22',
};

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const archiveFile = name => execFileSync('tar', ['-xOzf', archive, name], { maxBuffer: 32 * 1024 * 1024 });

test('candidate-17 packaged lockfiles retain immutable release provenance', () => {
  assert.equal(sha256(fs.readFileSync(archive)), expectedArchiveSha256, 'candidate archive identity changed');

  for (const [name, expectedHash] of Object.entries(lockfiles)) {
    const packagedBytes = archiveFile(name);
    assert.equal(sha256(packagedBytes), expectedHash, `${name} candidate provenance changed`);
    // Current dependency provenance is independently checked by the active candidate.

    const lock = JSON.parse(packagedBytes.toString('utf8'));
    assert.equal(lock.lockfileVersion, 3, `${name} must use npm lockfile v3`);
  }
});

test('candidate lockfiles retain the recorded exact package versions and source classes', () => {
  const expected = {
    'shell/package-lock.json': {
      '@deepseek-ai/dsh': ['0.1.1-rc.2', 'file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz'],
      '@deepseek-ai/dsh-llm-pi-ai': ['0.1.1-rc.2', 'https://registry.npmjs.org/'],
      '@earendil-works/pi-ai': ['0.82.1', 'https://registry.npmjs.org/'],
      pg: ['8.23.1', 'https://registry.npmjs.org/'],
      nodemailer: ['6.10.1', 'https://registry.npmjs.org/'],
    },
    'analytics/package-lock.json': {
      fastify: ['4.29.1', 'https://registry.npmjs.org/'],
      pg: ['8.23.0', 'https://registry.npmjs.org/'],
    },
  };

  for (const [file, packages] of Object.entries(expected)) {
    const lock = JSON.parse(archiveFile(file).toString('utf8'));
    for (const [name, [version, sourcePrefix]] of Object.entries(packages)) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `${file} is missing ${name}`);
      assert.equal(entry.version, version, `${file} ${name} version changed`);
      assert.ok(entry.resolved?.startsWith(sourcePrefix), `${file} ${name} source class changed`);
      assert.match(entry.integrity || '', /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/, `${file} ${name} has no lock integrity declaration`);
    }
  }
});
