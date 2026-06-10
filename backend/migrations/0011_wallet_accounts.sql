-- ADR 0013 — one passkey identity, MANY Safe accounts. The wallet derives extra
-- accounts (1-of-2 [passkeySigner, recoveryOwner] Safes) at increasing saltNonces;
-- these live in the device's localStorage but, until now, had nowhere to persist
-- server-side (the POST .../accounts route 404'd). Without this a second device
-- that logs in with the same passkey only ever sees the BOOTSTRAP account — the
-- derived ones are invisible cross-device. This table is that missing storage; the
-- new GET/POST /api/wallets/:cred/accounts endpoints read/write it.
--
-- All fields are public (deterministic Safe address, salt, the recovery owner's
-- public ADDRESS — never the mnemonic). Additive migration: a new table + one
-- nullable column; no existing row or payment data is touched.

-- Restore the identity's reusable recovery owner cross-device too, so a new device
-- can also MINT further accounts (deriveAccount needs it), not just view them.
ALTER TABLE wallet_registry ADD COLUMN recovery_owner TEXT;

CREATE TABLE wallet_accounts (
  credential_id  TEXT NOT NULL,   -- owning identity (→ wallet_registry.credential_id)
  safe_address   TEXT NOT NULL,   -- lowercased 0x; derived 1-of-2 Safe address
  salt_nonce     TEXT NOT NULL,   -- decimal uint256 string used in the CREATE2 derive
  recovery_owner TEXT NOT NULL,   -- lowercased 0x; 2nd owner baked into the derive
  name           TEXT NOT NULL,   -- in-app account label (e.g. a pinka campaign title)
  created_at     INTEGER NOT NULL,-- unix seconds
  PRIMARY KEY (credential_id, safe_address)
);

-- List a single identity's derived accounts on cross-device restore.
CREATE INDEX idx_wallet_accounts_cred ON wallet_accounts(credential_id);
