ALTER TABLE conversations ADD COLUMN IF NOT EXISTS native_session_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS native_session_key_sha256 TEXT;
