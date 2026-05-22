-- Wallet registry: lets us count distinct self-custody wallets created via
-- wallet.domovina.ai (otherwise invisible — we only see top-ups via
-- payment_intents), and serves as the lookup table for cross-device login
-- and OTP-gated recovery via [[reference-otp-domovina]].
--
-- All stored fields are public information (passkey credential id,
-- secp256r1 pubkey, deterministic Safe address). The single PII-adjacent
-- column is `phone_hash`, which is HMAC(PHONE_PEPPER, raw_phone) — never
-- the raw E.164 number. The raw phone is held only by the otp.domovina.ai
-- service's own DO SQLite audit log.
--
-- One row per *passkey credential*. A single user with multiple devices
-- (e.g. iPhone passkey + Android passkey on a 2/3 Safe) would have
-- multiple rows pointing at the same safe_address.
CREATE TABLE wallet_registry (
  credential_id TEXT PRIMARY KEY,        -- 0x-prefixed hex of WebAuthn credential id
  pub_key_x TEXT NOT NULL,               -- decimal stringified bigint
  pub_key_y TEXT NOT NULL,               -- decimal stringified bigint
  signer_address TEXT NOT NULL,          -- lowercased 0x; SafeWebAuthnSignerProxy address
  safe_address TEXT NOT NULL,            -- lowercased 0x; counterfactual or deployed Safe
  phone_hash TEXT,                       -- HMAC-SHA256(PHONE_PEPPER, e164_phone), NULL if no recovery bound
  rp_id TEXT NOT NULL,                   -- WebAuthn RP ID at create time (e.g. "wallet.domovina.ai")
  user_agent TEXT,                       -- truncated UA at create time (debug aid; rotate/prune later)
  created_at INTEGER NOT NULL,           -- unix seconds
  phone_bound_at INTEGER                 -- when phone_hash was added
);

-- Lookup by Safe address (e.g. admin "who owns this wallet?")
CREATE INDEX idx_wallet_safe ON wallet_registry(safe_address);

-- Lookup by phone hash (recovery flow: phone proves identity → find Safe).
-- May match multiple rows when same user has multiple devices.
CREATE INDEX idx_wallet_phone ON wallet_registry(phone_hash) WHERE phone_hash IS NOT NULL;

-- Admin chronological view + count.
CREATE INDEX idx_wallet_created ON wallet_registry(created_at DESC);

-- Replay protection for otp.domovina.ai verifications. Each verification id
-- can be consumed by at most one wallet registry action (register OR phone
-- bind OR recovery). Short retention is fine — verifications themselves
-- expire ~10 min after creation, so we only need to remember the consumed
-- ones long enough to prevent immediate replay.
CREATE TABLE otp_consumed (
  verification_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,                 -- caller-supplied tag at OTP start
  consumed_at INTEGER NOT NULL,          -- unix seconds
  consumed_for TEXT NOT NULL             -- 'wallet_register' | 'wallet_bind_phone' | 'wallet_recovery'
);

CREATE INDEX idx_otp_consumed_at ON otp_consumed(consumed_at DESC);
