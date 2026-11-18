-- ADR 0032 §4 — veza intent ↔ uplata ide kroz tablicu.
--
-- Jedan red po intentu koji je namiren (paid, underpaid ili late). Upisuje se
-- u istoj D1 transakciji (batch) kao `payment_intents.monerium_order_id`, pa
-- su ta dva uvijek usklađena. Ovim korakom guardovi i dalje gledaju
-- `monerium_order_id IS NULL`; prelazak guardova na ovu tablicu je sljedeći
-- korak i ne mijenja ponašanje jer je backfill ispod potpun.
CREATE TABLE intent_settlements (
  sid              TEXT    PRIMARY KEY REFERENCES payment_intents(sid),
  provider         TEXT    NOT NULL,            -- 'monerium' | 'swan' | 'sandbox' | …
  settlement_ref   TEXT    NOT NULL,            -- Monerium order id, ili sintetski (`swan_…`, `sim_…`)
  credit_event_id  INTEGER REFERENCES credit_events(id),  -- NULL dok događaj nije u inboxu
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_intent_settlements_ref ON intent_settlements (settlement_ref);
CREATE INDEX idx_intent_settlements_event ON intent_settlements (credit_event_id);

-- Backfill: svaki intent koji već ima settlement.
INSERT INTO intent_settlements (sid, provider, settlement_ref, credit_event_id, created_at)
SELECT i.sid,
       CASE
         WHEN i.monerium_order_id LIKE 'swan\_%' ESCAPE '\' THEN 'swan'
         WHEN i.monerium_order_id LIKE 'sim\_%'  ESCAPE '\' THEN 'sandbox'
         ELSE 'monerium'
       END,
       i.monerium_order_id,
       (SELECT ce.id FROM credit_events ce
         WHERE ce.settlement_ref = i.monerium_order_id
         ORDER BY ce.id DESC LIMIT 1),
       COALESCE(i.paid_at, i.created_at)
  FROM payment_intents i
 WHERE i.monerium_order_id IS NOT NULL;

-- Monerium priljev u inbox (ADR 0032 redoslijed 1): order.created → notified,
-- processed → booked. Indeks za vezu inbox → settlement po order id-u.
CREATE INDEX idx_credit_events_settlement_ref ON credit_events (settlement_ref);
