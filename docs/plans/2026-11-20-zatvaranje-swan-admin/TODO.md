# TODO — zatvaranje Swan / ADR 0032 i admin v2

Radna lista. Čuva se u repou da napredak preživi između sesija. Označene stavke su gotove
i provjerene (`cd backend && npm run typecheck && npm test` zelen, `scripts/compat-check.sh` zelen).
Odluke idu u [decisions.md](decisions.md).

Plan po sesijama: [plan.md](plan.md). Handoff po sesiji: [handoffs/](handoffs/).

Legenda: `[x]` gotovo · `[ ]` otvoreno · `[~]` u radu · `(!)` traži Matiju · `→ Sn` planirana sesija

## F0: guardovi i mjerenje inboxa (bez promjene ponašanja)

- [x] Produkcija: Monerium uplate nakon 18. 11. 14:30 imaju red u `credit_events` (`provider='monerium'`), a booked događaj je vezan (`intent_settlements.credit_event_id` nije NULL); brojke zapisane u `research/` → S1
- [x] `backend/src/intents/db.ts` claimovi (`markIntentPaid/Underpaid/Late`, ~r. 231, 270): `monerium_order_id IS NULL` → `NOT EXISTS (SELECT 1 FROM intent_settlements …)` → S1
- [x] `intents/db.ts` `findStrayCandidates` (~r. 367, 406) i `intents/shortRef.ts` (~r. 166) na `intent_settlements` → S1
- [x] `intents/list.ts` bucketi late/underpaid (~r. 106–108) i `payers/api.ts` (~r. 90) na `intent_settlements` → S1 (payers ostaje, odluka 102)
- [x] Test usklađenosti: za svaki put namire `monerium_order_id IS NOT NULL` ⇔ red u `intent_settlements` (paid, underpaid, late, sandbox, swan) → S1 (`test/settlementGuards.test.ts`)
- [x] compat-check zelen bez oznake `behavior-change`, PR mergan, deploy → S1 (#170, 0515534, deploy df9f84b9)

## F1: fiat bez sintetskog Monerium ordera

- [x] Čitatelji (`intents/stage.ts`, `receipts/*`, `intents/outbox.ts`, `admin/v2/data.ts`, `payers/api.ts`, `monerium/reconcile.ts`) za fiat intente čitaju `intent_settlements` + `credit_events`, a sintetski red ostaje (dvostruko čitanje, isti izlaz) → S2 (mijenjani samo `stage.ts` i `admin/v2/data.ts`, ostali ne ovise; odluke 201–204)
- [x] Test: fiat intent (Swan i sandbox) daje identičan status, outbox i admin prikaz sa i bez sintetskog reda → S2 (`test/fiatSettlementReaders.test.ts`)
- [x] (!) `inflow/settleFiat.ts` prestaje pisati `monerium_orders` i lažni `monerium_forwards` red; postojeće `swan_*` redove briše migracija 0037 → S3 (#172, odluke 300–307)
- [x] Živa provjera nakon deploya: Swan sandbox uplata → `paid`, nijedan novi `monerium_orders` red → S3 (`x22x58fvjk8s`, 20. 11.)

## F2: Monerium kroz zajednički matcher

- [x] Monerium `issue` događaj ide `credit_events` → `inflow/matcher.ts`; forward.ts/strayResolver samo izvršavaju odluku matchera → S4
- [x] Replay testovi: svi postojeći Monerium scenariji (sid, kratka referenca, stray po iznosu/vremenu, underpaid, late, dvostruki webhook) daju isti ishod → S4
- [ ] (!) Deploy na putu novca (✅ 26c3ccde); živa sandbox uplata (`/api/intents/<sid>/monerium-sandbox-transfer`) → `paid` → S4

## F3: Flutter fiat tekstovi (paralelno s F0–F2)

- [ ] `lib/models/payment_status.dart` i `lib/ui/payment_status_page.dart`: `settlement: fiat` prikazuje samo `payment` → `settled` („Knjiženo na računu primatelja”), bez minta, Gnosisscana i potvrde → S5
- [ ] `test/payment_status_test.dart` pokriva fiat i onchain; `flutter test` zelen → S5

## F4: Swan operativno

- [ ] Admin v2: uređivanje IBAN-a (i webhook secreta) postojećeg računa primatelja kroz UI, PUT ruta s auditom → S6
- [ ] Istraživanje: koji format `secret`-a Swan prihvaća za webhook pretplatu (introspekcija `possibleTypes`/input validacija), zapis u `research/` → S6
- [ ] (!) Matija upisuje IBAN na receiving account #1 i webhook secret kroz admin UI; provjera da Swan šalje `x-swan-secret` i da adapter odbija krivi → S6
- [ ] (!) Swan produkcija: „Talk to an expert”, ugovor, HR d.o.o. kao account holder, skrbništvo (G7/G8). Radi Matija, nema sesije.

## F5: Crošulja i v1 admin

- [ ] Crošulja (`/Users/ms/git/crosulja/crosulja-hr`, samo čitanje): narudžba plaćena samo na `intent.paid`, dedup po ID-u isporuke (`int_<sid>`, `rcv_<order>`); nalaz u `research/` → S7
- [ ] (!) Testna narudžba CRO-2026-0210 na stagingu: poništiti ako staging izdaje račun → S7
- [ ] (!) Odluka: gasi li se v1 `/admin/*` i kada → S7
- [ ] v1 uklonjen (PR s oznakom `behavior-change`, objašnjen svaki stari test) — samo ako je Matija odlučio → S8
