CREATE TABLE IF NOT EXISTS agent_web_calls (
 run_id UUID NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
 call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 128),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 7),
 signature TEXT NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
 lease_owner TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','completed','failed')),
 result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,call_id,ordinal)
);
