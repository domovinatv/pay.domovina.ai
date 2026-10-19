-- ITalk prelazi iz env raila u tenant_rail (svi tenanti isti put).
-- Pokreće se NAKON rail/import-env, prije deploya koda bez legacy raila.

-- Stari retci bez tenanta su ITalkovi (prije ADR 0017 drugih nije bilo).
UPDATE payment_intents SET tenant_id = 'italk' WHERE tenant_id IS NULL;
UPDATE monerium_orders SET tenant_id = 'italk' WHERE tenant_id IS NULL;
UPDATE monerium_forwards SET tenant_id = 'italk' WHERE tenant_id IS NULL;
-- unknown_tenant događaji namjerno nemaju tenanta.
UPDATE monerium_webhook_events SET tenant_id = 'italk'
 WHERE tenant_id IS NULL AND event_type <> 'unknown_tenant';

-- Setup dApp čita Roles događaje od ovog bloka (batch 001 na Gnosisu).
ALTER TABLE tenant_rail ADD COLUMN roles_from_block TEXT;
UPDATE tenant_rail SET roles_from_block = '46280000' WHERE tenant_id = 'italk';
