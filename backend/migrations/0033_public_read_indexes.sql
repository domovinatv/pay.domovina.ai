-- GET /api/payers/:address (ADR 0030): three indexed lookups instead of an OR
-- over a scan of every issue order. Additive only.
CREATE INDEX IF NOT EXISTS idx_monerium_orders_address_lower ON monerium_orders(lower(address));
CREATE INDEX IF NOT EXISTS idx_intents_target_order ON payment_intents(target_address, monerium_order_id);
CREATE INDEX IF NOT EXISTS idx_intents_order_paid ON payment_intents(monerium_order_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_monerium_forwards_target ON monerium_forwards(target_address, order_id);
