-- Database-level execution fence: one active Run per conversation across processes.
CREATE TABLE IF NOT EXISTS agent_conversation_leases (
  conversation_id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  lease_owner TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_conversation_leases_expiry
  ON agent_conversation_leases(lease_expires_at, conversation_id);
