-- Google login identity is issuer+subject, never an email-based account merge.
CREATE TABLE IF NOT EXISTS google_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  binding_approved_by TEXT, -- only populated for explicit trusted migration binding
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  CONSTRAINT google_identity_issuer CHECK (issuer = 'https://accounts.google.com')
);
-- Short-lived browser-bound one-shot authorization state; no auth codes or tokens.
CREATE TABLE IF NOT EXISTS google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_expiry ON google_oauth_states(expires_at);
