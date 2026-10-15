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

Zamke:

- Skripta u privremeni worktree prenosi samo `git diff HEAD`, pa **nove
  (untracked) datoteke ne vidi**. Simptom je `Cannot find module ../novi/modul`
  u starim testovima. Commitaj prije pokretanja.
- `node_modules` se u worktree linka simlinkom. Ako i radiš u worktreeu sa
  simlinkom `backend/node_modules`, pazi da ga ne commitaš.
- Ako je skripta prekinuta, worktree `compat-check.*` ostaje u `$TMPDIR`.
- Skripta u worktree prenosi samo `git diff HEAD`. Nova, još nepraćena datoteka zato
  nedostaje, pa stari testovi koji je importaju padaju cijeli (14 datoteka, 12. 10. 2026.).
  Prvo commit, pa provjera.
  Počisti ga s `git worktree prune`, ali tek kad nijedna druga sesija ne vrti
  skriptu.
