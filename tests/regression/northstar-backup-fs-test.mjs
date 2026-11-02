import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pinDirectory, listNames } = require('../../shell/runtime/backup-fs.cjs');

test('dirfd primitives stay anchored after the pinned directory is renamed and replaced', (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('backup-fs supports Linux and Darwin only');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-backup-fs-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const original = path.join(temp, 'root');
  const moved = path.join(temp, 'root-moved');
  fs.mkdirSync(original, { mode: 0o700 });
  fs.writeFileSync(path.join(original, 'source.tmp'), 'payload', { mode: 0o600 });

  let replaced = false;
  const pinned = pinDirectory(original, {
    onDirectoryPinned({ component }) {
      if (component !== 'root' || replaced) return;
      fs.renameSync(original, moved);
      fs.mkdirSync(original, { mode: 0o700 });
      fs.writeFileSync(path.join(original, 'replacement-marker'), 'replacement');
      replaced = true;
    },
  });
  try {
    assert.equal(replaced, true);
    pinned.mkdir('created-via-dirfd');
    const sourceFd = pinned.openFile('source.tmp');
    try {
      const bytes = Buffer.alloc(7);
      assert.equal(fs.readSync(sourceFd, bytes, 0, bytes.length, 0), 7);
      assert.equal(bytes.toString(), 'payload');
    } finally { fs.closeSync(sourceFd); }
    assert.equal(fs.existsSync(path.join(moved, 'created-via-dirfd')), true);
    assert.equal(fs.existsSync(path.join(original, 'created-via-dirfd')), false);
    pinned.chmodDirectory('created-via-dirfd', 0o500);
    assert.equal(fs.statSync(path.join(moved, 'created-via-dirfd')).mode & 0o777, 0o500);
    pinned.chmodDirectory('created-via-dirfd', 0o700);

    const createdFd = pinned.openFile('archive.part', { createExclusive: true, writeOnly: true, mode: 0o600 });
    try { fs.writeSync(createdFd, 'archive'); } finally { fs.closeSync(createdFd); }
    pinned.linkFile('archive.part', pinned, 'archive.final');
    pinned.chmodFile('archive.final', 0o640);
    assert.equal(fs.statSync(path.join(moved, 'archive.final')).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(path.join(moved, 'archive.final'), 'utf8'), 'archive');
    pinned.unlinkFile('archive.part');
    assert.equal(fs.existsSync(path.join(moved, 'archive.part')), false);
    assert.equal(fs.existsSync(path.join(original, 'archive.final')), false);
  } finally { pinned.close(); }
});

test('dirfd helper rejects traversal and symlink components', (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('backup-fs supports Linux and Darwin only');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-backup-fs-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const real = path.join(temp, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(temp, 'link'));
  fs.writeFileSync(path.join(real, 'target'), 'safe');
  fs.symlinkSync(path.join(real, 'target'), path.join(real, 'leaf-link'));
  assert.throws(() => pinDirectory(path.join(temp, 'link')), { code: 'BACKUP_FS_OPEN_FAILED' });
  const pinned = pinDirectory(real);
  try {
    assert.throws(() => pinned.openFile('../escape'), { code: 'BACKUP_FS_COMPONENT_INVALID' });
    assert.throws(() => pinned.openFile('leaf-link'), { code: 'BACKUP_FS_OPEN_FAILED' });
  } finally { pinned.close(); }
});

test('fdopendir enumeration remains on the pinned inode during rename and replacement', (t) => {
  if (process.platform !== 'darwin') return t.skip('fdopendir ABI is enabled only for the verified Darwin 64-bit layout');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-backup-enum-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  const moved = path.join(temp, 'root-moved');
  fs.mkdirSync(root);
  for (const name of ['alpha', 'bravo', 'charlie']) fs.writeFileSync(path.join(root, name), name);
  const pinned = pinDirectory(root);
  let swapped = false;
  try {
    const names = listNames(pinned, {
      onEntryRead() {
        if (swapped) return;
        fs.renameSync(root, moved);
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, 'replacement-only'), 'new inode');
        swapped = true;
      },
    });
    assert.equal(swapped, true);
    assert.deepEqual(new Set(names), new Set(['alpha', 'bravo', 'charlie']));
    assert.equal(names.includes('replacement-only'), false);
    assert.deepEqual(new Set(listNames(pinned)), new Set(['alpha', 'bravo', 'charlie']));
  } finally { pinned.close(); }
});

test('Linux directory enumeration remains fail-closed until its ABI is locally verified', (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-only ABI boundary');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-backup-enum-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const pinned = pinDirectory(temp);
  try { assert.throws(() => listNames(pinned), { code: 'BACKUP_FS_ENUMERATION_UNSUPPORTED' }); }
  finally { pinned.close(); }
});
