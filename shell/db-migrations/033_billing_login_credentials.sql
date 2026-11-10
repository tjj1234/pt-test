-- Separate login authorization from model API keys; never forward to DSH.
CREATE TABLE IF NOT EXISTS pt_billing_credentials (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 iv TEXT NOT NULL,
 ciphertext TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
