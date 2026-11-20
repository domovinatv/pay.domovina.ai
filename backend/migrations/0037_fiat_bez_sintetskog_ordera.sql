-- S3 lanca „zatvaranje Swan” (ADR 0032 §4, odluke 300–): fiat namira (Swan)
-- više ne piše sintetski `swan_…` red u `monerium_orders` ni `fiat_notify`
-- forward u `monerium_forwards`. Namira je red u `intent_settlements` +
-- booked `credit_events`; čitatelji to rade od S2 (#171).
--
-- Ova migracija stare intente svodi na isti oblik kao nove: `monerium_order_id`
-- i `forward_id` postaju NULL, a sintetski redovi se brišu. Samo tamo gdje
-- postoji red u `intent_settlements` s istim refom, da intent ne izgubi znak
-- da je namiren. Merchant i dalje vidi isti `monerium_order_id`
-- (intents/db.ts settlementId → `intent_settlements.settlement_ref`).
-- U prodi 20. 11. 2026.: 4 ordera i 4 forwarda, svi na sandbox tenantu.

UPDATE payment_intents
   SET monerium_order_id = NULL,
       forward_id = NULL
 WHERE monerium_order_id LIKE 'swan\_%' ESCAPE '\'
   AND EXISTS (SELECT 1 FROM intent_settlements s
                WHERE s.sid = payment_intents.sid
                  AND s.settlement_ref = payment_intents.monerium_order_id);

DELETE FROM monerium_forwards
 WHERE error = 'fiat_notify'
   AND order_id LIKE 'swan\_%' ESCAPE '\'
   AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.monerium_order_id = monerium_forwards.order_id);

DELETE FROM monerium_orders
 WHERE id LIKE 'swan\_%' ESCAPE '\'
   AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.monerium_order_id = monerium_orders.id);
