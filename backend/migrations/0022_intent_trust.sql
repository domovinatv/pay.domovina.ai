-- Fable 5.1 r2 SR-01 (P0-1): the stray resolver forwards a reference-less
-- payment only to a TRUSTED candidate — an intent whose destination is on the
-- tenant's static whitelist (admin / non-wallet seed rows), or one created with
-- the tenant's secret key. A self-registered wallet Safe (wallet_registry /
-- wallet_accounts, no proof of possession) still receives memo-carried
-- payments, but can no longer catch someone else's stray.

-- 1 = created with a tenant SECRET (sk_) key. Public pk_ keys ship in browser
-- code, so they prove nothing about who created the intent.
ALTER TABLE payment_intents ADD COLUMN created_with_key INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_intents_stray
  ON payment_intents(tenant_id, amount_cents, created_at);

-- Seed 0014 copied 47 wallet Safes into the static table with source='seed'
-- (label "… wallet_registry" / "… wallet_account"). They stay whitelisted for
-- memo-carried payments; only their trust for the resolver changes.
-- Pre-check 2026-10-10 (prod): no auto/manual forward ever went to one of them.
UPDATE tenant_payout_addresses
   SET source = 'seed_wallet'
 WHERE source = 'seed' AND label LIKE '%wallet%';
