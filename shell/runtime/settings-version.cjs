"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = (code) => Object.assign(new Error(code), { code });
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const STATE = '.northstar-settings-version.json';
const HASH = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
// Read-only validation: inspect must not create a home, profiles, or metadata.
function homePath(home) {
  if (typeof process.getuid !== 'function') throw fail('SETTINGS_POLICY_UNSUPPORTED');
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw fail('SETTINGS_PATH_UNSAFE');
  const absolute = path.resolve(home);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (!(process.platform === 'darwin' && stat.uid === 0 && ['/tmp', '/var', '/etc'].includes(current) && fs.realpathSync(current) === '/private' + current)) throw fail('SETTINGS_PATH_UNSAFE');
      current = fs.realpathSync(current); stat = fs.lstatSync(current);
    }
    const target = index === parts.length - 1;
    const sticky = !target && stat.uid === 0 && (stat.mode & 0o1000);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid()) || ((stat.mode & 0o022) && !sticky) || (target && stat.uid !== process.getuid())) throw fail('SETTINGS_PATH_UNSAFE');
  }
  return fs.realpathSync(absolute);
}
function readOwned(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw fail('SETTINGS_FILE_UNSAFE');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function readState(home) {
  let raw;
  try { raw = readOwned(path.join(home, STATE)); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  let state;
  try { state = JSON.parse(raw); } catch { throw fail('SETTINGS_BASELINE_INVALID'); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).sort().join(',') !== 'adoptedAt,schema,settingsHash,templateHash' || state.schema !== 1 || !isHash(state.settingsHash) || !isHash(state.templateHash) || typeof state.adoptedAt !== 'string' || (!Number.isFinite(Date.parse(state.adoptedAt)) || new Date(state.adoptedAt).toISOString() !== state.adoptedAt)) throw fail('SETTINGS_BASELINE_INVALID');
  return { state, hash: digest(raw) };
}
function snapshot(home, template) {
  const root = homePath(home);
  try { fs.lstatSync(path.join(root, '.northstar-settings-upgrade-journal.json')); throw fail('SETTINGS_RECOVERY_REQUIRED'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  // Template is a release input. No content is returned or logged.
  const templateHash = digest(fs.readFileSync(template));
  const settingsHash = digest(readOwned(path.join(root, 'settings.yaml')));
  const baseline = readState(root);
  return { root, settingsHash, templateHash, baseline };
}
function inspectSettings({ home, template }) {
  const value = snapshot(home, template);
  const baseline = value.baseline;
  return {
    status: !baseline ? 'untracked' : baseline.state.templateHash !== value.templateHash ? 'template-drift' : baseline.state.settingsHash !== value.settingsHash ? 'operator-edited' : 'current',
    settingsHash: value.settingsHash, templateHash: value.templateHash,
    baselineHash: baseline ? baseline.hash : null,
    ...(baseline ? { baseline: baseline.state } : {}),
  };
}
// This acknowledges a human-reviewed configuration; it does not migrate YAML.
// All three expected hashes must come from inspect, including null baselineHash.
function adoptSettings({ home, template, expected, reviewed = false }) {
  if (reviewed !== true || !expected || !isHash(expected.settingsHash) || !isHash(expected.templateHash) || !(expected.baselineHash === null || isHash(expected.baselineHash))) throw fail('SETTINGS_REVIEW_REQUIRED');
  const root = homePath(home);
  const lock = path.join(root, '.northstar-settings-version.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (cause) { if (cause.code === 'EEXIST') throw fail('SETTINGS_LOCKED'); throw cause; }
  let temporary;
  try {
    const current = inspectSettings({ home: root, template });
    for (const key of ['settingsHash', 'templateHash', 'baselineHash']) if (current[key] !== expected[key]) throw fail('SETTINGS_REVISION_CONFLICT');
    const destination = path.join(root, STATE);
    const next = { schema: 1, settingsHash: current.settingsHash, templateHash: current.templateHash, adoptedAt: new Date().toISOString() };
    temporary = path.join(root, '.northstar-settings-version-' + crypto.randomBytes(16).toString('hex'));
    fs.writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
    // Preserve the exact former baseline before publication, including on failure.
    if (current.baselineHash) {
      const backup = path.join(root, '.northstar-settings-version-backup-' + crypto.randomBytes(16).toString('hex') + '.json');
      fs.linkSync(destination, backup);
    }
    const checked = inspectSettings({ home: root, template });
    for (const key of ['settingsHash', 'templateHash', 'baselineHash']) if (checked[key] !== expected[key]) throw fail('SETTINGS_REVISION_CONFLICT');
    if (current.baselineHash) fs.renameSync(temporary, destination);
    else fs.linkSync(temporary, destination);
    return inspectSettings({ home: root, template });
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(lockFd); fs.unlinkSync(lock);
  }
}
module.exports = { inspectSettings, adoptSettings, settingsIO: { homePath, readOwned, digest, isHash } };
