# Implementacijski plan za Opus 5.5 (Fable 5.1 review, 2026-10-02)

Glavni deliverable. Svaki zadatak je pisan da se može dati Opusu kao
**samostalan prompt**: što, gdje, kako, test koji dokazuje, i što se ne smije
dirati. Nalazi po ID-u su u `backend-money-rail.md`, `wallet-crypto-relayer.md`,
`wallet-ui-flutter.md`.

Opseg: **S** ≤ pola dana · **M** 1–2 dana · **L** > 2 dana / arhitektonski.

## NE DIRAJ (regresija ako se promijeni)

- EPC 10-linijski layout; HUB3 14 polja (FL-02/04 diraju duljinu/validaciju, ne layout).
- Monerium forward gating `issue && order.updated && processed` — BW-23 **dodaje** uvjete, ne mijenja postojeće.
- Settle single-fire: `confirmForwardOnce` + `markIntentPaid WHERE state='pending'`. BW-15 dodaje korak **ispred**, BW-01 dodaje usporedbu **unutar** iste atomske izjave.
- `authorizeForward` kao jedina točka odluke; BW-17 retry **prolazi** kroz nju.
- Monotoni upsert ordera (jednak rank se primjenjuje — to je ono što okida forward na kasni webhook).
- Outbox PK = webhook-id; postojeći id prefiksi (`int_`, `cmp_`, `blk_`) ostaju byte-identični.
- Relay pre-flight `getCode(safe)`; wallet nikad ne briše passkeye; server-side recovery trajno odbijen (ADR 0001); passkey dedup = get-first probe + excludeCredentials.
- sid multi-forme parsiranje (`=`→`.` itd.); `jsonForScript` escape u checkoutu.

## Redoslijed

```
P0 (ovaj tjedan, prije ikakvog novog featurea)
  P0-1 BW-01  amount na paid flipu            S
  P0-2 DB-04  atomski zasun na forwards        S   ─► P0-6, P1-1
  P0-3 BW-18  dokaz posjeda na wallet upisima  M   ─► (klijent) P1-5
  P0-4 WU-01  /embed clickjacking              M
  P0-5 BW-05/07/06 PII rute, timing, GP proxy  S
  P0-6 BW-17  admin retry forwarda             S   (treba P0-2)
  P0-7 BW-15  deterministički istek            S
P1 (sljedeća 2 tjedna)
  P1-1 BW-16  dropped-tx detekcija + reconcile red   S
  P1-2 FL-N-01/02/03 POS istina                       S
  P1-3 WP-07 + WU-03  send idempotencija + receipt    M
  P1-4 BW-22  rate-limit, veličine, Turnstile          S/M
  P1-5 WC-01/02/03 + WP-03  klijent ne vjeruje backendu M   (klijentska polovica P0-3)
  P1-6 BW-20/21/23/24/11  sitni backend guardovi       S
  P1-7 WU-02/04/05/06, WP-04/08/09/10/11/12, WC-06/07/09/11/12/13  S
  P1-8 WC-04/05 + WR-02/04/05  relayer hardening       S/M
P2 (kad slegne)
  P2-1 XD-01 CREATE2 parity test + zajednički paket    M
  P2-2 XD-02 RPC fallback                              M
  P2-3 BW-25/26/27/28, FL-02..08                       S
  P2-4 Test paket (regression za sve P0/P1)            M
  P2-5 safe-tx/006 on-chain scoping (odluka Matije)    —
```

---

## P0

### P0-1 [S] Amount rekoncilijacija na paid flipu — BW-01 / DB-02

**Promjene.**
1. `backend/src/intents/db.ts` `markIntentPaid`: u isti `UPDATE` dodati `AND ? >= amount_cents` (bind `amountReceivedCents`) tako da **underpayment nikad ne flipa** `paid`. Vraćati `{flipped, reason}`: ako `changes === 0`, drugi SELECT razlikuje `already_paid | expired | underpaid | not_found`.
2. Novi status za underpayment: `UPDATE payment_intents SET amount_received_cents=?, monerium_order_id=?, forward_id=?, forward_tx_hash=? WHERE sid=? AND state='pending' AND monerium_order_id IS NULL` (bez promjene `state`), + novi outbox event `payment.underpaid` (`undp_<sid>`) s `{expected_cents, received_cents, delta_cents, funds_location:'recipient'}` — novac **jest** proslijeđen primatelju (forward ne gleda intent iznos), merchant odlučuje.
3. Overpayment (`received > expected`): flipa `paid`; payload `intent.paid` već nosi oba iznosa — dodati `overpaid_cents` radi jasnoće.
4. `computeStage`: nova faza nije potrebna; dodati `amount_mismatch: 'under'|'over'|null` u `StageResult` da checkout/Flutter mogu reći „Primljeno 30 od 50 EUR".
5. `settleNonRoutedPaid` (self-target) ide istim putem automatski jer zove `flipPaidAndNotify`.

**Ne dirati.** `WHERE state='pending'` ostaje; samo se proširuje.

**Test** (`backend/test/confirm.test.ts`): €50 očekivano / €30 primljeno → nije `paid`, `payment.underpaid` jednom, `intent.paid` nikad; €50/€50 → `paid`; €50/€70 → `paid` + `overpaid_cents=2000`; dvostruki settle underpaid → event jednom.

**Pitanje za Matiju (ne blokira):** treba li `cmp:` kampanje tretirati drukčije (tamo nema očekivanog iznosa — ne; `contribution.sepa` ostaje kakav jest).

---

### P0-2 [S] Atomski zasun na `monerium_forwards` — DB-04 / BW-02(a)

**Promjene.**
1. Prije migracije: `SELECT order_id, COUNT(*) FROM monerium_forwards WHERE status IN ('pending','submitted','confirmed') GROUP BY order_id HAVING COUNT(*)>1` na produkciji; ako ima redaka, ručno razriješiti (očekivano 0 prema stanju od 2026-09-28).
2. `backend/migrations/0016_forward_latch.sql`: `CREATE UNIQUE INDEX ux_forwards_live ON monerium_forwards(order_id) WHERE status IN ('pending','submitted','confirmed');`
3. `monerium/db.ts` `insertForward`: `INSERT OR IGNORE`; vratiti `0` kad nije upisano. `forward.ts` `handleForward`: ako `forwardId === 0` → `console.log(already claimed)` + return. Isto za `self_noop` granu.
4. `maybeForward`: zadržati SELECT samo za log; odluka je na INSERT-u.
5. `router/safe.ts`: `privateKeyToAccount(key, { nonceManager })` (viem ≥ 2.x `nonceManager` iz `viem/nonce`) — smanjuje sudare unutar izolata. Dokumentirati da preko izolata ostaje sudar → `failed` → P0-6 retry.

**Test** (`forward.test.ts`): `insertForward` stub koji drugi put vrati 0 → `forward()` pozvan točno jednom; `failed` redak ne blokira novi `pending` (parcijalni indeks).

---

### P0-3 [M] Dokaz posjeda na wallet-registry upisima — BW-18 / BW-19 / WC-01 / WC-02 / WC-03 (serverska polovica)

Kontekst: `credential_id` je javan (`/api/wallets/family/:safe`, `dw_cred` URL param), pa je „znam credentialId" nula autentikacije. Napadni lanac je u `wallet-crypto-relayer.md` WC-01 (injektiran račun → uplata napadaču) i WC-02 (otrovan `recovery_owner` → napadač su-vlasnik svih budućih računa). Klijentska polovica je P1-5; **serverska ide prva** jer zatvara upis bez ikakve promjene klijenta.

**Promjene (backend).**
1. `GET /api/wallets/challenge` → `{challenge: base64url(32 B), expires_in: 300}`; KV `TOKEN_CACHE` ključ `wchal:<challenge>` s TTL 300 s, single-use (delete na verify).
2. `POST /api/wallets` i `POST /api/wallets/:credentialId/accounts` traže `proof`:
   - `proof.kind = 'webauthn'`: `{authenticatorData, clientDataJSON, signature}`. Server: parsira `clientDataJSON`, provjeri `type === 'webauthn.get'`, `challenge` je iz KV-a, `origin ∈ ALLOWED_ORIGINS`; `rpIdHash` u `authenticatorData` = SHA-256(`rpId` iz tijela/retka); verificira ECDSA P-256 (`crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, pubKey(x,y), derToRaw(signature), authenticatorData || SHA-256(clientDataJSON))`). Pubkey: za registraciju iz tijela, za accounts iz `wallet_registry` retka.
   - `proof.kind = 'eoa'`: `{signature}` nad porukom `domovina-wallet-registry:<challenge>`; `viem.verifyMessage({address: recoveryOwner, …})`. Dopušteno samo za `/accounts` kad je `recoveryOwner` već u retku.
3. CREATE2 provjera: `safeAddress === predictSafeProxyAddress(owners, saltNonce)` gdje su `owners = [signerFromPubKey(x,y)]` (bootstrap) ili `[signer, recoveryOwner]` (derived). Kod i konstante uzeti iz `wallet/functions/_lib/safe.ts` — **ne kopirati**: izdvojiti u `packages/safe-create2/` (vidi P2-1) i koristiti iz oba mjesta. Dok paket ne postoji, privremeno `import` relativnom stazom je prihvatljiv uz TODO.
4. `recovery_owner` backfill grana (`wallets/db.ts:53-62`) se briše; promjena `recovery_owner` samo kroz (2) s `eoa` dokazom **starog** ownera.
5. `/api/gp/sync`: isti `proof` ili ukloniti rutu (preporuka: ukloniti dok GP integracija ne bude iza feature flaga u produkciji).
6. Kompatibilnost: `INTENT_REQUIRE_PROOF=0|1` env flag; u `0` server logira `proof_missing` i prihvaća (jedan deploy ciklus da se klijent pusti), u `1` odbija 401.

**Promjene (wallet klijent).** `registerWalletWithBackend` / `registerAccountWithBackend` u `wallet/src/lib/accounts.ts` šalju `proof` (jedan dodatni `navigator.credentials.get` — koristiti postojeći assertion ako se registracija radi odmah nakon logina, da se izbjegne dupli Face ID; vidi WebAuthn iOS „already pending" memoriju).

**Test.** Vitest: valjan assertion → 200; krivi challenge → 401; pubkey ne odgovara → 401; `safeAddress` ≠ predict → 400 `address_mismatch`; replay istog challengea → 401.

---

### P0-4 [M] `/embed` clickjacking — WU-01 / WU-02

**Promjene.**
1. `wallet/public/_headers`: `/embed` zadržava `frame-ancestors *` (potreban za SDK), **sve ostale rute** dobivaju `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
2. Potvrda + potpis izlaze iz iframea: Embed na `send` naredbu renderira samo „Otvori potvrdu" gumb; klik otvara `window.open(WALLET_ORIGIN + '/confirm?req=<id>', 'dw_confirm', 'popup,width=420,height=640')`. `/confirm` (nova ruta, `frame-ancestors 'none'`) čita zahtjev iz `sessionStorage`/`BroadcastChannel('dw_confirm')`, prikazuje iznos/primatelja/host origin, radi Face ID + relay, vraća rezultat Embedu kroz `BroadcastChannel`, Embed ga `postMessage`-a hostu. Safari: `window.open` mora biti u user-gesture — klik na gumb u iframeu to jest.
3. Minimum ako (2) ne stigne u ovaj ciklus: u `Embed.tsx` (a) `postError('busy')` dok `stage.kind !== 'waiting'`, (b) handler gumba vezan na `requestId`, (c) gumb `disabled` prvih 800 ms nakon rendera, (d) odbiti naredbe kad `document.visibilityState !== 'visible'`.
4. ADR 0009 dopuniti sekcijom „Clickjacking model" (što SDK garantira, što ne).

**Test.** Playwright: host stranica koja uokviri `/embed` s `opacity:0` i pošalje `send` — klik na hostov gumb ne smije doći do potpisa (gumb nije u iframeu / disabled). Unit: druga `send` dok je kartica otvorena → `error:'busy'`.

---

### P0-5 [S] Zatvaranje javnih ruta — BW-05 / DB-03, BW-07, BW-06

1. `index.ts`: `/api/hpb/accounts`, `/api/hpb/transactions`, `/api/monerium/orders`, `/api/monerium/orders/:id` → iza `bearerAuth({token: ADMIN_TOKEN})` (premjestiti pod `moneriumAdmin` / `admin` sub-app). Provjeriti u `lib/` i `wallet/` tko ih zove (grep `monerium/orders`, `hpb/`): ako Flutter history koristi `/api/monerium/orders`, dati mu `GET /api/intents/:sid` (već vraća sve što treba) ili scoped `GET /api/monerium/orders?sid=` koji vraća **samo** `id, state, amount, currency, placed_at, processed_at, tx_hashes` (bez IBAN/ime/raw_json).
2. `index.ts:412,422`: `timingSafeEqualString` izvući iz `monerium/webhook.ts` u `lib/crypto.ts` i koristiti na oba mjesta.
3. `gnosispay/proxy.ts`: dopušteno samo kad `GP_PROXY_ENABLED=1`; allowlist putanja (`/api/v1/auth/*`, `/api/v1/user*`, `/api/v1/safe*`, …— popis iz `wallet/src/lib/gnosispay.ts`); `Authorization` header obavezan; CF rate-limit 60/min/IP.

**Test.** curl bez tokena → 401 na sve četiri rute; Flutter/wallet i dalje rade (ručna provjera); grep `!== secret` prazan.

---

### P0-6 [S] Admin retry forwarda + trajni alarm — BW-17 (treba P0-2)

1. `admin/app.ts`: `POST /admin/api/forwards/:id/retry` — samo `failed`/`blocked`; učita order iz D1, zove `maybeForward(makeForwardDeps(env), order)` (prolazi `authorizeForward`, zasun iz P0-2 sprječava paralelu); audit `forward.retry` s actorom; vraća novi `forward_id`/status.
2. `POST /admin/api/orders/:id/forward` — za `processed` issue order bez live forward retka; isti put.
3. `monerium/reconcile.ts`: `isStuckWithoutForward` → bez prozora; KV ključ `stuckalert:<orderId>` s TTL 6 h → alarm se ponavlja svakih 6 h dok forward ne postoji.
4. Admin UI `/admin/forwards`: gumb „Pokušaj ponovno" + prikaz `error`; `/admin/orders/:id`: gumb „Pokreni forward" kad nema forwarda.

**Test.** `retry` na `confirmed` → 409; na `failed` → `forward()` pozvan jednom, audit red; dva paralelna retryja → jedan broadcast.

---

### P0-7 [S] Deterministički istek intenta — BW-15

1. `intents/stage.ts` `resolveStage`: `if (!order) return (intent.state === 'expired' || now >= intent.expires_at) ? 'expired' : 'awaiting_payment'`; `now` proslijediti (već je u `StageInput`). `stageEnteredAt` isto.
2. `index.ts` scheduled: `sweepExpiredIntents` na **svaki** tick (2 min), ne samo 6-satni.
3. `intents/db.ts`: `expireIntentIfOverdue(env, sid, now)`; `intents/confirm.ts` `flipPaidAndNotify` ga zove prije `markIntentPaid`.
4. Checkout `page.ts`: kad countdown dođe do 0 lokalno, prikaži „Sesija je istekla…" bez čekanja servera (UI je ionako sekundarni; server ostaje istina).

**Odluka za Matiju:** grace period nakon isteka (preporuka: 0).

**Test** (`stage.test.ts`, `confirm.test.ts`): `now > expires_at`, bez ordera → `expired`; settle nakon `expires_at` ali `state='pending'` → `late`, ne `paid`.

---

## P1

### P1-1 [S] Dropped-tx detekcija + reconcile red bez gladovanja — BW-16 / CT-03

1. `router/safe.ts` `getForwardStatus` → `{kind:'confirmed'|'reverted'|'in_mempool'|'not_found'|'rpc_error', error?}`: `getTransactionReceipt` u try/catch (`TransactionReceiptNotFoundError` → nastavi), zatim `getTransaction` (null → `not_found`).
2. `intents/confirm.ts`: `not_found && updated_at < now - 30*60` → `markForwardFailed(id, 'dropped_from_mempool')` + alarm; `rpc_error` → log, bez promjene.
3. `monerium/db.ts` `listSubmittedForwardsOlderThan`: `ORDER BY updated_at ASC`, i nakon svake provjere `updated_at = now` (dodati `touchForward`).
4. Zadržati postojeće tipove za pozivatelje preko malog adaptera da `pollForwardConfirmation` ostane čitljiv.

**Test.** dropped nakon 30 min → `failed` + 1 alarm; 60 zombija ne blokira 61. redak.

### P1-2 [S] POS govori istinu — FL-N-01 / FL-N-02 / FL-N-03 / FL-N-04

1. `payment_status_page.dart`: redni broj polla; ignorirati odgovor s manjim brojem; nakon terminalnog snapshota odbaciti ne-terminalne.
2. `_buildPosView`: zeleno samo za `minted/forwarding/settled` ili (`receivedProcessing && reviewExpected == false`); `reviewExpected == true` → žuto „Zaprimljeno — provjera u tijeku, ne isporučuj još"; `settled` jedini ima punu kvačicu.
3. `payment_status.dart`: parsirati `forward_error` i status koraka `forwarding`; failed/blocked → žuto „Prosljeđivanje nije uspjelo — kontaktiraj podršku"; `PaymentStage.unknown(wire)` umjesto `orElse: awaitingPayment`.
4. Isti copy u `checkout/page.ts` (tablica je dijeljena po dogovoru u komentaru).

**Test** (`test/payment_status_test.dart`): race (A spor, B terminal) → terminal ostaje; `fromWire('nova_faza')` → unknown; forward failed → nije zeleno.

### P1-3 [M] Send idempotencija + receipt — WP-07 / WU-03

1. Klijent (`wallet/src/lib/relay.ts`): `AbortSignal.timeout(20 s)`; `Idempotency-Key: <safeTxHash>` header; na timeout/mrežnu grešku **ne** prikazati „neuspješno" nego „Provjeravam…" i pozvati `GET /api/relay/status?key=<safeTxHash>`.
2. Relayer (`wallet/functions/api/relay.ts`): KV `relay:idem:<key>` → `{txHash}` upisan **prije** broadcasta kao `pending` i nakon s hashom; ponovljeni zahtjev s istim ključem vraća postojeći hash umjesto novog broadcasta. (Nonce-based dedup nije dovoljan jer `getSafeTxHash` čita novi nonce.)
3. `Send.tsx`/`Embed.tsx`: nakon hasha `waitForTransactionReceipt` u pozadini → „Potvrđeno"/„Neuspjelo (revert)"; `addRecipient` tek na uspjeh; refetch balancea.

**Test.** Relayer unit: isti `Idempotency-Key` dvaput → jedan `sendTransaction`.

### P1-4 [S/M] Rate-limit, veličine, Turnstile — BW-22 / BW-13

1. CF WAF rate-limit pravila (dashboard; zapisati ID-eve u `docs/runbook/rate-limits.md`): `POST /api/intents` 30/min/IP; `POST /api/wallets*` 10/min/IP; `POST /api/monerium/webhook` 60/min/IP; `/api/gp-proxy` 60/min/IP; `/api/relay` prema postojećem threat modelu.
2. `index.ts` webhook: `if (rawBody.length > 65536) return 413` prije ičega; kad `!verify.ok` spremiti `rawBody.slice(0, 4096)`.
3. `intents/api.ts`: `label.length ≤ 140`; `JSON.stringify(metadata).length ≤ 2048`, dubina 1, ključevi `^[A-Za-z0-9_]{1,40}$`; dokument za merchante: `metadata` je echo klijentovog unosa.
4. Turnstile na `POST /api/intents` iz browser origina, env-gated (`TURNSTILE_SECRET` prazan = fail-open), isti obrazac kao relayer.

### P1-5 [M] Klijent ne vjeruje backendu — WC-01 / WC-02 / WC-03 / WP-01 / WP-02 / WP-03 / WC-08 / WC-09

Backend postaje **cache**, ne izvor istine (ADR 0001). Točne linije u `wallet-crypto-relayer.md`.

1. **Sync računa** (`wallet/src/lib/accounts.ts:288-301`, `Embed.tsx:229-239`): remote red se prihvaća samo ako `r.recovery_owner === id.recoveryOwner` **i** `predictSafeAddressForOwners(derivedOwners(id.signerAddress, id.recoveryOwner), 1, r.salt_nonce) === r.safe_address`. Ostalo: `console.warn` + odbaciti (ne „untrusted" stanje — jednostavnije i nema UI površine za pogrešku).
2. **Recovery owner** (`Landing.tsx:546`, `accounts.ts:381-394`): `enterByCredentialId` ne upisuje `remote.recovery_owner`; `ensureRecoveryOwner` ga izvodi **samo** iz on-chain `getOwners(bootstrapSafe)` (codeless kandidat). Backend grana za nedeployani Safe se briše (bootstrap Safe je uvijek deployan pri kreiranju). Bez codeless kandidata → `null` + UI poruka (WC-08). Ispraviti komentar `accounts.ts:382-384`.
3. **Restore identiteta** (`Landing.tsx:537-548, 934-955`, `Send.tsx:277-290`, `Embed.tsx:119-126`): `signerAddress` uvijek lokalno iz pubKeya; `safe_address` prihvatiti samo ako on-chain `getOwners(safe)` sadrži taj signer; pubKey iz backenda mora biti jedan od 2 kandidata iz `recoverPubkeys()` nad stvarnom assertionom (već postoji u `recover.ts`).
4. **Tombstone** za arhivirane derived račune (`archived: Record<safeAddress, unixAt>` u `domovina_accounts_v3`); sync preskače tombstonirane.
5. **Salt race** (WC-09): `deriveAccount` najprije `await syncAccountsWithBackend`; salt = `max(local, remote) + 1`.

**Test** (prvi wallet testovi, vidi P2-4): remote red s tuđim `recovery_owner` → odbačen; remote `safe_address` ≠ predict → odbačen; restore s pubKeyem koji nije kandidat → odbijen.

### P1-6 [S] Sitni backend guardovi — BW-20, BW-21, BW-23, BW-24, BW-11

1. `SID_RE` → `{6,32}`; Flutter `maxLength: 32` + regex; test koji veže `SID_RE` i `asciiToBytes32`.
2. CORS `allowHeaders` + `x-mpt-key`.
3. Webhook gate: `orderState(order) === 'processed'` + `currency === 'eur'`; park reason `unsupported_currency`.
4. `revokeCampaign`/`revokeApiKey` + `tenant_id`; `addCampaign` 409 na tuđi tenant.
5. `expires_in_seconds`: `Number.isFinite` guard → 400 `invalid_expires_in_seconds`.

### P1-7 [S] Wallet sitnice — WU-02, WU-04, WU-05, WU-06, WP-04, WP-08, WP-09, WP-10, WP-11, WP-12, WC-06, WC-07, WC-11, WC-12, WC-13

Po nalazu u `wallet-ui-flutter.md` i `wallet-crypto-relayer.md`. Istaknuto:
- WP-08: `/recover` ne prefila `to` iz URL-a.
- WP-09: Embed čita `readSafeThreshold` i odbija `send` za threshold > 1.
- WP-10: `consumeReturnParams` ne konzumira `dw_state` ako je prisutan `dw_account`/`dw_error`.
- WP-11: kumulativni dnevni cap ili obrisati tekst o „max kumulativno".
- WC-06: `recover.ts` makne `nonce: 0n` (recovery na deployanom Safeu).
- WC-07: `ExpandAccess` šalje `saltNonce`/`recoveryOwner` za derived račun; novi `PasskeyRecord.safeAddress` = bootstrap Safe, ne derived.
- WC-12: `bootstrap-deploy` timeout → `{ok:false, pending:true, txHash}`; klijent polla do 60 s; `excludeCredentialIds` pamti neuspjeli pokušaj.
- WC-11: UI napomena uz clipboard/PDF seed.
- WC-13: `decodeQR` eksplicitno `unsupported` za `1.5e18`.

### P1-8 [S/M] Relayer hardening — WC-04, WC-05, WR-02, WR-04, WR-05

1. `wallet/functions/api/relay.ts` + `bootstrap-deploy.ts`: eksplicitni `gas` na `sendTransaction` (izmjeriti: hot ~1.5M, cold ~3.5M; staviti 2× izmjereno). Receipt `gasUsed` logirati; `limits.ts` brojati stvarni gas, ne pozive (ili preimenovati).
2. Hot path: `safeAddress` mora biti Safe proxy — `getCode(safe)` == poznati 1.4.1 proxy runtime bytecode (hardkodirati hash) i `getOwners()` sadrži `signerAddress`; inače 400.
3. Cold path: `getSigner(pubKeyX, pubKeyY) !== body.signerAddress` → 400 (WC-05).
4. WR-02: CREATE2 guard izvući u `assertPredictedSafe()` i pozvati i u fallback grani `:359-364`.
5. WR-04: `readCount` → `Number.isFinite` guard; WR-05: pre-flight u `try` s 502 umjesto neuhvaćene iznimke.
6. Dokumentirati u `wallet/docs/relayer-threat-model.md` što je promijenjeno.

**Test.** Relay prema EOA-u s kodom koji nije Safe → 400; `signerAddress` ≠ derived → 400; fallback grana s mismatch → 400, nema deploya.

---

## P2

### P2-1 [M] CREATE2 parity + zajednički paket — XD-01

`packages/safe-create2/` (TS, bez ovisnosti o Workers ili Reactu): konstante v1.4.1 (factory, singleton, fallback handler, WebAuthn signer factory, verifier), `buildSafeInitializer(owners, threshold)`, `predictSafeProxyAddress(owners, saltNonce)`, `predictSignerAddress(x, y)`. Koriste ga `wallet/src/lib/safe.ts` (umjesto protocol-kita za predict), `wallet/functions/_lib/safe.ts`, `backend/src/wallets/*` (P0-3). Test matrica: 1-owner, 2-owner, campaign-salt, mixed-case owners, sortiranje ownera — klijent === relayer === backend, plus barem jedan **stvarni** on-chain deployani Safe iz produkcije kao fixture (adresa iz `wallet_registry`).

### P2-2 [M] RPC fallback — XD-02

`lib/rpc.ts` u backendu i `wallet/functions/_lib/rpc.ts`: `fallback([http(GNOSIS_RPC_URL), http(GNOSIS_RPC_URL_2), http('https://rpc.gnosischain.com')], {rank: true})`; drugi endpoint plaćeni (Ankr/dRPC/Alchemy Gnosis) kao secret. Indexer, router, confirm, relay svi kroz isti helper.

### P2-3 [S] Ostatak

BW-25 (indexer `latest - 12`, eksplicitni `PINKA_ONCHAIN_INGEST_URL`), BW-26 (checkout backoff), BW-27 (`parseEurAmount`), BW-28 (provjeriti Monerium `/orders` paginaciju u lokalnim docs i dodati alarm), FL-02 (HUB3 opis `sid:<sid>` 16 znakova ili skratiti adresu — **ne mijenjati EPC**), FL-03/05/06/07/08.

### P2-4 [M] Test paket (regression za P0/P1)

Prioritet: (1) amount rekoncilijacija, (2) forward zasun + dva paralelna, (3) webhook potpis valid/invalid/rotated, (4) dedup + release, (5) CREATE2 parity (klijent/relayer/backend, 1- i 2-owner, nenulti salt — WC-14), (6) sid/ADDR_RE, (7) dropped-tx reconcile, (8) istek deterministički, (9) proof-of-possession, (10) Flutter POS race + unknown stage, (11) Embed busy/clickjack, (12) relay idempotency, (13) `extractClientDataFields` nad snimljenim iOS/Android/Chrome `clientDataJSON`, (14) `recoverPubkeys` nad snimljenom assertionom, (15) sync računa odbija tuđi `recovery_owner`.

Wallet danas nema nijedan test (`wallet/` bez `*.test.ts`) — prvo postaviti vitest u `wallet/` (već postoji u backendu, isti obrazac).

### P2-5 [odluka] `safe-tx/006` on-chain scoping

Pripremljeno, nije izvršeno (ADR 0016 tablica). Preporuka iz 006 doc-a (samo kapica po transferu, npr. 250 EUR) je razuman prvi korak — zatvara „ukraden `ROUTER_PRIVATE_KEY` isprazni Safe". Odluka i potpis su Matijini; Opus ne izvršava.

---

## Što Opus treba napraviti prvo (max ROI / min rizik)

1. **P0-1** amount na paid — najizravniji „lažno plaćeno" put, izoliran, S.
2. **P0-2** zasun na forwards — S, preduvjet za retry.
3. **P0-5** zatvoriti PII rute + timing + GP proxy — S, čisto.
4. **P0-7** deterministički istek — S, uklanja nekonzistentan `paid`/`late`.
5. **P0-4** `/embed` clickjacking — jedini novi SEC nalaz s izravnim gubitkom sredstava korisnika; minimum (korak 3) je S, puna verzija M.

P0-3 (dokaz posjeda) je M i dira klijent + server; planirati kao zaseban PR nakon gornjih pet.
