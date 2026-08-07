CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at DESC);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount NUMERIC(14, 4) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'PTS',
  kind TEXT NOT NULL CHECK (kind IN ('credit', 'debit', 'adjustment')),
  reference TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ledger_entries ALTER COLUMN currency SET DEFAULT 'PTS';
CREATE INDEX IF NOT EXISTS ledger_entries_user_id_id_idx ON ledger_entries(user_id, id DESC);

CREATE TABLE IF NOT EXISTS billing_requests (
  request_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pipeline_id TEXT NOT NULL,
  upstream_cost_usd NUMERIC(14, 8),
  charged_credits NUMERIC(14, 4),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((settled_at IS NULL AND upstream_cost_usd IS NULL AND charged_credits IS NULL)
    OR (settled_at IS NOT NULL AND upstream_cost_usd IS NOT NULL AND charged_credits IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS billing_requests_user_pipeline_idx ON billing_requests(user_id, pipeline_id);
CREATE INDEX IF NOT EXISTS billing_requests_unsettled_idx ON billing_requests(created_at) WHERE settled_at IS NULL;
