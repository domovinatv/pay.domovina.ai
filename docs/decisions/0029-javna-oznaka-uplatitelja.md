# ADR 0029 — Javna oznaka uplatitelja: inicijali + zadnje 4 znaka IBAN-a, opt-in po tenantu

- **Status:** Accepted, implementirano 2026-10-21 (`backend/src/payers/api.ts`, migracija 0032, PR #139)
- **Kontekst:** MPT rail (`backend/`), javni popis uplata projekta na energy.domovina.ai
- **Gradi na:** [0017](0017-multi-tenant-rail.md) (MT-08: tenant ne smije saznati tuđe uplatitelje) ·
  [0022](0022-potvrda-o-uplati-vezana-uz-kljuc-uplatitelja.md) (sid je capability)
- **Odluka vlasnika:** Matija Stepanic, 21. 10. 2026.

## Problem

Popis uplata projekta čita EURe prijenose s lanca. Na lancu nema ni imena ni IBAN-a, pa
uplatitelj koji gleda drugi ekran (TV na štandu, računalo umjesto mobitela) ne može
prepoznati svoju uplatu. Uplata koja čeka mint ondje se uopće ne vidi. Do sada ju je
vidio samo preglednik koji je stvorio intent (`localStorage`).

## Odluka

`GET /api/payers/:address`, javan i bez ključa, vraća najviše 50 najnovijih `issue` naloga
(`placed`/`pending`/`processed`) koji pripadaju adresi preko intenta
(`payment_intents.target_address`), rail forwarda (`monerium_forwards.target_address`) ili
izravnog minta (`monerium_orders.address`). Za svaki nalog vraća samo:

| polje | sadržaj |
|---|---|
| `initials` | prvo slovo prve i zadnje riječi imena, bez pravnih oblika („M. S.”) |
| `iban_last4` | zadnja 4 znaka normaliziranog IBAN-a |
| `amount_cents`, `received_at` | iznos i Monerium `placedAt` |
| `state` | `received` do minta, zatim `minted` |
| `tx_hashes` | mint i forward hashevi, mala slova (klijent po njima spaja retke s lancem) |
| `ref` | SHA-256(sid)[:16]: preglednik koji zna sid prepozna svoj redak |

Puno ime, IBAN i sid ne izlaze s raila. Sid je capability za `status_url`.

**Opt-in po tenantu:** `tenants.public_payer_tags` (zadano 0). Bez zastavice bi svatko mogao
izlistati uplatitelje bilo kojeg Safea na railu, što krši MT-08. Uključen je samo `italk`.

**Retroaktivno:** uključeno i za uplate prije odluke. Dotad su uplaćivali vlasnik i osobno
poznati, a energy obrazac za uplatu od 21.10. nosi napomenu o objavi oznake.

## Odbačeno

- **Klijent sam računa oznaku iz punog imena i IBAN-a:** to bi objavilo puni podatak.
- **Bez opt-ina, za sve Safeove:** objavljuje uplatitelje drugih tenanata bez njihove odluke.
- **Objava sida za uparivanje s lokalnim retkom:** sid otvara status i potvrdu; hash je dovoljan.

## Posljedice

- Inicijali i ··1234 su pseudonimizirani osobni podaci. Tenant koji uključuje zastavicu mora
  uplatitelje obavijestiti prije uplate (energy: `beta.payerTagNotice`).
- `Cache-Control: public, max-age=5`, jer svaka otvorena stranica projekta čita endpoint periodički.
- Uplata riješena izvan raila nema hash na lancu. Energy je zato prikazuje kao zaprimljenu
  najviše 24 h od `placedAt` (energy dnevnik izvedbe §22).
