-- T02: trusted account disable state. Disabled users cannot authenticate via
-- existing sessions or Google callbacks; disabling revokes persisted sessions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
