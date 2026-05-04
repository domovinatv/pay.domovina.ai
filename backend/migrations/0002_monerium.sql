-- Monerium orders: each row is the latest snapshot of a Monerium order
-- (issue = incoming SEPA → EURe mint, redeem = EURe burn → outgoing SEPA).
-- Lifecycle: placed → pending → processed (or rejected). We upsert on every
-- webhook event so the row reflects the most recent state.
CREATE TABLE monerium_orders (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  account_id TEXT,
  kind TEXT NOT NULL,                 -- 'issue' | 'redeem'
  state TEXT NOT NULL,                -- 'placed' | 'pending' | 'processed' | 'rejected'
  amount TEXT NOT NULL,               -- decimal as string to preserve precision
  currency TEXT NOT NULL,             -- 'eur' | 'gbp' | 'usd'
  address TEXT,                       -- on-chain wallet address
  chain TEXT,                         -- 'gnosis' | 'ethereum' | 'polygon' | ...
  counterpart_iban TEXT,              -- sender IBAN for issue, recipient IBAN for redeem
  counterpart_name TEXT,
  memo TEXT,
  reference_number TEXT,              -- structured SEPA reference (max 35 chars)
  tx_hashes TEXT,                     -- JSON array of on-chain tx hashes
  placed_at TEXT,                     -- ISO timestamp from Monerium
  processed_at TEXT,
  raw_json TEXT NOT NULL,             -- full last-seen order payload for debugging / re-parsing
  updated_at INTEGER NOT NULL         -- unix seconds, our last upsert
);

CREATE INDEX idx_monerium_orders_state
  ON monerium_orders(state, placed_at DESC);

CREATE INDEX idx_monerium_orders_kind
  ON monerium_orders(kind, placed_at DESC);

-- Append-only log of every webhook event we received. Useful for replay,
-- debugging, and audit. Keep separate from monerium_orders so we never lose
-- intermediate states even after the order row is overwritten.
CREATE TABLE monerium_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  event_type TEXT,
  signature_ok INTEGER NOT NULL,      -- 0/1 — did HMAC verification pass?
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_monerium_events_order
  ON monerium_webhook_events(order_id, received_at DESC);
