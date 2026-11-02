-- Per-provider-operation state for Runs that produce multiple external artifacts.
-- Run execution lease remains owned by agent_runs; provider query leases are independent.
CREATE TABLE IF NOT EXISTS run_external_operations (
  operation_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitting','accepted','querying','pending_query','manual_check','succeeded','failed','cancelled')),
  task_id TEXT,
  query_attempts INTEGER NOT NULL DEFAULT 0 CHECK (query_attempts >= 0 AND query_attempts <= 8),
  next_query_at TIMESTAMPTZ,
  last_query JSONB,
  query_owner TEXT,
  query_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, operation_key),
  CHECK ((status NOT IN ('accepted','querying','pending_query') OR task_id IS NOT NULL)),
  CHECK ((query_owner IS NULL) = (query_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_run_external_operations_due
  ON run_external_operations(next_query_at, operation_id)
  WHERE task_id IS NOT NULL AND status IN ('accepted','pending_query') AND query_attempts < 8;

CREATE INDEX IF NOT EXISTS idx_run_external_operations_expired_query
  ON run_external_operations(query_expires_at, operation_id)
  WHERE status = 'querying';

CREATE INDEX IF NOT EXISTS idx_run_external_operations_unknown_intent
  ON run_external_operations(updated_at, operation_id)
  WHERE task_id IS NULL AND status = 'submitting';
