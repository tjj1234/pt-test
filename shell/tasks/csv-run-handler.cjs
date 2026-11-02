'use strict';

const { loadCsvRunSource } = require('../attachments/csv-run-source.cjs');
const { adaptCsvAnalysis } = require('./csv-analysis-adapter.cjs');
const { analyzeCsvColumn } = require('../attachments/csv-analysis.cjs');
const { renderCsvAnalysisResultCandidate } = require('../exports/csv-analysis-result-candidate.cjs');
const { writeCsvRunArtifact } = require('../runtime/csv-run-artifact.cjs');
const { selectCsvColumn } = require('../attachments/csv-column-selection-candidate.cjs');

const fail = (code) => Object.assign(new Error('CSV analysis request could not be verified'), { code });
const FIELDS = new Set(['sourceRef', 'sourceSha256', 'operation', 'column', 'startRow']);

/** The parent Run owns both the attachment snapshot and the current user turn. */
function createCsvRunHandler({ uploadsRoot, workspaceRoot, identity, runId, documentRefs, confirmedSelections, attachmentEvidence, emit } = {}) {
  const currentRefs = new Set(Array.isArray(documentRefs) ? documentRefs : []);
  if (!currentRefs.size) return Object.freeze({ handle: async () => { throw fail('CSV_DOCUMENT_REQUIRED'); } });
  return Object.freeze({
    async handle({ args } = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some((key) => !FIELDS.has(key)) ||
          typeof args.sourceRef !== 'string' || !currentRefs.has(args.sourceRef)) {
        throw fail('CSV_SOURCE_NOT_CURRENT');
      }
      const confirmed = Array.isArray(confirmedSelections)
        ? confirmedSelections.find((item) => item?.sourceRef === args.sourceRef) : null;
      if (!confirmed || confirmed.sourceSha256 !== args.sourceSha256 ||
          confirmed.column !== args.column || confirmed.startRow !== args.startRow) {
        throw fail('CSV_SELECTION_NOT_CONFIRMED');
      }
      const source = await loadCsvRunSource({
        uploadsRoot, identity, ref: args.sourceRef, attachmentEvidence,
      });
      const preview = selectCsvColumn(source, confirmed);
      if (preview.type !== 'decimal') throw fail('CSV_SELECTION_NOT_NUMERIC');
      const analysis = adaptCsvAnalysis({ source, selection: {
        sourceSha256: args.sourceSha256,
        operation: args.operation,
        column: args.column,
        startRow: args.startRow,
      } });
      const exact = analyzeCsvColumn(source, analysis.selection);
      const csv = renderCsvAnalysisResultCandidate({ source, analysis: exact });
      const artifact = writeCsvRunArtifact({ workspaceRoot, tenantId: identity.tenantId, runId, csv });
      if (typeof emit === 'function') await emit('artifact', { artifact });
      // Keep the model response bounded; the immutable source is rechecked for
      // full provenance when a durable result artifact is generated.
      const maxEvidence = 20;
      return Object.freeze({ ...analysis, artifact, evidence: Object.freeze({
        sources: analysis.evidence.sources.slice(0, maxEvidence),
        ignoredEmpty: analysis.evidence.ignoredEmpty.slice(0, maxEvidence),
        missingRows: analysis.evidence.missingRows.slice(0, maxEvidence),
        omittedSources: Math.max(0, analysis.evidence.sources.length - maxEvidence),
        omittedEmpty: Math.max(0, analysis.evidence.ignoredEmpty.length - maxEvidence),
        omittedMissing: Math.max(0, analysis.evidence.missingRows.length - maxEvidence),
      }) });
    },
  });
}

module.exports = { createCsvRunHandler };
