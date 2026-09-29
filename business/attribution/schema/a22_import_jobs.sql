-- A22: persist import job state across analytics process restarts.
CREATE TABLE IF NOT EXISTS attribution_import_jobs (
    import_id   UUID        PRIMARY KEY,
    tenant_id   UUID        NOT NULL,
    workspace_id TEXT       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL,
    job         JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attribution_import_jobs_tenant_created
    ON attribution_import_jobs (tenant_id, created_at DESC);

ALTER TABLE attribution_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attribution_import_jobs;
CREATE POLICY tenant_isolation ON attribution_import_jobs
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE attribution_import_jobs TO pt_app;
