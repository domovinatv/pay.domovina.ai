# Backend Worker — nalazi (BW-*, CT-*)

Podsustav: `backend/src/` (Hono + D1 + KV). Svi nalazi verificirani protiv
koda čitanjem `index.ts`, `intents/{confirm,db}.ts`, `monerium/{webhook,db,sid}.ts`,
`router/safe.ts`, `gnosispay/proxy.ts`, `og/preview.ts`, migracija `0003/0006/0007`.

---

## BW-01 [MONEY-BUG] Underpayment/overpayment označen kao `paid` bez rekoncilijacije iznosa

**file:** `backend/src/intents/db.ts:70` (`markIntentPaid`), poziv iz
`backend/src/intents/confirm.ts:220` (`flipPaidAndNotify`)

**Failure scenarij (verificiran):** Intent traži `amount_cents = 5000` (€50).
Platitelj u banci ručno pošalje €30 (SEPA memo/iznos je payer-editabilan).
Monerium izda order na €30, forward prođe, `settleConfirmedForward` →
`flipPaidAndNotify` → `markIntentPaid`. `markIntentPaid` izvršava
`UPDATE ... SET state='paid', amount_received_cents=3000 WHERE sid=? AND
state='pending'` — **nigdje ne uspoređuje `amount_received_cents` (3000) s
`amount_cents` (5000)**. Intent flipa u `paid`, merchant webhook
(`emitIntentPaid`) šalje "plaćeno". Migracija `0007` čak eksplicitno komentira
kolonu: `amount_received_cents -- actual amount; may differ from intent`.

**Fix:** U `markIntentPaid` (ili `flipPaidAndNotify` prije njega) dohvatiti
očekivani `amount_cents` i usporediti s primljenim. Odluka je produktna:
(a) odbiti flip ako `received < expected` i ostaviti `pending` (uz novo stanje
`underpaid`), ili (b) flipati ali u merchant webhook uvijek slati
`{expected, received, shortfall}` da merchant sam odluči. Minimalno: nikad ne
slati golo "paid" bez oba iznosa.

**Acceptance:** Unit test na `markIntentPaid`/`flipPaidAndNotify`: intent €50,
primljeno €30 → intent NIJE `paid` (ili webhook payload sadrži `shortfall:2000`).
Test overpayment €70 → definirano ponašanje (ne tiho `paid` kao €50).

---

## BW-02 [MONEY-BUG] Dvostruki forward: check-then-act bez atomskog zasuna + nonce collision

**file:** `backend/src/index.ts:459` (`maybeForward`), `backend/src/router/safe.ts:195`
(auto-nonce), `backend/migrations/0006_monerium_forwards.sql:40` (samo ne-unique indeks)

**Failure scenarij (verificiran):** Monerium pošalje dva *različita*
`order.updated`+`state=processed` eventa (različiti `webhook-id`) za isti order
u kratkom razmaku (dozvoljeno — komentar na `index.ts:222` kaže "order.updated
may fire more than once"). Oba prođu `alreadyProcessedEvent` (različit id) →
oba `waitUntil(maybeForward)`. Oba `getForwardByOrder` vide da još nema
`submitted`/`confirmed` reda → oba `insertForward` (nema `UNIQUE(order_id)`,
samo `CREATE INDEX idx_monerium_forwards_order`) → oba `forwardViaSafe`.
`forwardViaSafe` (safe.ts:141) kreira svjež `walletClient` i zove `writeContract`
**bez eksplicitnog noncea** — viem dohvaća nonce preko `eth_getTransactionCount`.
Dva ishoda, oba loša: (a) ako oba dohvate isti pending nonce → jedan tx zamijeni
drugi (isti nonce) → jedan forward tiho nestane, njegov intent nikad ne flipa;
(b) ako dohvate sekvencijalno različite nonceve → **oba lande → dupli EURe
transfer** istog iznosa.

**Fix:** Idempotencija na razini baze — budući da dizajn dopušta više redova po
`order_id` (multi-recipient, migration comment), dodati `UNIQUE(order_id,
target_address)` ili uvesti atomski `INSERT ... ON CONFLICT DO NOTHING` guard
oko `(order_id, target)` prije `forwardViaSafe`, i serijalizirati forward EOA
nonce (nonce manager ili per-order lock preko D1/DO). Vidi WR-01 za istovjetan
problem na wallet relayer EOA.

**Acceptance:** Test koji simulira dvije istovremene `maybeForward` pozivke za
isti order → točno JEDAN `forwardViaSafe` broadcast. Integracijski: dva
istovremena webhooka istog ordera → jedan forward red, jedan on-chain tx.

---

## BW-03 [MONEY-BUG] Webhook-id dedup markira event obrađenim prije trajnog forwarda

**file:** `backend/src/index.ts:199` (`alreadyProcessedEvent`), backstop
`backend/src/intents/confirm.ts:189` (`reconcileSubmittedForwards`)

**Failure scenarij (verificiran):** Prva dostava webhook-ida `X`:
`alreadyProcessedEvent(X)` radi `INSERT OR IGNORE` → vraća `false` (nije viđen),
**upisuje `X` kao obrađen NA OVOM MJESTU (linija 199)**. Zatim
`waitUntil(maybeForward)` (linija 232). Ako taj `waitUntil` transientno padne
(RPC hiccup → `insertForward` status `failed`) ILI Worker bude evictan prije
nego `maybeForward` uopće izvrši, Monerium retry-a **isti** `webhook-id` `X`
(Standard Webhooks retry reuse id, do 10×/12h). Druga dostava:
`alreadyProcessedEvent(X)` → `true` → `return {dedup:true}` na liniji 202,
**nikad ne poziva `maybeForward`**. Cron `reconcileSubmittedForwards` pokriva
samo `status='submitted'` redove (confirm.ts:302 `WHERE status='submitted'`) —
`failed` ili nepostojeći forward se nikad ne pokupi. EURe zaglavljen, sustav
misli da je event obrađen.

**Fix:** Ne markirati `webhook-id` obrađenim dok forward nije barem u
`submitted` (ili razdvojiti "event zabilježen" od "forward dovršen"). Alternativa:
proširiti cron reconcile da pokriva i `failed`/`pending` forwardove starije od
praga (retry s backoffom), i `no_routing_target`/orphan alerting.

**Acceptance:** Test: prva dostava → `maybeForward` baci (mock RPC fail) →
forward `failed`; druga dostava istog id → forward se retry-a (ili cron ga
pokupi). Trenutno se druga dostava tiho odbaci.

---

## BW-04 [MONEY-BUG] Neuspjeli broadcast nikad automatski ne retry-a

**file:** `backend/src/index.ts:566` (`handleForward` else grana),
`backend/src/router/safe.ts:142` (jedini RPC)

**Failure scenarij (verificiran):** `forwardViaSafe` uhvati iznimku (RPC
timeout/5xx na `rpc.gnosischain.com`) → vrati `{ok:false}`. `handleForward`
upiše forward `status='failed'` (linija 567) i završi. Nijedan scheduled put ne
retry-a `failed` forwardove (reconcile gleda samo `submitted`). Jedan tranzijentni
RPC kvar u trenutku forwarda = trajno parkiran EURe dok netko ručno ne
intervenira (admin `POST /sync` samo re-upserta ordere, ne re-forwarda).

**Fix:** Cron put koji re-pokušava `failed` forwardove (uz cap na `attempts` i
eksponencijalni backoff), ili premjestiti forward u durable retry queue.
Vezano uz XD-02 (RPC fallback bi smanjio učestalost okidača).

**Acceptance:** Test: forward `failed` zbog RPC → sljedeći cron tick ga
re-broadcasta (uz `attempts++`), do maksimuma pokušaja pa alert.

---

## BW-05 [SEC] Javni neautenticirani endpointi cure PII platitelja

**file:** `backend/src/index.ts:240` (`/api/monerium/orders`), `:245`
(`/api/monerium/orders/:id`), `:82` (`/api/hpb/accounts`), `:87`
(`/api/hpb/transactions`)

**Failure scenarij (verificiran):** Sve četiri rute su mountane na glavni `app`
BEZ `bearerAuth` middlewarea (koji postoji samo na `admin`/`moneriumAdmin`
sub-appovima). `listMoneriumOrders` (`monerium/db.ts:78`) radi `SELECT *` i vraća
`counterpart_iban`, `counterpart_name`, `memo`, `reference_number` i cijeli
`raw_json`. Bilo tko s URL-om dohvati IBAN-ove, imena i memo svih platitelja.
`/api/hpb/transactions?account_id=…` vraća sve bankovne transakcije računa.

**Fix:** Staviti Monerium/HPB read rute iza `bearerAuth` (ili barem iza
per-intent scoping tokena), ILI vratiti samo ne-PII projekciju. Ako checkout
stranica treba read pristup, koristiti per-sid scoped endpoint koji vraća samo
taj intent, ne cijelu listu.

**Acceptance:** `curl` bez `Authorization` na `/api/monerium/orders` → 401.
Postojeći consumeri (admin UI, checkout) migrirani na autenticiran/scoped put.

---

## BW-06 [SEC] Gnosis Pay proxy je neautenticiran open relay

**file:** `backend/src/gnosispay/proxy.ts:30`

**Failure scenarij (verificiran):** `buildGnosisPayProxy` montira `api.all('/*')`
koji svaki path+query prosljeđuje na `https://api.gnosispay.com${rest}${search}`
s browser-like headerima; naša strana nema auth. Bilo tko može koristiti naš
Worker kao anonimizirajući proxy prema GP (naš CF egress IP, potencijalno
zaobilazi GP geo/IP kontrole). Prosljeđuje se caller-ov vlastiti `Authorization`
(nema server-held tajne — self-custody netaknut), pa nije eskalacija
privilegija, ali je reputacijski/abuse rizik i otvorena površina.

**Ublaženo:** iza `VITE_GP_ENABLED` gatinga (GP faze još nisu general-release).
Regex `rest = path.replace(/^.*\/api\/gp-proxy/, '')` NE dopušta host-switch
(path-only), pa nije klasičan SSRF na proizvoljan host.

**Fix:** Staviti proxy iza istog `bearerAuth` ili barem iza Turnstile/origin
provjere; allowlist dozvoljenih GP putanja umjesto `/*`.

**Acceptance:** Neautenticiran zahtjev na `/api/gp-proxy/...` → 401/403 kad je
GP omogućen.

---

## BW-07 [SEC] Non-constant-time usporedba tajne (indexer/OG)

**file:** `backend/src/index.ts:390` (`/api/onchain/scan`), `:400` (`/api/og-preview`)

**Failure scenarij (verificiran):** Oba endpointa rade `key !== secret` (obični
string `!==`) protiv `INTENT_WEBHOOK_SECRET`. Teoretski timing-side-channel za
rekonstrukciju tajne. Praktična eksploatabilnost niska (mrežni jitter ≫ timing
signal, treba puno uzoraka), ali `webhook.ts` već ima `timingSafeEqualString` —
nekonzistentno je da ga ovi putevi ne koriste.

**Fix:** Koristiti `timingSafeEqualString` (već postoji u `monerium/webhook.ts`)
za obje usporedbe.

**Acceptance:** Grep: nema `!== secret` na secret-comparison putevima; svi idu
kroz timing-safe helper.

---

## BW-08 [BUG] Forward gate ne provjerava currency

**file:** `backend/src/index.ts:227` (forward gate uvjet)

**Failure scenarij:** Gate provjerava `order.kind==='issue' && eventType===
'order.updated' && order.state==='processed'`, ali NE `order.currency`.
`handleForward` → `eurToWei(order.amount)` tretira iznos kao EURe (18 dec) bez
obzira na valutu. Ako Monerium ikad izda ne-EUR issue order (npr. GBP), forwardao
bi se nominalni iznos kao EURe. **Confidence: medium** — ovisi o tome može li
Monerium profil uopće izdati ne-EUR; za trenutni EURe-only setup nije okidljivo,
ali je tiha pretpostavka bez guarda.

**Fix:** Dodati `&& order.currency === 'eur'` u gate; loggirati skip za ostale.

**Acceptance:** Test: issue order `currency='gbp'` → nema forwarda, zabilježen skip.

---

## BW-09 [BUG] `ADDR_RE` bez granice → truncation dugačkog hex stringa

**file:** `backend/src/monerium/sid.ts:5` (`ADDR_RE = /0x[0-9a-fA-F]{40}/`)

**Failure scenarij (verificiran, niska reachability):** Regex nema završni
anchor/granicu. Za memo s hex nizom dužim od 40 znakova bez separatora (npr.
64-hex tx hash zalijepljen kao `0x<64hex>`), `.match` vraća **prvih 40** hex
znakova → skraćena, pogrešna adresa → forward šalje EURe na neželjenu adresu.
Naši QR-ovi emitiraju točno 40-hex iza kojeg slijedi `?`/space/kraj, pa se ne
okida; okidanje traži malformiran/adversarijalan memo, a napadač bi štetio samo
sebi (šalje vlastiti novac). Zato **BUG, ne MONEY-BUG**.

**Fix:** `\b` granica ili negativni lookahead: `/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/`.

**Acceptance:** Test: `parseSid`/`extractRoutingTarget` na `0x<64hex>` → null ili
odbijeno, ne skraćena adresa.

---

## BW-12 [BUG] `order.state` vs `meta.state` neusklađenost

**file:** `backend/src/monerium/db.ts:60` (upsert prihvaća `order.state ??
order.meta?.state`) vs `backend/src/index.ts:229` (gate čita samo `order.state`)

**Failure scenarij (verificiran):** `upsertMoneriumOrder` sprema
`order.state ?? order.meta?.state ?? 'placed'` — dakle order kojem je stanje
samo u `meta.state='processed'` biva spremljen kao `processed`. Ali forward gate
na `index.ts:229` provjerava `order.state === 'processed'` (bez meta fallbacka)
→ takav order se nikad ne forwarda iako je u bazi "processed". Nekonzistentnost
između write i read pretpostavke; EURe parkiran, admin UI pokazuje "processed".

**Fix:** Ekstrahirati stanje kroz jedan helper (`resolveOrderState(order)`) koji
oba mjesta koriste, uključujući meta fallback.

**Acceptance:** Test: order sa `state` samo u `meta` → gate ga tretira kao
processed (ili se eksplicitno dokumentira da meta-only nije valjan signal).

---

## BW-13 [RISK] Webhook upisuje puni payload+headere prije provjere potpisa

**file:** `backend/src/index.ts:178` (`recordMoneriumWebhookEvent` prije
`if (!verify.ok)` na `:189`)

**Failure scenarij (verificiran):** `recordMoneriumWebhookEvent` upisuje
`payload` (cijeli raw body) + `headers_json` u D1 **prije** nego se odbije
nevaljan potpis (linija 189). Neautenticiran napadač može slati velike bodyje na
`/api/monerium/webhook` i napuhati `monerium_webhook_events` tablicu (storage
flood / write amplification, D1 troškovi).

**Fix:** Odbiti prevelike bodyje (Content-Length cap) prije upisa; ili upisivati
samo skraćeni preview za signature-failed evente; rate-limit po IP.

**Acceptance:** Body > N KB s nevaljanim potpisom → odbijen bez punog D1 upisa.

---

## BW-14 [RISK-low] Webhook nema timestamp toleranciju (replay window)

**file:** `backend/src/monerium/webhook.ts:40` (`verifyWebhookSignature`)

**Failure scenarij:** `verifyWebhookSignature` ne validira `webhook-timestamp`
protiv tolerancije — Standard Webhooks preporuča odbiti dostave starije od ~5
min. **Ublaženo:** `alreadyProcessedEvent` dedup po `webhook-id` znači da replay
istog capturea biva odbijen (isti id), a napadač ne može forgeati potpis za novi
id. Zato je praktični replay rizik nizak. Ipak, timestamp check je jeftina
defense-in-depth.

**Fix:** Odbiti ako `abs(now - webhook-timestamp) > 300s`.

**Acceptance:** Test: valjan potpis sa `webhook-timestamp` starim 1h → odbijen.

---

## CT-01 [SEC-latent] safe-tx `005` daje delegatecall na MultiSend bez unwrappera

**file:** `backend/safe-tx/005-extend-role-payment-registry.mjs:136`

**Failure scenarij:** Batch `005` proširuje Zodiac Roles rolu da dopusti
`allowFunction` na `MultiSendCallOnly.multiSend` preko DELEGATECALL, ali **bez
postavljanja transaction unwrappera** na Roles Modifieru. Bez unwrappera, Roles
ne dekodira inner pozive MultiSenda → ograničenje "smije samo `EURe.transfer`"
je zaobiđeno: kompromitiran `ROUTER_PRIVATE_KEY` mogao bi kroz MultiSend
delegatecall izvršiti proizvoljne inner pozive u kontekstu Safe-a. **Latentno:**
registry put nije live (`PAYMENT_REGISTRY_ADDRESS=''`, nema `004`/`005` EXECUTED
fajlova). **Confidence: medium** — stvarno ponašanje deploy-anog modifiera nije
verificirano offline.

**Fix:** Prije aktivacije registry puta, postaviti `setTransactionUnwrapper` za
MultiSendCallOnly na Roles Modifieru (Zodiac Roles v2 MultiSendUnwrapper), tako
da su inner pozivi scope-ani na `registry.record` + `EURe.transfer`.

**Acceptance:** On-chain: role s aktivnim unwrapperom revert-a MultiSend batch
koji sadrži bilo koji inner poziv osim record+transfer.

---

## CT-03 [BUG-low] `getForwardStatus` ne razlikuje "not mined" od RPC greške

**file:** `backend/src/router/safe.ts:225`

**Failure scenarij:** `getTransactionReceipt` baci (RPC greška) → `catch` vraća
`'unknown'`; a not-yet-mined tx vraća `'pending'`. Poll/reconcile tretiraju
`unknown` kao ne-terminalno (nastavljaju), pa RPC greška izgleda kao normalno
čekanje — maskira trajni RPC problem. Minorno (ne gubi novac), ali otežava
dijagnostiku.

**Fix:** Loggirati/brojati `unknown` odvojeno; nakon N uzastopnih `unknown` na
istom tx-u → alert.

**Acceptance:** Metrika/log razlikuje "pending (not mined)" od "RPC unknown".
