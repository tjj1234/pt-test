ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_reasoning_effort_valid' AND conrelid='conversations'::regclass) THEN
ALTER TABLE conversations ADD CONSTRAINT conversations_reasoning_effort_valid
CHECK (reasoning_effort IS NULL OR (reasoning_effort ~ '^[A-Za-z0-9_-]{1,64}$' AND model_preference IS NOT NULL AND model_preference <> 'AUTO'));
END IF;
END $$;
