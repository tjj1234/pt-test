-- Durable query scheduling and bounded audit for already accepted provider tasks.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS external_query_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (external_query_attempts >= 0),
  ADD COLUMN IF NOT EXISTS external_next_query_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_last_query JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_runs_external_query_due
  ON agent_runs(external_next_query_at, run_id)
  WHERE reconciliation = 'needs_reconciliation'
    AND external_task_id IS NOT NULL
    AND external_state IN ('accepted', 'pending_query');
