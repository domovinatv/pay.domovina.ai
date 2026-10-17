# Sigurnosni audit pay.domovina.ai (MPT rail) — 2026-10-16

- **Datum:** 2026-10-16
- **Autor:** Claude Fable 5.1 (neovisni prolaz; sav kod u repou pisao je Claude Opus 5.5)
- **Pregledani commit:** `2d9e75ddd665f01661d270dd5a4e74cff2b2acb4` (`origin/main`, merge PR #113)
- **Namjena:** ulaz za popravke koje radi Opus 5.5. Svaki nalaz ima `putanja:linija` u tom commitu; ništa nije pokretano protiv produkcije ni sandboxa, nijedan vanjski servis nije zvan osim `npm audit` (registry).

## Opseg

**Pročitano u cijelosti (ručno):** `backend/src/**` (index, intents, monerium, tenants, router, receipts, sandbox, admin, wallets, gnosispay, providers, db), `backend/migrations/*` (shema, latchevi, seed), `backend/safe-tx/009-*`, `backend/safe-tx/lib/roles-v2.mjs`, `backend/safe-tx/000`, `tools/funding/router-scope.mjs` (+ grep ostalih skripti), `wallet/functions/**` (relay, bootstrap-deploy, status, limits, turnstile), `wallet/src/lib/accounts.ts`, `wallet/src/lib/registry.ts`, `wallet/public/_headers`, `wallet/wrangler.toml`, `.github/workflows/ci.yml`, `backend/wrangler.toml`, ADR 0016/0017/0018/0022/0024/0025/0026, `docs/admin-auth.md`, postmortem 0002, runbooks, `wallet/docs/security-custody-model.md`, `wallet/docs/relayer-threat-model.md`, prethodni reviewi (`docs/reviews/2026-10-fable51-r2/INDEX.md`).

**Pregledano djelomično (grep, ne čitanje):** `backend/src/admin/views.ts` (escapiranje), `backend/src/checkout/page.ts` (escapiranje, `return_url`), `wallet/src/routes/*` (samo pozivi sync/recovery), `shopify/` (samo popis ruta).

**Nije pregledano:** Flutter aplikacija (`lib/`, `web/`), `shopify/worker` logika, `backend/src/receipts/client/*` (PDF u pregledniku), `backend/contracts/PaymentRegistry.sol` (nije deployan), `docs/plans/**`.

**Alati:** `npm audit --omit=dev` (backend, wallet, shopify/worker), grep tajni po radnom stablu i `git log -S` po povijesti.

## Sažetak

Novčani put je dobro ograđen: inbound webhook se verificira isključivo tajnom tenanta iz URL-a, forward/settle ide kroz jednu točku odluke (`authorizeForward`) s atomskim latchevima u D1, stanja forwarda čuva SQL guard, a od ADR 0025/0026 Worker nema ključ koji može pomaknuti EURe izvan skupa projektnih Safe-ova koje su 2/3 vlasnika potpisali. Admin autentikacija (Access + passkey, `__Host-` kolačić, Origin CSRF, CSP nonce) je uredna, a rupa iz postmortema 0002 je zatvorena i pokrivena regresijskim testom.

Problemi su na rubovima raila, u javnim pomoćnim API-jima i u jednoj posljedici prelaska na `direct` način koju ADR-ovi nisu primijetili. Nema kritičnih nalaza. Tri najvažnija:

1. **SEC-01 (Visoko)** — `POST /api/wallets/:credentialId/accounts` je neautenticiran, a wallet pri ulasku povlači tuđe zapise i njihov `recovery_owner` u lokalni registar. Napadač može žrtvi podmetnuti „račun“ koji je 1-od-2 Safe s napadačevim ključem kao suvlasnikom. To izravno krši jamstvo iz `wallet/docs/security-custody-model.md` §5.
2. **SEC-02 (Visoko)** — `GET /api/hpb/accounts` i `GET /api/hpb/transactions` su javni i vraćaju IBAN-e spojenih bankovnih računa i sve transakcije (ime i IBAN protustranke, opis plaćanja, sirovi JSON).
3. **SEC-03 (Visoko)** — U `direct` načinu svaki intent za `italk` cilja Safe kampanje, a svaki Safe kampanje je na statičnoj whitelisti, pa je **svaki anonimni intent „trusted“ kandidat** za stray resolver i SR-01 kapica se ne primjenjuje. Napadač bez ključa može držati otvoren intent s uobičajenim iznosom i preuzeti pripisivanje (`intent.paid` + `metadata`) tuđe uplate bez reference. Novac završi na pravom Safeu, ali zasluga/kredit ide napadaču.

Brojevi: Kritično 0 · Visoko 3 · Srednje 3 · Nisko 7 · Info 7. Ovisnosti: `hono@4.12.16` ima niz objavljenih savjeta (jedan primjenjiv: ReDoS u CORS middlewareu); wallet vuče `ethers@5.4.0`/`elliptic@6.5.4` kroz nekorišteni `@safe-global/safe-passkey`.

## Model prijetnji (ukratko)

**Imovina:** EURe u MPT Safeu `0x449a…af2e` i Safeovima tenanata; EURe u korisničkim Safeovima walleta; xDAI relayera; Monerium vjerodajnice tenanata (`tenant_rail.*_enc`, KEK); podaci o uplatiteljima (IBAN, ime, iznos) u `monerium_orders`, `monerium_webhook_events`, `transactions`; integritet pripisivanja uplate intentu (merchant `intent.paid`, potvrde o uplati); admin sesija.

**Napadači:**
- anonimni internet (javni API bez ključa: intenti, status po sid-u, sandbox, wallet registar, GP proxy; public repo = kod je poznat, vidi postmortem 0002);
- SEPA uplatitelj (kontrolira opis naloga i iznos, ne i ime/IBAN pošiljatelja);
- nositelj `pk_`/`sk_` ključa tenanta (ključ je identifikator, ne autentikacija — ADR 0016);
- kompromitirani Worker / Cloudflare račun (ima KEK i sve tajne; od ADR 0026 ne može pomaknuti novac izvan projektnog skupa);
- insajder s admin sesijom (može dodati kampanju, adresu, izdati ključ; postmortem 0002 pokazuje što to vrijedi);
- primatelj outbound webhooka (drži `INTENT_WEBHOOK_SECRET` / `outbound_webhook_secret`).

**Ulazne točke:** `POST /api/monerium/webhook[/t/:id]`, `POST/GET /api/intents*`, `/checkout/:sid`, `/potvrda/*`, `/api/receipts/*`, `POST /api/sandbox/*`, `/api/wallets*`, `/api/gp*`, `/api/hpb/*`, `/admin/*`, legacy bearer `/api/monerium/admin/*`, `/api/hpb/admin/*`, `/api/monerium/orders`; cron (`scheduled`); Pages funkcije `wallet/functions/api/*`.

---

## Nalazi

### Visoko

#### SEC-01 — Trovanje wallet registra: neautenticirani `POST /api/wallets/:credentialId/accounts` + sync na klijentu daje napadaču suvlasništvo nad „novim računom“ žrtve

**Gdje:**
- `backend/src/wallets/api.ts:206-238` — `POST /:credentialId/accounts` bez ikakve autentikacije ili dokaza posjeda; upisuje `safeAddress`, `saltNonce`, `recoveryOwner`, `name` za bilo koji `credentialId`.
- `backend/src/wallets/db.ts:85-103` — `upsertAccount` (`ON CONFLICT … DO UPDATE SET name`).
- `backend/src/wallets/api.ts:124-133` — `GET /family/:safeAddress` javno vraća `credential_id` svakog passkeya vezanog uz Safe; `backend/src/wallets/api.ts:104-117` javno vraća `signer_address` i javni ključ.
- `wallet/src/lib/accounts.ts:281-302` — `syncAccountsWithBackend` **PULL**: svaki zapis s backenda kojeg nema lokalno upisuje se u `domovina_accounts_v3` zajedno s `recovery_owner` iz odgovora.
- `wallet/src/routes/Landing.tsx:510`, `:561`, `:812` — sync se poziva pri svakom ulasku u wallet.
- `wallet/src/routes/Send.tsx:359-360` → `wallet/functions/api/relay.ts:207`, `:259`, `:286` — za `derived` račun klijent šalje `saltNonce` + `recoveryOwner` iz lokalnog zapisa, a relay cold-path deploya Safe s vlasnicima `[signer, recoveryOwner]`, prag 1.
- Dodatno: `backend/src/wallets/db.ts:54-60` — `registerWallet` popunjava `recovery_owner` ako je `NULL` za **postojeći** `credential_id` (bez autentikacije), a `wallet/src/lib/accounts.ts:385-388` za nedeployan bootstrap Safe uzima `recovery_owner` s backenda.

**Scenarij:**
1. Napadač zna žrtvin Safe (javno: primio je uplatu, adresa je na lancu). `GET /api/wallets/family/<safe>` → `credential_id`; `GET /api/wallets/<credential_id>` → `signer_address`.
2. Izračuna `S = predictSafeProxyAddress([signer_žrtve, EOA_napadača], salt)` (ista derivacija kao u `wallet/functions/_lib/safe.ts`, javno u repou).
3. `POST /api/wallets/<credential_id>/accounts {safeAddress: S, saltNonce: salt, recoveryOwner: EOA_napadača, name: "Glavni"}`.
4. Žrtva otvori wallet (pogotovo na drugom uređaju): sync doda račun „Glavni“. Ako žrtva na njega primi EURe (Receive pokazuje adresu aktivnog računa) ili s njega pošalje (relay deploya 1-od-2 Safe s napadačem kao vlasnikom), napadač kao vlasnik s pragom 1 prazni Safe bez ikakvog Face ID-a žrtve.

Varijanta bez „novog računa“: za legacy zapis bez `recovery_owner` i još nedeployan bootstrap Safe napadač upiše `recovery_owner` (`registerWallet` backfill), pa svaki račun koji žrtva kasnije sama izvede (`deriveAccount` koristi `id.recoveryOwner`) ima napadača kao suvlasnika.

**Utjecaj:** gubitak sredstava korisnika walleta bez njegove biometrije; izravno krši tvrdnju „a compromised server can't inject itself as a co-owner of accounts you later mint“ (`wallet/docs/security-custody-model.md` §5) — ovdje ne treba ni kompromitiran server, dovoljan je javni endpoint. Prethodni reviewi su „dokaz posjeda na walletima (P0-3)“ vodili kao otvoreno; ovaj nalaz pokazuje konkretan put do krađe.

**Popravak:**
1. Sve mutacije pod `/api/wallets/:credentialId/*` (register s postojećim id-om, `accounts`, `bind-phone`) tražiti **dokaz posjeda passkeya**: WebAuthn assertion nad izazovom koji server izda (`POST /api/wallets/challenge` → `challenge`; klijent potpiše; server verificira `@simplewebauthn/server`-om protiv `pub_key_x/y` iz registra, kao što admin passkey već radi u `backend/src/admin/auth/passkey.ts`). Alternativa bez WebAuthn-a: potpis ERC-1271 Safe-a (isti mehanizam kao `backend/src/receipts/api.ts:139-151`).
2. Na klijentu `syncAccountsWithBackend` smije **povući** samo zapise čiji je `recovery_owner` jednak lokalno poznatom `id.recoveryOwner` (ili koji se podudaraju s on-chain vlasnicima ako je Safe deployan); sve ostalo odbaciti i logirati. `ensureRecoveryOwner` za nedeployan Safe ne smije uzimati vrijednost s backenda (ili je smije uzeti samo uz dokaz posjeda iz točke 1).
3. `GET /family/:safeAddress` i `GET /:credentialId` ne vraćati javno `credential_id` tuđih zapisa; ako je potrebno za cross-TLD linking, vratiti samo `signer_address`/`safe_address` bez `credential_id`.

**Kako provjeriti:** test u `backend/test/`: `POST /api/wallets/<cred>/accounts` bez potpisa → 401; s potpisom drugog ključa → 403; s valjanim → 200. Test u `wallet/functions/__tests__` ili vitest za `accounts.ts`: remote zapis s `recovery_owner` ≠ lokalnom se ne upisuje. Ručno: ponoviti korake 1–4 na stagingu i potvrditi da račun ne nastaje.

#### SEC-02 — Javni `GET /api/hpb/accounts` i `GET /api/hpb/transactions` otkrivaju IBAN-e spojenih bankovnih računa i sve transakcije (PII)

**Gdje:** `backend/src/index.ts:82-94` (nema middlewarea za autentikaciju; `legacyHpb` bearer se montira tek na `/api/hpb/admin`, `index.ts:238-241`); `backend/src/db.ts:100-137` — `listAccounts` vraća `iban`, `name`; `listTransactions` vraća `remittance_info`, `counterparty_name`, `counterparty_iban`, `raw_json` (do 200 redaka po računu).

**Scenarij:** `curl https://mpt.domovina.ai/api/hpb/accounts` → popis `account_id`-ova i IBAN-a; `curl …/api/hpb/transactions?account_id=<id>` → godinu dana transakcija s imenima i IBAN-ima uplatitelja (Enable Banking vuče `date_from = now − 365 d`, `backend/src/providers/enable_banking.ts:207-217`).

**Utjecaj:** otkrivanje osobnih podataka uplatitelja i stanja na računu tenanta svakome na internetu. Jedino što ublažava jest to što tablice `accounts`/`transactions` možda nemaju redaka u produkciji (HR IBAN listener je po README-u „u planu“; vidi „Za provjeru“). Endpoint postoji i radi neovisno o tome.

**Popravak:** premjestiti oba endpointa pod `/admin/api/hpb/*` (sesija, `backend/src/admin/opsRoutes.ts:36-82` već ima `authorizations`) i ukloniti javne rute; `/api/hpb/institutions` smije ostati javan (vraća samo popis banaka). Ako neki klijent treba čitati izvode, dati mu `sk_` ključ i filtrirati po tenantu.

**Kako provjeriti:** test: `GET /api/hpb/accounts` i `/api/hpb/transactions?account_id=x` → 404/401 bez admin sesije; `GET /admin/api/hpb/accounts` sa sesijom → 200.

#### SEC-03 — U `direct` načinu svaki anonimni intent je „trusted“ kandidat: preuzimanje pripisivanja uplate bez reference (SR-01 je u praksi poništen)

**Gdje:**
- `backend/wrangler.toml:98` `INTENT_REQUIRE_TENANT_KEY = "0"`; `backend/src/tenants/auth.ts:51-53` — bez ključa → `italk`; `backend/src/intents/api.ts:86-90`.
- `backend/src/intents/api.ts:114-120` — u `direct` načinu intent smije ciljati samo Safe kampanje (`findCampaignBySafe`).
- `backend/src/tenants/admin.ts:148-153` + `backend/src/tenants/db.ts:208-225` — svaka registrirana kampanja ide i u `tenant_payout_addresses` sa `source = 'admin'`.
- `backend/src/intents/db.ts:73-79` — `TRUSTED_CANDIDATE_SQL`: kandidat je trusted ako je odredište na statičnoj whitelisti (`source IN ('admin','seed')`) **ili** je stvoren `sk_` ključem. Tko ga je stvorio nije uvjet.
- `backend/src/intents/api.ts:156` — SR-01 kapica se preskače kad je `direct` (`!secretKey && !direct && …`), dakle za `italk` danas **nikad**.
- `backend/src/monerium/strayResolver.ts:77-95` — među trusted kandidatima odlučuje najnoviji (`created_at DESC`); `backend/src/monerium/forward.ts:221-234`, `:806-809` — forward uzima prvi nezauzeti sid iz tog redoslijeda.
- `backend/src/intents/confirm.ts:299-311` + `backend/src/intents/outbound.ts:41-58`, `:132` — `intent.paid` s `metadata` intenta ide merchantu.

**Scenarij:** energy.domovina.ai ne šalje ključ (ADR 0017 §Za potrošače). Donator D otvori checkout za 1,00 € na Safe kampanje C i plati Revolutom bez reference (ADR 0025 §Revolut: to je *normalan* slučaj). Napadač A svake minute `POST /api/intents {target: C, amount_eur: "1.00", metadata: {user: "A"}}` bez ključa (nema kapice, nema ključa, odredište je trusted). Uplata stigne: oba intenta su trusted, iste adrese → `match`, `sids = [A_najnoviji, D, …]` → forward/`direct_owed` zauzme **A-ov** sid, `intent.paid` s A-ovim `metadata` ode na webhook, D-ov intent ostane `pending` i istekne (D-ov checkout nikad ne pokaže „zaprimljeno“, jer `previewStraySid` isto bira A). Novac je na C (ispravno), ali zasluga, kredit, glas ili potvrda („rcpt1-unbound“) pripadaju A.

**Utjecaj:** integritet pripisivanja za sve klijente koji na `intent.paid` daju nešto vrijedno (Open SaaS krediti po ADR 0024, pinka/energy doprinosi). ADR 0018 taj rizik opisuje kao slučajnu zamjenu među legitimnim uplatiteljima, ne kao namjerno umetanje; SR-01 popravak („trusted“) štiti samo netrusted odredišta, a u `direct` načinu netrusted odredišta više ne postoje.

**Popravak (bilo koja od prve dvije, plus treća):**
1. Trusted kandidat = intent stvoren `sk_` ključem **ili** (statično odredište **i** intent stvoren `pk_` ključem poznatog klijenta). Anonimni intent (bez ključa) nikad nije kandidat za stray, neovisno o odredištu. Za to energy.domovina.ai/solardei moraju slati bar `pk_` (ADR 0016 to i planira: `INTENT_REQUIRE_TENANT_KEY=1`).
2. Ako anonimni intenti moraju ostati: u `resolveStray` kandidate s ključem rangirati ispred anonimnih, a među anonimnima kod više kandidata iste adrese **parkirati** (ne „najnoviji“), jer je redoslijed napadaču pod kontrolom.
3. SR-01 kapicu primijeniti i u `direct` načinu za pozivatelje bez `sk_` (ukloniti `!direct` iz uvjeta na `intents/api.ts:156`), s većom granicom za kampanje ako treba.

**Kako provjeriti:** test u `strayResolver.test.ts`: dva kandidata iste adrese, stariji s `created_with_key=1`, noviji anoniman → pobjeđuje stariji; dva anonimna → `conflict`/park. Test u `sandbox.test.ts`/`tenantIsolation.test.ts`: `POST /api/intents` bez ključa na kampanju 21. put → 429.

### Srednje

#### SEC-04 — Legacy bearer rute sa statičnim `ADMIN_TOKEN` još su montirane

**Gdje:** `backend/src/index.ts:216-217` (`/api/monerium/orders*`), `:237-245` (`/api/hpb/admin/*`, `/api/monerium/admin/*`); `docs/admin-auth.md:92-97` kaže „ukloniti nakon jednog ciklusa“ (od 2026-10-08). `backend/src/admin/opsRoutes.ts:115-127` `/replay-last` vraća cijeli zadnji webhook payload (IBAN, ime) + zaglavlja; `/api/monerium/orders` vraća sve ordere s IBAN-ima.

**Scenarij:** token iz curl skripte / shell povijesti / CI loga daje trajni, nerotirani, neaudit-vezani (`actor: 'admin-token'`) pristup PII-ju i `POST /api/monerium/admin/sync` + `/webhooks` (URL je pinovan na naše hostove, `opsRoutes.ts:24-25`, što je dobro).

**Popravak:** obrisati tri mounta i `ADMIN_TOKEN` iz `Env`; rotirati/obrisati secret (`wrangler secret delete ADMIN_TOKEN`). Ako skripte još trebaju bearer, uvesti kratkotrajni token izdan iz admin sesije.

**Kako provjeriti:** `GET /api/monerium/orders` s bilo kojim tokenom → 404; `grep -rn ADMIN_TOKEN backend/src` prazan.

#### SEC-05 — Ovisnosti s objavljenim savjetima: `hono@4.12.16` (backend) i `ethers@5.4.0`/`elliptic@6.5.4` preko nekorištenog `@safe-global/safe-passkey` (wallet)

**Gdje:** `backend/package-lock.json` (`hono 4.12.16`, `viem 2.50.4`, `ws 8.18.0`); `wallet/package-lock.json` (`@safe-global/safe-passkey 0.2.0` → `ethers 5.4.0`, `elliptic 6.5.4`, `ws 7.4.6`); `wallet/package.json` deklarira `@safe-global/safe-passkey`, a `grep -rn safe-passkey wallet/src wallet/functions` ne nalazi nijedan import.

`npm audit --omit=dev`: backend 3 high (hono ≤4.13.6: među njima ReDoS u CORS middlewareu preko `Access-Control-Request-Headers` — CORS je na `*` u `backend/src/index.ts:59-69`; ostali savjeti — JSX, JWT middleware, `app.mount`, Lambda adapteri, serve-static — ovdje se ne koriste), wallet 5 critical + 3 high (elliptic/ethers; nisu u bundleu ako nema importa, vidi „Za provjeru“), shopify/worker 0.

**Popravak:** `hono` ≥ 4.13.7 (ili zadnja 4.x) u backendu i shopify/workeru; ukloniti `@safe-global/safe-passkey` iz `wallet/package.json`; dodati `.github/dependabot.yml` (npm, tjedno, za `backend`, `wallet`, `shopify/worker`, `tools/funding`).

**Kako provjeriti:** `npm audit --omit=dev` u sva tri paketa bez high/critical; CI zelen; `npx vitest run` u backendu.

#### SEC-06 — `/api/gp-proxy/*` je neautenticirani otvoreni proxy prema `api.gnosispay.com` s lažiranim `Origin`

**Gdje:** `backend/src/gnosispay/proxy.ts:30-59` (sve metode, bilo koja putanja, tijelo i `Authorization` prolaze; `Origin: http://localhost:5173` i browser UA su hardkodirani), montirano u `backend/src/index.ts:266`. Nema rate limita ni vezanja uz sesiju walleta. README: kartice su „u planu“.

**Scenarij:** bilo tko koristi `mpt.domovina.ai` kao relej za proizvoljne pozive na GP API (brute-force, skeniranje, zlouporaba tuđih JWT-ova); GP WAF blokira naš egress ili nas partner prijavi; naš Worker troši kvotu.

**Popravak:** dok GP kartice nisu u produkciji, ne montirati proxy (zastavica `GP_PROXY=1`, default 0). Kad se uključi: allowlista putanja (`/api/v1/…` koje FE stvarno koristi), samo `GET/POST/PUT/DELETE` koje treba, zahtjev mora nositi `Authorization` (bez njega 401), rate limit po IP-u (KV ili WAF), ne lažirati `Origin` bez partnerskog dogovora.

**Kako provjeriti:** `curl -X POST https://mpt.domovina.ai/api/gp-proxy/anything` → 404 (isključeno) ili 401 (bez `Authorization`).

### Nisko

#### SEC-07 — `authorizeDirect` ne provjerava kampanju u trenutku namire; opoziv kampanje ne zaustavlja `direct_settle`/`direct_owed`

**Gdje:** `backend/src/tenants/whitelist.ts:277-298` — provjerava sid, tenant, mint adresu i status tenanta, ali ne `findCampaignBySafe` (za razliku od forward načina, koji whitelistu provjerava u trenutku forwarda, `whitelist.ts:233-236`, i ADR 0016 „opoziv djeluje odmah“). Provjera kampanje je samo pri kreiranju intenta (`intents/api.ts:114-120`). Alarm za D4 bez routera (`forward.ts:398-409`) kaže vlasnicima točno što prebaciti.

**Utjecaj:** u prozoru do 24 h (TTL intenta) opozvana kampanja i dalje dobiva `direct_settle` ili D4 dug; s ProjectRouterom na lancu odlučuje skup iz role, pa je šteta ograničena na knjigovodstvo i pogrešnu uputu u alarmu.

**Popravak:** u `authorizeDirect` nakon `tenant_mismatch` dodati `getCampaignBySafe(tenantId, intent.target_address)`; ako nema aktivne → `park: not_whitelisted` (ili novi razlog `campaign_revoked`).

**Kako provjeriti:** test u `directMode.test.ts`: intent na kampanju, kampanja opozvana, order minta na main Safe → `park`, ne `direct_owed`.

#### SEC-08 — Inbound webhook ne provjerava `webhook-timestamp` toleranciju

**Gdje:** `backend/src/monerium/webhook.ts:31-77` — potpis se računa nad `id.timestamp.body`, ali se vrijednost `timestamp` ne uspoređuje s trenutnim vremenom (Standard Webhooks preporuča ±5 min). Replay sprječava samo dedup po `webhook-id` (`backend/src/monerium/db.ts:493-506`, nikad se ne prazni — dobro), ali se zapis oslobađa pri grešci obrade (`db.ts:512-521`, `webhookHandler.ts:246-248`).

**Utjecaj:** stari uhvaćeni event može se ponovno isporučiti ako je njegov id bio oslobođen zbog privremene greške; posljedica je ponovna obrada koju latchevi ionako drže idempotentnom. Obrana u dubini.

**Popravak:** u `verifyWebhookSignature` odbiti `|now − timestamp| > 300 s` (`reason: 'timestamp_out_of_tolerance'`), s testom u `webhookRoute.test.ts`.

#### SEC-09 — `INTENT_WEBHOOK_SECRET` je i HMAC ključ koji drži primatelj (pinka) i naš autentikacijski ključ; usporedba nije konstantna

**Gdje:** `backend/src/tenants/rail.ts:166-169` (outbound potpis), `backend/src/index.ts:270-276` (`/api/onchain/scan`), `:280-292` (`/api/og-preview`), `backend/src/intents/onchainIndexer.ts:49`. Usporedba `key !== secret` (`index.ts:273`, `:283`).

**Utjecaj:** kompromitacija domovina-api/pinka-webhook daje pozive na `scan` i `og-preview` (SSRF je ograničen: `backend/src/og/preview.ts:20-44`). Timing usporedba je u praksi beznačajna na Workersima, ali repo drugdje koristi `timingSafeEqualString`.

**Popravak:** zaseban secret `INTERNAL_API_KEY` za te dvije rute i indexer; usporedba kao u `backend/src/receipts/routes.ts:14-19`.

#### SEC-10 — Samoposlužni sandbox: `return_url` daje open redirect s `mpt.domovina.ai`, `webhook_url` daje potpisane POST-ove na proizvoljan `https://` host

**Gdje:** `backend/src/intents/api.ts:93-98`, `:480-506` (sandbox `sk_test_` smije bilo koji `https://`), `backend/src/sandbox/api.ts:30-42` (`validateWebhookUrl` samo shema), `backend/src/checkout/page.ts:65-68` (`returnHref`). Sandbox ključ dobije svatko (`POST /api/sandbox/tenants`, 5/IP/dan).

**Utjecaj:** phishing stranica na našoj domeni (ADR 0024 D5 to ublažava crvenom trakom „SANDBOX“ i bez IBAN-a); do 100 potpisanih POST-ova dnevno po tenantu prema tuđem URL-u.

**Popravak:** za sandbox tenante `return_url` i `webhook_url` ograničiti na host koji je developer potvrdio (npr. DNS TXT ili jednokratni GET s tokenom), ili barem blokirati `*.domovina.ai`/`*.pinka.*` i IP literal hostove. Rate limit webhookova po tenantu postoji; dodati i po ciljnom hostu.

#### SEC-11 — `POST /api/intents` bez rate limita i bez gornje granice za `label`/`metadata`

**Gdje:** `backend/src/intents/api.ts:75-175` (nema provjere duljine `label`, `metadata` se `JSON.stringify`-a u `backend/src/intents/db.ts:61` bez limita); `docs/runbook/rate-limits.md:300-304` — WAF pravilo za `/api/intents` **nije primijenjeno** (Free plan = jedno pravilo, zauzeto sandboxom). SR-01 kapica ne vrijedi za trusted odredišta (vidi SEC-03).

**Utjecaj:** punjenje D1 (red po zahtjevu, `metadata_json` do limita D1 reda ~1 MB), rast troška, zagušenje stray prozora (`STRAY_CANDIDATE_LIMIT = 200`, `intents/db.ts:341` — pun prozor samo logira upozorenje).

**Popravak:** `label ≤ 140`, `JSON.stringify(metadata).length ≤ 4096` → 400; kapica po IP-u u KV (npr. 60/10 min) za pozive bez `sk_`; Pro plan ili Workers rate-limit binding.

#### SEC-12 — `GET /api/intents/:sid` javno vraća `metadata` i `return_url` svima koji znaju sid

**Gdje:** `backend/src/intents/api.ts:306-317`, `:552`, `:569`. Sid je vidljiv banci, Moneriumu, u QR-u i (ako se koristi `PaymentRegistry`) na lancu (ADR 0022 §Problem).

**Utjecaj:** `metadata` merchant puni po volji (ADR 0024: Open SaaS stavlja korisničke identifikatore; migracija 0007 spominje `customer_email`). `return_url` može nositi interne parametre.

**Popravak:** `metadata` i `return_url` vraćati samo uz `sk_` ključ tenanta; javni status ostaje bez njih (checkout ih ne treba — `return_url` dobiva server-side pri renderu).

#### SEC-13 — `extractSessionId` pretražuje cijeli JSON ordera, ne samo `memo`/`referenceNumber`

**Gdje:** `backend/src/monerium/sid.ts:33-45` (`candidates.push(JSON.stringify(order))`), koristi se u `backend/src/monerium/webhookHandler.ts:119` (sid na eventu, `publish`) i `backend/src/intents/lifecycle.ts:32` (`payment.received` merchantu).

**Utjecaj:** sid iz polja koje ne kontrolira naš QR (npr. `counterpart.details.name`, `meta.*`) može pokrenuti `payment.received` i SSE „zaprimljeno“ na tuđem intentu. Novčana odluka (`authorizeForward`) koristi samo memo/reference, pa je utjecaj informativan. Polja protustranke dolaze iz banke, pa je napad težak.

**Popravak:** ukloniti fallback na cijeli JSON (ili ga ograničiti na `meta.*` polja koja Monerium dokumentira).

#### SEC-14 — Potpis za `POST /api/intents/:sid/receipt` može se ponoviti 5 minuta (nema nonce-a)

**Gdje:** `backend/src/receipts/api.ts:22`, `:183-189` (`ts` ± 300 s, poruka = sid + ts).

**Utjecaj:** uhvaćeni zahtjev daje popis naknadno pokrivenih uplata (order id-ovi, iznosi, tenanti) — read-only, samo vlasnikovi podaci.

**Popravak:** server izdaje izazov (`GET /receipt/challenge` → nasumičan nonce u KV, TTL 5 min, jednokratan), poruka uključuje nonce.

### Info

#### SEC-15 — `onError` vraća `err.message` klijentu
`backend/src/index.ts:310-318`: poruke Moneriuma/D1/RPC-a (`Monerium /orders → 401: …`, SQL greške) idu u 500 tijelo. Vratiti generičku poruku, detalj u log.

#### SEC-16 — `hashIp` ima konstantan rezervni pepper
`backend/src/sandbox/db.ts:53-54`: ako ni `SANDBOX_IP_PEPPER` ni `PHONE_PEPPER` nisu postavljeni, pepper je literal `'mpt-sandbox'` (IP se može pogoditi iz hasha). Umjesto fallbacka: fail-closed (odbiti kreiranje) ili bar `console.error`.

#### SEC-17 — Nema automatskog nadzora ovisnosti ni skeniranja tajni u CI-ju
`.github/` ima samo `ci.yml` i rulesete; nema `dependabot.yml` ni gitleaks/`secret-scanning` koraka. Repo je javan (postmortem 0002, lekcija 4). Grep radnog stabla i `git log -S` za privatne ključeve, `whsec_`, `sk_`, PEM i KEK vrijednosti nisu našli ništa stvarno (sve su placeholderi, docs ili generatori) — dobro, ali to treba automatizirati.

#### SEC-18 — `ALLOWED_ORIGINS` u produkciji sadrži `http://localhost:5173` i `http://localhost:3007`
`backend/wrangler.toml:62`. API ne koristi kolačiće za `/api/*`, pa je rizik mali; svejedno izdvojiti u lokalni `.dev.vars`/`[env.dev]`.

#### SEC-19 — Monerium access tokeni i Enable Banking JWT u KV-u u čistom tekstu
`backend/src/monerium/client.ts:49-81`, `backend/src/providers/enable_banking.ts:51-78`. Uobičajena praksa na Workersima; zabilježiti u model prijetnji (tko ima KV read, ima živi token tenanta do isteka).

#### SEC-20 — Nema alarma na osjetljive admin upise
Postmortem 0002 (otvorena stavka): `key.issue`, `address.add`, `campaign.add`, `rail.*` u `tenant_audit_log` ne šalju Telegram. Dodati `sendAlert` u `backend/src/tenants/admin.ts` (`:78`, `:154`, `:215`) i `railAdmin.ts`, plus alarm na `actor = 'admin:unknown'` i `admin_encoded_path_rejected`.

#### SEC-21 — D4: ručni prijenos vlasnika i ProjectRouter mogu platiti isti dug dvaput (poznato, ADR 0026)
`backend/src/monerium/forward.ts:553-570` (simulate → claim → broadcast) i `backend/src/monerium/outflowWatch.ts:352-378` (`settleOwed` traži samo `owed`, ne `broadcasting`). Latch sprječava dvostruko *knjiženje*, ne dvostruko *plaćanje* ako vlasnici prenesu ručno unatoč alarmu. Novac ostaje unutar vlastitih Safeova. Preporuka: kad rail ima ProjectRouter, alarm 🧾 ne ispisivati iznos/adresu za ručni prijenos (`forward.ts:388-396` već kaže „ne prenositi ručno“ — ostaviti samo to).

---

## Za provjeru (sumnje bez potvrde u kodu)

- **SEC-02 u produkciji:** imaju li tablice `accounts`/`transactions` redaka (`SELECT COUNT(*) FROM accounts`)? Ako da, tretirati kao incident otkrivanja podataka i zapisati u postmortem.
- **SEC-05 wallet bundle:** potvrditi da `ethers`/`elliptic` nisu u `wallet/dist` (`grep -l "elliptic" wallet/dist/assets/*.js` nakon `npm run build:default`). Ako jesu, podići severity na Srednje.
- **Hono CORS ReDoS:** provjeriti u GHSA savjetu točan raspon verzija i je li `4.12.16` pogođen; ako nije, SEC-05 je čista higijena.
- **`ADMIN_TOKEN` rotacija:** je li rotiran nakon postmortema 0002 (napadač je imao puni admin, ali ne nužno token)? `wrangler secret list`.
- **pipeline.domovina.ai `mount.ts`:** postmortem 0002 ostavlja otvorenim je li tamo portan preuski guard iz #106; nije u ovom repou.
- **WAF pravila i heartbeat:** `docs/runbook/rate-limits.md` (nije primijenjeno) i `docs/runbook/theft-detector.md` (`WATCH_HEARTBEAT_URL` nije postavljen) su operativne praznine, ne kod.
- **`/embed` clickjacking (prethodni P0-4):** `wallet/public/_headers:63-65` namjerno dopušta `frame-ancestors *`; `wallet/src/routes/Embed.tsx:78-84` ispravno koristi `event.origin`. Preklapanje iframea prozirnim slojem host stranice nije provjereno u ovom prolazu.
- **`workers.dev` ruta:** `backend/wrangler.toml` ne postavlja `workers_dev`; ako je preview host aktivan, admin ga preusmjerava na `ADMIN_HOST` (`mount.ts:82-88`), a javni API radi i tamo — provjeriti u dashboardu i isključiti.
- **Monerium `profile` na legacy railu:** `webhookHandler.ts:94-98` ne provjerava profil za `italk` (`rail.legacy`). Ako ITalk račun dobije drugi profil, event bi prošao; ADR 0017 to svjesno ostavlja.

## Što je dobro napravljeno (ne dirati)

- Webhook atribucija isključivo tajnom tenanta iz URL-a, bez isprobavanja tajni; neverificirani payload se krati na 4 KB i čuva samo `webhook-*`/UA/IP zaglavlja (`webhookHandler.ts:100-102`, `:121-126`); tijelo > 64 KB odbijeno prije D1 (`index.ts:157-164`).
- `authorizeForward` kao jedina točka odluke; latchevi `ux_forwards_live` (0016) i `ux_forwards_resolved_sid` (0018) čine INSERT odlukom; svaki prijelaz stanja forwarda ide kroz `transitionForward` sa SQL guardom (`monerium/forwardStates.ts`, `monerium/db.ts:372-394`).
- `direct` način nikad ne potpisuje (`forward.ts:132-134` drugi zasun), ProjectRouter se učitava samo kad su svi dijelovi prisutni (`rail.ts:118-122`), simulacija ide prije latcha (`forward.ts:553-570`), a `009` generator provjerava `owner/avatar/target`, mastercopy i strane module prije potpisa (`safe-tx/009-project-router-role.mjs:130-152`) i traži fork-simulaciju.
- Tajne tenanata: AES-256-GCM s AAD `<tenant>|<field>`, rotacija KEK-a s PREV ključem, `redactRail` nikad ne vraća tajne (`tenants/secrets.ts`, `onboarding.ts:282-308`).
- Admin: `__Host-` kolačić, sha-256 tokena u D1, Origin CSRF na svakoj mutaciji, CSP nonce, Access JWT s `iss`/`aud`, passkey upis samo uz svježu prijavu (`admin/auth/*`), popravak percent-encoded putanje s regresijskim testom (`test/adminAuth.test.ts:47-51`), Monerium webhook URL pinovan na vlastite hostove.
- Reroute i offrail: provjera iznosa i stanja (SR-02), legovi tx-a (OF-01/02), on-chain provjera prije `resolved_offrail`.
- Sandbox tenanti nemaju `tenant_rail` pa su izvan svih novčanih putova; `return_url` samo uz `sk_`; test ključevi vežu se samo uz sandbox tenante.
- Potvrde: `sid` kao obveza na ključ, lazy popis samo uz potpis vlasnika, `.ots` prihvaćen samo ako sidri isti `chain_head`.
- Escapiranje: `escapeAttr`/`jsonForScript`/`esc` dosljedno u checkoutu, potvrdama i admin ekranima; `innerHTML` u adminu puni se escapiranim vrijednostima.
- CI: `tsc`, vitest, dry-run bundle, compat-check (stari testovi na novom kodu), `permissions: contents: read`, rulesets na `main`.
- Nema tajni u gitu ni u povijesti (provjereno grep-om i `git log -S`).

## Zadaci za Opus 5.5 (po prioritetu)

- [ ] SEC-01 Dokaz posjeda passkeya (ili ERC-1271) za `POST /api/wallets/:credentialId/accounts`, `bind-phone` i backfill `recovery_owner`; klijent povlači samo zapise s poznatim `recovery_owner`; `GET /family` bez `credential_id`.
- [ ] SEC-02 Ukloniti javne `GET /api/hpb/accounts` i `GET /api/hpb/transactions`; preseliti pod `/admin/api/hpb/*`; provjeriti ima li produkcija redaka (postmortem ako ima).
- [ ] SEC-03 Anonimni intent nije stray kandidat (ili park kod više anonimnih kandidata); SR-01 kapica i u `direct` načinu; plan za `INTENT_REQUIRE_TENANT_KEY=1` (energy/solardei šalju `pk_`).
- [ ] SEC-04 Obrisati legacy bearer mountove (`/api/monerium/orders*`, `/api/monerium/admin`, `/api/hpb/admin`) i `ADMIN_TOKEN`.
- [ ] SEC-05 `hono` ≥ 4.13.7 (backend, shopify/worker); ukloniti `@safe-global/safe-passkey`; `dependabot.yml`.
- [ ] SEC-06 GP proxy iza zastavice (default isključen); kad se uključi: allowlista putanja, obavezan `Authorization`, rate limit.
- [ ] SEC-07 `authorizeDirect` provjerava aktivnu kampanju u trenutku namire.
- [ ] SEC-08 Tolerancija `webhook-timestamp` ±300 s.
- [ ] SEC-09 Zaseban interni ključ za `/api/onchain/scan`, `/api/og-preview`, indexer; konstantna usporedba.
- [ ] SEC-10 Sandbox `return_url`/`webhook_url`: potvrda hosta ili blokada vlastitih domena i IP literala.
- [ ] SEC-11 Limiti `label`/`metadata`; kapica po IP-u za pozive bez `sk_`.
- [ ] SEC-12 `metadata` i `return_url` samo uz `sk_` na `GET /api/intents/:sid`.
- [ ] SEC-13 `extractSessionId` bez pretrage cijelog JSON-a.
- [ ] SEC-14 Nonce za potpis potvrde.
- [ ] SEC-15 Generička 500 poruka.
- [ ] SEC-16 `hashIp` bez konstantnog fallbacka.
- [ ] SEC-17 Secret scanning u CI (gitleaks) + dependabot.
- [ ] SEC-18 `localhost` origini izvan produkcijskog `ALLOWED_ORIGINS`.
- [ ] SEC-20 Telegram alarm na `key.issue`/`address.add`/`campaign.add`/`rail.*` i na `admin:unknown`.
- [ ] Za provjeru: stanje `accounts`/`transactions` u prod D1, wallet bundle (ethers/elliptic), rotacija `ADMIN_TOKEN`, `workers.dev` host, WAF i heartbeat iz runbooka.
