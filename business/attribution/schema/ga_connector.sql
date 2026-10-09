CREATE TABLE IF NOT EXISTS ga_connections (
 tenant_id UUID PRIMARY KEY, property_id TEXT NOT NULL,
 refresh_iv TEXT NOT NULL, refresh_ciphertext TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ga_oauth_states (
 state_hash TEXT PRIMARY KEY, tenant_id UUID NOT NULL, session_hash TEXT NOT NULL,
 property_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE ga_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE ga_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ga_connections;
CREATE POLICY tenant_isolation ON ga_connections
 USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
 WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON ga_oauth_states;
CREATE POLICY tenant_isolation ON ga_oauth_states
 USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
 WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ga_connections, ga_oauth_states TO pt_app;
