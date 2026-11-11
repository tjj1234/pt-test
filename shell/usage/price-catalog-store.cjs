'use strict';

const { createHash } = require('node:crypto');
const { fingerprint } = require('../contracts/phase1.cjs');
const { selectTextPriceSnapshot, parseUnambiguousUtc, OFFICIAL_PRICE_SOURCE } = require('./price-snapshot-selection-candidate.cjs');
const {basePrice,materializePrice}=require('./price-time-rule.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

function normalizeCatalog(input) {
  // Reuse the existing bounded JSON check before reading the maintenance input.
  fingerprint(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.reviewed !== true ||
      Object.keys(input).some(key => !['reviewed', 'sourceEvidence', 'snapshots'].includes(key)) ||
      typeof input.sourceEvidence !== 'string' || !input.sourceEvidence.trim() ||
      Buffer.byteLength(input.sourceEvidence) > 512_000 ||
      !Array.isArray(input.snapshots) || !input.snapshots.length || input.snapshots.length > 1000) {
    throw fail('PRICE_CATALOG_REVIEW_REQUIRED');
  }
  const snapshots = input.snapshots.map(snapshot => {
    const from = parseUnambiguousUtc(snapshot?.effectiveFrom);
    const captured = parseUnambiguousUtc(snapshot?.capturedAt);
    if (from === null || captured === null) throw fail('PRICE_CATALOG_INVALID');
    const requestedAt = new Date(Math.max(from, captured)).toISOString();
    const selected = selectTextPriceSnapshot({ snapshots: [basePrice(snapshot)], model: snapshot.model, requestedAt });
    if (!selected.snapshot) throw fail('PRICE_CATALOG_INVALID');
    return Object.hasOwn(snapshot,'timeRule')?{...selected.snapshot,timeRule:snapshot.timeRule}:selected.snapshot;
  }).sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 :
    parseUnambiguousUtc(a.effectiveFrom) - parseUnambiguousUtc(b.effectiveFrom)));
  for (let index = 1; index < snapshots.length; index++) {
    const previous = snapshots[index - 1], current = snapshots[index];
    if (previous.model === current.model && (previous.effectiveUntil === null ||
        parseUnambiguousUtc(previous.effectiveUntil) > parseUnambiguousUtc(current.effectiveFrom))) {
      throw fail('PRICE_CATALOG_OVERLAPPING');
    }
  }
  const sourceSha256 = hash(input.sourceEvidence);
  const catalogId = hash(JSON.stringify({ sourceSha256, snapshots }));
  return { catalogId, sourceSha256, sourceEvidence: input.sourceEvidence, snapshots };
}

function createTextPriceCatalogStore(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('Price catalog store requires a database');
  async function importCatalog(input) {
    const normalized = normalizeCatalog(input);
    const now = new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
    if (normalized.snapshots.some(snapshot => parseUnambiguousUtc(snapshot.capturedAt) > now)) {
      throw fail('PRICE_CATALOG_FUTURE_CAPTURE');
    }
    // Never update existing price evidence. Re-importing identical content is idempotent.
    await db.query(
      `INSERT INTO text_price_catalogs(catalog_id,source_url,source_sha256,source_evidence,snapshots)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (catalog_id) DO NOTHING`,
      [normalized.catalogId, OFFICIAL_PRICE_SOURCE, normalized.sourceSha256, normalized.sourceEvidence, JSON.stringify(normalized.snapshots)],
    );
    const row = (await db.query('SELECT catalog_id,source_sha256,recorded_at FROM text_price_catalogs WHERE catalog_id=$1', [normalized.catalogId])).rows[0];
    return { catalogId: row.catalog_id, sourceSha256: row.source_sha256,
      recordedAt: new Date(row.recorded_at).toISOString() };
  }
  async function selectAt({ model, requestedAt }) {
    if (parseUnambiguousUtc(requestedAt) === null || typeof model !== 'string') throw fail('PRICE_SELECTION_INVALID');
    const row = (await db.query(
      `SELECT catalog_id,source_sha256,recorded_at,snapshots FROM text_price_catalogs
        WHERE recorded_at<=$1::timestamptz ORDER BY recorded_at DESC,ordinal DESC LIMIT 1`, [requestedAt],
    )).rows[0];
    if (!row) return { catalogId: null, sourceSha256: null, snapshot: null, coverage: 'unknown', reasonCode: 'NO_RECORDED_CATALOG' };
    const selected = selectTextPriceSnapshot({ snapshots: row.snapshots.map(snapshot=>materializePrice(snapshot,requestedAt)), model, requestedAt });
    return { catalogId: row.catalog_id, sourceSha256: row.source_sha256, ...selected };
  }
  async function selectNow(model) {
    const requestedAt = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
    return { requestedAt, ...(await selectAt({ model, requestedAt })) };
  }
  return { importCatalog, selectAt, selectNow };
}

module.exports = { createTextPriceCatalogStore };
