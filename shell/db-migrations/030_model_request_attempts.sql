-- A reservation proves only authorization to begin a request, never provider receipt or zero charge.
CREATE TABLE IF NOT EXISTS model_request_attempts (
 run_id UUID NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK (purpose IN ('chat','compaction')),
 turn BIGINT NOT NULL CHECK (turn>=0), step BIGINT NOT NULL CHECK (step>=0),
 attempt_id UUID NOT NULL, signature TEXT NOT NULL, lease_owner TEXT NOT NULL,
 record JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,purpose,turn,step), UNIQUE(run_id,attempt_id)
);
