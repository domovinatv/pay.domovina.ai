# Testovi i regresije

## Što postoji

| Dio | Naredba | Što pokriva |
|---|---|---|
| `backend/` | `npm test` | rail: webhook, forward gate, stray resolver, settle, outbox, admin, tenanti, detektor krađe. Dio testova radi na pravom SQLiteu sa svim migracijama (`test/helpers/sqliteD1.ts`). |
| `shopify/worker/` | `npm test` | potpisi, sid, klasifikacija narudžbi, pristup ekstenziji |
| `wallet/` | `npm test` | relayer: CREATE2 parity na stvarnim računima, cold/hot path, limiti |
| Flutter (`test/`) | `flutter test` | status plaćanja, EIP-55 |

CI (`.github/workflows/ci.yml`) vrti sve na svaki PR i push na `main`, uz
`tsc`, `flutter analyze` i `wrangler deploy --dry-run`.

## Ugovor o kompatibilnosti

Postojeći testovi opisuju ponašanje na koje se netko oslanja (merchant,
checkout, operater). Pravila:

1. **Ne mijenjati provjere (`expect`) u postojećim testovima** da bi novi kod
   prošao. Dopušteno je prilagoditi *test-dvojnik* (novo obavezno polje u
   lažnom deps objektu) tako da stari test i dalje provjerava isto.
2. Namjerna promjena ponašanja: novi test s novim imenom, stari ukloniti, PR
   dobiva oznaku `behavior-change`, a opis navodi svaki stari test koji je
   pao i zašto.
3. `scripts/compat-check.sh [commit]` vrti testove starog commita nad trenutnim
   kodom. CI to radi na svakom PR-u prema bazi PR-a; pad bez oznake
   `behavior-change` blokira PR.

Za provjeru prema onome što je na produkciji:
`scripts/compat-check.sh <commit iz kojeg je deployano>`.
