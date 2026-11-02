#!/usr/bin/env node
'use strict';
// Read-only shape counts. No application imports and no raw cache values leave this process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_FILES = 64, MAX_BYTES = 4 * 1024 * 1024;
const TASKS = ['textChat','imageUnderstanding','audioUnderstanding','videoUnderstanding','textToImage','imageToImage','textToVideo','imageToVideo','speechToText','textToSpeech','embedding','rerank','toolCalling'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = () => ({ missing: 0, null: 0, invalidWrapper: 0, valueMissing: 0, valueWrongType: 0 });
function wrapper(parent, key, counts) {
  if (!object(parent) || !Object.hasOwn(parent, key)) { counts.missing++; return null; }
  const value = parent[key];
  if (value === null) { counts.null++; return null; }
  if (!object(value)) { counts.invalidWrapper++; return null; }
  return value;
}
function fact(parent, key, counts, valid) {
  const value = wrapper(parent, key, counts);
  if (!value) return;
  if (!Object.hasOwn(value, 'value')) counts.valueMissing++;
  else if (value.value !== null && !valid(value.value)) counts.valueWrongType++;
}
function shapes(records) {
  const fields = Object.fromEntries(['ptEndpointTasks','endpoints','inputModalities','outputModalities','tasks','adaptations','verifications','localPolicy'].map(key => [key, counter()]));
  fields.tasks.facts = Object.fromEntries(TASKS.map(task => [task, counter()]));
  for (const model of records) {
    for (const key of ['ptEndpointTasks','endpoints','inputModalities','outputModalities']) fact(model, key, fields[key], value => Array.isArray(value) && value.every(item => typeof item === 'string'));
    const tasks = wrapper(model, 'tasks', fields.tasks);
    for (const task of TASKS) fact(tasks, task, fields.tasks.facts[task], value => typeof value === 'boolean');
    for (const key of ['adaptations','verifications']) wrapper(model, key, fields[key]);
    const policy = wrapper(model, 'localPolicy', fields.localPolicy);
    if (policy && (typeof policy.enabled !== 'boolean' || typeof policy.source !== 'string' || !policy.source.trim() || typeof policy.version !== 'string' || !policy.version.trim())) fields.localPolicy.valueWrongType++;
  }
  return fields;
}
function scan(cacheDir) {
  const result = { limits: { maxFiles: MAX_FILES, maxBytesPerFile: MAX_BYTES }, counts: { matching: 0, scanned: 0, symlink: 0, nonRegular: 0, oversized: 0, parseError: 0, readError: 0, envelopeValid: 0, envelopeInvalid: 0, limitReached: false }, files: [] };
  const directory = fs.opendirSync(cacheDir);
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (!/^model-catalog-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      result.counts.matching++;
      if (result.counts.matching > MAX_FILES) { result.counts.limitReached = true; break; }
      const row = { number: result.counts.matching };
      const filename = path.join(cacheDir, entry.name);
      let fd;
      try {
        const before = fs.lstatSync(filename);
        if (before.isSymbolicLink()) { result.counts.symlink++; continue; }
        if (!before.isFile()) { result.counts.nonRegular++; continue; }
        if (before.size > MAX_BYTES) { result.counts.oversized++; continue; }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) { result.counts.readError++; continue; }
        if (stat.size > MAX_BYTES) { result.counts.oversized++; continue; }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) { const read = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!read) break; length += read; }
        if (length > MAX_BYTES) { result.counts.oversized++; continue; }
        const bytes = buffer.subarray(0, length);
        Object.assign(row, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: length, mtime: stat.mtime.toISOString() });
        result.counts.scanned++;
        let envelope;
        try { envelope = JSON.parse(bytes.toString('utf8')); } catch { result.counts.parseError++; result.files.push(row); continue; }
        const valid = envelope?.schemaVersion === 1 && typeof envelope.scopeId === 'string' && envelope.scopeId.length > 0 && object(envelope.snapshot) && envelope.snapshot.scopeId === envelope.scopeId && Array.isArray(envelope.snapshot.models);
        row.envelopeValid = valid;
        result.counts[valid ? 'envelopeValid' : 'envelopeInvalid']++;
        if (valid) { row.records = envelope.snapshot.models.length; row.fields = shapes(envelope.snapshot.models); }
        result.files.push(row);
      } catch { result.counts.readError++; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } finally { directory.closeSync(); }
  return result;
}
function main(args) {
  if (args.length !== 2 || args[0] !== '--cache-dir' || !path.isAbsolute(args[1])) throw new Error('INVALID_ARGUMENTS');
  return scan(args[1]);
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch { process.stderr.write('{"error":"PROBE_FAILED"}\n'); process.exitCode = 1; }
}
module.exports = { scan, MAX_FILES, MAX_BYTES };
