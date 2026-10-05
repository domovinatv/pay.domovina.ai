-- Per-tenant Monerium account, webhook and signer (ADR 0017,
-- docs/decisions/0017-multi-tenant-rail.md).
--
-- Additive only. ITalk (the default tenant) gets NO row here: its rail keeps
-- coming from the Worker env exactly as before, so the live ITalk flow is
-- untouched. Every other tenant needs a row before the rail will accept its
-- webhooks or sign its forwards — no row = fail-closed.
--
-- Secrets (*_enc) are AES-256-GCM ciphertexts `v1:<iv>:<ct>` under the
-- TENANT_SECRETS_KEK Worker secret, with AAD `<tenant_id>|<field>` so a
-- ciphertext cannot be transplanted to another tenant (src/tenants/secrets.ts).
CREATE TABLE tenant_rail (
  tenant_id        TEXT PRIMARY KEY,
  -- 'production' → api.monerium.app · 'sandbox' → api.monerium.dev
  monerium_env     TEXT NOT NULL DEFAULT 'production',
  -- 'gnosis' (100) · 'chiado' (10200, Monerium sandbox chain)
  chain            TEXT NOT NULL DEFAULT 'gnosis',
  -- 'client_credentials' (tenant's own Monerium private app) · 'oauth'
  auth_kind        TEXT NOT NULL DEFAULT 'client_credentials',
  client_id        TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  -- Monerium profile the tenant's KYB/IBAN belongs to. Every order delivered
  -- on this tenant's webhook must carry exactly this profile.
  profile_id       TEXT NOT NULL,
  -- Address the tenant's IBAN is linked to = where Monerium mints. Lowercase.
  -- Forwards are signed FROM this Safe and only for orders minted to it.
  receiving_safe   TEXT NOT NULL,
  -- Zodiac Roles Modifier whose avatar is receiving_safe, the role key, and
  -- the tenant's own router EOA (member of that role).
  roles_modifier   TEXT,
  role_key         TEXT,
  router_address   TEXT,
  router_key_enc   TEXT,
  -- Overrides; NULL = Worker env defaults (gnosis only).
  eure_contract    TEXT,
  rpc_url          TEXT,
  -- Inbound Monerium webhook secret (whsec_…) + its subscription id.
  webhook_secret_enc      TEXT,
  webhook_subscription_id TEXT,
  -- Outbound merchant webhook for this tenant. NULL = no outbound events
  -- (never falls back to the global INTENT_WEBHOOK_URL — that would leak this
  -- tenant's payer data to another tenant's receiver).
  outbound_webhook_url        TEXT,
  outbound_webhook_secret_enc TEXT,
  -- Software mirror of the on-chain per-transfer cap (cents), STRICT: the
  -- amount must be below it, exactly like the LessThan in safe-tx/007.
  -- NULL = no cap beyond the intent API maximum.
  max_forward_cents INTEGER,
  verified_at      INTEGER,
  verify_report    TEXT,             -- JSON from POST …/rail/verify
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Which tenant's Monerium account a record belongs to. NULL = written before
-- this migration (all of those are ITalk).
ALTER TABLE monerium_orders ADD COLUMN tenant_id TEXT;
ALTER TABLE monerium_forwards ADD COLUMN tenant_id TEXT;
ALTER TABLE monerium_webhook_events ADD COLUMN tenant_id TEXT;

CREATE INDEX idx_monerium_orders_tenant
  ON monerium_orders(tenant_id, state)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_monerium_events_tenant
  ON monerium_webhook_events(tenant_id, received_at DESC)
  WHERE tenant_id IS NOT NULL;
