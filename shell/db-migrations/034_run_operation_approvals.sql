-- Exact-operation approvals are distinct from conversational clarification.
CREATE TABLE IF NOT EXISTS agent_run_approvals (
 approval_id UUID PRIMARY KEY,
 run_id UUID NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
 call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 128),
 lease_owner TEXT NOT NULL,
 operation_type TEXT NOT NULL CHECK(operation_type='run-script'),
 payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 payload JSONB NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired','cancelled','consumed')),
 deadline BIGINT NOT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 UNIQUE(run_id,call_id)
);
CREATE INDEX IF NOT EXISTS idx_run_approvals_pending ON agent_run_approvals(run_id,deadline) WHERE state='pending';
