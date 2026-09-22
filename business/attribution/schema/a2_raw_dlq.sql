-- A2 · raw event + DLQ 持久化（业务线；同一数据库，禁止第二套连接）
-- 幂等：IF NOT EXISTS
-- tenant_id 只由应用从 AttributionContext / envelope 写入，不信任客户端 body。

CREATE TABLE IF NOT EXISTS attribution_raw_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID         NOT NULL,
    workspace_id    TEXT         NOT NULL,
    event_id        UUID,
    webhook_id      TEXT,
    received_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    raw_event       JSONB        NOT NULL,
    parse_status    TEXT         NOT NULL DEFAULT 'received'
                                 CHECK (parse_status IN ('received','normalized','rejected','ingested')),
    request_id      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attribution_raw_tenant_event
  ON attribution_raw_events (tenant_id, event_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attribution_raw_tenant_received
  ON attribution_raw_events (tenant_id, received_at DESC);

CREATE TABLE IF NOT EXISTS attribution_event_dlq (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID         NOT NULL,
    workspace_id    TEXT         NOT NULL,
    event_id        UUID,
    webhook_id      TEXT,
    reason          TEXT         NOT NULL,
    error_class     TEXT         NOT NULL DEFAULT 'permanent'
                                 CHECK (error_class IN ('permanent','retry_exhausted','validation')),
    raw_event       JSONB        NOT NULL,
    envelope        JSONB,
    attempts        INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolution      TEXT
);
CREATE INDEX IF NOT EXISTS idx_attribution_dlq_tenant_created
  ON attribution_event_dlq (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_dlq_open
  ON attribution_event_dlq (tenant_id)
  WHERE resolved_at IS NULL;

-- 可选授权（PostgreSQL 交付角色存在时）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON attribution_raw_events TO pt_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON attribution_event_dlq TO pt_app;
    GRANT USAGE, SELECT ON SEQUENCE attribution_raw_events_id_seq TO pt_app;
    GRANT USAGE, SELECT ON SEQUENCE attribution_event_dlq_id_seq TO pt_app;
  END IF;
END $$;

-- A13 · 租户隔离 RLS（对齐 analytics/schema/003_delivery.sql）
ALTER TABLE attribution_raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_raw_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attribution_raw_events;
CREATE POLICY tenant_isolation ON attribution_raw_events
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE attribution_event_dlq ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_event_dlq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attribution_event_dlq;
CREATE POLICY tenant_isolation ON attribution_event_dlq
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
