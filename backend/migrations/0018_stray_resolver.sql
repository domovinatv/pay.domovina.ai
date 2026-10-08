-- Stray payment resolver (reference-less SEPA → intent by tenant + amount + time).
--
-- 1. Lookup support: the resolver's NOT EXISTS probes live forwards by sid.
CREATE INDEX IF NOT EXISTS idx_monerium_forwards_sid
  ON monerium_forwards(sid)
  WHERE sid IS NOT NULL;

-- 2. Latch: at most ONE live auto-resolved forward per intent. Two strays of
--    the same amount arriving together must not both claim the same intent —
--    the loser moves on to the next candidate (or parks). Same partial-index
--    trick as ux_forwards_live (0016); memo-carried forwards ('mpt'/'cmp') are
--    untouched, a payer may legitimately pay one sid twice.
--
-- PRE-CHECK (must return 0 rows; trivially true before the first deploy):
--   SELECT sid, COUNT(*) FROM monerium_forwards
--    WHERE memo_prefix IN ('auto', 'manual')
--      AND status IN ('pending','submitted','confirmed')
--    GROUP BY sid HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX ux_forwards_resolved_sid
  ON monerium_forwards(sid)
  WHERE memo_prefix IN ('auto', 'manual')
    AND status IN ('pending', 'submitted', 'confirmed');
