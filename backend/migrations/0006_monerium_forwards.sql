-- Off-chain → on-chain forward log. One row per `forwardViaSafe(...)` call
-- triggered by an incoming Monerium issue order. Tracks the lifecycle from
-- "we extracted a routing target" through "TX confirmed on Gnosis".
--
-- Lifecycle:
--   pending    — row inserted, TX not yet broadcast (e.g. router disabled)
--   submitted  — broadcast succeeded, tx_hash populated, awaiting confirmation
--   confirmed  — TX mined, receipt.status == success
--   failed     — TX reverted on-chain OR broadcast threw before submission
--
-- Separate from monerium_orders so we keep order history pristine even if
-- routing logic changes (e.g. multi-recipient splits added later — each
-- recipient gets its own forward row referencing the same order_id).
CREATE TABLE monerium_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  -- Lowercased 0x address extracted from order.memo by extractRoutingTarget.
  target_address TEXT NOT NULL,
  -- Amount in EURe wei (18 decimals). Stored as TEXT to preserve precision
  -- — SQLite INTEGER caps at 2^63-1 which is fine for EUR amounts but TEXT
  -- avoids any future surprise if we ever route on a chain with bigger units.
  amount_wei TEXT NOT NULL,
  -- Display amount in cents for admin UI sorting/filtering (lossy but easy).
  amount_cents INTEGER,
  -- Session id from memo, joined back to browser session for SSE notify.
  sid TEXT,
  -- "mpt" | "gnosis" | NULL — which memo prefix matched. Helps debug parser.
  memo_prefix TEXT,
  -- 0x-prefixed 32-byte TX hash once broadcast; NULL until status='submitted'.
  tx_hash TEXT,
  status TEXT NOT NULL,
  -- Last error string when status='failed'. Captures both pre-broadcast
  -- validation errors and on-chain revert reasons.
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_monerium_forwards_order
  ON monerium_forwards(order_id);
CREATE INDEX idx_monerium_forwards_status
  ON monerium_forwards(status, created_at DESC);
CREATE INDEX idx_monerium_forwards_sid
  ON monerium_forwards(sid, created_at DESC)
  WHERE sid IS NOT NULL;
