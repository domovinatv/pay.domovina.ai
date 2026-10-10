# Implementacijski plan za Opus 5.5 (Fable 5.1 review r2, 2026-10-09)

Glavni deliverable. Svaki zadatak je pisan kao **samostalan prompt**: što, gdje,
kako, test koji dokazuje, što se ne smije dirati. Nalazi po ID-u su u
`rail-multi-tenant-stray.md` (SR-*, MT-*), `detector-admin-offrail.md` (TD-*,
OF-*, AD-*) i `shopify-app.md` (SH-*). Prethodni plan
(`../2026-10-fable51/implementation-plan.md`) ostaje važeći za sve što tamo nije
označeno ✅; ovdje se referira kao „prethodni P0-x".

Opseg: **S** ≤ pola dana · **M** 1–2 dana · **L** > 2 dana.

## Stanje implementacije (Opus 5.5, 2026-10-10, grana `fix/fable51-r2-fixes`)

Sve ispod je na grani, **nije deployano**. Backend 412/412 testova, Shopify
worker 26/26, `tsc` čist u oba. Novi testovi na pravom SQLiteu sa svim
migracijama (`backend/test/helpers/sqliteD1.ts`, `node:sqlite`).

| Zadatak | Stanje | Commit |
|---|---|---|
| P0-1 SR-01 trusted kandidati | ✅ (+ migracija 0022; kapica samo za netrusted odredišta) | `e1e6299` |
| P0-2 SR-02 + BW-01 | ✅ | `0e8239e`, `c312ac2` |
| P0-3 MT-01 | ✅ | `d99e50d` |
| P0-4 TD-01/03 | ✅ (provjereno na stvarnom forward tx-u) | `8298529` |
| P0-5 SR-03 | ✅ | `44f33b7` |
| P0-6 MT-04/09 | ✅ u kodu; WAF samo dokumentiran | `9968e4e` |
| P0-7 AD-01 | ✅ | `57f00b8` |
| P0-8 MT-02 | ✅ | `83a0fb7` |
| P1-1 SR-05 | ✅ (`RECONCILE_FORWARDS` zadano isključen) | `25fb251` |
| P1-2 TD-02/04 | ✅ (heartbeat secret treba postaviti) | `c8694ce` |
| P1-3 MT-10 | ✅ | `4378c64` |
| P1-4 SH-01..04 | ✅ (bez IP rate-limita) | `08786a1` |
| P1-5 MT-03/07/08 | ✅ (`LEGACY_REQUIRE_MINT_AT="1"`) | `16e0b18` |
| P1-6 AD-02/03 | ✅ (stari bearer URL-ovi još jedan ciklus) | `0570a84` |
| P1-7 OF-01/02 | ✅ (+ migracija 0023) | `44d7460` |
| P1-8 MT-05/06 | ✅ | `920a169` |
| P1-9 prethodni P1-1 (dropped tx), P1-6 (guardovi) | ✅ | `8e07983`, `7a48733` |
| P1-9 prethodni P0-7 (strogi istek) | ⏸ **odluka Matije** — mijenja `paid` → `payment.late` za uplate nakon isteka | — |
| P2-1 SH-05/06/08/09/10, TD-05, SR-06 (parser), AD-04 | ✅ | `ecb7065`, `19dfd7a`, `8cb7426`, `7058689` |
| P2-1 SR-06 (preview iza dedupa), AD-05 (4-eyes) | ⏸ (AD-05 je odluka Matije) | — |
| P2-2 wallet (dokaz posjeda, embed, klijent ne vjeruje backendu) | ⏸ nije dirano | — |
| P2-3 ADR 0018 tekst | ✅ (§Zašto je to sigurno, dopuna SR-05) | `e1e6299`, `25fb251` |

Prije deploya: `wrangler d1 migrations apply` (0022, 0023, 0024); WAF pravila
iz `docs/runbook/rate-limits.md`; `WATCH_HEARTBEAT_URL` secret.

## NE DIRAJ (regresija ako se promijeni)

- Atribucija webhooka: potpis **samo** tajnom tenanta iz URL-a; nikad probati
  druge tajne. Legacy ruta = `legacyRail(env)`, dedup ključ goli id za ITalk.
- `authorizeForward` jedina točka odluke; resolver, reroute i (novo) reconcile
  forward **prolaze** kroz nju. Redoslijed provjera u njoj se ne mijenja.
- Latch 0016/0018: `insertForward` ON CONFLICT DO NOTHING = odluka; `park` ne
  uzima latch; `claimForward` petlja po kandidatima.
- Dvoslojno pravilo resolvera (otvoreni > istekli, najnoviji prvi) — SR-01
  mijenja **tko je kandidat**, ne pravilo.
- `park` prijavljuje memo, ne pogodak.
- AAD `<tenant>|<field>` na tajnama; `v1` format ostaje čitljiv.
- Settle single-fire (`confirmForwardOnce`, `markIntentPaid WHERE state='pending'`).
- Admin: `__Host-` kolačić, Origin CSRF, CSP nonce, Access `aud`/`iss`.
- Shopify: sid derivacija `sid:v1:<shop>:<gid>` (promjena = novi sidovi za
  otvorene narudžbe); potpisi nad sirovim tijelom.
- EPC 10 linija, HUB3 14 polja; `MULTI_TENANT_RAIL` ostaje `0` dok prvi tenant
  ne prođe sandbox.

## Redoslijed

```
P0 (ovaj tjedan — zatvara stvarni put do gubitka novca ili PII)
  P0-1 SR-01       trusted kandidati + kapica otvorenih intenata         M
  P0-2 SR-02+BW-01 iznos na reroute + underpayment nikad paid           S/M  (prethodni P0-1)
  P0-3 MT-01       tenantId na contribution.sepa, enqueue odbija bez     S
  P0-4 TD-01       klasifikacija po Safe eventima, ne tx.to              S
  P0-5 SR-03       loadStageContext ne pokazuje tuđi settled             S
  P0-6 MT-04+MT-09 kapice: webhook body, SSE sinkovi, WAF rate-limit     S
  P0-7 AD-01       actor iz sesije                                       S
  P0-8 MT-02       nema ključa → failed + alarm, ne tiho                 S
P1 (sljedeća 2 tjedna)
  P1-1 SR-05       reconcile alarm za sve processed bez forwarda + forward iz reconcilea  S
  P1-2 TD-02/04    dead-man heartbeat, lag alarm, range shrink           S
  P1-3 MT-10       nonceManager + admin retry failed (prethodni P0-6)    S/M
  P1-4 SH-01/02/03 Shopify: vezanje na kupca, re-read iznosa, cancel grace  M
  P1-5 MT-03/07/08 requireMintAt za ITalk, gas ITalk routera, isKnownPayer po tenantu  S
  P1-6 AD-02/03    monerium admin rute pod sesiju; passkey re-auth       M
  P1-7 OF-01/02    offrail noga + iznos                                  S
  P1-8 MT-05/06    gašenje stare pretplate; KEK rotacija (v2 + PREV)    M
  P1-9 prethodni P0-7 (istek), P1-1 (dropped tx), P1-6 (sitni guardovi)  S
P2
  P2-1 SH-04..10, TD-03/05, SR-04/06, MT-09 rate-limit, AD-04/05        S
  P2-2 prethodni P0-3 (dokaz posjeda), P0-4 (embed), P1-5 (klijent ne vjeruje backendu)  M/L
  P2-3 ADR 0018 tekst: ispraviti §„Zašto je to sigurno" (SR-01), §Otvoreno (SR-03)  S
  P2-4 test paket (dolje)                                                M
```

---

## P0

### P0-1 [M] Resolver forwarda samo „trusted" kandidate; kapica otvorenih intenata — SR-01, SR-04

**Promjene.**
1. Migracija `0022_intent_trust.sql`: `ALTER TABLE payment_intents ADD COLUMN
   created_with_key INTEGER NOT NULL DEFAULT 0;` + indeks
   `idx_intents_stray (tenant_id, amount_cents, created_at)`.
2. `intents/api.ts` POST: `createIntent({..., createdWithKey: tenant.keyKind !== null})`.
3. `intents/db.ts` `findStrayCandidates` i `listRerouteCandidates`: SELECT
   dobiva `trusted`:
   ```sql
   (i.created_with_key = 1
     OR EXISTS (SELECT 1 FROM tenant_payout_addresses p
                 WHERE p.tenant_id = COALESCE(i.tenant_id, ?default)
                   AND lower(p.address) = lower(i.target_address)
                   AND p.revoked_at IS NULL
                   AND (p.source = 'admin'
                        OR (p.source = 'seed' AND p.label NOT LIKE '%wallet%')))) AS trusted
   ```
   Napomena: svih 53 seed reda iz 0014 ima `source='seed'`; 27+6+13 od njih su
   wallet Safe-ovi (label `… wallet_registry` / `wallet_account`), zato
   `label NOT LIKE '%wallet%'`. Čistije: migracija 0022 prepiše `source` tih
   redova u `'seed_wallet'` i uvjet postane `source IN ('admin','seed')`.
   Ukloniti `LIMIT 20` (ili 200 + `console.warn` kad je dosegnut).
4. `monerium/strayResolver.ts` `StrayCandidate.trusted: boolean`;
   `resolveStray` filtrira `live = candidates.filter(c => trusted && (pending|expired))`
   **prije** tierova. Untrusted kandidati se ne vraćaju ni u `conflict.candidates`
   (alert ih ne spominje; operater ih vidi u reroute pickeru označene „⚠️ wallet").
5. `previewStraySid` isto (koristi `resolveStray`).
6. Admin reroute picker (`admin/views.ts`): netrusted red ima pill „wallet
   (nije na statičnoj whitelisti)"; reroute na njega traži `force` + razlog
   (vidi P0-2).
7. Kapica: `intents/db.ts` `countOpenIntentsForTarget(tenantId, target)`;
   `intents/api.ts` → ako `≥ MAX_OPEN_INTENTS_PER_TARGET` (env, zadano 20) →
   429 `too_many_open_intents`. Ne primjenjuje se na zahtjeve s `sk_` ključem.
8. CF WAF (dashboard, zapisati ID-eve u `docs/runbook/rate-limits.md`): `POST
   /api/intents` 30/min/IP; `POST /api/wallets*` 10/min/IP.
9. **Pre-check na produkciji (prije deploya, obavezno):** energy Safe-ovi
   (Lukavec `0x4f7f…0173`, Rab, …) **nisu** u seedu 0014 (grep 4f7f prazan) —
   whitelistirani su dinamički (SDK `createAccount` → `wallet_accounts`) ili
   admin unosom. Upit: `SELECT DISTINCT lower(target_address) FROM
   monerium_forwards WHERE memo_prefix IN ('auto','manual') OR sid IN (SELECT
   sid FROM payment_intents WHERE tenant_id='italk' AND created_at > <2026-09-01>)`
   → svaku adresu koja nije `admin`/ne-wallet `seed` dodati kroz
   `/admin/whitelist` kao `admin` s labelom projekta **prije** deploya. Inače
   legitimni strayi počinju parkirati. Isto za svaki budući energy/solardei Safe:
   onboarding projekta = admin whitelist unos (dokumentirati u energy docs/15).

**Ne dirati.** Tier logika, redoslijed, `claimForward`.

**Test** (`strayResolver.test.ts`, `forward.test.ts`, novi `intentsApi.test.ts`):
untrusted jedini otvoren → `none`; trusted istekli + untrusted otvoreni → trusted
match; trusted otvoreni različitih adresa → conflict (nepromijenjeno); SQL
`trusted` = 1 samo za `admin|seed` ili `created_with_key`; 21. otvoreni intent na
istu adresu → 429; `sk_` nema kapicu.

---

### P0-2 [S/M] Iznos na reroute; underpayment nikad `paid` — SR-02, BW-01

1. `tenants/whitelist.ts` `AuthorizeDeps.getIntentBySid` vraća i `state`,
   `amount_cents`, `monerium_order_id` (tip proširen, gate ih ne koristi).
2. `forward.ts` `checkReroute(deps, order, sid, opts?: {force?: boolean})`:
   - `intent.state === 'paid' || intent.monerium_order_id` → `'already_settled'`;
   - `intent.amount_cents !== parseAmountCents(order.amount)` i `!force` →
     `'amount_mismatch'`.
   `RerouteRefusal` tip dobiva oba.
3. `admin/app.ts` reroute: tijelo `{sid, force?, reason?}`; `force` traži
   `reason.length ≥ 10`; audit `forward.reroute` s `actor` (P0-7), `sid`,
   `order_amount`, `intent_amount`, `force`, `reason`. UI: za različit iznos
   otvara polje „razlog" umjesto drugog klika.
4. **BW-01** po prethodnom P0-1, nepromijenjeno: `markIntentPaid … AND ? >=
   amount_cents`; underpayment → `UPDATE … amount_received_cents, monerium_order_id,
   forward_id, forward_tx_hash WHERE sid=? AND state='pending' AND monerium_order_id IS NULL`
   (bez promjene `state`) + outbox `payment.underpaid` (`undp_<sid>`,
   `{expected_cents, received_cents, delta_cents, funds_location:'recipient'}`);
   overpayment flipa `paid` + `overpaid_cents` u payloadu. `computeStage` dobiva
   `amount_mismatch: 'under'|'over'|null`.
5. Shopify worker (`sync.ts` `classifyIntent`) već razumije `underpaid` iz
   `paid_at` + `amount_received_cents`; nakon 4 `paid_at` za underpayment više
   neće biti postavljen → dodati granu: `intent.amount_received_cents !== null &&
   intent.monerium_order_id && !intent.paid_at` → `underpaid`. Test u
   `core.test.ts`.

**Test.** reroute na `paid` → 409; 1 € na 500 € → 409 `amount_mismatch`; s
`force`+`reason` → forward + audit; BW-01: 50/30 → nije paid, `payment.underpaid`
jednom, dvostruki settle → jednom; 50/70 → paid + `overpaid_cents=2000`.

---

### P0-3 [S] `contribution.sepa` po tenantu; enqueue bez tenanta ne kompajlira — MT-01

1. `intents/outbox.ts` `OutboxEvent.tenantId: string | null` (obavezno, ne `?`).
2. `intents/outbound.ts` `emitCampaignContributionWebhook(env, {..., tenantId})`.
3. `intents/confirm.ts` `settleConfirmedForward`: `tenantId: fwd.tenant_id ??
   null` (za legacy redove NULL = default, točno kao i danas).
4. `ConfirmDeps.emitCampaignContribution` tip proširen; `test/confirm.test.ts`
   harness dobiva polje.

**Test.** forward s `tenant_id='zupa-x'` + `memo_prefix='cmp'` → outbox red
`tenant_id='zupa-x'`; `endpointFor('zupa-x')` bez outbound URL-a → **ništa**
nije poslano (ni na globalni). `tsc` pada ako se `enqueueWebhook` pozove bez
`tenantId`.

---

### P0-4 [S] Detektor klasificira po Safe eventima — TD-01, TD-03

1. `outflowWatch.ts` `OutflowWatchDeps.txTarget` → `safeExecEvents(txHash):
   Promise<{ viaModule: string[]; viaOwners: boolean }>`: iz receipta logovi s
   `address === safe`: `ExecutionFromModuleSuccess(address indexed module)`
   (topic0 `0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8`)
   i `ExecutionSuccess(bytes32,uint256)`
   (`0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e`).
   Oba selektora provjerena `viem.toEventSelector` 2026-10-09; u kodu ih
   izračunati iz ABI stringa (`toEventSelector`), ne hardkodirati.
2. `classify`: `viaModule.includes(rolesModifier)` → `role_*`; `viaModule`
   neprazno a ne sadrži modifier → **novi** `module_unknown` (🚨 tekst: „EURe
   izašao kroz modul koji nije naš Roles: `<module>`"); `viaOwners` → `other`;
   ništa → `other` + napomena.
3. `hasUnhashedForward`: `AND status='pending' AND created_at > ?` (now − 15 min).
4. `alertText` za `role_unknown` ostaje; `tx.to` više se ne čita.

**Test.** receipt s `ExecutionFromModuleSuccess(modifier)` i `tx.to=0xRelay` →
🚨; `ExecutionFromModuleSuccess(0xOther)` → 🚨 `module_unknown`;
`ExecutionSuccess` → ℹ️; `failed` red star 1 dan ne daje ⚠️.

---

### P0-5 [S] Checkout ne pokazuje tuđi `settled` — SR-03

1. `intents/stage.ts` `loadStageContext`: nakon `getForwardByOrder`, ako je
   order došao preko `sid_resolved` grane i `forward && forward.sid &&
   forward.sid !== intent.sid && forward.status IN ('pending','submitted','confirmed')`
   → `order = null; forward = null`.
2. `StageForward` dobiva `sid`; `resolveStage`: `forward.sid && forward.sid !==
   intentSid` → tretirati kao da forwarda nema (obrana u dubinu; `StageInput`
   dobiva `intentSid`).
3. `forward.ts` `handleForward`: nakon `claimForward`, `publish` za svaki sid iz
   `claimSids` koji nije `claimed.sid`.

**Test** (`stage.test.ts`): order via `sid_resolved=A`, forward `sid=B`
confirmed → A `awaiting_payment`; forward `sid=A` → `settled`; forward null →
`received_processing`.

---

### P0-6 [S] Kapice na javnim ulazima — MT-04, MT-09, (BW-13)

1. `index.ts` obje webhook rute: `if (rawBody.length > 65_536) return c.json({error:'payload_too_large'}, 413)`
   prije ičega. `/t/:tenantId` unknown tenant: ne spremati payload (KV brojač
   `wh:unknown:<ip>` TTL 1 h → jedan `console.warn`), ili `payload.slice(0, 1024)`.
2. `webhookHandler.ts` `recordEvent` kad `!verify.ok`: `payload: rawBody.slice(0, 4096)`,
   `headersJson` samo `webhook-*`, `user-agent`, `cf-connecting-ip`.
3. `intents/stream.ts` `StreamHub.subscribe`: `if (this.sinks.size >=
   MAX_SINKS_PER_SID (8)) { sink.close(); return 'full' }` → DO vraća 429;
   `openIntentStream` prosljeđuje status.
4. WAF: `/api/monerium/webhook*` 60/min/IP; `/api/intents/*/stream` 10/min/IP
   (uz P0-1.8).

**Test.** 70 KB tijelo → 413 bez D1 reda; krivi potpis → red s payloadom ≤ 4096;
9. sink → 429 (`stream.test.ts`).

---

### P0-7 [S] Actor iz sesije — AD-01

1. `admin/auth/mount.ts`: `export function actorOf(c): string { return adminSession(c)?.email ?? 'admin:unknown'; }`.
2. Zamijeniti svih 13 poziva `actorFrom(c.req.header('Authorization'))` u
   `tenants/admin.ts` i `tenants/railAdmin.ts`; obrisati `actorFrom`.
3. `docs/admin-auth.md`: redak „audit actor = e-mail sesije".

**Test** (`adminAuth.test.ts` ili `tenantBoundaries.test.ts`): `address.add`
s valjanom sesijom → `tenant_audit_log.actor = 'ms@…'`.

---

### P0-8 [S] Bez ključa → `failed` + alarm — MT-02

1. `webhookHandler.ts:223-228`: ukloniti `&& rail.signer.privateKey`.
2. `forwardViaSafe` već vraća `router_disabled: …`; `handleForward` upisuje
   `failed` i šalje ❌ (postojeća grana). Provjeriti da `park` nije potreban.
3. Test `webhookHandler.test.ts:221` preokrenuti: bez ključa → `forward` pozvan,
   red `failed`, alert jednom.

---

## P1

### P1-1 [S] Reconcile vidi i zalutale; smije forwardati — SR-05

1. `reconcile.ts` `isStuckWithoutForward`: ukloniti memo regex; uvjet =
   `issue && processed && processedAt < now − 15 min && getForwardByOrder === null`.
   Alarm dedup: KV `stuckalert:<orderId>` TTL 6 h (ponavlja se dok forward ne
   postoji), umjesto prozora jednog intervala.
2. `somethingInFlight`: dodati `OR EXISTS (SELECT 1 FROM monerium_orders o WHERE
   o.kind='issue' AND o.state='processed' AND o.updated_at > now − 86400 AND NOT
   EXISTS (SELECT 1 FROM monerium_forwards f WHERE f.order_id=o.id))` (po
   tenantu za ne-legacy).
3. `RECONCILE_FORWARDS=1` (env): za takav order `maybeForward(makeForwardDeps(env, rail), order)`
   umjesto samo alarma. Latch 0016 jamči jedan forward i kad webhook retry stigne
   istodobno. Dokumentirati u ADR 0018 §Implementacija.

**Test.** processed bez memoa bez reda, star 20 min → alarm; isti u 6 h → bez;
`RECONCILE_FORWARDS=1` → `maybeForward` jednom; `somethingInFlight` true samo
zbog takvog ordera.

### P1-2 [S] Detektor: dead-man, lag, range shrink — TD-02, TD-04

1. `outflowWatch.ts` `watchAllRailOutflows` na uspješan prolaz (bez iznimke)
   `fetch(env.WATCH_HEARTBEAT_URL)` ako je postavljen (secret; healthchecks.io
   10-min grace). Nikad ne baca.
2. Svaki 30. tick: audit `outflow.tick` `{from,to,outflows}`.
3. `watchSafeOutflows`: na grešku `outgoingTransfers` pokušati `to = from +
   (range/2)` do min 100 blokova; 3 uzastopna neuspjeha (KV `watch:fail:<key>`)
   → ⚠️ alarm „detektor ne čita chain".
4. `head − cursor > 500` → ⚠️ „detektor zaostaje N blokova" (jednom u 6 h).

### P1-3 [S/M] `nonceManager` + admin retry — MT-10 (prethodni P0-2.5, P0-6)

1. `router/safe.ts`: `privateKeyToAccount(key, { nonceManager })` (`viem/nonce`).
2. `POST /admin/api/forwards/:id/retry` samo za `failed` memo/auto/manual
   redova: učita order iz D1 → `maybeForward(makeForwardDeps(env, rail), order)`
   (latch sprječava dupli); audit `forward.retry` s actorom; UI gumb „Pokušaj
   ponovno" u `/admin/forwards`.
3. `handleForward`: ako `result.error` matcha `/nonce too low|replacement
   transaction underpriced|already known/i` → jedan automatski retry nakon 5 s
   kroz `maybeForward` (isti latch), pa tek onda `failed`.

**Test.** retry na `confirmed` → 409; na `failed` → `forward()` jednom; dva
paralelna retryja → jedan broadcast; `nonce too low` → drugi pokušaj.

### P1-4 [M] Shopify: kupac, iznos, cancel grace — SH-01, SH-02, SH-03, SH-04

1. `/ext/order`: `verifySessionToken` vraća `{shop, sub}`; `ensureIntent` /
   `fetchOrder` dohvaća `customer { id }` i `createdAt`; `sub` prisutan →
   `customer.id === sub`; gost → `createdAt > now − 2 h`; inače 403
   `order_not_yours`. Rate-limit KV `ext:<shop>:<ip>` 20/min → 429.
2. `syncFinalToShopify('paid')`: re-read `totalOutstandingSet`; `received <
   outstanding` → `underpaid` grana; `received > outstanding` → tag
   `mpt-preplata` + metafield `amount_overpaid`.
3. `auto_cancel`: `CANCEL_GRACE_S` (shops stupac, zadano 7200); cancel samo kad
   `now > expires_at + grace` **i** `intent.status.stage === 'expired'`.
4. `received` tag: idempotentno pri svakom prolazu dok je `received` ili
   `tags_synced` JSON stupac.

**Test** (`core.test.ts` + novi `sync.test.ts` s mock Admin API-jem): gost +
narudžba 3 h → 403; `sub` ≠ customer → 403; 120 nakon izmjene / primljeno 100 →
`underpaid`; expired bez gracea → nema cancela; tag retry.

### P1-5 [S] ITalk hardening — MT-03, MT-07, MT-08

1. `whitelist.ts:101` `requireMintAt: rail.receivingSafe` iza
   `env.LEGACY_REQUIRE_MINT_AT === '1'`; pre-check SQL: `SELECT COUNT(*) FROM
   monerium_orders WHERE kind='issue' AND lower(address) <> lower('<SAFE>')`
   mora biti 0 (ili samo poznati stari EOA redovi).
2. `checkRouterGas`: uključiti `legacyRail(env)`.
3. `isKnownPayer(env, iban, excludeOrderId, tenantId)`: `AND COALESCE(tenant_id, ?) = ?`.

### P1-6 [M] Admin: Monerium rute pod sesiju; passkey re-auth — AD-02, AD-03

1. Premjestiti `/api/monerium/admin/*` → `/admin/api/monerium/*` i
   `/api/hpb/admin/*` → `/admin/api/hpb/*` (sesija + CSRF + audit `monerium.*`).
   Ako nijedan vanjski alat ne zove `/api/monerium/orders*` (grep po repoima:
   lib/, wallet/, energy, solardei) → obrisati rute, inače ostaviti iza
   `ADMIN_TOKEN` još jedan ciklus i rotirati token.
2. Passkey register: sesija `created_at > now − 10 min` ili `method='access'`
   + Telegram alert `admin.passkey_added`; max 5 po e-mailu.

### P1-7 [S] Offrail noga i iznos — OF-01, OF-02

1. `GET /admin/api/orders/:id/offrail-legs?tx=` → sve EURe noge iz Safe-a u tx-u
   `[{logIndex,to,valueWei,used}]`.
2. `POST …/resolved-offrail {tx_hash, log_index}`; `used` = postoji red s istim
   `tx_hash` i `log_index` (novi stupac `tx_log_index` na `monerium_forwards`,
   aditivno). Bez `log_index` → stara heuristika samo ako tx ima jednu nogu.
3. `valueWei !== eurToWei(order.amount)` → 409 `amount_mismatch` osim `force`+`reason`.

### P1-8 [M] Stara pretplata + KEK rotacija — MT-05, MT-06

1. `registerTenantWebhook`: `disableWebhookSubscription(old)` best-effort prije
   rotacije; `createWebhookSubscription` vraća `created.id` i kad PATCH padne
   (spremi id, vrati `typesApplied:false` → verify check `webhook_types`).
2. `secrets.ts`: `VERSION='v2'` za nove zapise; `decryptSecret(keks: {current,
   prev?}, …)` čita `v1` s `prev ?? current`, `v2` s `current`.
   `TENANT_SECRETS_KEK_PREV` opcionalan; `POST /admin/api/tenants/:id/rail/rewrap`
   ponovno šifrira sve `*_enc` → `v2`; `docs/runbook/kek-rotation.md`.

### P1-9 Prethodni plan — P0-7 (istek deterministički), P1-1 (dropped tx), P1-6 (sitni guardovi)

Nepromijenjeno; vidi `../2026-10-fable51/implementation-plan.md`. Dodatak za
P1-6: `currency === 'eur'` u gate `webhookHandler.ts:223-227` sada ima i
Shopify razlog (narudžbe u EUR jedino prolaze `ensureIntent`).

---

## P2

- **P2-1** SH-05 (AAD + `v2`), SH-06, SH-08 (timestamp ≤ 24 h), SH-09 (`?move=1`),
  SH-10 (backoff), TD-05 (`only_module_is_roles` verify check), SR-04 (bez
  LIMIT-a), SR-06 (preview iza dedupa, egzaktni `parseAmountCents`), AD-04
  (idle timeout), AD-05 (4-eyes iznad praga — odluka Matije).
- **P2-2** Prethodni P0-3 (dokaz posjeda na `/api/wallets*`), P0-4 (`/embed`
  clickjacking), P1-5 (klijent ne vjeruje backendu), P1-8 (relayer). Wallet od
  srpnja nije diran; svi nalazi stoje.
- **P2-3** ADR 0018: §„Zašto je to sigurno" → uvjet trusted kandidata; §Otvoreno
  → SR-03 riješen; §Poznata ograničenja → „Safe s vanjskim vlasnikom" postaje
  nemoguć auto cilj. ADR 0017 §Implementacija: MT-01, MT-02.
- **P2-4 Test paket** (regression): (1) trusted/untrusted resolver matrica,
  (2) reroute iznos/stanje, (3) BW-01 under/over, (4) outbox tenant za svih 6
  tipova eventa, (5) detektor po eventima + relay ugovor, (6) stage via
  `sid_resolved` s tuđim forwardom, (7) webhook 413 + skraćeni payload, (8) SSE
  9. sink, (9) audit actor, (10) bez ključa → failed, (11) reconcile stray
  alarm + forward, (12) Shopify kupac/iznos/grace, (13) KEK `v1`/`v2`/PREV.

---

## Što Opus treba napraviti prvo (max ROI / min rizik)

1. **P0-1** (trusted kandidati) — jedini novi nalaz s izravnim gubitkom
   sredstava bez tajne; mali diff, pre-check na produkciji obavezan.
2. **P0-3** (tenant na contribution.sepa) — 10 linija, zatvara PII curenje prije
   prvog tenanta.
3. **P0-4** (detektor po eventima) — detektor je jedina obrana od ukradenog
   ključa dok ADR 0019 ne stigne; danas ga relay ugovor zaobilazi.
4. **P0-2** (iznos + BW-01) — ručni reroute je novi put do „lažno plaćeno".
5. **P0-5, P0-7, P0-8, P0-6** — po S, bez ovisnosti.
