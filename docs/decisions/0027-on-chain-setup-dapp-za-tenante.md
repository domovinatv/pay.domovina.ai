# ADR 0027 — On-chain setup dApp za tenante (bez Safe sučelja i bez delegatea)

- **Status:** Accepted (2026-10-17): MVP mergan (#114, #115), deployan i prošao Chiado E2E
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

## Dodavanje i uklanjanje projekata (17. 10. 2026.)

Na setup stranici „Dodaj projekt" upiše kampanju u D1 (isti `POST …/campaigns`: kampanja +
payout whitelista + audit), a plan odmah doda adresu u `scopeFunction`. „Ukloni" opozove
kampanju u D1 (`DELETE …/campaigns/:id`), pa plan adresu izbaci iz role. Projekt koji je samo na
lancu (bez kampanje) uklanja se „Ukloni s lanca" (samo u memoriji stranice). Builder prima
`remove`: uklanjanje ima prednost pred dodavanjem, a zadnji projekt se ne može ukloniti (rola
bez primatelja; tada se opoziva router). D1 je samo željeno stanje: bez 2/3 potpisa router
ne smije ništa novo.

### Prvi novi projekt kroz stranicu: domovina.ai (17. 10. 2026.)

1. `node tools/funding/funding-init.mjs --env sandbox --project domovinatv-domovina-ai --title "domovina.ai"`:
   Safe `0xFbAf41F513cDbF0438b2E339C25A8Fdc949f9722` (2/3, deploy platio deployer `0x9915…4c65`
   iz `.env.sandbox`), Monerium `POST /addresses` → 201 linked. Korak 6 (delegate) pada s 422, što je
   očekivano i ne zaustavlja skriptu.
2. Setup stranica → „Dodaj projekt" → plan `scopeFunction(… to ∈ 3 projekata)`, simulacija ~157.837 gas.
3. 2/3 u MetaMasku, izvršio `0x788b…d1E2`: [`0x8faa…fe18`](https://gnosis-chiado.blockscout.com/tx/0x8faa6e8251dc9ddf5040e8f3824c160d93be9bc31ccb4c60e98c8469e175fe18)
   (blok 23568613, 242.198 gas). Provjera role ✓ za sva tri projekta, `0x…dEaD` pada.

Ključevi koji plaćaju gas na Chiadu (lako ih je pomiješati):

| Adresa | Uloga |
|---|---|
| `0x9915…4c65` | `DEPLOYER_PRIVATE_KEY` iz `tools/funding/.env.sandbox`: deploy Safe-ova projekata |
| `0xD922…6759` | ProjectRouter EOA `italk-sandbox`: `execTransactionWithRole` prema projektima |
| `0x788b…d1E2` | relayer walleta (`RELAYER_PRIVATE_KEY`, CF Pages); ovdje samo kao MetaMask račun koji izvršava |
| `0xd612…54CB` | umirovljeni MPT router (ADR 0025), na Gnosisu ~0,599 xDAI za počistiti |

Zamke iz istog dana:

- `run()` iscrta stranicu prije akcije, pa forma koja čita polja unutar akcije šalje prazno (#118).
- Nakon reloada dApp nije znao za već odobreni MetaMask račun i gumb je bio disabled bez razloga.
  Sada `eth_accounts` pri učitavanju i tekst razloga uz gumb (#119).
- Blockscout javni API vraća `429 Too many requests`. Blok deploya modifiera sada se traži
  binarnom pretragom `eth_getCode` po povijesti (24 RPC poziva) i pamti u localStorageu (#120).
- `client.js` ima `max-age=300`, pa je preglednik nakon deploya izvršavao stari kod. URL sada nosi
  hash sadržaja (#121).

### Dizajn sljedećeg koraka: „Dodaj projekt" s izradom Safe-a i Monerium linkom

`funding-init.mjs` danas jedini izrađuje Safe projekta i veže ga u Monerium. Podjela kad ide u dApp:

- **Deploy Safe-a (preglednik):** permissionless, adresa je CREATE2 iz vlasnika, praga i salta
  `project:<id>`, a Safe se rađa s potpisanom Monerium porukom (`--pre-sign-link`). Plaća MetaMask
  ili kasnije MPT gas ključ. Vlasnici i prag biraju se na stranici (default današnja trojka 2/3).
- **Monerium link (backend):** treba client secret, pa ide kroz admin endpoint (npr.
  `POST /admin/api/tenants/:id/projects`). Provjeri kod i ERC-1271 na lancu, pozove `POST /addresses`
  i `PATCH …/config` (ime), upiše kampanju i whitelistu. Prije toga provjeriti ima li worker
  Monerium vjerodajnice po tenantu (sandbox i prod).
- `funding-init.mjs` ostaje CLI nad istom bibliotekom (kao `009` nad `project-router-batch.mjs`).

### „Dodaj projekt" s izradom Safe-a i Monerium linkom (izgrađeno 17. 10. 2026.)

Jedan tok na setup stranici, `POST /admin/api/tenants/:id/projects` (`src/setup/projects.ts`):

1. Plan Safe-a iz vlasnika, praga i salta `project:<campaign_id>` (`safe-tx/lib/project-safe.mjs`,
   ista biblioteka u dAppu, workeru i `tools/funding`). Safe se rađa s potpisanom Monerium porukom
   (SignMessageLib u `setup()`); 1.5.0 na Gnosisu ima SignMessageLib `0x4FfeF822…b5aa` (codehash
   provjeren prema safe-deployments), pa isto radi i u produkciji.
2. Deploy: worker ga šalje sam ako ima ključ za taj lanac (`CHIADO_DEPLOYER_PRIVATE_KEY`, kasnije
   `GNOSIS_DEPLOYER_PRIVATE_KEY`). Ključ plaća samo `createProxyWithNonce` s argumentima koje worker
   sam izračuna, nije vlasnik nijednog Safe-a i ne miče novac. Bez ključa stranica deploya iz MetaMaska.
3. Worker provjeri kod, točne vlasnike i prag te ERC-1271 s `"0x"`, pa Monerium `POST /addresses`
   **vjerodajnicama tenanta** (`getTenantRail`: italk iz env, ostali iz `tenant_rail`). Rail koji se
   ne razriješi znači da nema projekta (fail-closed).
4. Tek tada kampanja, whitelista i audit `project.add`. Svaka greška prije toga ne upiše ništa, a
   ponovni pokušaj je idempotentan (postojeći Safe se samo provjeri, povezana adresa se ne veže dvaput).
5. Ime adrese u Moneriumu: javni API ga nema (`PATCH …/config` radi samo pod web sesijom, vidi
   `link-safe.mjs`), pa odgovor nosi naredbu za konzolu `sandbox.monerium.dev` / `monerium.app`.

Deploy 18. 10. 2026.: #123 + #124, worker `cfa9e509`; secret `CHIADO_DEPLOYER_PRIVATE_KEY` = sandbox
deployer `0x9915…4c65` iz `tools/funding/.env.sandbox` (~0,03 xDAI). Proba na Chiadu: vidi E2E maksimir niže.

Zamke:

- `client.generated.ts` u #123 izgrađen je prije zadnje izmjene `main.ts`, a CI to ne provjerava
  (job „bundle" gradi worker, ne uspoređuje bundle s izvorom). Deploy s maina ponovno izgradi
  klijent, pa je produkcija bila ispravna, a main nije (#124). `npm run build:setup-client` je zadnji
  korak prije commita.
- Ime walleta u Moneriumu (`sandbox.monerium.dev/wallets`) jedino je što API ne dopušta. Sve ostalo
  radi worker u jednom pozivu; 2/3 potpis plana role je ručan namjerno.

**„Izvrši, MPT plaća gas" (#126, worker `63484ced`):** gas ključ lanca (isti `CHIADO_DEPLOYER_PRIVATE_KEY`)
šalje `execTransaction` za Safe tx koji su vlasnici već potpisali do praga (`src/setup/execute.ts`).
Worker sam pročita tx iz Tx Servicea, vlasnike/prag/nonce s lanca i safeTxHash sa Safe-a, odbije
refund parametre i simulira prije slanja; audit `setup.execute`. Ključ samo plaća gas. Time je
otvorena stavka „MPT plaća gas" riješena bez Safe relaya i bez wallet relayera.

**Chiado E2E 18. 10. 2026.: `maksimir.DOMOVINA.ai`** dodan kroz „Dodaj projekt", plan role 2/2 potpisan
u MetaMasku, izvršio worker `0x9915…4c65`:
[`0x087b…487e`](https://gnosis-chiado.blockscout.com/tx/0x087b517b86c0af30dce1c3e64a4543b3bd48033dfa6516ca5f396bedcf5d487e)
(blok 23569104, 288.311 gas, Safe nonce 3). Provjera role ✓ za maksimir.

Router projekt smije plaćati tek kad 2/3 vlasnika potpiše novi plan na istoj stranici. Postojeći Safe
(bez CREATE2 plana) i dalje se dodaje opcijom „Postojeći Safe" (`POST …/campaigns`).

## Sljedeće

- Ostali koraci kao isti plan/potpis tok: deploy Roles modifiera (`deploy-roles.mjs`), gas za router.
- `GNOSIS_DEPLOYER_PRIVATE_KEY` za produkciju kad se sandbox tok pokaže.
- Chiado relayer za wallet (`wallet/functions/_lib/relayer.ts` je danas samo Gnosis).
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
- `eth_requestAccounts` vraća račun koji je već spojen sa stranicom, pa promjena računa u
  MetaMasku i novi klik nisu ništa mijenjali. Sada `accountsChanged` mijenja potpisnika, a klik
  otvori izbor računa (`wallet_requestPermissions`); EIP-6963 bira MetaMask ispred Brave Walleta (#115).
- MetaMask ne daje dAppu ime računa, a app.safe.global imena drži u localStorageu svoje domene:
  čitljiva imena vlasnika moraju biti naš vlastiti adresar.
- Safeovi sponzorirani izvršaji idu kroz njihov relay (`safe-client.safe.global/v1/chains/<id>/relay`):
  na Chiadu `403 No relayer defined`, a za tuđe sučelje nije namijenjen.
- Chiado base fee 17. 10. bio je 7 wei: setup (381.548 gas) stajao je 0,0000000000027 xDAI.

## Chiado E2E (17. 10. 2026.)

Na produkcijskoj stranici `mpt.domovina.ai/admin/tenants/italk-sandbox/setup`: prijedlog nonce 0
(`0x5975…d26d`) potpisala su u MetaMasku dva vlasnika (`0x4924…`, `0xC238…`), a izvršio ga je
račun s faucet xDAI-jem (`0x788b…d1E2`): [`0x7a19…1c15`](https://gnosis-chiado.blockscout.com/tx/0x7a19a3a92a6c8b0effd6a9444d7f9f9b24bf5923454d0bae8d61e2c32e3e1c15),
blok 23568189. Nakon osvježavanja: „Lanac je usklađen", provjera role ✓ za oba projekta i
✓ odbijanje `0x…dEaD`. Cron je u bloku 23568209 proslijedio owed #96 i #97 (ADR 0026).
