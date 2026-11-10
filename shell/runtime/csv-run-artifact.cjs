'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { pinDirectory } = require('./backup-fs.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 20 * 1024 * 1024;
const fail = (code) => Object.assign(new Error('CSV Run artifact could not be published'), { code });

function openOrCreate(parent, name) {
  try { return parent.openDirectory(name); }
  catch (error) {
    if (error?.code !== 'BACKUP_FS_OPEN_FAILED') throw error;
    try { parent.mkdir(name, 0o700); }
    catch (mkdirError) {
      // Another Run may create it concurrently; only a safe pinned directory
      // can be used after a failed mkdir.
      return parent.openDirectory(name);
    }
    return parent.openDirectory(name);
  }
}

/** Atomically publish one immutable CSV file beneath tenant/run-scoped paths. */
function writeTableRunArtifact({ workspaceRoot, tenantId, runId, bytes, format,documentResult=false } = {}) {
  if (!UUID.test(tenantId) || !UUID.test(runId) || !Buffer.isBuffer(bytes) || !(documentResult?['docx','pdf','xlsx']:['csv','xlsx']).includes(format)) throw fail('CSV_ARTIFACT_ARGUMENT_INVALID');
  if (!bytes.length || bytes.length > MAX_BYTES) throw fail('CSV_ARTIFACT_SIZE_INVALID');
  const root = pinDirectory(fs.realpathSync(workspaceRoot));
  let tenant, exportsDir, runDir;
  let tempName;
  try {
    tenant = openOrCreate(root, tenantId);
    const category=documentResult?'document-results':format==='xlsx'?'spreadsheet-results':'csv-results';
    exportsDir = openOrCreate(tenant,category);
    runDir = openOrCreate(exportsDir, runId);
    const token = crypto.randomUUID();
    tempName = `.pending-${token}`;
    const finalName = `${token}.${format}`;
    let fd;
    try {
      fd = runDir.openFile(tempName, { createExclusive: true, writeOnly: true, mode: 0o600 });
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw fail('CSV_ARTIFACT_WRITE_FAILED');
        offset += count;
      }
      fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    runDir.linkFile(tempName, runDir, finalName);
    runDir.unlinkFile(tempName);
    tempName = null;
    return Object.freeze({
      rel: `${category}/${runId}/${finalName}`,
      name: (documentResult?'report.':'csv-analysis-result.')+format, kind: format, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  } catch (error) {
    if (tempName && runDir) { try { runDir.unlinkFile(tempName); } catch {} }
    if (error?.code?.startsWith('CSV_ARTIFACT_')) throw error;
    throw fail('CSV_ARTIFACT_WRITE_FAILED');
  } finally {
    runDir?.close(); exportsDir?.close(); tenant?.close(); root.close();
  }
}

function writeCsvRunArtifact(input = {}) {
  if (typeof input.csv !== 'string') throw fail('CSV_ARTIFACT_ARGUMENT_INVALID');
  return writeTableRunArtifact({...input,format:'csv',bytes:Buffer.from(input.csv,'utf8')});
}
function writeXlsxRunArtifact(input = {}) {return writeTableRunArtifact({...input,format:'xlsx'});}
function writeDocumentRunArtifact(input={}){return writeTableRunArtifact({...input,documentResult:true});}
module.exports = { writeCsvRunArtifact, writeXlsxRunArtifact,writeDocumentRunArtifact };
