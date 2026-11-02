-- Preserve historic token totals as-is; identify their formula as unclassified.
-- New writers must provide an explicit semantic tag for totals they can prove.
ALTER TABLE chat_usage
  ADD COLUMN IF NOT EXISTS total_semantics TEXT;

UPDATE chat_usage
   SET total_semantics = 'legacy_unclassified'
 WHERE total_semantics IS NULL;

ALTER TABLE chat_usage
  ALTER COLUMN total_semantics SET DEFAULT 'legacy_unclassified',
  ALTER COLUMN total_semantics SET NOT NULL;

ALTER TABLE chat_usage DROP CONSTRAINT IF EXISTS chat_usage_total_semantics_check;
ALTER TABLE chat_usage ADD CONSTRAINT chat_usage_total_semantics_check
  CHECK (total_semantics IN (
    'legacy_unclassified',
    'dsh_pi_ai_disjoint_0_1_1_rc_2',
    'upstream_reported_unclassified',
    'unknown'
  ));
