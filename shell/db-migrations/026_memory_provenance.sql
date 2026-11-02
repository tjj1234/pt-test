CREATE TABLE IF NOT EXISTS memory_records (
 memory_id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 scope_ref TEXT NOT NULL,
 key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 80),
 value TEXT NOT NULL CHECK(length(value)<=2000),
 provenance TEXT NOT NULL CHECK(provenance IN ('user-explicit-confirmation','user-verbatim-statement','model-inference')),
 confirmed BOOLEAN NOT NULL DEFAULT FALSE,
 confirmed_by UUID REFERENCES users(id),
 confirmed_at TIMESTAMPTZ,
 source_id UUID REFERENCES document_sources(source_id),
 source_sha256 TEXT,
 source_version INTEGER,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,scope_ref,key)
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS memory_revocation_pending BOOLEAN NOT NULL DEFAULT FALSE;
-- Legacy records were manually entered but lack confirmation evidence. Keep them visible for confirmation.
INSERT INTO memory_records(memory_id,user_id,tenant_id,scope_ref,key,value,provenance,confirmed,updated_at)
 SELECT md5(m.user_id::text||':'||m.key)::uuid,m.user_id,u.tenant_id,'user',m.key,m.value,'user-verbatim-statement',FALSE,m.updated_at
 FROM user_memory m JOIN users u ON u.id=m.user_id
 WHERE LEFT(m.key,1)<>'$' AND length(m.key) BETWEEN 1 AND 80 AND length(m.value)<=2000
 ON CONFLICT DO NOTHING;

UPDATE conversations SET source_context_start=jsonb_array_length(messages) WHERE user_id IN (SELECT user_id FROM user_memory WHERE LEFT(key,1)<>'$');
