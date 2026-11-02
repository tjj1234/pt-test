'use strict';

const { renderCsvExport } = require('../exports/csv.cjs');

const COLUMNS = Object.freeze([
  'run_id', 'response_seq', 'selected_model', 'provider_reported_model', 'cost_basis',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens',
  'usage_coverage', 'total_semantics', 'cost', 'cost_coverage', 'requested_at',
  'cost_currency', 'price_version', 'price_catalog_id', 'cost_reason_code', 'attempt_id',
]);
const text = value => ({ type: 'text', value: value == null ? 'unknown' : String(value) });
const count = value => Number.isSafeInteger(value) && value >= 0
  ? { type: 'decimal', value: String(value) } : text('unknown');

function renderRunUsageCsv({ runId, responses } = {}) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
      !Array.isArray(responses) || responses.length > 5000) {
    throw Object.assign(new TypeError('Run usage export is invalid'), { code: 'RUN_USAGE_EXPORT_INVALID' });
  }
  const rows = responses.map(row => {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.responseSeq) || row.responseSeq < 0) {
      throw Object.assign(new TypeError('Run usage export is invalid'), { code: 'RUN_USAGE_EXPORT_INVALID' });
    }
    return [
      text(runId), count(row.responseSeq), text(row.selectedModel), text(row.providerReportedModel),
      text(row.costBasis), count(row.inputTokens), count(row.outputTokens),
      count(row.cacheReadTokens), count(row.cacheWriteTokens), count(row.totalTokens),
      text(row.coverage), text(row.totalSemantics), text(row.cost), text(row.costCoverage), text(row.requestedAt),
      text(row.costCurrency), text(row.priceVersion), text(row.priceCatalogId), text(row.costReasonCode), text(row.attemptId),
    ];
  });
  return renderCsvExport({ columns: COLUMNS, rows });
}

module.exports = { renderRunUsageCsv };
