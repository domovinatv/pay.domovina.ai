-- Idempotency: dedupe Monerium webhook retries by webhook-id header.
-- Monerium retries failed deliveries up to 10 times over 12 hours; we may
-- also receive the same event from the cron sync that the webhook already
-- delivered. INSERT OR IGNORE is the cheap path.
CREATE TABLE monerium_processed_event_ids (
  webhook_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
