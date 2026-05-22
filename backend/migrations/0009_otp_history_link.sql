-- Link otp_consumed rows to the wallet that consumed them, so we can
-- traverse from a wallet to its history of phone verifications. The chain
-- by design ends at otp.domovina.ai for the raw phone — see ADR 0001:
--
--   wallet_registry  →  otp_consumed (credential_id, verification_id)
--                                                    │
--                                                    └─→  otp.domovina.ai
--                                                         GET /api/verifications/:id
--                                                         returns verified_phone
--
-- This way mpt.domovina.ai never stores raw phones, and otp.domovina.ai
-- never stores wallet identifiers — but with admin access to BOTH, we
-- can resolve "send SMS to the owner of wallet X" without putting the
-- raw phone in our own DB.
ALTER TABLE otp_consumed ADD COLUMN credential_id TEXT;

CREATE INDEX idx_otp_consumed_credential_time
  ON otp_consumed(credential_id, consumed_at DESC)
  WHERE credential_id IS NOT NULL;
