-- Audit columns on webhook event log.
--
-- sid_extracted:   session id parsed out of order.memo / order.referenceNumber.
--                  Lets the admin UI surface "which browser session does this
--                  payment belong to" without re-parsing raw JSON every read.
--                  Index it because the planned realtime endpoint will look up
--                  events by sid (SessionHub DO push).
-- amount_cents:    integer copy of the order amount in minor units. Stored
--                  loosely (NULL allowed) so we can filter/sort numerically
--                  in the admin table without parsing the JSON blob.
-- currency:        copy of order.currency so the admin table can show amount
--                  in context without joining monerium_orders.
-- processing_note: free-text room for "skipped because subscription.created"
--                  / "no order in payload" / dedup-reason. Read by admin UI.
ALTER TABLE monerium_webhook_events ADD COLUMN sid_extracted TEXT;
ALTER TABLE monerium_webhook_events ADD COLUMN amount_cents INTEGER;
ALTER TABLE monerium_webhook_events ADD COLUMN currency TEXT;
ALTER TABLE monerium_webhook_events ADD COLUMN processing_note TEXT;

CREATE INDEX idx_monerium_events_sid
  ON monerium_webhook_events(sid_extracted, received_at DESC)
  WHERE sid_extracted IS NOT NULL;

CREATE INDEX idx_monerium_events_received
  ON monerium_webhook_events(received_at DESC);
