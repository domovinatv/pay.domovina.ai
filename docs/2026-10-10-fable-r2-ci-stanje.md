# 2026-10-10 — Fable r2 fixevi, CI i stanje produkcije

Vezani dokumenti: `docs/reviews/2026-10-fable51-r2/implementation-plan.md`
(tablica stanja po nalazu), `docs/testing.md` (ugovor o kompatibilnosti),
`docs/runbook/{rate-limits,theft-detector,kek-rotation}.md`.

## Što je na produkciji

| Komponenta | Stanje |
|---|---|
| backend Worker | #69 deployan (verzija `bd6c0096`), D1 migracije 0022–0024 primijenjene; `MULTI_TENANT_RAIL="0"`, `LEGACY_REQUIRE_MINT_AT="1"` |
| wallet.domovina.ai | deployan iz `main` (`ship:default`), prvi put od srpnja (`203ef39`) — uključuje GP kartice iza flaga, ADR 0015 resolver, e-Demokracija brand, WR-02/WR-04 |
| wallet-sportklub, wallet-zupa | NISU osvježeni (srpanj) |
| Shopify worker | nikad deployan (`database_id` placeholder u `wrangler.toml`) |
| crosulja-staging tenant | rail ISKLJUČEN: commit `56b7894` (flag na `"1"`) deployan 9. 10. u 21:25 pa pregažen deployem iz `main` u 22:17; grana obrisana, commit ostaje po SHA-u |

## Regresije r2 izmjena — mjerenje

Stari testovi (`f9abf7b`, 367) nad novim kodom: **48 padova**.

| Uzrok | Broj | Primjer |
|---|---|---|
| novo obavezno polje u test-dvojniku (ponašanje isto) | 44 | `trusted`, `safeExecEvents`, `usedLegs`, `markIntentUnderpaid`, `listModules`, `created_at` sesije |
| namjerna promjena ponašanja | 4 | MT-02 (bez ključa → failed + alarm), OF-01 ×2, OF-02 |

Po imenu: 363/367 starih testova postoji i prolazi; 4 nedostaju = te namjerne
promjene. U starim test fajlovima +1029 / −27 linija. To je mjerenje koje sada
radi CI job `compat` na svakom PR-u.

## Zamke otkrivene ovdje

- **Workers glavni modul smije izvoziti samo default handler i DO klase.**
  `export const` u `backend/src/index.ts` ruši `wrangler dev`/deploy („Incorrect
  type for map entry"); vitest to ne vidi. Pokriveno: `test/entrypoint.test.ts` +
  `wrangler deploy --dry-run` u CI-ju.
- **wrangler pages deploy neinteraktivno** pada na više CF računa → uvijek
  `CLOUDFLARE_ACCOUNT_ID=7dc7167b7e2e00923bfa7cd697df14e4`.
- `wrangler dev` šalje Workeru host iz prve rute (`monerium.domovina.ai`), pa
  lokalni admin traži `--var ADMIN_HOST:monerium.domovina.ai`.
- Shopify sid je bio 36 znakova, a on-chain registry prima ≤ 32 (bytes32) —
  skraćen dok app nije deployan.

## Otvoreno

- **Odluke Matije:** strogi istek intenta (prethodni P0-7, `paid` → `payment.late`),
  4-eyes iznad praga (AD-05), wallet P2-2 (dokaz posjeda na `/api/wallets*`,
  `/embed` clickjacking, klijent ne vjeruje backendu), crosulja-staging rail.
- **Ručno:** WAF rate-limit pravila (`docs/runbook/rate-limits.md`),
  `WATCH_HEARTBEAT_URL` secret (`docs/runbook/theft-detector.md`).
- **Kod:** SR-06 preview resolvera iza dedupa; stari bearer URL-ovi
  `/api/monerium/admin/*` obrisati nakon ciklusa + rotirati `ADMIN_TOKEN`;
  pokrivenost backenda ~50 % (najslabije: `monerium/client.ts`, `router/safe.ts`,
  `wallets/api.ts`, `reconcile.ts`).
