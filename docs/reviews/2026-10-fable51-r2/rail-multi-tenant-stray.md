# Rail: multi-tenant (ADR 0017) + stray resolver (ADR 0018) — nalazi (Fable 5.1, 2026-10-09)

Opseg: `backend/src/**` na HEAD `ef6622c`, s naglaskom na 40 commita od
`be47b62` (prethodni review). Svaki nalaz je traceovan protiv koda (file:line),
ne protiv ADR-a. Oznake kao u `../2026-10-fable51/`:

- **MONEY** — može izgubiti, zaglaviti ili pogrešno prijaviti novac.
- **SEC** — napadač bez tajne može nešto postići.
- **BUG** — pogrešno ponašanje bez direktnog gubitka.
- **RISK** — latentno ili operativno; postaje MONEY/SEC pod promjenom konfiguracije ili skale.

Redoslijed i acceptance kriteriji su u `implementation-plan.md`.

---

## A. Stray resolver (ADR 0018)

### SR-01 [SEC → MONEY] Svatko s registriranim wallet Safe-om može „uhvatiti" uplate bez reference: resolver + otvoren intent API + `wallet_registry` auto-whitelista

**Gdje.**
- `intents/api.ts:54-57` + `tenants/auth.ts:48-51` — bez ključa → `DEFAULT_TENANT_ID` (`italk`), `INTENT_REQUIRE_TENANT_KEY = "0"` (`wrangler.toml:98`). **Svatko na internetu stvara ITalk intente.**
- `tenants/db.ts:146-161` — za ITalk `allow_sources = '["wallet_registry"]'` (`migrations/0014:32`): svaki `safe_address` iz `wallet_registry` / `wallet_accounts` je whitelistiran.
- `wallets/api.ts:60-101` — `POST /api/wallets` prihvaća **bilo koju** `safeAddress` uz format-provjeru; nema dokaza posjeda ni CREATE2 provjere (P0-3 iz prethodnog plana nije napravljen, `git diff be47b62..HEAD -- wallet` je prazan).
- `monerium/strayResolver.ts:70-71` — tier 1: ako je u trenutku uplate **bilo koji** kandidat otvoren (`expires_at >= placedAt`), odlučuju samo otvoreni; istekli se ne gledaju.
- `intents/db.ts:215-242` — kandidati = isti tenant, isti `amount_cents`, `created_at` u `[placed − 48 h, placed + 2 min]`, bez živog forwarda.

ADR 0018 tvrdi: „Napadač bez API pristupa ne može stvoriti kandidata." To je
netočno za tenant `italk`: API pristup nije potreban, a odredište ne mora biti
tenantov Safe, dovoljan je **bilo koji** registrirani wallet Safe.

**Kako puca.**
1. Napadač otvori wallet na wallet.domovina.ai (ili samo `POST /api/wallets` s
   vlastitom adresom). Adresa `A` je sad na ITalk whitelisti.
2. Svakih 14 min (TTL 15 min) `POST /api/intents` s `target_address = A` i
   `amount_eur` ∈ {1, 2, 5, 10, 20, 50, 100, …} — par desetaka intenata po
   ciklusu, bez ključa, bez rate-limita (BW-22 otvoren).
3. Legitimni platitelj plaća Revolutom bez reference (od 7. 10. to je normalan
   slučaj) iznos X:
   - **intent merchanta još otvoren** → dva otvorena kandidata, različite adrese
     → `conflict` → park. Svaka zalutala uplata ITalka ide na ručnu obradu
     (griefing; resolver efektivno ugašen).
   - **intent merchanta istekao** (platitelj platio nakon 15 min, dokazano
     7. 10.: 7 i 23 min nakon isteka) → tier 1 sadrži samo napadačev intent →
     `match` → **forward na A**. Gate prolazi: binding (intent postoji),
     tenant = italk, whitelist = `wallet_registry`. Alert 🔀 stigne, ali novac je
     već u Safe-u napadača s 1/1 passkey vlasnikom; ITalk ga ne može vratiti
     (ADR 0018 §Poznata ograničenja to priznaje za tuđe Safe-ove).
4. `previewStraySid` (`forward.ts:463-480`) na `order.created` upali
   „zaprimljeno" na napadačevom checkoutu; nebitno za napad, ali pokazuje da se
   isti kandidat smatra vjerodostojnim i prije `processed`.

Napad ne zahtijeva nikakvu tajnu, košta nula (intenti su besplatni), skalira se
preko iznosa, i zadani iznos 1 € na energy.domovina.ai ga čini realističnim.

**Popravak (predloženo, slojevito).**
1. **Povjerenje u kandidata, ne samo u whitelistu.** `findStrayCandidates` i
   `listRerouteCandidates` dobivaju stupac `trusted`:
   `target_address` je na **statičnoj** whitelisti tenanta
   (`tenant_payout_addresses`, `source IN ('admin','seed')`), ne iz dinamičkog
   `wallet_registry` izvora. Resolver auto-forwarda **samo** trusted kandidate;
   netrusted kandidati ne ulaze ni u tier 1 ni u tier 2 (ne mogu ni griefati).
   Za wallet Safe-ove ostaje: memo sa sid-om (kao i danas) ili ručni reroute.
   Oprez: svih 53 reda iz seeda 0014 ima `source='seed'`, a 46 od njih su
   wallet Safe-ovi (label `… wallet_registry` / `wallet_account`) — trusted
   mora isključiti i njih (po labelu ili prepisom `source`). Energy Safe-ovi
   (Lukavec `0x4f7f…0173`) **nisu** u seedu, dakle danas prolaze samo kroz
   dinamički izvor → prije deploya ih dodati kao `admin` unose, inače legitimni
   strayi parkiraju (pre-check u planu P0-1.9).
2. **Dodatni signal:** intent kreiran s tenant ključem (`keyKind` ≠ null) je
   trusted i bez statične whiteliste; spremiti `created_with_key` (0/1) u
   `payment_intents` (migracija, aditivno) i koristiti kao `trusted` ILI uvjet.
3. **Rate-limit `POST /api/intents`** (BW-22 / P1-4) — CF WAF 30/min/IP, i
   softverski: max N otvorenih intenata po `target_address` po tenantu (npr. 20);
   iznad toga 429 `too_many_open_intents`. Zatvara i „spam za conflict".
4. **`INTENT_REQUIRE_TENANT_KEY=1`** kao cilj: Flutter, wallet PWA i energy
   šalju `pk_`. Dok to ne bude, (1)–(3) su dovoljni.
5. ADR 0018 §„Zašto je to sigurno" ispraviti: tvrdnja o API pristupu ne vrijedi
   za zadani tenant; navesti (1) kao uvjet sigurnosti.

**Ne dirati.** Dvoslojno pravilo (otvoreni > istekli) i redoslijed „najnoviji
prvi" ostaju; mijenja se samo **tko smije biti kandidat**.

**Test** (`strayResolver.test.ts` + `confirm`/`forward` harness): (a) kandidat s
`trusted=false` i jedini otvoren → `none` (park), ne `match`; (b) trusted
istekli + untrusted otvoreni → trusted odlučuje (nema conflicta); (c) D1 upit
vraća `trusted=1` samo za `source IN ('admin','seed')`; (d) 21 otvoreni intent
na istu adresu → 429.

---

### SR-02 [MONEY] Ručni reroute ne provjerava iznos ni stanje intenta; uz otvoren BW-01 1 € može flipati intent od 500 € u `paid`

**Gdje.**
- `admin/app.ts:90-102` → `forward.ts:529-544` `checkReroute`: provjerava
  `issue`+`processed`, živi forward, `resolved_offrail`, i **samo postojanje**
  intenta (`getIntentBySid`). Ne gleda `intent.state`, `monerium_order_id` ni
  `amount_cents`.
- `intents/db.ts:247-273` `listRerouteCandidates` — namjerno „bilo koji iznos"
  (ADR 0018 §Odluka 9); UI (`admin/views.ts:905-915`) samo boji različit iznos
  žuto, bez upozorenja na razliku.
- `forward.ts:273-282` — forward šalje **iznos ordera** (`eurToWei(order.amount)`)
  na cilj intenta; `confirm.ts:239-263` → `intents/db.ts:76-108`
  `markIntentPaid` upisuje `amount_received_cents` bez usporedbe (BW-01 /
  P0-1 iz prethodnog plana — **i dalje otvoreno**, kod nepromijenjen).

**Kako puca.**
1. Parkirana uplata od 1,00 € (napadač ili slučajnost). Operater u popisu
   kandidata klikne krivi red — intent od 500,00 € (žuto, ali klikabilno, dva
   klika).
2. Forward prenese 1 € na cilj tog intenta; `markIntentPaid` flipa `paid` s
   `amount_received_cents = 100`; merchant dobije `intent.paid` za 500 €
   (payload nosi oba iznosa, ali svi dosadašnji potrošači čitaju `type`).
3. Varijanta bez operaterske greške: API prihvaća `sid` intenta koji je već
   `paid` (memo forward) → drugi transfer na isti cilj, `markIntentPaid` ne
   flipa (nije `pending`), `markIntentLate` ne (nije `expired`) → novac ode,
   nitko nije obaviješten, forward red ima `memo_prefix='manual'`.

**Popravak.**
1. `checkReroute`: odbiti `intent.state === 'paid'` i `monerium_order_id IS NOT
   NULL` (`already_settled`); zahtijevati `amount_cents === parseAmountCents(order.amount)`
   osim uz eksplicitan `force: true` u tijelu + `reason` string koji ide u audit.
   UI: za različit iznos traži upis razloga, ne samo drugi klik.
2. **BW-01 sada** (prethodni P0-1): `markIntentPaid … AND ? >= amount_cents`;
   underpayment ne flipa `paid` nego piše `amount_received_cents` + outbox
   `payment.underpaid`. Shopify worker već to očekuje
   (`shopify/worker/src/sync.ts:90-94` klasificira `underpaid` iz `paid_at` +
   `amount_received_cents`), ali backend danas šalje `intent.paid`.
3. `AuthorizeDeps.getIntentBySid` vraća i `state`, `amount_cents`,
   `monerium_order_id` (proširenje tipa, bez promjene gatea).

**Test.** reroute na `paid` → 409 `already_settled`; reroute 1 € na 500 € bez
`force` → 409 `amount_mismatch`; s `force` → forward + audit s razlogom; BW-01
testovi iz prethodnog plana (50/30 → nije paid, `payment.underpaid` jednom).

---

### SR-03 [BUG → lažno „plaćeno"] `sid_resolved` preview može prikazati `settled` na susjednom intentu čiji novac je otišao drugom intentu

**Gdje.**
- `monerium/webhookHandler.ts:128-135` — na `order.created` bez reference upisuje
  `sidResolved` (read-only pick) u `monerium_webhook_events`.
- `intents/stage.ts:297-310` `loadStageContext` — ako intent nema
  `monerium_order_id`, traži **najnoviji** event s `sid_extracted = ? OR
  sid_resolved = ?` i uzima njegov order; zatim `getForwardByOrder(order.id)`.
- `intents/stage.ts:170-185` `resolveStage` — order `processed` + forward
  `confirmed` → `settled`, **bez provjere `forward.sid === intent.sid`**.

**Kako puca.**
1. 22:57:21 `order.created` (1 €, bez memoa). Kandidati: intent A (Lukavec).
   Preview → `sid_resolved = A`. Checkout A: „zaprimljeno" (ispravno).
2. 22:57:25 netko otvori intent B (isti iznos, ista adresa Lukavec, npr. drugi
   tab ili drugi platitelj). 22:57:28 `processed` → resolver: oba otvorena, ista
   adresa → `match`, `sids = [B, A]` (najnoviji prvi) → claim B. Forward
   `sid = B`, B flipa `paid`, merchant webhook za B.
3. Checkout A: `loadStageContext` → event s `sid_resolved = A` → order X →
   forward X (`sid = B`, `confirmed`) → **`stage = settled`**, `forward_tx_hash`
   prikazan, „Plaćeno ✓". `state` je i dalje `pending`, a nakon 15 min
   `expired`; stage ostaje `settled` jer order postoji (`stage.ts:170`).
   Dvoje ljudi vidi „plaćeno" za jednu uplatu. ADR 0018 §Otvoreno priznaje
   razilaženje, ali opisuje ga kao „zaprimljeno na intentu iste adrese", ne kao
   „settled".
4. Isti mehanizam vrijedi i bez previewa: `sid_extracted` fallback nije
   problem (memo sid je jedinstven), ali `sid_resolved` jest, jer nije
   obvezujuć.

**Popravak.**
1. `loadStageContext`: kad je order nađen preko `sid_resolved`, prihvatiti ga
   samo ako `forward === null` **ili** `forward.sid === intent.sid`
   **ili** (`forward.status IN ('failed','blocked')`). Inače `order = null`
   (checkout A se vraća na „čekamo uplatu", što je istina).
2. `resolveStage`: kad `forward.sid` postoji i `≠ intent.sid`, nikad `settled`
   za taj intent (obrana u dubinu; `StageForward` dobiva `sid`).
3. Nakon claima u `handleForward`, `publish` i za **sve** `claimSids` koji nisu
   dobili forward (da se checkout A osvježi na istinito stanje).

**Test** (`stage.test.ts`): order preko `sid_resolved=A`, forward `sid=B`
confirmed → A je `awaiting_payment`/`expired`, ne `settled`; forward `sid=A` →
`settled`; forward `null` → `received_processing`.

---

### SR-04 [RISK] `findStrayCandidates` LIMIT 20 (najnoviji prvi) odbacuje starije kandidate; pod spamom legitimni istekli intent ispada iz prozora

**Gdje.** `intents/db.ts:237-238` — `ORDER BY created_at DESC LIMIT 20`.

**Kako puca.** Uz SR-01 scenarij, napadač s >20 otvorenih intenata istog iznosa
istisne legitimni istekli intent iz skupa prije nego resolver uopće vidi
„conflict". I bez napada: popularni iznos (1 €) na energy.domovina.ai u prometnom
danu može imati >20 intenata u 48 h → resolver vidi nasumičan podskup.

**Popravak.** Nema limita na D1 strani (indeks po tenant+amount+created_at
drži upit jeftinim), ili LIMIT 200 + alarm kad je dosegnut. Konflikt se odlučuje
nad cijelim skupom. Uz SR-01 (trusted only) skup je ionako malen.

---

### SR-05 [MONEY-RISK] Reconcile ne alarmira za zalutalu (bez reference) obrađenu uplatu bez forwarda; alarm za memo-uplate ima prozor od točno jednog intervala i ovisi o `somethingInFlight`

**Gdje.**
- `monerium/reconcile.ts:130-139` `isStuckWithoutForward`: `if (!/^(mpt|cmp):/i.test(order.memo ?? '')) return false` — order bez memoa nikad ne alarmira.
- `reconcile.ts:137` — alarm samo ako `FORWARD_GRACE_S ≤ age < FORWARD_GRACE_S + RECONCILE_INTERVAL_S` (15–25 min nakon `processedAt`).
- `reconcile.ts:39-58, 92` — reconcile se preskače kad nema `pending` intenta u 2 dana ni ordera u `placed/pending`. Obrađeni order **nije** „in flight".
- `reconcile.ts:18-21` — reconcile namjerno ne forwarda.

**Kako puca.**
1. `order.updated processed` za zalutalu uplatu izgubljen (Worker eviction u
   `waitUntil`, Monerium retry pao na 5xx…). `order.created` je stigao →
   checkout „zaprimljeno", `sid_resolved` upisan.
2. Reconcile u 10 min povuče order, `advanced++`, `notifyOrderLifecycle` → ali
   **forward se ne pokreće**, a `isStuckWithoutForward` vrati `false` (nema
   `mpt:` memoa). Novac trajno u Safe-u, checkout zauvijek „zaprimljeno", nitko
   ne zna. Prije ADR 0018 to je bio očekivani „park"; sad je tiha rupa.
3. Za memo-uplatu: ako je intent istekao prije uplate i nema drugih pending
   intenata (noć), `somethingInFlight` = false u prozoru 15–25 min → alarm
   nikad ne ispali.

**Popravak.**
1. `isStuckWithoutForward`: ukloniti memo uvjet; svaki `issue`+`processed`
   order bez **ikakvog** `monerium_forwards` reda (ni park) starije od 15 min
   alarmira. Prozor: KV ključ `stuckalert:<orderId>` TTL 6 h (P0-6.3 iz
   prethodnog plana) umjesto jednog intervala.
2. `somethingInFlight`: dodati `OR EXISTS (processed issue order bez forward
   reda u zadnjih 24 h)`; jeftin upit uz indeks.
3. Reconcile smije **pokrenuti** forward za takve ordere sada kad latch 0016
   postoji (razlog da ne smije, BW-02 check-then-act, više ne vrijedi):
   `maybeForward(makeForwardDeps(env, rail), order)` → INSERT je odluka.
   Opcionalno iza `RECONCILE_FORWARDS=1`.

**Test.** processed order bez memoa, bez forward reda, star 20 min → alarm;
isti order drugi put unutar 6 h → bez alarma; s `RECONCILE_FORWARDS=1` →
`maybeForward` pozvan jednom.

---

### SR-06 [LOW] Sitnice resolvera

- `webhookHandler.ts:128-135` — preview se izvršava **prije** dedup claima
  (`alreadyProcessed`, :159-166) i za svaki event tip; Monerium retry iste
  isporuke plaća D1 upit kandidata uzalud. Premjestiti iza dedupa (rezultat se
  svejedno piše u `recordEvent` koji je prije — potreban mali refactor: record
  bez `sidResolved`, pa `UPDATE` nakon previewa, ili dedup prije recorda uz
  zapis dedup-a kao `processing_note`).
- `forward.ts:129-134` `parseAmountCents` koristi `Number()*100` + `Math.round`
  dok `eurToWei` (:138-142) radi egzaktno; Shopify worker ima egzaktni
  `moneyToCents` (`shopify/worker/src/shopify.ts:187-191`). Ujednačiti na
  egzaktni parser; `"1e2"` danas prolazi `parseAmountCents` (10000 centi) a
  `eurToWei` baca.
- `strayResolver.ts:87-91` `placedAtUnix` fallback na `now` — za reconcile
  put `placedAt` uvijek postoji; OK.

---

## B. Multi-tenant rail (ADR 0017)

### MT-01 [SEC-PII] `contribution.sepa` se enqueuea bez `tenantId` → kampanjski eventi tenanta (IBAN + ime darovatelja) idu na ITalkov globalni endpoint (pinka)

**Gdje.**
- `intents/confirm.ts:152-167` `settleConfirmedForward` → `emitCampaignContribution({...})` bez tenanta.
- `intents/outbound.ts:186-217` `emitCampaignContributionWebhook` — `enqueueWebhook(env, { id, type, payload })`, nema `tenantId`.
- `intents/outbox.ts:160-166, 222` `endpointFor(null)` → `getTenantRail(defaultTenantId)` → `legacyRail` → `INTENT_WEBHOOK_URL` (pinka).
- Za usporedbu: `emitForwardBlockedWebhook` (:226-258) i lifecycle (:120-168) **imaju** `tenantId`.

**Kako puca.** Župa (tenant `zupa-x`) ima `cmp:` kampanju. Uplata → forward →
`settleConfirmedForward` → `contribution.sepa` s `sender_iban`, `sender_name`
→ **pinka-webhook**. Točno problem #1 iz ADR 0017 §Problem, pola riješen.
Danas latentno (`MULTI_TENANT_RAIL=0`, nema tenant kampanja), ali prvi tenant
s kampanjom curi PII trećoj strani.

**Popravak.** `emitCampaignContribution` dobiva `tenantId` (iz
`fwd.tenant_id ?? campaign.tenant_id`; `settleConfirmedForward` ima `fwd.tenant_id`
u `SettleableForward`). `enqueueWebhook` **odbija** event bez eksplicitnog
`tenantId` (`tenantId: string | null` obavezan u tipu, `undefined` = greška u
kompajliranju). Test: tenant forward `cmp` → outbox red s `tenant_id='zupa-x'`,
`send` pozvan s tenantovim URL-om, nikad s globalnim.

---

### MT-02 [RISK → MONEY] Bez router ključa webhook tiho preskače forward: ni park red, ni alarm

**Gdje.** `monerium/webhookHandler.ts:223-230` — `&& rail.signer.privateKey` u
gateu; grana `else` ne postoji. `tenants/rail.ts:196` — ključ je `''` kad
`router_key_enc` nedostaje **ili** kad dešifriranje padne (`railFromStoredRow`
vraća `null` samo za greške; `decrypt` baca → `null` → ruta 404, OK), ali
`onboarding.ts:265-276` dopušta `activate` bez ključa? Ne: `runVerify`
`router_gas` to hvata (:436-442). Ipak: rotacija ključa (`?rotate=1`) traži
`suspend_first`, a `generateRouterKey` briše `verified_at`, ali tenant ostaje
`suspended` → forward parkira `tenant_suspended`, OK.

Realni put: ITalk s obrisanim/pogrešnim `ROUTER_PRIVATE_KEY` (secret
rotation) → `processed` orderi prolaze upsert + lifecycle (`payment.received`
merchantu), forward se ne zove, `monerium_forwards` ostaje prazan, a jedini
signal je SR-05 reconcile alarm (s rupama).

**Popravak.** Ukloniti `rail.signer.privateKey` iz gatea; `forwardViaSafe` već
vraća `router_disabled: …` (`router/safe.ts:140-142`) → `handleForward` upiše
`failed` + ❌ alarm. Test `webhookHandler.test.ts:221` („does not forward when
no router key") preokrenuti u „records failed + alerts".

---

### MT-03 [RISK] ITalk rail ima `requireMintAt: null` — provjera mint adrese ugašena za jedinog živog tenanta

**Gdje.** `tenants/whitelist.ts:101` `requireMintAt: rail.legacy ? null : rail.receivingSafe`;
`authorizeForward` :122-124.

**Kako puca.** ITalk Monerium profil ima (ili dobije) drugu povezanu adresu
(npr. EOA iz `safe-tx/000`, test adresa). Issue order mintan tamo nosi
`mpt:` memo → forward troši EURe **iz MPT Safe-a** koji taj order nije donio.
Rizik je danas nizak (jedna adresa na profilu), ali zaštita košta jednu liniju.

**Popravak.** `requireMintAt: rail.receivingSafe` za sve rail-ove, iza
`env.LEGACY_REQUIRE_MINT_AT = "1"` jedan deploy ciklus (provjeriti u
`monerium_orders` da svi `issue` orderi imaju `address = SAFE_ADDRESS`; upit
u planu). Test: legacy order s `address ≠ SAFE_ADDRESS` → `mint_address_mismatch`.

---

### MT-04 [SEC-DoS] Neautentificirane webhook rute trajno spremaju tijelo bilo koje veličine; `/t/:tenantId` to radi i za nepostojeće tenante

**Gdje.**
- `index.ts:166-181` — nepoznat tenant: `recordMoneriumWebhookEvent({ payload: rawBody })` pa 404.
- `webhookHandler.ts:136-148` — `recordEvent({ payload: rawBody, headersJson })` **prije** provjere potpisa (:149).
- Nema `content-length` kapice; D1 red može biti do 1 MB po vrijednosti (BW-13 iz srpnja, otvoreno).

**Kako puca.** `for i in $(seq 1 100000); do curl -d @1mb.json
https://monerium.domovina.ai/api/monerium/webhook/t/x$i; done` → D1 raste GB-ima
(limit 10 GB po bazi), admin `/admin` lista eventova postaje neupotrebljiva,
trošak D1 storage/write. Isto i na legacy ruti s krivim potpisom.

**Popravak.** (1) `if (rawBody.length > 65_536) return 413` prije ičega;
(2) kad potpis ne valja ili tenant ne postoji, spremiti `rawBody.slice(0, 2048)`
i `headers` samo `webhook-*` + `user-agent`; (3) CF WAF rate-limit 60/min/IP
na `/api/monerium/webhook*`; (4) za `unknown_tenant` jedan KV brojač po IP
umjesto D1 reda (ili ne spremati uopće; 404 je dovoljno).

---

### MT-05 [OPS] `registerTenantWebhook` rotira tajnu prije registracije i nikad ne gasi prethodnu pretplatu

**Gdje.** `tenants/onboarding.ts:295-318` — novi `whsec_` → `UPDATE`
(`webhook_subscription_id = NULL`) → `createWebhookSubscription`;
`MoneriumClient.disableWebhookSubscription` (`monerium/client.ts:199-207`)
nije pozvan nigdje.

**Kako puca.** Ponovni `POST …/rail/webhook` (npr. nakon neuspjeha PATCH-a
tipova) ostavlja staru pretplatu aktivnom: Monerium šalje svaki event **dvaput**
na isti URL, jedan potpisan starom tajnom → `signature_invalid` + 401 → Monerium
retry 12 h × svaki event. Šum u `/admin`, lažni osjećaj napada. Ako POST uspije
a PATCH padne, red ima `webhook_subscription_id = NULL` a pretplata postoji s
default tipovima (`iban.updated`).

**Popravak.** Prije rotacije: ako `row.webhook_subscription_id` postoji →
`disableWebhookSubscription(old)` (best effort, logirati). Nakon
`createWebhookSubscription` upisati id **i** u catch-grani PATCH-a (vratiti
`created.id` iz klijenta i u slučaju neuspjelog PATCH-a). Test s mock klijentom:
drugi poziv gasi prvu pretplatu.

---

### MT-06 [RISK] Rotacija KEK-a nije moguća bez re-onboardinga; `v1` je jedini prihvaćeni format

**Gdje.** `tenants/secrets.ts:29, 94-96` — `VERSION = 'v1'`, dekripcija odbija
sve drugo; `importKek` čita samo `TENANT_SECRETS_KEK`.

**Kako puca.** Sumnja na curenje KEK-a (bivši suradnik, Cloudflare incident)
→ jedina opcija je novi KEK + ponovni unos **svih** tajni svih tenanata
(Monerium client secret traži novu private app kod tenanta, router EOA novi
batch 007 s potpisima tenanta). Realno: rotacija se ne radi.

**Popravak.** `TENANT_SECRETS_KEK_PREV` (opcionalno): dešifriranje proba
`v2` s trenutnim, `v1` s prethodnim; admin `POST /admin/api/tenants/:id/rail/rewrap`
(ili cron) ponovno šifrira sve `*_enc` novim ključem (`v2:`), audit red.
Dokumentirati postupak u `docs/runbook/kek-rotation.md`. Test: blob `v1` +
PREV → OK; `v1` bez PREV → `SecretsError`.

---

### MT-07 [OPS] Gas ITalkovog routera nije nadziran; tenant routeri jesu

**Gdje.** `tenants/onboarding.ts:516-542` `checkRouterGas` iterira
`listRailTenantIds` (bez legacy). `alerts.ts`, `reconcile.ts` ne gledaju saldo.

**Kako puca.** `0xd612…54CB` potroši xDAI → svaki forward `failed`
(`insufficient funds`) + ❌ alarm **po forwardu**, bez retryja (BW-17 otvoren).
Noćna uplata → ručni retry sutra ujutro (i to kroz reroute, jer `failed` memo
forward nema admin gumb).

**Popravak.** `checkRouterGas` uključuje `legacyRail(env)` (adresa iz
`ROUTER_PRIVATE_KEY`); prag `MIN_ROUTER_GAS_WEI` isti. Jedan red.

---

### MT-08 [LOW] `isKnownPayer` je globalan (preko svih tenanata)

**Gdje.** `monerium/db.ts:95-111` — nema `tenant_id` filtera; zove se iz
`lifecycle.ts:42` i `stage.ts:117-119`.

**Kako puca.** Monerium screening je po profilu (ADR 0017 §Otvorena pitanja
5): platitelj koji je platio ITalku prvi put plaća župi → `review_expected =
false` (krivo, bit će zadržan), a merchant župe ujedno sazna da je taj IBAN
već plaćao nekom drugom tenantu (minimizacija podataka). Dodati `tenant_id`
parametar s `COALESCE(tenant_id, default) = ?`.

---

### MT-09 [RISK] SSE Durable Object: bez autentikacije (sid je capability, OK), ali bez kapice na broj sinkova ni na trajanje DO-a

**Gdje.** `intents/stream.ts:209-242` — svaki `/subscribe` dodaje sink;
`startHeartbeat` radi D1 čitanje svakih 15 s dok postoji ijedan sink;
`MAX_STREAM_MS` 30 min po sinku, bez gornje granice broja sinkova po sid-u.

**Kako puca.** `for i in 1..5000: curl -N …/stream` na jedan javni sid (sid je
u checkout URL-u koji se dijeli) → 5000 otvorenih streamova u jednom DO-u,
`broadcast` nad 5000 writera po pokeu i pingu; DO CPU/memorija, D1 upiti.
Jeftino za napadača, Durable Object naplata za nas.

**Popravak.** `MAX_SINKS_PER_SID = 8`: iznad toga `subscribe` vrati 429 i
klijent pada na polling (već implementirano). CF rate-limit na
`/api/intents/*/stream` 10/min/IP. Test u `stream.test.ts`: 9. sink odbijen.

---

### MT-10 [RISK] Potpisivanje forwarda i dalje bez `nonceManager`/eksplicitnog gasa; ITalk paralelni forwardi daju `failed` bez retryja

**Gdje.** `router/safe.ts:146-147, 199-211` — `privateKeyToAccount(key)` bez
`nonceManager`, `writeContract` bez `gas`/`nonce`. Prethodni P0-2 točka 5 i
P0-6 (BW-17 admin retry) **nisu** napravljeni; ADR 0018 §Produkcija 8. 10. to
potvrđuje („između forwarda čekala se potvrda na chainu… nonce manager je
otvoren").

**Kako puca.** Dvije uplate ITalku u istoj sekundi (stray + memo) → dva
izolata → isti nonce → drugi `failed: nonce too low` → novac u Safe-u, ❌ alarm,
ručno. Uz resolver koji sad forwarda i uplate bez reference, frekvencija raste.

**Popravak.** (1) `privateKeyToAccount(key, { nonceManager })` iz `viem/nonce`
(unutar izolata); (2) `POST /admin/api/forwards/:id/retry` za `failed`
(prethodni P0-6; latch 0016 štiti od duplog); (3) automatski retry jednom
nakon 5 s za `nonce too low` / `replacement transaction underpriced` (prepoznatljive
poruke), kroz `handleForward` → latch.

---

## C. Stanje nalaza iz prethodnog reviewa (2026-10-02) — provjereno čitanjem

| ID | Stanje na `ef6622c` | Dokaz |
|---|---|---|
| P0-1 BW-01 underpayment → `paid` | **OTVORENO** | `intents/db.ts:76-108` nepromijenjen; Shopify worker ga zaobilazi na svojoj strani (`sync.ts:90-94`), rail i dalje šalje `intent.paid`. Pojačano SR-02. |
| P0-2 DB-04 latch | **RIJEŠENO** (bez točke 5) | `migrations/0016`, `monerium/db.ts:287-333`; `nonceManager` nema (MT-10). |
| P0-3 BW-18 dokaz posjeda | **OTVORENO** | `wallets/api.ts:60-101`; `wallet/` diff prazan. Pojačano SR-01. |
| P0-4 WU-01 clickjacking | **OTVORENO** | `wallet/` diff prazan. |
| P0-5 BW-05/07/06 | **DJELOMIČNO** | `/api/monerium/orders*` iza `ADMIN_TOKEN` (`index.ts:196-198`) ✓; `/api/hpb/accounts`, `/api/hpb/transactions` **i dalje javni** (`index.ts:77-89`); `key !== secret` i dalje (`index.ts:349, 359`); GP proxy nepromijenjen. |
| P0-6 BW-17 admin retry | **OTVORENO** | `admin/app.ts` ima reroute (samo za parkirane) i offrail, ne retry za `failed`. |
| P0-7 BW-15 istek | **OTVORENO** | `index.ts:536-542` sweep samo 6-satni; `stage.ts:170` ne gleda `now`. |
| P1-1 BW-16 dropped tx | **OTVORENO** | `router/safe.ts:224-239` nepromijenjen (`catch → 'unknown'`). |
| P1-4 BW-22 rate-limit/veličine | **OTVORENO** | nema limita na `/api/intents` ni webhooku (MT-04, SR-01). |
| P1-6 BW-20/21/23/24/11 | **OTVORENO** | `SID_RE {6,64}` (`intents/api.ts:32`), CORS bez `x-mpt-key` (`index.ts:62`), gate bez `currency` (`webhookHandler.ts:223-227`), `expires_in_seconds` bez `isFinite`. |
| Wallet (WC-*, WP-*, WR-*, WU-*) | **SVE OTVORENO** | `git diff --stat be47b62..HEAD -- wallet` prazan. |

Napomena: ADR 0019 (off-cloud signer) je `Proposed`; ITalk rola i dalje nema
`ScopeFunction` uvjete on-chain (ADR 0019 §Problem). To ostaje najveći
pojedinačni rizik (ukraden `ROUTER_PRIVATE_KEY` = cijeli Safe), nepromijenjen od
srpnja; detektor krađe (faza 0) ga skraćuje, ne zatvara — vidi `detector-admin-offrail.md`.
