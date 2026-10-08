-- Early "received" for reference-less payments (ADR 0018, dopuna 2026-10-09).
-- order.created arrives ~1 s after the payer taps Send, but a stray carries no
-- sid, so the checkout stayed on "awaiting" until the forward settled (~15 s).
-- The webhook now runs the stray resolver READ-ONLY on order.created and keeps
-- its pick here — separate from sid_extracted, which stays "what the memo said".
-- Nothing moves on this value; the forward still resolves on `processed`.
ALTER TABLE monerium_webhook_events ADD COLUMN sid_resolved TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_events_sid_resolved
  ON monerium_webhook_events(sid_resolved)
  WHERE sid_resolved IS NOT NULL;
