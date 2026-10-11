-- Jedan Monerium profil = jedan MPT tenant. Više Monerium appova na istom
-- profilu šalje svaki svoj webhook za istu uplatu; da su dva takva appa dva
-- tenanta, monerium_orders.tenant_id bi dobio onaj čiji webhook stigne prvi
-- (upsert ga ne prepisuje), a drugi bi parkirao uplatu kao tenant_mismatch.
-- Forward je i bez ovoga jedan (ux_forwards_live); ovo čuva atribuciju.
-- ITalk nema red u tenant_rail; njegov profil (env) provjerava railAdmin.
CREATE UNIQUE INDEX ux_tenant_rail_profile ON tenant_rail(profile_id);
