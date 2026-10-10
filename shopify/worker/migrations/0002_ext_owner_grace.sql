-- Fable 5.1 r2 SH-01/SH-03/SH-04.
-- Who may see an order's payment QR through /ext/order: the logged-in
-- customer it belongs to, or (guest) anyone holding a session token while the
-- order is fresh. Cached here so the extension's polling does not hit the
-- Shopify Admin API every few seconds.
ALTER TABLE orders ADD COLUMN customer_gid TEXT;
ALTER TABLE orders ADD COLUMN order_created_at INTEGER;
-- SH-04: the mpt-zaprimljeno tag actually landed in Shopify (retried until it does).
ALTER TABLE orders ADD COLUMN received_tag_at INTEGER;
-- SH-03: auto_cancel waits this long after the intent expired (and only
-- cancels once MPT itself reports stage 'expired').
ALTER TABLE shops ADD COLUMN cancel_grace_seconds INTEGER NOT NULL DEFAULT 7200;
