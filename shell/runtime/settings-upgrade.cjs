"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectSettings, settingsIO: { homePath, readOwned, digest, isHash } } = require('./settings-version.cjs');
const fail = code => Object.assign(new Error(code), { code });
const STATE = '.northstar-settings-version.json';
const JOURNAL = '.northstar-settings-upgrade-journal.json';
const LOCK = '.northstar-settings-version.lock';
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const random = () => crypto.randomBytes(16).toString('hex');
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function parse(bytes) { try { return JSON.parse(bytes); } catch { throw fail('SETTINGS_UPGRADE_INVALID'); } }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(','); }
function locked(root, staleLockToken, work) {
  const filename = path.join(root, LOCK);
  if (exists(filename) && staleLockToken) {
    const owner = parse(readOwned(filename));
    if (!exact(owner, ['pid', 'token']) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token) || owner.token !== staleLockToken) throw fail('SETTINGS_LOCKED');
    try { process.kill(owner.pid, 0); throw fail('SETTINGS_LOCKED'); }
    catch (error) { if (error.code !== 'ESRCH') throw fail('SETTINGS_LOCKED'); }
    fs.unlinkSync(filename);
  }
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('SETTINGS_LOCKED'); throw error; }
  try { fs.writeFileSync(fd, json({ pid: process.pid, token: random() })); return work(); }
  finally { fs.closeSync(fd); fs.unlinkSync(filename); }
}
function assertExpected(current, expected) {
  for (const key of ['settingsHash', 'templateHash', 'baselineHash']) if (!expected || !isHash(expected[key])) throw fail('SETTINGS_REVIEW_REQUIRED');
  for (const key of ['settingsHash', 'templateHash', 'baselineHash']) if (current[key] !== expected[key]) throw fail('SETTINGS_REVISION_CONFLICT');
}
function writeNew(filename, bytes) { fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 }); }
function publishCopy(source, destination, transaction) {
  const temporary = path.join(transaction, 'publish-' + random());
  try { writeNew(temporary, readOwned(source)); fs.renameSync(temporary, destination); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function readJournal(root) {
  const journalPath = path.join(root, JOURNAL);
  const journalRaw = readOwned(journalPath);
  const journal = parse(journalRaw);
  if (!exact(journal, ['schema', 'transaction', 'manifestHash']) || journal.schema !== 1 || typeof journal.transaction !== 'string' || !/^\.northstar-settings-upgrade-[a-f0-9]{32}$/.test(journal.transaction) || !isHash(journal.manifestHash)) throw fail('SETTINGS_UPGRADE_INVALID');
  const transaction = homePath(path.join(root, journal.transaction));
  const raw = readOwned(path.join(transaction, 'manifest.json'));
  if (digest(raw) !== journal.manifestHash) throw fail('SETTINGS_UPGRADE_INVALID');
  const manifest = parse(raw);
  if (!exact(manifest, ['schema', 'oldSettingsHash', 'oldBaselineHash', 'newSettingsHash', 'newBaselineHash']) || manifest.schema !== 1) throw fail('SETTINGS_UPGRADE_INVALID');
  for (const key of ['oldSettingsHash', 'oldBaselineHash', 'newSettingsHash', 'newBaselineHash']) if (!isHash(manifest[key])) throw fail('SETTINGS_UPGRADE_INVALID');
  for (const [name, key] of [['old-settings.yaml', 'oldSettingsHash'], ['old-baseline.json', 'oldBaselineHash'], ['new-settings.yaml', 'newSettingsHash'], ['new-baseline.json', 'newBaselineHash']]) {
    if (digest(readOwned(path.join(transaction, name))) !== manifest[key]) throw fail('SETTINGS_UPGRADE_INVALID');
  }
  return { transaction, manifest, journalHash: digest(journalRaw) };
}
function assertKnownCurrent(root, manifest) {
  for (const [filename, oldKey, newKey] of [['settings.yaml', 'oldSettingsHash', 'newSettingsHash'], [STATE, 'oldBaselineHash', 'newBaselineHash']]) {
    const hash = digest(readOwned(path.join(root, filename)));
    if (![manifest[oldKey], manifest[newKey]].includes(hash)) throw fail('SETTINGS_RECOVERY_CONFLICT');
  }
}
// reviewed/offline are explicit caller attestations, not process detection.
// Never merges YAML: edited configurations require manual merge + adopt instead.
function upgradeSettings({ home, template, expected, reviewed = false, offline = false }) {
  if (reviewed !== true || offline !== true) throw fail('SETTINGS_REVIEW_REQUIRED');
  const root = homePath(home);
  return locked(root, null, () => {
    const current = inspectSettings({ home: root, template });
    assertExpected(current, expected);
    if (!current.baseline) throw fail('SETTINGS_BASELINE_REQUIRED');
    if (current.settingsHash !== current.baseline.settingsHash || current.baseline.settingsHash !== current.baseline.templateHash) throw fail('SETTINGS_OPERATOR_EDITS');
    if (current.templateHash === current.baseline.templateHash) throw fail('SETTINGS_UPGRADE_NOT_REQUIRED');
    const nextSettings = fs.readFileSync(template);
    if (digest(nextSettings) !== current.templateHash) throw fail('SETTINGS_REVISION_CONFLICT');
    const transactionName = '.northstar-settings-upgrade-' + random();
    const transaction = path.join(root, transactionName);
    fs.mkdirSync(transaction, { mode: 0o700 });
    // Copies preserve old bytes independently of subsequent in-place writes.
    writeNew(path.join(transaction, 'old-settings.yaml'), readOwned(path.join(root, 'settings.yaml')));
    writeNew(path.join(transaction, 'old-baseline.json'), readOwned(path.join(root, STATE)));
    writeNew(path.join(transaction, 'new-settings.yaml'), nextSettings);
    const nextBaseline = json({ schema: 1, settingsHash: current.templateHash, templateHash: current.templateHash, adoptedAt: new Date().toISOString() });
    writeNew(path.join(transaction, 'new-baseline.json'), nextBaseline);
    const manifest = { schema: 1, oldSettingsHash: current.settingsHash, oldBaselineHash: current.baselineHash, newSettingsHash: current.templateHash, newBaselineHash: digest(nextBaseline) };
    const manifestBytes = json(manifest);
    writeNew(path.join(transaction, 'manifest.json'), manifestBytes);
    assertExpected(inspectSettings({ home: root, template }), expected);
    // Verify staged files before journal publication; pending journal blocks adopt/inspect.
    const journalBytes = json({ schema: 1, transaction: transactionName, manifestHash: digest(manifestBytes) });
    const stagedJournal = path.join(transaction, 'journal.json'); writeNew(stagedJournal, journalBytes);
    const journalPath = path.join(root, JOURNAL);
    fs.linkSync(stagedJournal, journalPath);
    try {
      const verified = readJournal(root); assertKnownCurrent(root, verified.manifest);
      publishCopy(path.join(transaction, 'new-settings.yaml'), path.join(root, 'settings.yaml'), transaction);
      publishCopy(path.join(transaction, 'new-baseline.json'), path.join(root, STATE), transaction);
      if (digest(readOwned(path.join(root, 'settings.yaml'))) !== manifest.newSettingsHash || digest(readOwned(path.join(root, STATE))) !== manifest.newBaselineHash) throw fail('SETTINGS_RECOVERY_CONFLICT');
      // No deletion: completed journal and old pair remain as reviewable evidence.
      fs.renameSync(journalPath, path.join(transaction, 'completed-journal.json'));
    } catch { throw fail('SETTINGS_RECOVERY_REQUIRED'); }
    return { ...inspectSettings({ home: root, template }), status: 'upgraded', transaction: transactionName };
  });
}
// Rollback only: validates all evidence and refuses any unknown current bytes.
// A partially completed rollback can be retried because old/new states are valid.
function recoverSettings({ home, expectedJournalHash, reviewed = false, offline = false, staleLockToken }) {
  if (reviewed !== true || offline !== true) throw fail('SETTINGS_REVIEW_REQUIRED');
  const root = homePath(home);
  return locked(root, staleLockToken, () => {
    const { transaction, manifest, journalHash } = readJournal(root);
    if (!isHash(expectedJournalHash) || expectedJournalHash !== journalHash) throw fail('SETTINGS_REVISION_CONFLICT');
    assertKnownCurrent(root, manifest);
    try {
      publishCopy(path.join(transaction, 'old-settings.yaml'), path.join(root, 'settings.yaml'), transaction);
      publishCopy(path.join(transaction, 'old-baseline.json'), path.join(root, STATE), transaction);
      if (digest(readOwned(path.join(root, 'settings.yaml'))) !== manifest.oldSettingsHash || digest(readOwned(path.join(root, STATE))) !== manifest.oldBaselineHash) throw fail('SETTINGS_RECOVERY_CONFLICT');
      fs.renameSync(path.join(root, JOURNAL), path.join(transaction, 'rolled-back-journal.json'));
    } catch { throw fail('SETTINGS_RECOVERY_REQUIRED'); }
    return { status: 'rolled-back', transaction: path.basename(transaction), settingsHash: manifest.oldSettingsHash, baselineHash: manifest.oldBaselineHash };
  });
}
function inspectSettingsRecovery({ home }) {
  const root = homePath(home);
  const { transaction, manifest, journalHash } = readJournal(root);
  assertKnownCurrent(root, manifest);
  return { status: 'recovery-required', transaction: path.basename(transaction), journalHash, ...manifest };
}
module.exports = { upgradeSettings, recoverSettings, inspectSettingsRecovery };
