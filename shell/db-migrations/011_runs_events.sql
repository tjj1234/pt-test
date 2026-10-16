-- Product task state only; execution remains in the existing runtime/DSH.
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id UUID PRIMARY KEY,
  -- Historical association survives conversation deletion for external-cost reconciliation.
  -- createRun validates ownership; removing a conversation must not erase paid-task evidence.
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting_external','awaiting_confirmation','cancelling','completed','failed','cancelled','interrupted')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  idempotency_scope TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  request JSONB NOT NULL,
  reconciliation TEXT NOT NULL DEFAULT 'not_required' CHECK (reconciliation IN ('not_required','needs_reconciliation','resolved')),
  external_provider TEXT,
  external_operation_key TEXT,
  external_task_id TEXT,
  external_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_owner ON agent_runs(tenant_id,user_id,created_at,run_id);
CREATE TABLE IF NOT EXISTS agent_run_events (
  event_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  event JSONB NOT NULL,
  UNIQUE (run_id,seq)
);

-- Logical terminal event is unique even when a producer generates a new event UUID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_one_done
  ON agent_run_events(run_id) WHERE (event->>'type') = 'done';
