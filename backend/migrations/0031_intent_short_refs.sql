-- ADR 0028: kratka referenca intenta (tijelo + Damm kontrolna znamenka).
--
-- payment_intents.short_ref je trajni zapis koda koji je intent dobio (prikaz,
-- admin, povijest). Jedinstvenost među ŽIVIM kodovima drži intent_short_refs:
-- jedan redak po (tenant, kod), PRIMARY KEY je ograničenje. Redak je živ dok
-- je hold_until > sada i intent nije plaćen; mrtav redak preuzima sljedeća
-- dodjela istim upsertom (ON CONFLICT … WHERE), pa dva istovremena POST-a
-- ne mogu dobiti isti kod.
ALTER TABLE payment_intents ADD COLUMN short_ref TEXT;

CREATE TABLE intent_short_refs (
  tenant_id TEXT NOT NULL,
  short_ref TEXT NOT NULL,    -- tijelo + kontrolna znamenka, npr. '0076'
  sid TEXT NOT NULL,          -- payment_intents.sid koji ga trenutno drži
  hold_until INTEGER NOT NULL, -- unix s: expires_at + prozor zadržavanja
  PRIMARY KEY (tenant_id, short_ref)
);

CREATE INDEX idx_intent_short_refs_sid ON intent_short_refs(sid);
