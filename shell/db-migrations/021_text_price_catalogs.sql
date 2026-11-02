-- Append-only public pricing captures; no tenant credentials or account bills.
CREATE TABLE IF NOT EXISTS text_price_catalogs (
  ordinal BIGSERIAL UNIQUE NOT NULL,
  catalog_id TEXT PRIMARY KEY CHECK (catalog_id ~ '^[a-f0-9]{64}$'),
  source_url TEXT NOT NULL CHECK (source_url = 'https://powertokens.ai/pricing'),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_evidence TEXT NOT NULL,
  snapshots JSONB NOT NULL CHECK (jsonb_typeof(snapshots) = 'array'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
CREATE INDEX IF NOT EXISTS idx_text_price_catalogs_recorded
  ON text_price_catalogs(recorded_at DESC, ordinal DESC);
