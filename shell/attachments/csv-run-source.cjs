'use strict';

const { readVerifiedChatAttachmentBytes } = require('../tasks/chat-request.cjs');
const { buildCsvSource } = require('./csv-source.cjs');

const CSV_REF = /^\/uploads\/[a-f0-9-]{36}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}\.csv$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const fail = (code) => Object.assign(new Error('CSV Run source could not be verified'), { code });

/** Resolve only a CSV attachment captured by this Run and owned by its tenant. */
async function loadCsvRunSource({ uploadsRoot, identity, ref, attachmentEvidence } = {}) {
  if (typeof ref !== 'string' || !CSV_REF.test(ref)) throw fail('CSV_SOURCE_SCOPE_INVALID');
  const evidence = Array.isArray(attachmentEvidence)
    ? attachmentEvidence.find((item) => item && item.ref === ref) : null;
  if (!evidence || !Number.isSafeInteger(evidence.size) || evidence.size < 1 || evidence.size > MAX_BYTES) {
    throw fail('CSV_SOURCE_SNAPSHOT_REQUIRED');
  }
  const bytes = await readVerifiedChatAttachmentBytes(ref, evidence, {
    uploadsRoot, identity, includeBytes: true,
  });
  return buildCsvSource({ bytes, ref, limits: { maxBytes: MAX_BYTES } });
}

module.exports = { loadCsvRunSource };
