# Backend money rail — nalazi (Fable 5.1, 2026-10-02)

Opseg: `backend/src/**` na HEAD `4b39998`. Svaki nalaz je traceovan protiv
stvarnog koda (file:line), ne protiv dokumentacije. Oznake:

- **MONEY** — može izgubiti, zaglaviti ili pogrešno prijaviti novac.
- **SEC** — napadač bez tajne može nešto postići.
- **BUG** — pogrešno ponašanje bez direktnog gubitka.
- **RISK** — latentno ili operativno; postaje MONEY/SEC pod promjenom konfiguracije ili skale.

Za svaki nalaz: što je, gdje je, kako puca, kako popraviti. Implementacijski
redoslijed i acceptance kriteriji su u `implementation-plan.md`.

---

## A. Stanje nalaza iz srpnja 2026 (`docs/reviews/2026-07-fable5/`)

Provjereno čitanjem koda na HEAD-u. Ništa od toga nije pretpostavljeno.

| ID | Stanje | Dokaz |
|---|---|---|
| BW-01 / DB-02 underpayment → `paid` | **OTVORENO** | `intents/db.ts:76-108` — `markIntentPaid` upisuje `amount_received_cents`, nikad ga ne uspoređuje s `amount_cents`. `tenants/whitelist.ts:88-145` veže samo adresu, ne iznos. |
| BW-02 / DB-01 / WR-01 dvostruki forward | **OTVORENO** | `monerium/forward.ts:109-115` check-then-act; `migrations/0006` nema UNIQUE na `order_id`; `router/safe.ts:195` nema nonce serijalizaciju. |
| BW-03 dedup prije obrade | **RIJEŠENO (uz ostatak)** | `index.ts:247-255` oslobađa claim kad obrada pukne. Ostatak: greške unutar `waitUntil` (`maybeForward`, `notifyOrderLifecycle`) claim ne oslobađaju — pokriveno alarmom, ne retryjem. |
| BW-04 neuspjeli broadcast bez retryja | **DJELOMIČNO** | Telegram alarm dodan (`forward.ts:194-199, 227-231`); automatski retry i dalje ne postoji, nema ni admin retryja (vidi BW-17). |
| BW-05 / DB-03 PII na javnim rutama | **OTVORENO** | `index.ts:82-94` (`/api/hpb/accounts`, `/api/hpb/transactions`), `index.ts:262-271` (`/api/monerium/orders(/:id)` — cijeli `raw_json` s IBAN-om i imenom platitelja). |
| BW-06 GP proxy open relay | **OTVORENO** | `gnosispay/proxy.ts:30-59` — `api.all('/*')` bez ikakve provjere. |
| BW-07 ne-konstantna usporedba tajne | **OTVORENO** | `index.ts:412` i `index.ts:422` — `key !== secret`. |
| BW-08 forward gate bez currency provjere | **OTVORENO** | `index.ts:239-244` — gate je `kind && eventType && state && key`, `currency` se nigdje ne gleda. |
| BW-09 ADDR_RE granica | **RIJEŠENO** | `monerium/sid.ts:9` negativni lookahead + `test/sid.test.ts:74-88`. |
| BW-11 `expires_in_seconds` NaN → 500 | **OTVORENO (nisko)** | `intents/api.ts:74-77` — string koji nije broj daje `NaN` → `expires_at = NaN` → D1 odbije NOT NULL → 500. |
| BW-12 `order.state` vs `meta.state` | **DJELOMIČNO** | Helper `orderState()` postoji (`monerium/orderState.ts:25`) i reconcile ga koristi (`reconcile.ts:59,82`), ali webhook gate (`index.ts:242`) i dalje čita goli `order.state`. |
| BW-13 webhook sprema neograničen payload prije potpisa | **OTVORENO** | `index.ts:156-188` — `rawBody` bilo koje veličine ide u D1 i kad potpis ne valja. |
| BW-14 timestamp tolerancija | **OTVORENO (nisko)** | `monerium/webhook.ts:31-77` — nema provjere `webhook-timestamp`. |
| CT-01 safe-tx 005 delegatecall bez unwrappera | **OTVORENO, latentno** | `PAYMENT_REGISTRY_ADDRESS = ""` u `wrangler.toml:275` → registry put ugašen; batch 005 vjerojatno nije izvršen. Ostaje opasno ako se uključi bez 006 scopinga. |
| CT-03 `getForwardStatus` ne razlikuje RPC grešku | **OTVORENO** | `router/safe.ts:217-230` — viem `getTransactionReceipt` baca kad receipta nema, pa grana `if (!receipt)` nikad ne radi; sve završi u `catch → 'unknown'`. |
| XD-02 jedan RPC bez fallbacka | **OTVORENO** | `router/safe.ts:142,221`, `intents/onchainIndexer.ts:63` — `GNOSIS_RPC_URL || 'https://rpc.gnosischain.com'`, nema `fallback([...])`. |
| XD-03 razmak u IBAN konstanti | **RIJEŠENO** | `lib/ui/home_page.dart:83`, `tenants/db.ts:36` — kanonski oblik bez razmaka. |
| Rujan A1–A5, B1–B3, D1 | **RIJEŠENO** | Potvrđeno: outbox (`intents/outbox.ts`), lifecycle eventi (`intents/lifecycle.ts`, `outbound.ts:120-168`), monotoni upsert (`monerium/db.ts:30-83`), reconcile cron (`monerium/reconcile.ts`). |

---

## B. Novi nalazi

### BW-15 [BUG → MONEY-semantika] Istek intenta se materijalizira samo 6-satnim cronom; svi putovi čitaju `state`, ne `expires_at`

**Gdje.**
- `index.ts:572-585` — `sweepExpiredIntents` samo pod `event.cron === '0 */6 * * *'`.
- `intents/stage.ts:169` — `if (!order) return intent.state === 'expired' ? 'expired' : 'awaiting_payment'` (ne gleda `now` vs `expires_at`).
- `intents/db.ts:95-96` — `markIntentPaid … WHERE state = 'pending'`; `db.ts:132-134` — `markIntentLate … WHERE state = 'expired'`.
- `checkout/page.ts:485-487, 576-585` — klijent broji do `0:00` i onda ostaje na „Čekamo uplatu — istječe za 0:00".

**Kako puca.**
1. Intent s TTL 15 min istekne u 12:15. Do 18:00 (sljedeći 6-satni cron) `GET /api/intents/:sid` i checkout vraćaju `awaiting_payment`; checkout pokazuje `0:00` i puls do 6 sati.
2. Uplata koja stigne u 14:00 flipa intent u **`paid`** i merchant dobije `intent.paid`. Ista uplata u 19:00 daje **`payment.late`**. Semantika „late" ovisi o tome kad je cron prošao, ne o ugovoru (TTL).
3. `monerium/reconcile.ts:37-46` `somethingInFlight` vidi pending intente do 2 dana → cron zove Monerium API svakih 10 min i kad ničeg stvarno nema.

**Popravak (predloženo).**
1. `computeStage`: kad nema ordera, `expired` ako `intent.state === 'expired' || now >= intent.expires_at`. Isti uvjet u `stageEnteredAt`. Dodati test.
2. Sweep prebaciti na 2-minutni cron (`UPDATE … WHERE state='pending' AND expires_at < ?` je jeftin zbog `idx_intents_pending_expires`).
3. U `flipPaidAndNotify` (`intents/confirm.ts:228`) prije `markIntentPaid` pozvati `expireIntentIfOverdue(sid, now)` (isti UPDATE ograničen na jedan sid), pa tek onda paid/late. Tako je rezultat deterministički: uplata nakon `expires_at` je **uvijek** `late`.
4. **Odluka za Matiju**: ako je poslovno poželjno da uplata unutar, recimo, 1 h nakon isteka još bude `paid` (grace), definirati `LATE_GRACE_S` eksplicitno, ne prepustiti cronu. Preporuka: bez gracea; `late` je jasan signal merchantu.

**Ne dirati.** Atomski `WHERE state='pending'` ostaje. Samo se ispred njega dodaje deterministički korak.

---

### BW-16 [MONEY-RISK] `submitted` forward čiji tx nikad ne bude rudaren ostaje `submitted` zauvijek — bez alarma, intent nikad `paid`, i blokira reconcile red

**Gdje.**
- `intents/confirm.ts:208-226` — `reconcileSubmittedForwards`: `pending`/`unknown` → ništa.
- `monerium/db.ts:376-388` — `listSubmittedForwardsOlderThan` `ORDER BY id ASC LIMIT 50`.
- `router/safe.ts:217-230` — dropped tx i RPC pad oba daju `'unknown'`.

**Kako puca.** RPC vrati hash (broadcast OK), tx ispadne iz mempoola (gas skok, nonce rupa nakon paralelnog neuspjeha, RPC node koji nije propagirao). Redak ostaje `submitted`; svaki cron tick troši RPC poziv; intent ostaje `pending`/`expired`; merchant ništa ne dobije; nitko nije alarmiran. Kad se nakupi 50 takvih redaka (`LIMIT 50 ORDER BY id ASC`), noviji `submitted` forwardi se više nikad ne reconcilaju.

**Popravak.**
1. `getForwardStatus` vratiti bogatiji rezultat: `{kind:'confirmed'|'reverted'|'in_mempool'|'not_found'|'rpc_error'}` — `getTransactionReceipt` u try, pa `getTransaction(hash)`: ako i to vrati null → `not_found`.
2. U reconcileu: `not_found` i `updated_at < now - 30 min` → `status='failed', error='dropped_from_mempool'`, Telegram alarm (jednom), redak postaje kandidat za retry (BW-17). `rpc_error` → ne mijenjaj, ali alarmiraj ako traje > 1 h.
3. Reconcile upit: `ORDER BY updated_at ASC` + nakon obrade `updated_at = now` i za ne-promijenjene retke (tako nitko ne gladuje), ili uvesti `next_check_at`.
4. Test: dropped tx nakon 30 min → `failed` + 1 alarm + ne blokira sljedeće.

---

### BW-17 [OPS / MONEY-RISK] Nema operaterskog puta za ponovni forward; alarm „order obrađen, forward nije pokrenut" se šalje u točno jednom 10-minutnom prozoru

**Gdje.**
- `admin/app.ts` — postoji `POST /admin/api/outbox/:id/resend`, ne postoji ništa za `monerium_forwards`.
- `monerium/reconcile.ts:81-90` — `isStuckWithoutForward` je `true` samo kad je `age ∈ [900, 1500)` sekundi; ako cron taj tick preskoči (`somethingInFlight` false, deploy, CF incident) alarm se nikad ne pošalje.
- Jedini retry alat je ručna skripta `backend/safe-tx/003-manual-forward.mjs` s `ROUTER_PRIVATE_KEY` na laptopu.

**Popravak.**
1. `POST /admin/api/forwards/:id/retry` (Basic Auth, audit log): dopušteno samo za `failed`/`blocked`; ponovno prolazi `authorizeForward` (nikad ga ne zaobilazi); zahtijeva atomski zasun iz DB-04 da ne može trčati paralelno s webhookom.
2. `POST /admin/api/orders/:id/forward` za `processed` issue order **bez** forward retka (slučaj propuštenog webhooka): isti put, ista provjera.
3. Alarm „stuck without forward": čuvati `alerted_at` (nova kolona na `monerium_orders` ili KV ključ) i ponavljati svakih 6 h dok forward ne postoji — ne jednokratni prozor.
4. Admin UI (`/admin/forwards`): gumb „Pokušaj ponovno" na `failed`/`blocked` recima; prikaz `error`.

---

### BW-18 [SEC] Javni wallet-registry endpointi primaju neautenticirane upise za bilo koji `credentialId`

**Gdje.**
- `wallets/api.ts:60-101` — `POST /api/wallets` prima `credentialId, pubKeyX/Y, signerAddress, safeAddress, recoveryOwner` bez ikakvog dokaza posjeda.
- `wallets/api.ts:205-237` — `POST /api/wallets/:credentialId/accounts` dodaje račun (Safe + `recoveryOwner`) bilo kojem credentialu.
- `wallets/db.ts:53-62` — backfill `recovery_owner` za legacy retke (`WHERE recovery_owner IS NULL`): prvi tko pošalje vrijednost za tuđi credential, postavlja je.
- `wallets/api.ts:123-132` — `/family/:safeAddress` javno vraća sve `credential_id`-eve → napadač ih ne mora pogađati.

**Kako puca.** Napadač pročita `credential_id` žrtve preko `/family/<safe>`, pa POST-a `/accounts` s `{safeAddress: <svoj Safe>, recoveryOwner: <svoj EOA>, saltNonce}`. Pri sljedećem cross-device loginu `syncAccountsWithBackend` (WP-01) uvuče otrovan račun; ako `ensureRecoveryOwner` (WP-02) doda `recovery_owner` iz backenda kao vlasnika, napadač postaje su-vlasnik. Backend time krši ADR 0001 posredno: server ne radi recovery, ali može natjerati klijenta da ga napravi.

Ovo je serverska polovica WP-01/WP-02. Klijentsku polovicu (lokalna verifikacija) obrađuje `wallet-crypto-relayer.md`.

**Popravak.**
1. **Dokaz posjeda na svaki upis.** `GET /api/wallets/challenge` → random 32 B (KV, TTL 5 min). `POST` nosi WebAuthn assertion nad tim challengeom; server verificira ECDSA P-256 (`crypto.subtle.verify`, `{name:'ECDSA', hash:'SHA-256'}`) protiv `pub_key_x/y` iz tijela (registracija) ili iz retka (accounts). Alternativa za derived račune: EOA potpis `recovery_owner`-a nad challengeom (`viem.verifyMessage`).
2. **CREATE2 provjera na serveru.** `safeAddress === predict(signer(pubKeyX, pubKeyY), [recoveryOwner], saltNonce)` — konstante i kod već postoje u `wallet/functions/_lib/safe.ts`; izdvojiti u zajednički paket (vidi XD-01) i koristiti ovdje. Bez ovoga `wallet_registry` kao dinamični whitelist izvor (`tenants/db.ts:144-159`) znači „bilo koja adresa koju itko prijavi".
3. `recovery_owner` nepromjenjiv nakon prvog upisa koji prođe (1); backfill grana se briše.
4. Rate-limit (vidi BW-22).

---

### BW-19 [SEC-nisko] `/api/gp/sync` neautenticiran; `gp_signer` se zaključava na prvi upis

**Gdje.** `gnosispay/api.ts:44-76`, `gnosispay/db.ts:29-54` (`gp_signer` se nikad ne ažurira).
**Kako puca.** Bilo tko može za tuđi `(credentialId, safeAddress)` upisati `onboardingStep: 'ready'` ili zaključati pogrešan `gp_signer`. Danas je to samo keš (FE čita GP API izravno), pa je šteta UI-zbunjivanje.
**Popravak.** Isti dokaz posjeda kao BW-18, ili ukloniti mirror dok ne bude potreban.

---

### BW-20 [BUG-latentno MONEY] Ugovor duljine `sid`: server dopušta 6–64, Flutter dopušta ručni unos, a `asciiToBytes32` baca iznad 32 bajta

**Gdje.** `intents/api.ts:31` (`SID_RE {6,64}`), `router/safe.ts:254-262` (throw > 32 B), `lib/ui/home_page.dart:62` (korisnik može urediti sid).
**Kako puca.** Danas latentno (`PAYMENT_REGISTRY_ADDRESS = ""`). Čim se registry uključi, svaki intent sa sid-om > 32 bajta završi u `forward … FAILED: asciiToBytes32` → novac parkiran, alarm, ručni rad.
**Popravak.** `SID_RE` → `{6,32}` na serveru; Flutter `maxLength: 32` + ista validacija; test koji veže `SID_RE` i `asciiToBytes32` (`sid od 32 znaka prolazi, 33 pada na API-ju, ne u forwardu`).

---

### BW-21 [RISK] `x-mpt-key` nije u CORS `allowHeaders`

**Gdje.** `index.ts:67` — `allowHeaders: ['Content-Type', 'Authorization']`; `tenants/auth.ts:26` čita `x-mpt-key`.
**Kako puca.** Čim wallet PWA ili e-demokracija pošalju tenant ključ iz browsera, preflight pada. Prebacivanje na `INTENT_REQUIRE_TENANT_KEY=1` bez ovoga ruši sve browser klijente.
**Popravak.** Dodati `x-mpt-key` u `allowHeaders`. Uz to u `implementation-plan.md` stoji runbook za strict mode.

---

### BW-22 [RISK → SEC pod opterećenjem] Javne write rute bez rate-limita, bez ograničenja veličine, s napadačevim sadržajem koji ide merchantu

**Gdje.**
- `intents/api.ts:40-95` — `POST /api/intents` bez ključa (soft mode), `label`/`metadata` bez ograničenja veličine; `metadata` se prosljeđuje merchantu u `intent.paid` (`outbound.ts:100`).
- `index.ts:155-196` — webhook sprema cijeli `rawBody` + headere i kad potpis ne valja (BW-13).
- `wallets/api.ts` (BW-18), `gnosispay/proxy.ts` (BW-06).

**Kako puca.** D1 raste neograničeno (storage + write cost); `metadata` od 100 KB po intentu; merchant prima `metadata` koju je sastavio napadač (ako pinka iz nje čita npr. `user_id`, to je injekcija u merchantov sustav — nije provjereno u ovom repou).
**Popravak.**
1. CF WAF rate-limit pravila (dashboard ili Terraform, zapisati u `docs/runbook`): `POST /api/intents` 30/min po IP-u, `POST /api/wallets*` 10/min, `POST /api/monerium/webhook` 60/min, `/api/gp-proxy` 60/min.
2. Webhook: ako `rawBody.length > 64 KB` → 413 bez upisa; za nevaljan potpis spremiti najviše 4 KB payloada (dovoljno za dijagnozu).
3. Intent: `label ≤ 140`, `metadata` serijalizirano ≤ 2 KB, dubina 1, ključevi `[A-Za-z0-9_]{1,40}`; dokumentirati merchantu da je `metadata` echo klijentovog unosa, ne provjeren podatak.
4. Browser klijenti: env-gated Turnstile kao kod relayera (fail-open dok nije provisionirano).

---

### BW-23 [BUG] Webhook forward gate: nema `currency`, ne koristi `orderState()`

**Gdje.** `index.ts:239-244` vs `monerium/orderState.ts:25` i `reconcile.ts:59`.
**Kako puca.** (a) Ako Monerium ikad pošalje `meta.state` bez top-level `state`, reconcile orderu upiše `processed` (jer koristi helper), a webhook gate nikad ne okine forward → zaglavljen novac s alarmom. (b) Ne-EUR issue order (ako profil ikad dobije drugu valutu) bi se forwardao kao EURe u iznosu `amount`.
**Popravak.** `orderState(order) === 'processed' && (order.currency ?? 'eur').toLowerCase() === 'eur'`; park reason `unsupported_currency`. Test za oba.

---

### BW-24 [RISK] Admin ne izolira tenante: revoke/add rute ignoriraju `:id`

**Gdje.** `tenants/admin.ts:165-178` (`revokeCampaign` bez `tenant_id`), `:222-234` (`revokeApiKey` bez tenanta), `tenants/db.ts:273-292` (`addCampaign ON CONFLICT … SET tenant_id = excluded.tenant_id` — prepisuje vlasnika kampanje).
**Kako puca.** Danas jedan admin, pa je šteta samo greška u ruci. Čim drugi tenant dobije admin pristup (ili se Basic Auth zamijeni per-tenant ključevima), admin tenanta A može ugasiti kampanju tenanta B ili je preuzeti.
**Popravak.** `AND tenant_id = ?` u revoke upitima; `addCampaign`: ako redak postoji s drugim `tenant_id` → 409 `campaign_owned_by_other_tenant`. Test.

---

### BW-25 [RISK] On-chain indexer bez reorg dubine; URL ingest funkcije izveden string-replaceom

**Gdje.** `intents/onchainIndexer.ts:65-68, 128` (`latest`, kursor na `latest`), `:40-44` (`ingestUrl` iz `INTENT_WEBHOOK_URL`).
**Kako puca.** Reorg na Gnosisu je rijedak ali moguć u zadnjih nekoliko blokova; donacija kreditirana pa nestala. Promjena imena pinka funkcije tiho razbija indexer.
**Popravak.** `toBlock = latest - 12`; `PINKA_ONCHAIN_INGEST_URL` kao eksplicitna varijabla.

---

### BW-26 [RISK-nisko] Checkout polla svake 2 s zauvijek na `awaiting_payment` / `expired`

**Gdje.** `checkout/page.ts:619, 796-821`; svaki poll = `loadStageContext` (3 D1 upita) + povremeni RPC.
**Popravak.** Nakon isteka backoff na 10 s; prestati nakon 24 h uz poruku „osvježi stranicu"; `Cache-Control: no-store` već postoji na fetchu, dodati i na odgovor.

---

### BW-27 [BUG-nisko] `parseAmountCents` i `eurToWei` ne validiraju format; za > 2 decimale se razilaze

**Gdje.** `monerium/forward.ts:88-101`, `monerium/orderState.ts:30-34`.
**Kako puca.** Monerium danas šalje 2 decimale, pa latentno. `"12.345"` → cents 1235 (zaokruženo), wei 12.345 EURe → `amount_received_cents` ≠ forwardani iznos. Negativan ili znanstveni zapis (`"1e2"`) → `eurToWei` baca ili vrati besmislicu.
**Popravak.** Jedan `parseEurAmount(s): {cents, wei} | null` sa strogim `^\d{1,9}(\.\d{1,2})?$`; neuspjeh → park `invalid_amount` (fail-closed), ne throw.

---

### BW-28 [RISK, NEPROVJERENO] Monerium `listOrders` bez paginacije/ordera; reconcile pretpostavlja da su nedavni orderi u prvoj stranici

**Gdje.** `monerium/client.ts:119-128`, `reconcile.ts:53-57`.
**Što provjeriti.** Vraća li `/orders?profile=` sve ordere ili prvih N i kojim redom (docs.monerium.com lokalno u `monerium-wallet-ios/docs`). Ako je stranica ograničena i sortirana uzlazno, backstop za propušteni webhook tiho prestaje raditi nakon N ordera.
**Popravak.** Dodati `?state=`/`?limit=`/`?since=` ako postoje; alarm ako najstariji vraćeni order nije stariji od `LOOKBACK_S` (znak da prva stranica ne pokriva prozor).

---

### DB-04 [MONEY-BUG, = DB-01 operacionaliziran] Atomski zasun na `monerium_forwards` + nonce

**Gdje.** `migrations/0006` (samo indeksi), `monerium/forward.ts:109-115`, `router/safe.ts:141-143`.
**Popravak.**
1. Migracija `0016_forward_latch.sql`: `CREATE UNIQUE INDEX ux_forwards_live ON monerium_forwards(order_id) WHERE status IN ('pending','submitted','confirmed')`. Postojeći `failed`/`blocked` reci ne smetaju; postojeći duplikati `confirmed` po istom orderu (ako ih ima — provjeriti upitom prije migracije) moraju se ručno razriješiti.
2. `insertForward` za status `pending` → `INSERT OR IGNORE`; `changes === 0` → `return` (netko drugi već radi). `maybeForward` više ne treba prethodni `getForwardByOrder` SELECT (ostaje samo za log).
3. Nonce: `privateKeyToAccount(key, { nonceManager })` iz viema smanjuje sudare unutar istog izolata; preko izolata ne. Prihvatljiv međukorak je: zasun iz (1) garantira da su paralelni forwardi za **različite** ordere; nonce sudar tada obori jedan od njih u `failed` (bez gubitka), a BW-17 retry ga vraća. Robusna verzija (Durable Object kao serijalizator broadcasta) ostaje L-scope.
4. Test: dvije istovremene `maybeForward` za isti order → jedan `forward()` poziv.

---

## C. Što je dobro (ne „popravljati")

- **Outbox** (`intents/outbox.ts`): PK = webhook-id, klasifikacija odgovora, backoff tablica, `next_attempt_at` parkiran da cron ne utrči u in-flight pokušaj, potpis u trenutku slanja. Dobro promišljeno.
- **Monotoni upsert ordera** (`monerium/db.ts:30-83`) sa SQL rankom — jednostavan i točan; jednak rank se primjenjuje (važno: kasni `processed` webhook nakon reconcilea i dalje okida forward).
- **`authorizeForward`** je stvarno jedina točka odluke; testovi (`whitelist.test.ts`, `forward.test.ts`) pokrivaju svaki park razlog.
- **Settle single-fire** (`confirmForwardOnce` + `markIntentPaid WHERE pending`) i dalje ispravni; BW-15 dodaje korak **ispred**, ne mijenja ih.
- **Alert-test endpoint** i fail-open alerting s eksplicitnim `configured/ok` razlikovanjem.
- **`jsonForScript`** i `escapeAttr` u checkoutu; admin views dosljedno koriste `escapeHtml`/`esc`.
- **`FALLBACK_SEPA`** koristi se samo za prikaz, nikad za odluku o novcu — i to je zapisano u kodu.
- **Tenant ključ je identifikator, ne autentikacija** — iskreno dokumentirano u `tenants/auth.ts`; sigurnosna granica je whitelist. Nalazi BW-18/22 to ne osporavaju, nego traže da dinamični izvor whitelista (`wallet_registry`) ne bude „bilo tko".
