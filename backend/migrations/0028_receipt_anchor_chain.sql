-- ADR 0023 §2 — chained anchors, running totals, daily heartbeat, append-only.
--
-- receipt_anchors is rebuilt: an anchor is now identified by its `seq` (1, 2,
-- 3 … without gaps), the root is no longer UNIQUE (a heartbeat with no new
-- leaves repeats the zero root), and every anchor carries
--   chain_head = keccak256(abi.encode(prev_chain_head, seq, root, leaf_count,
--                                     total_leaves, total_cents, lazy_count))
-- with running totals, so dropping or rewriting any earlier anchor changes
-- every later chain_head. OpenTimestamps stamps sha256(chain_head).
--
-- receipt_leaves is rebuilt too: its anchor_id must reference the new key.
--
-- PRE-CHECK (both must return 0; true on 2026-10-12, nothing was issued yet):
--   SELECT COUNT(*) FROM receipt_anchors;  SELECT COUNT(*) FROM receipt_leaves;
PRAGMA defer_foreign_keys = true;

DROP TABLE receipt_leaves;
DROP TABLE receipt_anchors;

CREATE TABLE receipt_anchors (
  seq INTEGER PRIMARY KEY,                 -- = receipt_leaves.anchor_id
  prev_chain_head TEXT NOT NULL,
  chain_head TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL,                      -- 0x00…00 when leaf_count = 0 (heartbeat)
  leaf_count INTEGER NOT NULL,             -- leaves in this anchor
  total_leaves INTEGER NOT NULL,           -- running totals over all anchors so far
  total_cents INTEGER NOT NULL,
  lazy_count INTEGER NOT NULL,
  ots TEXT,                                -- hex .ots of sha256(chain_head); replaced by an upgraded proof
  ots_calendars TEXT,
  chain_tx_hash TEXT,                      -- Gnosis anchor tx (ADR 0023 §5), NULL until then
  created_at INTEGER NOT NULL
);

-- Same columns as 0027; only the reference changes.
CREATE TABLE receipt_leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'lazy')),
  sid TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  tx_hash TEXT,
  amount_cents INTEGER NOT NULL,
  placed_at TEXT,
  leaf_hash TEXT NOT NULL,
  anchor_id INTEGER REFERENCES receipt_anchors(seq),
  name_mismatch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_receipt_leaves_sid ON receipt_leaves(sid);
CREATE INDEX idx_receipt_leaves_pending ON receipt_leaves(anchor_id) WHERE anchor_id IS NULL;

-- Append-only (ADR 0023 §2). A leaf may only get its anchor once; an anchor
-- may only gain or upgrade its proof and its chain tx. Nothing is deleted.
CREATE TRIGGER receipt_leaves_no_delete BEFORE DELETE ON receipt_leaves
BEGIN
  SELECT RAISE(ABORT, 'receipt_leaves is append-only');
END;

CREATE TRIGGER receipt_leaves_no_rewrite BEFORE UPDATE ON receipt_leaves
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.sid IS NOT OLD.sid
  OR NEW.order_id IS NOT OLD.order_id OR NEW.tx_hash IS NOT OLD.tx_hash
  OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.placed_at IS NOT OLD.placed_at
  OR NEW.leaf_hash IS NOT OLD.leaf_hash OR NEW.name_mismatch IS NOT OLD.name_mismatch
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.anchor_id IS NOT NULL AND NEW.anchor_id IS NOT OLD.anchor_id)
BEGIN
  SELECT RAISE(ABORT, 'receipt_leaves: only anchor_id NULL -> value may change');
END;

CREATE TRIGGER receipt_anchors_no_delete BEFORE DELETE ON receipt_anchors
BEGIN
  SELECT RAISE(ABORT, 'receipt_anchors is append-only');
END;

CREATE TRIGGER receipt_anchors_no_rewrite BEFORE UPDATE ON receipt_anchors
WHEN NEW.seq IS NOT OLD.seq OR NEW.prev_chain_head IS NOT OLD.prev_chain_head
  OR NEW.chain_head IS NOT OLD.chain_head OR NEW.root IS NOT OLD.root
  OR NEW.leaf_count IS NOT OLD.leaf_count OR NEW.total_leaves IS NOT OLD.total_leaves
  OR NEW.total_cents IS NOT OLD.total_cents OR NEW.lazy_count IS NOT OLD.lazy_count
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.chain_tx_hash IS NOT NULL AND NEW.chain_tx_hash IS NOT OLD.chain_tx_hash)
BEGIN
  SELECT RAISE(ABORT, 'receipt_anchors: only ots and chain_tx_hash may change');
END;
