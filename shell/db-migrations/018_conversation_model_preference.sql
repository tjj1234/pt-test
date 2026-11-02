-- A conversation snapshots its model preference once; later user defaults apply
-- only to new conversations. NULL denotes legacy/not-yet-snapshotted rows.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_preference TEXT;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_model_preference_valid' AND conrelid = 'conversations'::regclass) THEN
ALTER TABLE conversations ADD CONSTRAINT conversations_model_preference_valid
  CHECK (model_preference IS NULL OR (
    length(model_preference) BETWEEN 1 AND 512
    AND model_preference = btrim(model_preference)
    AND model_preference !~ '[[:cntrl:]]'
  ));
END IF;
END $$;
