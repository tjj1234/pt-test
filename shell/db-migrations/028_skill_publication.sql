CREATE TABLE IF NOT EXISTS skill_releases (
 release_id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL,
 version TEXT NOT NULL,
 content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 files JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,skill_id,version),
 UNIQUE(release_id,user_id,tenant_id,skill_id)
);
CREATE TABLE IF NOT EXISTS skill_publications (
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL,
 active_release_id UUID NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 pending_cleanup BOOLEAN NOT NULL DEFAULT FALSE,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(user_id,skill_id),
 FOREIGN KEY(active_release_id,user_id,tenant_id,skill_id) REFERENCES skill_releases(release_id,user_id,tenant_id,skill_id)
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS skill_context_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS skill_revocation_pending BOOLEAN NOT NULL DEFAULT FALSE;
