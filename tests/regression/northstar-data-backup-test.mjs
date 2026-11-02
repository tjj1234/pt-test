import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'shell/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const dbmod = require('../shell/db.cjs');
const keysMod = require('../shell/keys.cjs');
const backup = require('../shell/runtime/data-backup.cjs');
const cli = require('../scripts/northstar-data-backup.cjs');
const cliPath = path.join(root, 'scripts/northstar-data-backup.cjs');
const migrationsDir = path.join(root, 'shell/db-migrations');

function putFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function parseHeader(bytes) {
  const manifestSize = bytes.readUInt32BE(8);
  const manifestStart = 12;
  return { manifestSize, manifestStart, digestStart: manifestStart + manifestSize, payloadStart: manifestStart + manifestSize + 32 };
}

function rewriteManifest(bytes, manifest) {
  const { manifestStart, digestStart, payloadStart } = parseHeader(bytes);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length);
  const digest = crypto.createHash('sha256').update(manifestBytes).digest();
  return Buffer.concat([bytes.subarray(0, 8), length, manifestBytes, digest, bytes.subarray(payloadStart)]);
}

test('isolated PGlite and allowlisted file snapshot restores to a new root and rejects corruption', async (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-data-backup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dbDir = path.join(temp, 'source-db');
  const runtimeDir = path.join(temp, 'source-runtime');
  const outputFile = path.join(temp, 'fixture.nsbackup');
  const targetRoot = path.join(temp, 'restored');
  const masterKeyFile = path.join(temp, 'separate-key-channel', 'master.json');
  const syntheticMasterKey = crypto.randomBytes(32);
  putFile(masterKeyFile, JSON.stringify({ scheme: 'raw-0600', protected: false, key: syntheticMasterKey.toString('base64'), created_at: 'fixture' }));
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const conversationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const sessionToken = 'synthetic-session-token';
  const fixtureApiKey = 'synthetic-never-live-api-key-1234';
  const upload = Buffer.from('synthetic uploaded text\n');
  const artifact = Buffer.from('# synthetic artifact\n');
  const skill = Buffer.from('---\nname: fixture-skill\n---\nSynthetic only.\n');

  let db = new PGlite(dbDir);
  try {
    await db.waitReady;
    await dbmod.migrate(db, migrationsDir);
    await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [tenantId, 'synthetic tenant']);
    await db.query('INSERT INTO users(id,tenant_id,username,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6)', [userId, tenantId, 'backup-fixture', 'backup@example.test', 'synthetic-not-a-password-hash', 'member']);
    await db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval \'1 day\')', [userId, crypto.createHash('sha256').update(sessionToken).digest('hex')]);
    await db.query('INSERT INTO conversations(id,user_id,title,messages) VALUES ($1,$2,$3,$4::jsonb)', [conversationId, userId, 'fixture conversation', JSON.stringify([{ role: 'user', text: 'synthetic backup' }])]);
    await db.query('INSERT INTO user_memory(user_id,key,value) VALUES ($1,$2,$3)', [userId, 'fixture', 'synthetic memory']);
    await db.query('INSERT INTO agent_runs(run_id,conversation_id,user_id,tenant_id,workspace_id,contract_version,policy_version,state,idempotency_scope,request_hash,request) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)', [runId, conversationId, userId, tenantId, tenantId, 'v1', 'fixture-policy', 'completed', 'fixture-scope', 'a'.repeat(64), JSON.stringify({ message: 'synthetic run' })]);
    const keys = await keysMod.initKeys({ db, masterKeyFile });
    assert.equal((await keys.encryptApiKey(userId, fixtureApiKey)).ok, true);
  } finally {
    await db.close();
  }

  putFile(path.join(runtimeDir, '_uploads', tenantId, 'input.txt'), upload);
  putFile(path.join(runtimeDir, 'workspaces', tenantId, 'reports', 'result.md'), artifact);
  putFile(path.join(runtimeDir, 'workspace', '.dsh', 'skills', 'fixture-skill', 'SKILL.md'), skill);
  putFile(path.join(runtimeDir, '_tmp', 'must-not-be-packed.txt'), 'excluded temporary data');
  putFile(path.join(runtimeDir, 'dsh-home', 'unmanaged-secret.txt'), 'not in allowlist');

  await t.test('CLI contract requires explicit offline assertion for a PGlite backup', () => {
    assert.throws(() => cli.parse(['backup', '--backend', 'pglite', '--db-dir', dbDir, '--runtime-dir', runtimeDir, '--output', outputFile]), { code: 'BACKUP_USAGE' });
    assert.equal(cli.parse(['backup', '--backend', 'pglite', '--db-dir', dbDir, '--runtime-dir', runtimeDir, '--output', outputFile, '--offline-confirmed']).action, 'backup');
    const cliArchive = path.join(temp, 'cli.nsbackup');
    const cliTarget = path.join(temp, 'cli-restored');
    const childEnv = { ...process.env, PT_MASTER_KEY_FILE: masterKeyFile };
    for (const key of Object.keys(childEnv)) if (/^PT_PG_/i.test(key)) delete childEnv[key];
    const created = spawnSync(process.execPath, [cliPath, 'backup', '--backend', 'pglite', '--db-dir', dbDir, '--runtime-dir', runtimeDir, '--output', cliArchive, '--offline-confirmed'], { encoding: 'utf8', env: childEnv });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).ok, true);
    const restored = spawnSync(process.execPath, [cliPath, 'restore', '--backend', 'pglite', '--input', cliArchive, '--target-root', cliTarget], { encoding: 'utf8', env: childEnv });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).ok, true);
    assert.deepEqual(fs.readFileSync(path.join(cliTarget, 'runtime', '_uploads', tenantId, 'input.txt')), upload);
  });

  await t.test('PG configuration fails before creating an archive and never echoes its value', () => {
    const syntheticDsn = 'postgres://synthetic-only@127.0.0.1/no-connect';
    assert.throws(() => backup.createBackup({ backend: 'pglite', dbDir, runtimeDir, outputFile, masterKeyFile, env: { PT_PG_DSN: syntheticDsn } }), (error) => {
      assert.equal(error.code, 'BACKUP_POSTGRES_CONFIGURED');
      assert.equal(error.message.includes(syntheticDsn), false);
      return true;
    });
    assert.equal(fs.existsSync(outputFile), false);
    assert.throws(() => backup.restoreBackup({ backend: 'pglite', inputFile: path.join(temp, 'nonexistent.nsbackup'), targetRoot, env: { PT_PG_HOST: 'synthetic-only' } }), { code: 'BACKUP_POSTGRES_CONFIGURED' });
    assert.equal(fs.existsSync(targetRoot), false);
  });

  await t.test('snapshot contains only allowlisted roots and excludes the separate master key', () => {
    const result = backup.createBackup({ backend: 'pglite', dbDir, runtimeDir, outputFile, masterKeyFile, env: {} });
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
    const bytes = fs.readFileSync(outputFile);
    assert.equal(bytes.includes(fs.readFileSync(masterKeyFile)), false);
    assert.equal(bytes.includes(Buffer.from('must-not-be-packed.txt')), false);
    assert.equal(bytes.includes(Buffer.from('unmanaged-secret.txt')), false);
    assert.equal(bytes.includes(Buffer.from('runtime/_uploads/' + tenantId + '/input.txt')), true);
    assert.equal(bytes.includes(Buffer.from('runtime/workspaces/' + tenantId + '/reports/result.md')), true);
    assert.throws(() => backup.createBackup({ backend: 'pglite', dbDir, runtimeDir, outputFile: path.join(temp, 'must-not-include-key.nsbackup'), masterKeyFile: path.join(runtimeDir, 'workspaces', tenantId, 'master.key'), env: {} }), { code: 'BACKUP_MASTER_KEY_IN_SOURCE' });
    assert.throws(() => backup.createBackup({ backend: 'pglite', dbDir, runtimeDir, outputFile, masterKeyFile, env: {} }), { code: 'BACKUP_OUTPUT_EXISTS' });
  });

  await t.test('restore verifies manifest and file hashes, refuses existing destinations, and preserves synthetic data', async () => {
    const existing = path.join(temp, 'existing-target');
    fs.mkdirSync(existing);
    putFile(path.join(existing, 'keep.txt'), 'do not overwrite');
    assert.throws(() => backup.restoreBackup({ backend: 'pglite', inputFile: outputFile, targetRoot: existing, env: {} }), { code: 'BACKUP_TARGET_EXISTS' });
    assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'do not overwrite');

    const restored = backup.restoreBackup({ backend: 'pglite', inputFile: outputFile, targetRoot, env: {} });
    assert.equal(restored.dbDir, path.join(targetRoot, 'db'));
    assert.equal(fs.existsSync(path.join(targetRoot, 'RESTORE-INCOMPLETE')), false);
    assert.deepEqual(fs.readFileSync(path.join(restored.runtimeDir, '_uploads', tenantId, 'input.txt')), upload);
    assert.deepEqual(fs.readFileSync(path.join(restored.runtimeDir, 'workspaces', tenantId, 'reports', 'result.md')), artifact);
    assert.deepEqual(fs.readFileSync(path.join(restored.runtimeDir, 'workspace', '.dsh', 'skills', 'fixture-skill', 'SKILL.md')), skill);
    assert.equal(fs.existsSync(path.join(restored.runtimeDir, '_tmp', 'must-not-be-packed.txt')), false);

    db = new PGlite(restored.dbDir);
    await db.waitReady;
    await dbmod.migrate(db, migrationsDir);
    assert.equal((await db.query('SELECT name FROM tenants WHERE id=$1', [tenantId])).rows[0].name, 'synthetic tenant');
    assert.equal((await db.query('SELECT token_hash FROM sessions WHERE user_id=$1', [userId])).rows.length, 1);
    assert.equal((await db.query('SELECT title FROM conversations WHERE id=$1', [conversationId])).rows[0].title, 'fixture conversation');
    assert.equal((await db.query('SELECT run_id FROM agent_runs WHERE run_id=$1', [runId])).rows.length, 1);
    assert.equal((await db.query('SELECT value FROM user_memory WHERE user_id=$1 AND key=$2', [userId, 'fixture'])).rows[0].value, 'synthetic memory');
    const restoredKeyStore = await keysMod.initKeys({ db, masterKeyFile });
    assert.equal(await restoredKeyStore.decryptApiKey(userId), fixtureApiKey, 'separate synthetic key file decrypts restored BYOK ciphertext');
    await db.close();
  });

  await t.test('manifest tampering and payload corruption are rejected before target creation', () => {
    const original = fs.readFileSync(outputFile);
    const offsets = parseHeader(original);
    const badManifest = Buffer.from(original);
    badManifest[offsets.manifestStart] ^= 1;
    const manifestFile = path.join(temp, 'bad-manifest.nsbackup');
    fs.writeFileSync(manifestFile, badManifest);
    const manifestTarget = path.join(temp, 'manifest-target');
    assert.throws(() => backup.restoreBackup({ backend: 'pglite', inputFile: manifestFile, targetRoot: manifestTarget, env: {} }), { code: 'BACKUP_MANIFEST_HASH_MISMATCH' });
    assert.equal(fs.existsSync(manifestTarget), false);

    const badPayload = Buffer.from(original);
    badPayload[badPayload.length - 1] ^= 1;
    const payloadFile = path.join(temp, 'bad-payload.nsbackup');
    fs.writeFileSync(payloadFile, badPayload);
    const payloadTarget = path.join(temp, 'payload-target');
    assert.throws(() => backup.restoreBackup({ backend: 'pglite', inputFile: payloadFile, targetRoot: payloadTarget, env: {} }), { code: 'BACKUP_FILE_HASH_MISMATCH' });
    assert.equal(fs.existsSync(payloadTarget), false);
  });

  await t.test('valid checksums do not allow a file to masquerade as a parent directory', () => {
    const original = fs.readFileSync(outputFile);
    const offsets = parseHeader(original);
    const manifest = JSON.parse(original.subarray(offsets.manifestStart, offsets.digestStart).toString('utf8'));
    const emptyDigest = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    manifest.entries.push(
      { path: 'db/forged-parent', type: 'file', size: 0, sha256: emptyDigest, mode: 0o600 },
      { path: 'db/forged-parent/child', type: 'file', size: 0, sha256: emptyDigest, mode: 0o600 },
    );
    manifest.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const forgedArchive = path.join(temp, 'valid-checksum-invalid-tree.nsbackup');
    fs.writeFileSync(forgedArchive, rewriteManifest(original, manifest));
    const forgedTarget = path.join(temp, 'forged-tree-target');
    assert.throws(() => backup.restoreBackup({ backend: 'pglite', inputFile: forgedArchive, targetRoot: forgedTarget, env: {} }), { code: 'BACKUP_MANIFEST_INVALID' });
    assert.equal(fs.existsSync(forgedTarget), false);
  });
});
