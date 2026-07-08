# D1 shema + Contracts — nalazi (DB-*, CT-*)

Podsustav: `backend/migrations/` (0001–0012), `backend/contracts/`,
`backend/safe-tx/`. Verificirano čitanjem svih migracija + queryja.

---

## DB-01 [MONEY-BUG] Nedostaje atomski idempotency zasun na `monerium_forwards`

**file:** `backend/migrations/0006_monerium_forwards.sql:40`

**Nalaz:** Tablica ima samo `CREATE INDEX idx_monerium_forwards_order ON
monerium_forwards(order_id)` — **ne-unique**. Check-then-act u `maybeForward`
(BW-02) nema DB backstop. Dizajn dopušta više redova po `order_id`
(multi-recipient, komentar migracije linija 13), pa naivni `UNIQUE(order_id)`
nije rješenje — treba `UNIQUE(order_id, target_address)` ili aplikacijski
atomski `INSERT ... ON CONFLICT DO NOTHING`. **Isti root kao BW-02** — vidi tamo
za scenarij i acceptance.

---

## DB-02 [MONEY-BUG] `amount_received_cents` se ne uspoređuje s `amount_cents`

**file:** `backend/migrations/0007_payment_intents.sql:16,28`

**Nalaz:** Shema ima `amount_cents INTEGER NOT NULL -- expected` i
`amount_received_cents INTEGER -- actual amount; may differ from intent`. Shema
sama priznaje da se mogu razlikovati, ali kod (`markIntentPaid`) nikad ne
usporedi. **Isti root kao BW-01** — vidi tamo.

---

## DB-03 [SEC] PII curenje kroz javne read rute

Vidi **BW-05**. Root je auth na endpointima, ne shema, ali shema drži PII
(`counterpart_iban`, `counterpart_name`, `raw_json`) koji se `SELECT *`-a bez
projekcije.

---

## DB-observacije (bez nalaza — POTVRĐENO DOBRO)

- **Novčani tipovi:** svi iznosi su `INTEGER` (minor units) ili `TEXT`
  (`amount_wei` decimalni string) — **nema `REAL`/floating-point za novac** u
  D1. Dobro.
- **Timestamp konvencije:** naši redovi konzistentno koriste unix-sekunde
  (`Math.floor(Date.now()/1000)`); Monerium `placed_at`/`processed_at` su ISO
  stringovi i pravilno se konvertiraju u `stage.ts`. Nema mješanja
  sekunde/milisekunde u našim tablicama.
- **FK:** `authorizations`/`accounts`/`transactions` `REFERENCES` klauzule su
  dekorativne (D1 ne enforca FK po defaultu), ali su na admin-ingestion putu, ne
  na money putu — nije MONEY rizik. Notirati u dokumentaciji da FK nije enforced.
- **`monerium_processed_event_ids`** (migracija 0003) s `INSERT OR IGNORE` je
  ispravan atomski idempotency primitiv — dobar uzorak koji `monerium_forwards`
  NEMA (DB-01).

---

## CT-01 [SEC-latent] safe-tx 005 delegatecall bez unwrappera

Vidi **backend-worker.md → CT-01**.

---

## PaymentRegistry.sol — pregled (bez blocking nalaza)

**file:** `backend/contracts/PaymentRegistry.sol`

Pročitan liniju-po-liniju. Ugovor je thin event-emitter (`record(...)` emitira
`Payment` event). Nema custody sredstava, nema `transfer`/`call` na vrijednosti,
nema reentrancy površine (samo `emit`). Access control: bilo tko može zvati
`record` (event je informativan, indexer ga koristi kao join-key). To je OK dok
je registry samo za feed-metadata i indexer VERIFICIRA on-chain transfer odvojeno
— ali ako feed ikad počne tretirati `Payment` event kao dokaz plaćanja bez
provjere pripadajućeg transfera, netko može emitirati lažne evente. **Notirati
kao pretpostavku:** registry event ≠ dokaz transfera; indexer mora cross-check-ati
stvarni `EURe.transfer` u istom tx-u. Trenutno registry put nije live.

**Acceptance ako se aktivira:** Indexer test — `Payment` event bez pripadajućeg
`EURe.transfer` u istom tx-u se NE kreditira kao donacija/plaćanje.
