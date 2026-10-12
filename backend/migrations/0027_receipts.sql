-- ADR 0022 — payment receipts bound to the payer's key.
--
-- One Merkle root over a batch of leaves (sorted-pair keccak tree, leaves in
-- id order). `ots` is the OpenTimestamps proof of sha256(root bytes), stored
-- as hex; NULL when every calendar refused.
CREATE TABLE receipt_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT NOT NULL UNIQUE,
  leaf_count INTEGER NOT NULL,
  ots TEXT,
  ots_calendars TEXT,
  -- Gnosis tx recording the root in PaymentRegistry (kind 'rcpt1-root');
  -- NULL while the registry is not deployed (PAYMENT_REGISTRY_ADDRESS empty).
  chain_tx_hash TEXT,
  created_at INTEGER NOT NULL
);

-- receipt_leaves: one row per receipt fact that goes into a daily Merkle root.
--   kind='direct' — a confirmed forward of a receipt sid (r1…) whose sid came
--                   in the payer's own remittance. sid = that receipt sid.
--   kind='lazy'   — an earlier payment from the SAME payer IBAN, linked to the
--                   direct receipt `sid` (ADR 0022 §3a). sid = the anchor sid.
-- order_id is UNIQUE: every Monerium order is covered at most once, by its
-- own direct receipt or by the first anchor after it (§3a rule 3).
CREATE TABLE receipt_leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'lazy')),
  sid TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  -- Gnosis tx that settled this payment: the forward tx for 'direct', the
  -- Monerium mint tx (first of monerium_orders.tx_hashes) for 'lazy'.
  tx_hash TEXT,
  amount_cents INTEGER NOT NULL,
  placed_at TEXT,
  leaf_hash TEXT NOT NULL,
  -- NULL until the daily anchor job folds it into a root.
  anchor_id INTEGER REFERENCES receipt_anchors(id),
  -- Payer name differed from the anchor's (alerted, still linked: §3a rule 7).
  name_mismatch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_receipt_leaves_sid ON receipt_leaves(sid);
CREATE INDEX idx_receipt_leaves_pending ON receipt_leaves(anchor_id) WHERE anchor_id IS NULL;

-- Lazy matching looks up earlier issue orders by normalised payer IBAN.
CREATE INDEX idx_monerium_orders_payer_iban
  ON monerium_orders(REPLACE(UPPER(counterpart_iban), ' ', ''), placed_at)
  WHERE kind = 'issue';
