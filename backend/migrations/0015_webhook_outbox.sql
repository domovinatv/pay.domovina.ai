-- Durable outbox for OUTBOUND merchant webhooks (intent.paid, payment.received,
-- payment.rejected, payment.late, contribution.sepa, forward.blocked).
--
-- Why: until now each event was a single fire-and-forget fetch. A merchant
-- endpoint that answered 5xx or timed out lost the event for good — only a
-- console.error remained. In the merchant-direct model the notification IS the
-- product, so every event is persisted first and delivered from here, with
-- cron retries on a backoff schedule (src/intents/outbox.ts).
--
-- `id` is the Standard Webhooks `webhook-id` (e.g. `int_<sid>`, `rcv_<order>`)
-- and the primary key: enqueueing the same event twice is a no-op, which makes
-- every emit call site idempotent without its own guard.
CREATE TABLE webhook_outbox (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,          -- JSON body, signed fresh on every attempt
  tenant_id       TEXT,
  -- 'pending'   — not yet delivered, next_attempt_at says when
  -- 'delivered' — receiver answered 2xx
  -- 'failed'    — permanent: 4xx (except 408/429) or retries exhausted; alerted
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status     INTEGER,                -- last HTTP status, NULL on network error
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);

CREATE INDEX idx_webhook_outbox_due
  ON webhook_outbox(next_attempt_at)
  WHERE status = 'pending';
