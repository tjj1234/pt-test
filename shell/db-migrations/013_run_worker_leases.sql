-- A lease identifies the single runtime currently responsible for a durable run.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agent_runs_lease_expiry
  ON agent_runs(lease_expires_at, run_id)
  WHERE state IN ('queued','running','cancelling','waiting_external');
