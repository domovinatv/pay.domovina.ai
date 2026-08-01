-- Tenant registry + fail-closed payout whitelist for the MPT forward rail.
--
-- Why (see docs/decisions/0016-tenant-payout-whitelist.md): until now the
-- forward destination came straight out of the SEPA remittance parsed by
-- `extractRoutingTarget` — anybody who could make a SEPA transfer to the MPT
-- IBAN could name an arbitrary Gnosis address and have EURe forwarded there.
-- That turns the rail into an open on-ramp (Monerium Business ToS §16 /
-- money-remittance exposure) and gives us no sanctions surface at all.
--
-- The new model is fail-closed on TWO independent conditions:
--   1. binding   — the parsed target must match a destination we already
--                  authorised (payment_intents.target_address for `mpt:`,
--                  tenant_campaigns.safe_address for `cmp:`)
--   2. whitelist — the target must be an active payout address of the tenant
--                  that owns that intent/campaign
-- Anything else parks the EURe in the Safe with forward status 'blocked'.

-- One row per merchant/product consuming the rail. `allow_sources` is a JSON
-- array of DYNAMIC whitelist sources evaluated in addition to the static
-- tenant_payout_addresses table. Currently understood:
--   "wallet_registry" — any Safe self-registered through /api/wallets
--                       (wallet_registry.safe_address or
--                       wallet_accounts.safe_address). Keeps DOMOVINA Wallet
--                       self-serve onboarding working without an admin step.
-- Unknown source names are ignored (fail-closed: they never widen the set).
-- A tenant is the legal entity that (a) holds the Monerium relationship the
-- SEPA leg lands on and (b) authorises payout destinations. Those two are the
-- same fact: money arrives on THAT entity's KYB'd IBAN, so only that entity may
-- say where it goes on. A second tenant therefore requires its own Monerium
-- KYC/KYB and its own IBAN — it is not just a row.
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,             -- slug, e.g. 'italk'
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
  allow_sources TEXT NOT NULL DEFAULT '[]',   -- JSON array of dynamic sources
  -- SEPA collection leg baked into every QR / EPC payload this tenant issues.
  -- Stored per tenant rather than hardcoded because tenant #2 collects on a
  -- DIFFERENT IBAN — its own, after its own Monerium onboarding.
  beneficiary_name TEXT NOT NULL,             -- e.g. 'ITalk d.o.o.'
  iban             TEXT NOT NULL,             -- canonical, NO spaces
  bic              TEXT,                      -- e.g. 'LHVBEE22'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- API keys identifying which tenant created an intent. Only the sha256 hex of
-- the key is stored — the raw value is shown once at issue time and never
-- again. `kind`:
--   'public' (pk_…) — safe to embed in a browser/app bundle. Identifies the
--                     tenant; grants nothing beyond that tenant's whitelist.
--   'secret' (sk_…) — server-to-server only.
CREATE TABLE tenant_api_keys (
  key_hash   TEXT PRIMARY KEY,   -- sha256 hex of the raw key
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,      -- 'public' | 'secret'
  label      TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_tenant_api_keys_tenant ON tenant_api_keys(tenant_id);

-- Static payout whitelist. Revocation is soft (revoked_at) so the audit trail
-- survives — a revoked row must never be treated as allowed.
CREATE TABLE tenant_payout_addresses (
  tenant_id  TEXT NOT NULL,
  address    TEXT NOT NULL,      -- lowercase 0x + 40 hex
  label      TEXT,
  source     TEXT NOT NULL,      -- 'seed' | 'admin'
  created_at INTEGER NOT NULL,
  created_by TEXT,
  revoked_at INTEGER,
  revoked_by TEXT,
  PRIMARY KEY (tenant_id, address)
);
CREATE INDEX idx_tenant_payout_active
  ON tenant_payout_addresses(address)
  WHERE revoked_at IS NULL;

-- Registry for the permanent campaign QR (`cmp:` protocol). Without a row
-- here a `cmp:` memo has no authorised destination and parks fail-closed —
-- campaigns must be registered before their QR is published.
CREATE TABLE tenant_campaigns (
  campaign_id  TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  safe_address TEXT NOT NULL,    -- lowercase 0x; the ONLY target this id may pay
  label        TEXT,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  revoked_at   INTEGER
);
CREATE INDEX idx_tenant_campaigns_tenant ON tenant_campaigns(tenant_id);

-- Append-only audit trail: who changed the whitelist, and every forward the
-- whitelist refused. `actor` is 'admin:<basic-auth-user>' or 'system'.
CREATE TABLE tenant_audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  tenant_id TEXT,
  action    TEXT NOT NULL,   -- address.add | address.revoke | campaign.add
                             -- | campaign.revoke | key.issue | key.revoke
                             -- | forward.blocked
  address   TEXT,
  actor     TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX idx_tenant_audit_at ON tenant_audit_log(at DESC);
CREATE INDEX idx_tenant_audit_tenant ON tenant_audit_log(tenant_id, at DESC);

-- Which tenant authorised this intent. NULL only for rows created before this
-- migration; 0014 backfills them to the default tenant.
ALTER TABLE payment_intents ADD COLUMN tenant_id TEXT;
CREATE INDEX idx_intents_tenant ON payment_intents(tenant_id, created_at DESC);
