# ADR 0027 — On-chain setup dApp za tenante (bez Safe sučelja i bez delegatea)

- **Status:** Proposed (2026-10-17), MVP na grani `feat/adr0027-tenant-setup-dapp`
- **Kontekst:** MPT rail (`backend/`), tenanti s načinom `direct` (ADR 0025), ProjectRouter (ADR 0026)
- **Gradi na:** [0026](0026-project-router-ogranicen-na-projektne-safeove.md) ·
  [0017](0017-multi-tenant-rail.md) (rail po tenantu) · [0021](0021-mpt-hr-javni-hostovi-i-api-v1.md) (dashboard.mpt.hr)

## Problem

Svaki tenant s direktnim plaćanjima mora proći isti on-chain postupak dvaput, za Monerium
sandbox (Chiado) i za produkciju (Gnosis): Roles modifier, `enableModule`, scope role,
članstvo routera, kasnije i svaki novi projekt. Do sada su za to trebali CLI skripte
(`safe-tx/009`, `tools/funding/router-scope.mjs`), JSON za Transaction Builder, fork-simulacija
anvilom, snippeti u konzoli i app.safe.global. Ondje dodavanje proposera traži plaćeni Safe Pro,
pa je delegate trebalo registrirati ručnim EIP-712 potpisom (ADR 0026 §Delegate). Tako ne može
raditi nijedan klijent MPT-a, a ni mi to ne želimo ponavljati.

## Odluka

Vlastiti dApp koji iz stanja na lancu programski izgradi korake, a vlasnici samo potpisuju.

1. **Plan iz lanca, idempotentno.** Stranica pročita vlasnike, prag, nonce, module, skup primatelja
   role (replay `ScopeFunction`) i članove (replay `AssignRoles`). Željeno stanje dolazi iz D1:
   rail tenanta i neopozvane kampanje (`tenant_campaigns`). Gradi se isti batch kao `safe-tx/009`:
   kod je izvučen u `backend/safe-tx/lib/project-router-batch.mjs`, a CLI ga samo uvozi. Koraci koji
   su već na lancu se preskaču, pa je i članstvo routera sad idempotentno.
2. **Simulacija u pregledniku.** Cijeli batch izvrši se kao Safe kroz
   `simulateAndRevert(SimulateTxAccessor)` (`eth_call`, bez potpisa). Prijedlog se ne nudi ako
   simulacija padne. Anvil fork ostaje za produkcijsku provjeru u CLI-ju.
3. **Potpis vlasnika, bez delegatea.** Vlasnik potpiše EIP-712 `SafeTx` u MetaMasku. Hash se računa
   lokalno i usporedi s `getTransactionHash` samog Safe-a, a potpis se prije slanja provjeri
   recoverom. Vlasnik prijedlog šalje izravno u Safe Transaction Service, pa delegate i Safe Pro
   više nisu potrebni. Isti prijedlog vidi se u app.safe.global i u Safe Mobile.
4. **Red = Safe Transaction Service.** Ostali vlasnici otvore istu stranicu i kliknu „Potpiši".
   Kad je prag skupljen, bilo koji račun s xDAI-jem izvrši `execTransaction`. Vlasnik koji još nije
   potpisao „Potpiši i izvrši" napravi jednim slanjem (pre-validated potpis, v=1).
5. **Provjera nakon izvršenja.** `eth_call` kao router: 1 wei prema svakom projektu mora proći, a
   prema `0x…dEaD` modifier ga mora odbiti.
6. **Lokalni ključ samo za sandbox.** Na Chiadu se može učitati generirani testni ključ vlasnika
   (samo memorija kartice). Na Gnosisu je ta opcija isključena i vrijedi samo MetaMask (uz Ledger).
   Produkcijski ključ vlasnika nikad ne ulazi u web stranicu (ADR 0025).

Server poslužuje stranicu i javne podatke raila (`GET /admin/tenants/:id/setup`,
`/admin/api/tenants/:id/setup`) i ne drži ključ vlasnika. CSP stranice dodaje u `connect-src` samo
RPC raila, `api.safe.global` i Blockscout.

## Posljedice

- Chiado E2E za ADR 0026 (koraci 1–3 iz handoffa 16. 10.) radi se kroz dApp, bez registracije delegatea.
- `router-scope.mjs` i delegate ostaju za CLI (`funding-init.mjs`), ali više nisu jedini put.
- Vlasnicima treba malo xDAI-ja za izvršenje: na Chiadu su sva tri vlasnika 17. 10. imala 0, a
  izvršiti može i ne-vlasnik.
- Stranica je za sada u adminu. Za tenante bez admin pristupa ide na `dashboard.mpt.hr` (ADR 0021).

## Sljedeće

- Ostali koraci kao isti plan/potpis tok: deploy Roles modifiera (`deploy-roles.mjs`), gas za router,
  Monerium link adrese (ERC-1271), dodavanje projekta iz `funding-init`.
- Produkcijski `italk` (legacy env rail): adresa routera unosi se na stranici, ključ ostaje offline (`safe-tx/000`).

## Zamke otkrivene u MVP-u (17. 10. 2026.)

- `scripts/compat-check.sh` primjenjuje samo `git diff HEAD`: novi **neverzionirani** fajlovi
  (npr. `src/setup/routes.ts`, `client.generated.ts`) ne uđu u radnu kopiju pa 12 starih test
  fajlova padne na importu. Commitaj prije compat-checka.
- Blockscout legacy API (`/api?module=logs&action=getLogs&fromBlock=0`) vraća najstariji log prvi,
  pa daje blok deploya Roles modifiera na Chiadu (23538972, isto kao `.env.sandbox`). Na
  `gnosis.blockscout.com` isti poziv 17. 10. nije vratio JSON, pa legacy `italk` koristi fiksni
  `46280000` iz `safe-tx/009`.
- `simulateAndRevert` + SimulateTxAccessor (1.3.0 `0x59AD…69Da` na Chiadu, 1.4.1 `0x3d4B…6199` na
  Gnosisu) radi kroz javni RPC: setup batch `success: true, ~271k gas`, a prevelik `EURe.transfer`
  `success: false` s revert podacima. Na Chiadu 1.4.1 accessor ne postoji.
- Javni Chiado RPC ima `access-control-allow-origin: *`, pa preglednik smije zvati izravno.
- Sva tri vlasnika Chiado Safe-a imala su 0 xDAI, pa izvršava bilo koji račun s gasom.
- MVP je testiran samo kao statična kopija stranice u headless Chromiumu (plan + simulacija).
  MetaMask potpis, Tx Service POST i `execTransaction` još nisu prošli na pravom lancu.
