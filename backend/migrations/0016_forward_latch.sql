-- Atomic latch on the forward table (Fable 5.1 review P0-2 / DB-04, BW-02a).
--
-- Until now the only guard against forwarding one Monerium order twice was a
-- check-then-act in maybeForward: SELECT existing forward, then INSERT. Two
-- concurrent order.updated deliveries (Monerium retry racing the original, or
-- two tenants' webhooks once the rail is multi-tenant — ADR 0017) can both
-- pass the SELECT and both broadcast a transfer.
--
-- The decision moves to the INSERT: at most ONE live forward per order. A
-- 'failed' or 'blocked' row does not count, so a retry after a failed
-- broadcast still inserts a fresh 'pending' row (partial index).
--
-- PRE-CHECK before applying to production (must return 0 rows, otherwise the
-- index creation fails and the duplicates have to be resolved by hand first):
--   SELECT order_id, COUNT(*) FROM monerium_forwards
--    WHERE status IN ('pending','submitted','confirmed')
--    GROUP BY order_id HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX ux_forwards_live
  ON monerium_forwards(order_id)
  WHERE status IN ('pending', 'submitted', 'confirmed');
