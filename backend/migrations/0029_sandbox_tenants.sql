-- ADR 0024 — self-serve sandbox tenants (simulated payments) + return_url.
--
-- A sandbox tenant is an ordinary `tenants` row with sandbox = 1 and NO
-- tenant_rail row: no Monerium account, no chain, no signer. Every money path
-- that resolves a rail gets null for it and refuses (fail-closed). Its
-- payments are simulated by the rail (POST /api/intents/:sid/simulate) through
-- the same settle path as real ones.
ALTER TABLE tenants ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0;

-- What a sandbox tenant has instead of tenant_rail: its outbound webhook and
-- the bookkeeping for abuse limits and expiry.
CREATE TABLE sandbox_tenants (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  outbound_webhook_url TEXT,
  outbound_webhook_secret_enc TEXT NOT NULL,  -- KEK-encrypted whsec_ (field 'outbound_webhook_secret')
  created_ip_hash TEXT NOT NULL,              -- HMAC of the caller IP (rate limit), never the IP
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                 -- last_active_at + 90 days; cron deletes after
);

CREATE INDEX idx_sandbox_tenants_ip ON sandbox_tenants(created_ip_hash, created_at);
CREATE INDEX idx_sandbox_tenants_expiry ON sandbox_tenants(expires_at);

-- Where the checkout sends the buyer back (only settable with a secret key).
ALTER TABLE payment_intents ADD COLUMN return_url TEXT;
