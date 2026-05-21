-- Payment intents: server-side records of "buyer intends to pay €X to
-- target Y, identified by sid." Mirrors the otp.domovina.ai verification
-- table semantically: pending → terminal (paid | expired), with TTL sweep
-- and idempotent updates from the webhook handler.
--
-- The intent is paired to a Monerium order via sid that the merchant /
-- creator bakes into the SEPA remittance (mpt:<target>?sid=<sid>). The
-- webhook handler, after forwarding EURe from the MPT Safe to the target,
-- also flips the matching intent to 'paid' and links the forward row.
--
-- Phase 1 ships polling: clients GET /api/intents/:sid every 2s.
-- Phase 2 will add SSE via Durable Object; intent storage stays in D1.
CREATE TABLE payment_intents (
  sid TEXT PRIMARY KEY,                  -- 10-12 char URL-safe id; embedded in SEPA memo
  target_address TEXT NOT NULL,          -- lowercased 0x; routing destination
  amount_cents INTEGER NOT NULL,         -- expected EUR × 100; intent strict
  currency TEXT NOT NULL DEFAULT 'eur',
  label TEXT,                            -- human-readable description for admin UI
  metadata_json TEXT,                    -- caller-supplied JSON (order_id, customer_email, ...)
  state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'expired'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,           -- unix seconds; sweep target
  -- Populated when state becomes 'paid':
  paid_at INTEGER,
  monerium_order_id TEXT,
  forward_id INTEGER,                    -- monerium_forwards.id reference
  forward_tx_hash TEXT,
  amount_received_cents INTEGER          -- actual amount; may differ from intent
);

-- Filter pending intents past expiry — cron sweep target.
CREATE INDEX idx_intents_pending_expires
  ON payment_intents(expires_at)
  WHERE state = 'pending';

-- Admin "show intents for target wallet X over time."
CREATE INDEX idx_intents_target
  ON payment_intents(target_address, created_at DESC);

-- Admin "show paid intents in time range."
CREATE INDEX idx_intents_paid_at
  ON payment_intents(paid_at DESC)
  WHERE paid_at IS NOT NULL;
