-- Theft detector (ADR 0019 phase 0, src/monerium/outflowWatch.ts): last block
-- scanned for EURe leaving each rail's receiving Safe. key = '<chain>:<safe>'.
-- No row = never scanned; the first tick starts at the chain head (no
-- backfill, so historic manual transfers don't all alert at once).
CREATE TABLE chain_watch_cursor (
  key         TEXT PRIMARY KEY,
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
