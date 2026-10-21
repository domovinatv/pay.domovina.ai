-- Javna oznaka uplatitelja na popisu uplata projekta (GET /api/payers/:address):
-- inicijali + zadnje 4 znamenke IBAN-a, nikad ime ni IBAN. Uplatitelj na bilo
-- kojem ekranu vidi da je baš stigla njegova uplata.
--
-- Opt-in po tenantu (MT-08: bez zastavice bi svatko izlistao uplatitelje tuđeg
-- Safea). ITalk ga uključuje odlukom vlasnika 21.10.2026., retroaktivno, uz
-- napomenu na obrascu za uplatu (energy.domovina.ai).
ALTER TABLE tenants ADD COLUMN public_payer_tags INTEGER NOT NULL DEFAULT 0;
UPDATE tenants SET public_payer_tags = 1 WHERE id = 'italk';
