-- Native clarification persistence. Never conveys approval or execution authority.
CREATE TABLE IF NOT EXISTS agent_question_scopes (
  run_id UUID PRIMARY KEY REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS agent_run_questions (
  run_id UUID NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','answered','expired','cancelled')),
  deadline BIGINT NOT NULL,
  record JSONB NOT NULL,
  PRIMARY KEY (run_id,call_id,question_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_questions_pending ON agent_run_questions(run_id,deadline) WHERE status='pending';
