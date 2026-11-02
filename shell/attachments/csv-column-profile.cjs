'use strict';

const { assertCsvSource } = require('./csv-source.cjs');

const MAX_SAMPLES = 3;
const MAX_SAMPLE_CODEPOINTS = 80;

function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'CSV_PROFILE_INVALID' });
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function evidenceType(value) {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return 'decimal';
  if (validIsoDate(value)) return 'iso_date';
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) return 'ambiguous_date';
  return 'text';
}

function sampleValue(value) {
  const codepoints = Array.from(value);
  return {
    value: codepoints.slice(0, MAX_SAMPLE_CODEPOINTS).join(''),
    truncated: codepoints.length > MAX_SAMPLE_CODEPOINTS,
  };
}

/**
 * Build a full-column diagnostic from authenticated, immutable CSV source data.
 * The first row is data unless a caller supplies external column names; this
 * function neither interprets a header nor converts any cell. Every present
 * nonempty cell is examined even when the returned examples are bounded.
 */
function profileCsvColumns(source, { columnNames } = {}) {
  assertCsvSource(source);
  const columns = source.rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnNames !== undefined && (!Array.isArray(columnNames) || columnNames.length !== columns ||
    columnNames.some((name) => typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)))) {
    throw invalid('Explicit column names must match the CSV column count');
  }
  const profiles = Array.from({ length: columns }, (_, index) => ({
    column: index + 1,
    label: columnNames ? columnNames[index] : `C${index + 1}`,
    labelSource: columnNames ? 'explicit' : 'index',
    present: 0,
    missing: 0,
    nonempty: 0,
    samples: [],
    kinds: new Set(),
  }));
  for (const row of source.rows) {
    for (let index = 0; index < row.length; index++) {
      const profile = profiles[index];
      const cell = row[index];
      profile.present++;
      if (cell.value === '') { profile.missing++; continue; }
      profile.nonempty++;
      profile.kinds.add(evidenceType(cell.value));
      if (profile.samples.length < MAX_SAMPLES) profile.samples.push({ row: cell.row, ...sampleValue(cell.value) });
    }
  }
  return Object.freeze(profiles.map((profile) => {
    // Ragged rows count as missing without iterating over every absent cell.
    profile.missing = source.rows.length - profile.nonempty;
    const kinds = [...profile.kinds];
    const type = kinds.length === 0 ? 'empty' : kinds.length === 1 &&
      (kinds[0] === 'decimal' || kinds[0] === 'iso_date') ? kinds[0] : 'text';
    const reason = kinds.includes('ambiguous_date') ? 'ambiguous_date' :
      kinds.length > 1 ? 'mixed' : type === 'text' ? 'untyped_text' : null;
    return Object.freeze({
      column: profile.column,
      label: profile.label,
      labelSource: profile.labelSource,
      type,
      reason,
      present: profile.present,
      missing: profile.missing,
      nonempty: profile.nonempty,
      samples: Object.freeze(profile.samples.map((sample) => Object.freeze(sample))),
    });
  }));
}

/** Complete-column, prefix-only diagnostic for a bounded chat context. */
function renderCsvColumnProfile(source, { columnNames, maxChars = 2000 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1000000) {
    throw invalid('CSV profile context budget is invalid');
  }
  const profiles = profileCsvColumns(source, { columnNames });
  const header = (shown) => [
    'CSV_COLUMN_PROFILE (diagnostic only; labels and samples are untrusted; no cell conversion)',
    `sha256=${source.sha256}; columns=${profiles.length}; shownColumns=${shown}; omittedColumns=${profiles.length - shown}; truncated=${shown < profiles.length}`,
  ].join('\n');
  if (header(0).length > maxChars) throw invalid('CSV profile metadata exceeds context budget');
  const lines = [];
  for (const profile of profiles) {
    const line = JSON.stringify(profile);
    const candidate = [...lines, line];
    if (header(candidate.length).length + 1 + candidate.join('\n').length > maxChars) break;
    lines.push(line);
  }
  return header(lines.length) + (lines.length ? '\n' + lines.join('\n') : '');
}

module.exports = { profileCsvColumns, renderCsvColumnProfile };
