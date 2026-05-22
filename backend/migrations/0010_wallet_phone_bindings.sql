-- Many-to-many wallet ↔ phone bindings. Replaces the single
-- `wallet_registry.phone_hash` column (which silently overwrote on every
-- second bind) with an explicit relation so we can support BOTH directions
-- of the legitimate combinatorics:
--
--   1) one wallet, N phones — a user can prove they own several phones
--      (multi-device household, business/personal split, etc.). Each phone
--      becomes a distinct row; verification_count bumps independently per
--      phone. The signal is "wallet has attested to K distinct phones, all
--      verified within the last X months" — much stronger than "wallet has
--      a phone."
--
--   2) one phone, N wallets — a user moved between wallets while keeping
--      the same number, OR a sybil farm is reusing one SIM across many
--      walletovs. Same `phone_hash` appears on several rows. The sybil
--      detection query becomes:
--         SELECT phone_hash, COUNT(*) FROM wallet_phone_bindings
--         GROUP BY phone_hash HAVING COUNT(*) > 1
--
-- Privacy stays unchanged from ADR 0001: phone_hash is HMAC(PHONE_PEPPER,
-- e164_phone), never the raw number. Raw phones still live only in
-- otp.domovina.ai's audit log.
CREATE TABLE wallet_phone_bindings (
  credential_id      TEXT NOT NULL,
  phone_hash         TEXT NOT NULL,
  first_bound_at     INTEGER NOT NULL,
  latest_verified_at INTEGER NOT NULL,
  verification_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (credential_id, phone_hash)
);

-- Sybil scan: phones held by 2+ distinct wallets.
CREATE INDEX idx_bindings_phone ON wallet_phone_bindings(phone_hash);

-- "How many distinct phones has this wallet attested to?" — list view per wallet.
CREATE INDEX idx_bindings_credential ON wallet_phone_bindings(credential_id);

-- Admin "recent activity" sort.
CREATE INDEX idx_bindings_latest ON wallet_phone_bindings(latest_verified_at DESC);

-- Backfill existing single-phone bindings into the new shape. wallet_registry
-- keeps its denormalized phone_hash column as a "latest phone" convenience
-- read but the source of truth is now this table.
INSERT INTO wallet_phone_bindings (credential_id, phone_hash, first_bound_at, latest_verified_at, verification_count)
SELECT
  credential_id,
  phone_hash,
  COALESCE(phone_bound_at, created_at),
  COALESCE(phone_bound_at, created_at),
  1
FROM wallet_registry
WHERE phone_hash IS NOT NULL;
