'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const capabilities = require('./capabilities.cjs');
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tri = (value) => value === null || typeof value === 'boolean';
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableDate = (value) => value == null || date(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fact(value, accepts) {
  if (!record(value) || !Object.hasOwn(value, 'value') || !Object.hasOwn(value, 'source')) return false;
  if (value.source !== null && (!record(value.source) || !text(value.source.kind))) return false;
  return (value.value === null || (value.source !== null && accepts(value.value)));
}

/** Only normalized capability records may enter merge/eligibility. Display caches
 * are not a migration source for permission, adaptations or runtime verification. */
function validModel(model, scopeId) {
  if (!record(model) || !text(model.id) || model.scopeId !== scopeId ||
      !['present', 'removed'].includes(model.availability) || !tri(model.permission) ||
      !/^[a-f0-9]{64}$/.test(model.capabilityRevision || '') || !date(model.observedAt) ||
      !nullableDate(model.verificationNotBefore) || !record(model.tasks)) return false;
  if (!capabilities.TASKS.every((task) => fact(model.tasks[task], (v) => typeof v === 'boolean'))) return false;
  for (const key of ['inputModalities', 'outputModalities']) {
    if (!fact(model[key], (v) => strings(v) && v.every((item) => capabilities.MODALITIES.includes(item)))) return false;
  }
  if (!fact(model.endpoints, strings) || !fact(model.ptEndpointTasks, (v) => strings(v) && v.every((item) => capabilities.TASKS.includes(item)))) return false;
  for (const key of ['owner', 'provider', 'protocol']) if (!fact(model[key], (v) => typeof v === 'string')) return false;
  if (!record(model.features) || !['streaming', 'structuredOutput', 'toolCalling'].every((key) => fact(model.features[key], (v) => typeof v === 'boolean'))) return false;
  if (!record(model.limits) || !['contextWindow', 'maxOutputTokens', 'maxFileBytes', 'maxAudioSeconds', 'maxVideoSeconds', 'maxImages'].every((key) => fact(model.limits[key], (v) => Number.isSafeInteger(v) && v > 0))) return false;
  if (model.localPolicy !== null && (!record(model.localPolicy) || typeof model.localPolicy.enabled !== 'boolean' || !text(model.localPolicy.source) || !text(model.localPolicy.version))) return false;
  for (const key of ['adaptations', 'verifications']) {
    if (!record(model[key]) || !Object.entries(model[key]).every(([task, value]) => capabilities.TASKS.includes(task) && record(value))) return false;
  }
  if (model.manualOverride !== null && (!record(model.manualOverride) || model.manualOverride.id !== model.id || !text(model.manualOverride.source) || !text(model.manualOverride.version) || !record(model.manualOverride.tasks) || !Object.entries(model.manualOverride.tasks).every(([task, value]) => capabilities.TASKS.includes(task) && tri(value)))) return false;
  if (model.routeHistory != null && !Array.isArray(model.routeHistory)) return false;
  return true;
}

function validSnapshot(snapshot, scopeId) {
  return record(snapshot) && snapshot.scopeId === scopeId && Array.isArray(snapshot.models) &&
    nullableDate(snapshot.lastSuccessfulAt) && nullableDate(snapshot.lastCompleteAt) && nullableDate(snapshot.nextSyncAt) &&
    (snapshot.syncFailureCount == null || (Number.isSafeInteger(snapshot.syncFailureCount) && snapshot.syncFailureCount >= 0)) &&
    new Set(snapshot.models.map((m) => m?.id)).size === snapshot.models.length &&
    snapshot.models.every((model) => validModel(model, scopeId));
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }

function readRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_BYTES) throw new Error('unsafe cache file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!sameFile(stat, fs.fstatSync(fd))) throw new Error('cache changed');
    const bytes = fs.readFileSync(fd);
    if (!sameFile(stat, fs.fstatSync(fd)) || !sameFile(stat, fs.lstatSync(file))) throw new Error('cache changed');
    return { bytes, stat, sha256: digest(bytes) };
  } finally { fs.closeSync(fd); }
}

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : ''; }
function hash(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }

/** Stable, non-secret cache scope. The credential itself is never written to disk. */
function resolveScopeId({ apiKey, baseURL, scopeId } = {}) {
  const key = text(apiKey);
  if (!key) return null;
  const base = text(baseURL).replace(/\/+$/, '');
  const explicit = text(scopeId);
  return 'pt-scope-' + hash(JSON.stringify([base, explicit, hash(key)]));
}

function cacheFile(root, scopeId) {
  if (!text(scopeId)) throw new TypeError('scopeId required');
  return path.join(root, 'model-catalog-' + hash(scopeId) + '.json');
}

function inspectScopedCache(root, scopeId) {
  let input;
  try {
    input = readRegularFile(cacheFile(root, scopeId));
  } catch (error) {
    // A dangling symlink is an unreadable cache, never an absent cache.
    if (error?.code === 'ENOENT') {
      try { fs.lstatSync(cacheFile(root, scopeId)); } catch (again) {
        if (again?.code === 'ENOENT') return { status: 'missing', snapshot: null };
      }
    }
    return { status: 'read_error', snapshot: null };
  }
  try {
    const value = JSON.parse(input.bytes.toString('utf8'));
    if (value?.schemaVersion !== 1 || value.scopeId !== scopeId || !validSnapshot(value.snapshot, scopeId)) return { ...input, status: 'invalid', snapshot: null };
    // Never trust cached derived eligibility flags. Recompute from the validated
    // source facts and revision-bound local evidence without changing timestamps.
    const snapshot = capabilities.mergeSnapshot(value.snapshot, { scopeId, observedAt: value.snapshot.lastSuccessfulAt || new Date(0).toISOString(), success: false });
    snapshot.events = value.snapshot.events;
    return { ...input, status: 'valid', snapshot };
  } catch { return { ...input, status: 'invalid', snapshot: null }; }
}

function readScopedCache(root, scopeId) { return inspectScopedCache(root, scopeId).snapshot; }

/** Keep the exact invalid bytes before replacement. No contents or path are
 * returned to catalog diagnostics; existing backup files must also verify. */
function backupInvalidCache(root, scopeId, inspected) {
  if (inspected?.status !== 'invalid') return false;
  const file = cacheFile(root, scopeId);
  const backup = file + '.invalid-' + inspected.sha256 + '.bak';
  try {
    const current = readRegularFile(file);
    if (!sameFile(current.stat, inspected.stat) || current.sha256 !== inspected.sha256) return false;
    let fd;
    try {
      fd = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, inspected.bytes);
      fs.fsyncSync(fd);
    } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    const saved = readRegularFile(backup);
    return saved.sha256 === inspected.sha256 && (saved.stat.mode & 0o777) === 0o600;
  } catch { return false; }
}

function writeScopedCache(root, scopeId, snapshot) {
  if (!text(scopeId) || !validSnapshot(snapshot, scopeId)) return false;
  const file = cacheFile(root, scopeId);
  const temporary = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  try {
    fs.mkdirSync(root, { recursive: true });
    const prior = inspectScopedCache(root, scopeId);
    if (prior.status === 'read_error' || (prior.status === 'invalid' && !backupInvalidCache(root, scopeId, prior))) return false;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, scopeId, snapshot }), { mode: 0o600, flag: 'wx' });
    const current = inspectScopedCache(root, scopeId);
    if (current.status !== prior.status || (prior.stat && (!current.stat || !sameFile(current.stat, prior.stat) || current.sha256 !== prior.sha256))) throw new Error('cache changed');
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
    return false;
  }
}

module.exports = { resolveScopeId, cacheFile, readScopedCache, inspectScopedCache, backupInvalidCache, writeScopedCache };
