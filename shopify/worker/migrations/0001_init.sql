-- MPT for Shopify — one row per installed shop, one per order paid by MPT QR.
-- Secrets (*_enc) are AES-GCM ciphertext under TOKEN_KEK, never plaintext.

CREATE TABLE shops (
  shop                   TEXT PRIMARY KEY,          -- foo.myshopify.com
  access_token_enc       TEXT,
  access_expires_at      INTEGER,                   -- unix; NULL = non-expiring
  refresh_token_enc      TEXT,
  refresh_expires_at     INTEGER,
  scope                  TEXT,
  installed_at           INTEGER NOT NULL,
  uninstalled_at         INTEGER,
  -- MPT side, set by an operator after the merchant's tenant is onboarded.
  active                 INTEGER NOT NULL DEFAULT 0,
  mpt_api_key_enc        TEXT,                      -- tenant key (x-mpt-key)
  mpt_webhook_secret_enc TEXT,                      -- tenant outbound_webhook_secret (whsec_…)
  target_address         TEXT,                      -- merchant Safe on Gnosis (whitelisted on the tenant)
  gateway_match          TEXT NOT NULL DEFAULT 'MPT', -- substring of the manual payment method name
  intent_ttl_seconds     INTEGER NOT NULL DEFAULT 86400,
  auto_cancel            INTEGER NOT NULL DEFAULT 0, -- cancel + restock unpaid orders after expiry
  updated_at             INTEGER NOT NULL
);

CREATE TABLE orders (
  sid                    TEXT PRIMARY KEY,          -- MPT intent sid (deriveSid)
  shop                   TEXT NOT NULL,
  order_gid              TEXT NOT NULL,             -- gid://shopify/Order/…
  order_name             TEXT,                      -- #1001
  amount_cents           INTEGER NOT NULL,
  -- pending → received → paid; or expired / cancelled / underpaid / rejected
  status                 TEXT NOT NULL,
  intent_json            TEXT,                      -- last intent snapshot (QR payload, IBAN, checkout_url)
  expires_at             INTEGER,
  paid_at                INTEGER,
  forward_tx_hash        TEXT,
  amount_received_cents  INTEGER,
  shopify_synced_at      INTEGER,                   -- when Shopify was told the final status
  last_error             TEXT,
  last_polled_at         INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (shop, order_gid)
);
CREATE INDEX orders_open ON orders (status, created_at);

CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  shop       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
