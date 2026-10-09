# Shopify app (put B) — nalazi (Fable 5.1, 2026-10-09)

Opseg: `shopify/worker/src/**`, `shopify/extensions/mpt-payment-qr/**`,
`shopify/scripts/*`, `shopify/shopify.app.toml` na HEAD `ef6622c` (mergeano u
#67, **nije deployano**). Ground check: `vitest` 18/18, `tsc` čist. Oznake kao u
`rail-multi-tenant-stray.md`.

Model: jedan Worker, N Shopify appova (custom distribution po trgovcu + opcionalni
shared), D1 s AES-GCM tajnama, intent po narudžbi preko tenant `pk_/sk_` ključa,
Thank-you/Order-status ekstenzija polla `/ext/order`.

---

### SH-01 [SEC-PII] `/ext/order` daje svakom nositelju session tokena trgovine podatke (i QR) o **bilo kojoj** narudžbi te trgovine

**Gdje.**
- `shopify/worker/src/index.ts:184-208` — `verifySessionToken` vraća samo
  `shop`; `order_id` iz query parametra; `ensureIntent(env, shop, orderGid)`
  dohvaća narudžbu Admin API-jem i stvara intent.
- `index.ts:236-255` — token vezan na `aud` (app) i `dest` (shop), ne na kupca
  (`sub`) ni na narudžbu.
- `index.ts:211-230` `publicView` vraća `order_name` („#1042"), `amount_eur`,
  QR, `checkout_url`.

**Kako puca.** Shopify session token dobiva **svaki** posjetitelj checkouta
(ekstenzija ga traži `shopify.sessionToken.get()`; token vrijedi ~1 min, ali
izdaje se neograničeno). Order GID-ovi su veliki, ali **sekvencijalni** brojevi
(`gid://shopify/Order/6123456789012`). Kupac A s tokenom u ruci enumerira
`order_id` ± 1000 → za svaku narudžbu plaćenu MPT-om dobije broj narudžbe,
iznos i QR; za ostale `not_mpt_gateway` (otkriva način plaćanja). Uz to svaki
pogodak **stvara intent** na railu (D1 red + 24 h TTL) i poziva Shopify Admin
API — amplifikacija troška.

**Popravak.**
1. Vezati zahtjev na narudžbu koju ekstenzija stvarno prikazuje: Thank-you /
   Order-status ekstenzije imaju `shopify.order` / `orderConfirmation` s
   `id` **i** kupčevim kontekstom; u tokenu Shopify stavlja `sub` (customer id)
   kad je kupac prijavljen. Server: ako `payload.sub` postoji →
   `order.customer.id === sub`, inače (gost) → dopustiti samo narudžbe
   kreirane u zadnjih 2 h **i** rate-limit 20/min po tokenu-`jti`/IP.
2. Nikad ne stvarati intent iz `/ext/order` za narudžbu koju `orders/create`
   webhook još nije vidio **i** koja je starija od 2 h (webhook je primarni put,
   ekstenzija je rezerva samo za svježe narudžbe).
3. Ne vraćati `order_name` za `pending` ako nije potreban u UI-ju (koristi se
   samo u labelu intenta).

**Test.** token bez `sub` + narudžba stara 3 h → 403; `sub` ≠ customer → 403;
20 pogodaka/min → 429.

---

### SH-02 [RISK → MONEY-semantika] Iznos intenta zamrznut pri prvom viđenju; kasnije izmjene narudžbe ne utječu na `paid`/`underpaid`

**Gdje.** `sync.ts:51-66` — `totalOutstandingSet` jednom, u `amount_cents`;
`sync.ts:90-94` `classifyIntent(intent, row.amount_cents)` uspoređuje s tim
zamrznutim iznosom; `syncFinalToShopify` (:153-163) `markOrderPaid` ako
`canMarkAsPaid`.

**Kako puca.** Trgovac uredi narudžbu (doda artikl, +20 €) prije uplate. Kupac
plati stari QR (100 €). Rail: `paid` 100/100 → worker `paid` → `orderMarkAsPaid`
na narudžbi od 120 € → Shopify je označi plaćenom (mutacija ne provjerava
iznos) → kupac duguje 20 € koje nitko ne vidi. Obratno (popust −20 €): kupac
plati 100, worker `paid`, OK, ali preplata nije zabilježena.

**Popravak.** U `syncFinalToShopify('paid')` ponovno pročitati
`totalOutstandingSet` i usporediti s `amount_received_cents`: ako primljeno <
trenutno dugovanje → tretirati kao `underpaid` (tag + metafield, **ne**
`markOrderPaid`); ako primljeno > dugovanje → tag `mpt-preplata` + metafield.
Test: narudžba 120 nakon izmjene, primljeno 100 → `underpaid`.

---

### SH-03 [RISK] `auto_cancel` otkazuje, vraća zalihu i šalje e-mail kupcu na `expired` bez provjere je li novac u međuvremenu krenuo

**Gdje.** `sync.ts:172-179` — `status === 'expired'` → `cancelOrder(…,
restock: true, notifyCustomer: true)`. `classifyIntent` (:95-99) `expired`
dolazi iz `intent.state`, a `received` iz `status.stage`; `nextStatus` (:104-108)
štiti `received` od regresije, ali ne i obrnuto po vremenu.

**Kako puca.** SEPA Instant plaćanje u 23:59:50, intent istječe 00:00:00;
Monerium `order.created` stiže 00:00:03. Cron tick 00:00:01: `GET
/api/intents/:sid` → `state='expired'`, `status.stage='awaiting_payment'`
(rail još ne zna) → `expired` → **cancel + restock + e-mail „otkazano"**. Rail
00:00:15: forward, `payment.late` → worker `paidAfterCancel` → trgovac ručno
vraća novac ili oživljava narudžbu; kupac je dobio dva kontradiktorna maila.
Uz BW-15 (istek materijaliziran 6-satnim cronom) `state` je ionako nepouzdan
signal.

**Popravak.** Grace nakon isteka prije otkazivanja: `expired` → `cancelled`
tek kad `now > expires_at + CANCEL_GRACE_S` (zadano 2 h, konfigurabilno po
trgovini) **i** zadnji `GET` intenta vraća `status.stage === 'expired'`
(server-side, ne `state`). Dotad status `expired` bez Shopify akcije (tag
`mpt-isteklo` može odmah).

---

### SH-04 [BUG] Tag `mpt-zaprimljeno` se dodaje jednom; ako Admin API padne, nikad se ne ponovi

**Gdje.** `sync.ts:116-129` — `updateOrder(status='received')` **prije**
`addOrderTags`; sljedeći prolaz `row.status === 'received'` → preskok.
`last_error` se upiše, ali nema retryja.

**Popravak.** Zasebno polje `tags_synced` (bitmask ili JSON) ili dodati tag
idempotentno pri svakom prolazu dok `status === 'received'` (Shopify `tagsAdd`
je idempotentan). Test: prvi `tagsAdd` baca → drugi prolaz ga ponovi.

---

### SH-05 [LOW] AES-GCM bez AAD — šifrati se mogu presaditi među redovima (`shops.mpt_api_key_enc` ↔ `apps.client_secret_enc`)

**Gdje.** `crypto.ts:107-121` — `encrypt({ name: 'AES-GCM', iv })` bez
`additionalData`; backend ima AAD `<tenant>|<field>` (`backend/src/tenants/secrets.ts:67-69`).

**Kako puca.** Tko ima write na D1 (ali ne KEK) kopira tenant ključ trgovine A
u red trgovine B → B stvara intente na A-ovom tenantu (A-ov IBAN, A-ova
whitelista) — zbunjujuće, ali whitelist gate na railu i dalje štiti novac.
Parnost s backendom, jeftino.

**Popravak.** `encryptSecret(kek, plaintext, aad = '<table>|<key>|<column>')`;
format `v2:` uz `v1` čitanje; migracijski rewrap pri prvom čitanju.

---

### SH-06 [LOW] `/webhooks/mpt` odgovara različito za nepoznat sid prije provjere potpisa

**Gdje.** `index.ts:153-166` — `unknown sid` 200 vs `webhook secret not
configured` 401 vs `invalid signature` 401. Sid je HMAC-izveden (32 hex), pa
enumeracija nije praktična; svejedno ujednačiti na 200 `ignored` za sve tri
grane nakon što se signatura provjeri gdje je moguće (ili 202 bez teksta).

---

### SH-07 [RISK] Deploy checklist: `database_id = "REPLACE_WITH_D1_ID"`, `SID_SECRET` nerotabilan, KEK bez kopije

**Gdje.** `wrangler.toml:19, 31-37`. Isto kao backend `TENANT_SECRETS_KEK` →
Keychain kopija (memorija `project_multi_tenant_rail`). `SID_SECRET` rotacija =
svi otvoreni intenti dobivaju nove sidove (409 `exists` više ne pogađa) → označiti
u README kao „never rotate" (već jest u komentaru) **i** spremiti u Keychain.
Prije prvog deploya: `wrangler d1 create`, ID u toml, `wrangler secret put` ×4,
`Keychain` kopije, `shopify app deploy` s `--config`, test trgovina + 1 €
(`shopify/README.md` plan).

---

### SH-08 [LOW] Install HMAC bez provjere svježine `timestamp`

**Gdje.** `index.ts:93-96` `installApp` → `verifyShopifyQueryHmac` (:43-53) ne
gleda `timestamp`. Shopify preporuča odbiti potpisane URL-ove starije od ~24 h
(replay instalacijskog linka). Posljedica je samo ponovno pokretanje OAuth-a (koji
traži Shopify consent), pa nisko; dodati `|now − timestamp| ≤ 86400`.

---

### SH-09 [LOW] `PUT /admin/apps/:client_id` dopušta tiho premještanje postojećeg appa na drugu trgovinu

**Gdje.** `index.ts:271-285` + `apps.ts:72-85` `ON CONFLICT … shop =
excluded.shop`. Operaterska greška („krivi slug") prebaci A-ov app na B; A-ove
instalacije (`shops.client_id`) ostaju, ali `appServesShop` sad odbija A →
webhooci A-a padaju 401. Zahtijevati `?move=1` za promjenu `shop` postojećeg
reda i logirati.

---

### SH-10 [LOW] Ekstenzija: polling bez eksponencijalnog backoffa i bez gornje granice trajanja

**Gdje.** `PaymentBlock.jsx:5, 33` — 5 s fiksno dok je `pending`/`received`;
Order-status stranica može ostati otvorena satima → 720 poziva/h po kupcu,
svaki s novim session tokenom. Backoff do 30 s nakon 2 min, stop nakon 1 h
(prikaz „Osvježi"). Server već throttla MPT poziv na 4 s (:195-197), pa je to
samo trošak Workera.

---

## Što je dobro

- Potpisi: Shopify query HMAC (sortiranje, bez `hmac`/`signature`), webhook
  HMAC nad sirovim tijelom, MPT Standard Webhooks s tolerancijom 300 s i
  rotacijom — sve konstantno-vremenski (`crypto.ts`).
- Više appova po Workeru: shop header samo bira kandidate, potpis odlučuje
  (`index.ts:105-110`); custom app jamči samo za svoju trgovinu (`appServesShop`).
- OAuth `state` jednokratan, vezan na shop i app, 10 min (`db.ts:112-128`).
- Session token: `aud` neprovjeren samo za **odabir** appa, potpis se
  provjerava tim appom; `dest` normaliziran i vezan na app (`index.ts:236-255`).
- `deriveSid` s tajnom — sid nije enumerabilan iz order id-a (`crypto.ts:94-97`).
- Underpayment se **ne** označava plaćenim (`sync.ts:90-94, 164-168`); late
  plaćanje se tretira kao plaćeno; `cancelled` ne regresira.
- Payload MPT webhooka je samo trigger; stanje se re-čita s API-ja (`index.ts:166-169`).
- `shop/redact` briše sve; `customers/*` nemaju što brisati (nema PII kupca).
