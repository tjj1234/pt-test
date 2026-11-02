CREATE TABLE IF NOT EXISTS document_sources (
 source_id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 source_ref TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
 source_bytes INTEGER NOT NULL CHECK (source_bytes BETWEEN 1 AND 20971520),
 source_format TEXT NOT NULL CHECK (source_format IN ('txt','md','csv','docx','xlsx','pptx')),
 display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255),
 source_version INTEGER NOT NULL DEFAULT 1 CHECK (source_version>0),
 deleted_at TIMESTAMPTZ,
 cleanup_complete BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,source_ref)
);
CREATE INDEX IF NOT EXISTS document_sources_owner ON document_sources(user_id,tenant_id,created_at,source_id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_context_start INTEGER NOT NULL DEFAULT 0 CHECK(source_context_start>=0);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_revocation_pending BOOLEAN NOT NULL DEFAULT FALSE;
