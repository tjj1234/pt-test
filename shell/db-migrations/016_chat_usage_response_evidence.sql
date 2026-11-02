-- Persist observable DSH response usage by Run and SDK event sequence.
-- No upstream request id, retry count, or provider cost is inferred here.
ALTER TABLE chat_usage
  ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS response_seq BIGINT,
  ADD COLUMN IF NOT EXISTS cache_read_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS coverage TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS cost_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS cost_currency TEXT,
  ADD COLUMN IF NOT EXISTS cost_coverage TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE chat_usage ALTER COLUMN prompt_tokens TYPE BIGINT;
ALTER TABLE chat_usage ALTER COLUMN completion_tokens TYPE BIGINT;
ALTER TABLE chat_usage ALTER COLUMN total_tokens TYPE BIGINT;

ALTER TABLE chat_usage DROP CONSTRAINT IF EXISTS chat_usage_coverage_check;
ALTER TABLE chat_usage ADD CONSTRAINT chat_usage_coverage_check CHECK (coverage IN ('complete','partial','unknown'));
ALTER TABLE chat_usage DROP CONSTRAINT IF EXISTS chat_usage_cost_coverage_check;
ALTER TABLE chat_usage ADD CONSTRAINT chat_usage_cost_coverage_check CHECK (cost_coverage IN ('known','partial','unknown'));

UPDATE chat_usage
   SET coverage = CASE
     WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN 'complete'
     WHEN prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL THEN 'partial'
     ELSE 'unknown'
   END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_usage_run_response
  ON chat_usage(run_id,response_seq)
  WHERE run_id IS NOT NULL AND response_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_usage_run ON chat_usage(run_id) WHERE run_id IS NOT NULL;
