-- Candidate only: no runtime caller. Count authorization, never a monetary cap.
CREATE TABLE controlled_media_grants (
  grant_id TEXT PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(run_id),
  user_id UUID NOT NULL REFERENCES users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  credential_scope_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('text2image','image2image','text2video','image2video')),
  capability_revision TEXT NOT NULL CHECK (capability_revision ~ '^[a-f0-9]{64}$'),
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at)
);
CREATE TABLE controlled_media_reservations (
  reservation_id UUID PRIMARY KEY,
  grant_id TEXT UNIQUE NOT NULL REFERENCES controlled_media_grants(grant_id),
  run_id UUID NOT NULL REFERENCES agent_runs(run_id),
  operation_key TEXT UNIQUE NOT NULL,
  credential_scope_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status = 'reserved'),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (credential_scope_id, model_id, task_type)
);
