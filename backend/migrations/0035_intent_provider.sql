-- Provider intenta: kroz koji izvor priljeva intent ide (ADR 0032). Određuje
-- checkout (IBAN, referenca, vremenska crta, poruke) i API odgovor.
--
--   'monerium' — SEPA → Monerium → EURe mint na Gnosisu (dosadašnji put)
--   'swan'     — obična SEPA (Instant) na tenantov Swan račun, bez EURe-a
--
-- NULL = stari red prije ove migracije = 'monerium'. Fiksira se pri izradi
-- intenta, pa promjena tenantovih računa kasnije ne mijenja povijest.
ALTER TABLE payment_intents ADD COLUMN provider TEXT;

-- Swan intenti napravljeni prije ove migracije: plaćeni (sintetski order
-- swan_…) i otvoreni na tenantima s aktivnim Swan računom.
UPDATE payment_intents SET provider = 'swan'
 WHERE provider IS NULL
   AND (monerium_order_id LIKE 'swan\_%' ESCAPE '\'
        OR (state = 'pending' AND tenant_id IN (
              SELECT tenant_id FROM receiving_accounts
               WHERE provider = 'swan' AND mode = 'fiat_notify' AND active = 1)));
