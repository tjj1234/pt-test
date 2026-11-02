'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareProfilePaths, seedSettings } = require('./profile-paths.cjs');
const NAME = 'run-persistent';
const MANIFEST = 'northstar-profile-manifest.json';
const fail = (code, message) => Object.assign(new Error(message), { code });
function exists(p) { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function regular(p, directory = false) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile()) || (typeof process.getuid === 'function' && s.uid !== process.getuid()) || (s.mode & 0o022) !== 0) throw fail('PROFILE_TARGET_UNSAFE', 'Profile entry is not a regular managed entry');
}
function validateManifest(m) {
  if (!m || m.formatVersion !== 1 || m.rpcProtocolVersion !== 1 || !m.files || Array.isArray(m.files) || typeof m.files !== 'object' || !Object.keys(m.files).length) throw fail('PROFILE_MANIFEST_INVALID', 'Invalid profile manifest');
  for (const [name, hash] of Object.entries(m.files)) {
    if (name === MANIFEST || name === '.' || name === '..' || /[/\\\0]/.test(name) || !/^[a-f0-9]{64}$/.test(hash)) throw fail('PROFILE_MANIFEST_INVALID', 'Invalid manifest file entry');
  }
  return m;
}
const canonical = m => JSON.stringify([m.formatVersion, m.rpcProtocolVersion, Object.entries(m.files).sort(([a], [b]) => a.localeCompare(b))]);
function verify(dir, expected) {
  regular(dir, true);
  const mf = path.join(dir, MANIFEST);
  if (!exists(mf)) throw fail('PROFILE_MANIFEST_MISSING', 'Profile has no manifest');
  regular(mf);
  let current;
  try { current = validateManifest(JSON.parse(fs.readFileSync(mf, 'utf8'))); }
  catch (e) { if (e.code === 'PROFILE_MANIFEST_INVALID') throw e; throw fail('PROFILE_MANIFEST_INVALID', 'Cannot read profile manifest'); }
  for (const [name, hash] of Object.entries(current.files)) {
    const p = path.join(dir, name);
    if (!exists(p)) throw fail('PROFILE_FILE_MISSING', 'Managed profile file is missing');
    regular(p);
    if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== hash) throw fail('PROFILE_FILE_MISMATCH', 'Managed profile file differs from manifest');
  }
  if (expected && canonical(current) !== canonical(expected)) throw fail('PROFILE_STALE', 'Profile requires explicit rebuild');
  return current;
}
function manageProfile({ dshHome, settingsTemplate, files, manifest, mode = 'ensure', recovery }) {
  if (!['ensure', 'rebuild', 'recover'].includes(mode)) throw fail('PROFILE_MODE_INVALID', 'Unknown profile lifecycle mode');
  const { home, profilesDir } = prepareProfilePaths(dshHome);
  const dir = path.join(profilesDir, NAME);
  const lock = path.join(profilesDir, `.${NAME}.northstar-lock`);
  const ownerFile = path.join(lock, 'owner.json');
  const journalFile = path.join(profilesDir, `.${NAME}.northstar-journal.json`);
  if (mode === 'recover' && exists(lock) && recovery?.lockToken) {
    regular(lock, true); regular(ownerFile);
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (owner.token !== recovery.lockToken || !Number.isInteger(owner.pid) || owner.pid <= 0) throw fail('PROFILE_RECOVERY_INVALID', 'Lock owner does not match explicit recovery');
    try { process.kill(owner.pid, 0); throw fail('PROFILE_BUSY', 'Lock owner is still alive'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.unlinkSync(ownerFile); fs.rmdirSync(lock);
  }
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw fail('PROFILE_BUSY', 'Profile lifecycle lock exists; explicit recovery is required'); throw e; }
  const token = crypto.randomBytes(16).toString('hex');
  let owned = false;
  try {
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); owned = true;
    if (exists(journalFile)) {
      if (mode !== 'recover') throw fail('PROFILE_RECOVERY_REQUIRED', 'Interrupted profile transaction requires explicit recovery');
      if (!['restore-backup', 'keep-current'].includes(recovery?.action)) throw fail('PROFILE_RECOVERY_INVALID', 'Explicit restore-backup action is required');
      regular(journalFile);
      let journal;
      try { journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')); } catch { throw fail('PROFILE_RECOVERY_INVALID', 'Invalid recovery journal'); }
      if (!journal || journal.version !== 1 || typeof journal.backup !== 'string' || !journal.backup.startsWith(`.${NAME}.northstar-backup-`) || path.basename(journal.backup) !== journal.backup) throw fail('PROFILE_RECOVERY_INVALID', 'Invalid backup path');
      const backupDir = path.join(profilesDir, journal.backup);
      validateManifest(journal.oldManifest);
      if (typeof journal.staging !== 'string' || !journal.staging.startsWith(`.${NAME}.northstar-staging-`) || path.basename(journal.staging) !== journal.staging) throw fail('PROFILE_RECOVERY_INVALID', 'Invalid staging path');
      if (recovery.action === 'keep-current') {
        if (exists(backupDir)) throw fail('PROFILE_RECOVERY_INVALID', 'Backup exists; use explicit restore-backup recovery');
        verify(dir, journal.oldManifest); fs.unlinkSync(journalFile);
        return { name: NAME, dir, recovered: true };
      }
      verify(backupDir, journal.oldManifest);
      let preservedDir;
      if (exists(dir)) {
        if (recovery.preserveCurrent !== true) throw fail('PROFILE_RECOVERY_INVALID', 'Existing target requires explicit preserveCurrent authorization');
        regular(dir, true); preservedDir = unique(profilesDir, 'preserved'); fs.renameSync(dir, preservedDir); }
      try { fs.renameSync(backupDir, dir); }
      catch (e) { if (preservedDir && !exists(dir)) fs.renameSync(preservedDir, dir); throw e; }
      verify(dir); fs.unlinkSync(journalFile);
      return { name: NAME, dir, preservedDir, recovered: true };
    }
    if (mode === 'recover') throw fail('PROFILE_RECOVERY_INVALID', 'No interrupted transaction to recover');
    validateManifest(manifest);
    if (!files || Object.keys(files).sort().join('\0') !== Object.keys(manifest.files).sort().join('\0')) throw fail('PROFILE_MANIFEST_INVALID', 'Source files and manifest differ');
    if (exists(dir)) { verify(dir, mode === 'ensure' ? manifest : undefined); if (mode === 'ensure') { seedSettings(home, settingsTemplate); return { name: NAME, dir }; } }
    else if (mode === 'rebuild') throw fail('PROFILE_MANIFEST_MISSING', 'Rebuild requires an existing managed profile');
    const staging = fs.mkdtempSync(path.join(profilesDir, `.${NAME}.northstar-staging-`));
    fs.chmodSync(staging, 0o700);
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(staging, name), content, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(staging, MANIFEST), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    verify(staging, manifest);
    seedSettings(home, settingsTemplate);
    if (mode === 'ensure') {
      if (exists(dir)) throw fail('PROFILE_TARGET_RACE', 'Profile target appeared during generation');
      fs.renameSync(staging, dir); verify(dir, manifest); return { name: NAME, dir };
    }
    const oldManifest = verify(dir);
    const backupDir = unique(profilesDir, 'backup');
    fs.writeFileSync(journalFile, JSON.stringify({ version: 1, backup: path.basename(backupDir), staging: path.basename(staging), oldManifest }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(dir, backupDir);
    try {
      if (exists(dir)) throw fail('PROFILE_TARGET_RACE', 'Profile target appeared during rebuild');
      fs.renameSync(staging, dir); verify(dir, manifest);
    } catch (e) {
      // Preserve even partially published data; never recursively delete user content.
      try {
        if (exists(dir)) fs.renameSync(dir, unique(profilesDir, 'preserved'));
        fs.renameSync(backupDir, dir); fs.unlinkSync(journalFile);
      } catch { throw fail('PROFILE_RECOVERY_REQUIRED', 'Profile switch rollback failed; explicit recovery is required'); }
      throw e;
    }
    fs.unlinkSync(journalFile);
    return { name: NAME, dir, backupDir };
  } finally {
    if (owned) {
      try { regular(lock, true); regular(ownerFile); const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); if (owner.token === token && owner.pid === process.pid) { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); } } catch { /* Unknown lock entries remain fail-closed. */ }
    } else { try { fs.rmdirSync(lock); } catch {} }
  }
}
function unique(parent, kind) { return path.join(parent, `.${NAME}.northstar-${kind}-${crypto.randomBytes(16).toString('hex')}`); }
module.exports = { manageProfile };
