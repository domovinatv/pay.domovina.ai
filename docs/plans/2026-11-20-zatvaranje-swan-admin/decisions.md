# Odluke — zatvaranje Swan / ADR 0032 i admin v2

Svaka odluka ima broj, datum, razlog i uvjet revizije. Odluka se ne briše: nova je zamjenjuje
i navodi koju. Blokovi po sesiji: S1 100–199, S2 200–299 … S8 800–899.

## S0 (2026-11-20)

1. **Opseg.** Stavke iz „Otvoreno” u `docs/2026-11-18-admin-v2.md` i `docs/research/provideri/swan.md`
   te koraci 1–4 iz ADR 0032 „Stanje 2026-11-18”. Revolut, Wise, LHV i bank-push-gateway nisu u ovom lancu.
2. **Redoslijed: prvo bez promjene ponašanja.** Guardovi (S1) i dvostruko čitanje (S2) idu prije
   bilo kakve promjene pisanja (S3) ili odlučivanja (S4), da compat-check svaki korak drži bez
   `behavior-change`. Revizija: ako se pokaže da S2 ne može biti bez promjene izlaza.
3. **Mjerenje prije matchera.** S4 se ne pokreće dok S1 ne potvrdi da se Monerium uplate u prodi
   zapisuju u `credit_events` i vežu na `intent_settlements`.
4. **Stupac `monerium_order_id` ostaje** (čitatelji izvan lanca, v1, export). Njegovo uklanjanje nije
   u ovom lancu.
5. **Swan produkcija nije sesija.** Razgovor sa Swanom vodi Matija; uvjeti i cijene ne ulaze u ovaj
   javni repo.
6. **v1 admin se ne dira dok Matija ne odluči** (S7). Do tada vrijedi pravilo da v2 ne linka u v1.
7. **Testovi:** backend `vitest` bez mreže, `skipped 0`; Flutter `flutter test`. Novi testovi se
   dodaju, stari se ne mijenjaju.

## S1 (2026-11-20)

100. **Inbox radi, S4 smije krenuti.** Jedina Monerium uplata nakon deploya #155
     (`sq6x4g29kx8e`, crosulja-staging, 19. 11.) ima notified + booked u `credit_events` i
     `intent_settlements.credit_event_id` = booked. Odstupanja `monerium_order_id` ⇔ settlement: 0.
     Brojke: `research/2026-11-20-monerium-inbox-mjerenje.md`. Revizija: S4 prije početka ponavlja
     upite. Ako nova uplata nema vezan događaj, S4 stoji.
101. **„Namireno” = `settledSql(alias)`** (`intents/db.ts`): red u `intent_settlements` ILI
     `monerium_order_id IS NOT NULL`. Čisti prelazak samo na `intent_settlements` rušio je 5 starih
     testova (`stateMachines`, `strayTrustSql`, `intentList`) čiji fixtureovi pišu `monerium_order_id`
     bez reda u settlementu. To je promjena ponašanja na podacima koji krše invarijantu, pa prema
     regresijskom ugovoru ide OR. U prodi su oba uvjeta ista (odluka 100). S3 ostavlja
     `monerium_order_id` NULL i oslanja se na red. Revizija: kad stari fixtureovi pređu na
     `intent_settlements` (behavior-change PR), `monerium_order_id` pola se briše.
102. **Opravdana preostala mjesta s `monerium_order_id IS`:** samo `payers/api.ts:90`. Tamo je to
     ID Monerium ordera (UNION s `monerium_orders.id` za oznake platitelja), a ne „namireno”. JS
     provjere nad već učitanim redom ostaju do S3: `inflow/matcher.ts` `settleable`,
     `intents/intentStates.ts`, `monerium/forward.ts:902`, `sandbox/simulate.ts:104`. Njih štiti SQL
     claim. Za Monerium i sandbox, koji i dalje pišu `monerium_order_id`, su točne. S3 ih mora
     prebaciti kad fiat prestane pisati sintetski order.
103. **Redoslijed u batchu je testiran:** `test/settlementGuards.test.ts`. Ako se zamijene `[claim, link]`,
     padne 5 od 7 testova. Ako se makne guard u `markIntentLate`, padnu 2.
104. **S1 bez subagenata.** Paket je imao 4 datoteke i 11 SQL izmjena, pa ga je orkestrator radio sam.
     Pravilo o subagentima ostaje za veće pakete.

## S2 (2026-11-20)

200. **„Sandbox fiat intent” = Swan intent na sandbox tenantu** (`sbx-…`, Swan Testing API). ADR 0024
     simulacija (`sandbox/simulate.ts`, `sim_…`) je Monerium/onchain rail, ne piše `credit_events` i
     nije fiat (`intentProvider` = monerium). Zato S2 i S3 ne diraju `sim_` redove. Test pokriva Swan
     na živom i na sandbox tenantu.
201. **Jedan čitač, isti graditelj.** `inflow/settleFiat.ts` `fiatSettlementOrder(env, intent)` za fiat
     intent s redom u `intent_settlements` vraća order-red izgrađen iz booked `credit_events` događaja
     kroz isti `buildSyntheticOrder` + `moneriumOrderRow` (izvučen iz `upsertMoneriumOrder`). Pogled je
     polje po polje jednak sintetskom redu, osim `updated_at` (= `intent_settlements.created_at`).
     Koristi ga `loadStageContext` (status, SSE) i `getPaymentBundle` (admin v2 detalj). Bez
     settlementa, ili ako se `settlement_ref` ne slaže s događajem, čita se kao prije (dvostruko čitanje).
202. **Veza na događaj bez prozora.** `credit_event_id` postavlja `recordMatch` tek nakon settlea, pa
     čitač za taj trenutak nađe booked događaj po ključu: `provider_ref = <ref bez "<provider>_">:booked`.
     U prodi su sva 4 Swan settlementa vezana (`credit_event_id` nije NULL, upit 20. 11.).
203. **`forwards` u admin detalju nije dio „istog izlaza”.** Sintetski `fiat_notify` forward se u v2 detalju
     prikazuje kao „Proslijeđeno na odredište → 0x000…0000 · fiat_notify”. To je lažan korak (fiat
     nema isplate na lancu), pa ga S2 ne glumi iz `credit_events`. Kad ga S3 prestane pisati, korak
     nestaje. To je jedina vidljiva razlika i ide u S3 PR kao namjerna.
204. **Čitatelji bez izmjene** (popis iz `grep -rn "monerium_orders\|syntheticOrderId\|swan_\|monerium_forwards" backend/src`):
     - `admin/v2/data.ts` lista/brojke: status ovisi samo o zadnjem forwardu `failed/blocked`; fiat forward
       je `confirmed`, pa je izlaz isti i bez njega (test).
     - `intents/outbox.ts`/`outbound.ts`: outbox se piše pri namiri iz objekta u memoriji, isporuka ne
       čita ordere. Payload `payment.received` gradi se iz sintetskog ordera; S3 ga mora graditi isto.
     - `receipts/*`: fiat intent ne može dobiti potvrdu (`receipts_not_for_fiat`, `intents/api.ts:271`).
     - `payers/api.ts`: traži po 0x adresi; fiat cilj je `FIAT_TARGET_PLACEHOLDER`.
     - `monerium/reconcile.ts:52`: gleda otvorene/neforwardane ordere; sintetski je `processed` s forwardom.
     - `sandbox/db.ts`, `sandbox/simulate.ts`: samo `sim_` (odluka 200).
     - `intents/shortRef.ts`, `intents/db.ts` stray upiti, `offrail`, `outflowWatch`, `confirm`: onchain forwardi.
205. **Postojeći nedostaci koje S3 popravlja usput** (danas ih uzrokuje sintetski red; S2 ih ne mijenja
     jer bi to bila promjena ponašanja):
     - `monerium/db.ts` `isKnownPayer` broji i `swan_` ordere, pa Swan uplata s IBAN-a X čini kasniju
       Monerium uplatu s istog IBAN-a „poznatim platiteljem”.
     - `receipts/link.ts` `coverable()` isključuje `sim_`, ali ne i `swan_`: lijena potvrda Monerium
       uplate može „pokriti” raniju Swan uplatu s istog IBAN-a.
     - `sandbox/db.ts` sweep ne briše `swan_` ordere i `fiat_notify` forwarde sandbox tenanta (nema FK, pa
       ne puca, samo ostaju siročad).
     - admin v2 isplate (`listForwards`) prikazuju `fiat_notify` forwarde; v2 detalj linka na v1
       `/admin/orders/swan_…`, koji bez reda vraća 404.
206. **S2 bez subagenata** (kao 104): 4 izvorne datoteke, 1 test.

## S3 (2026-11-20)

300. **Matija je odobrio vrata S3 (20. 11. u sesiji):** fiat namira prestaje pisati sintetske
     `monerium_orders`/`monerium_forwards` redove, a odobrenje uključuje i deploy nakon merga. Stari
     redovi (4 `swan_` ordera + 4 `fiat_notify` forwarda u prodi, svi na sandbox tenantu) **brišu se
     migracijom** `0037_fiat_bez_sintetskog_ordera.sql`.
301. **Claim bez ordera.** `markIntentPaid/Underpaid/Late` primaju `SettleArgs`. Kod fiata su
     `moneriumOrderId` i `forwardId` NULL, a `settlementRef` (`<provider>_<txId>`) imenuje uplatu. Red
     u `intent_settlements` piše se u istom batchu kao i dosad. Uvjet „claim je prošao” za fiat je
     `WHERE changes() > 0` (prethodna naredba iste transakcije), jer na intentu nema ničega što bi se
     ponovno pročitalo. Monerium put ostaje doslovno isti SQL. Revizija: ako živa Swan uplata nakon
     deploya nema red u `intent_settlements`, `changes()` u D1 batchu ne radi kako je pretpostavljeno.
302. **Učitani red nosi namiru.** `getIntent` i `listTenantIntents` vraćaju i `settlement_ref`
     (podupit). JS provjere iz odluke 102 idu kroz `isSettled(row)`: `matcher.ts` `settleable`,
     `intentStates.ts` `logicalIntentState`, `forward.ts` reroute (preko `whitelist.ts`
     `getIntentBySid`) i `simulate.ts`. SQL tekst `getIntent` i dalje sadrži
     `FROM payment_intents WHERE sid`, jer test doubleovi (`tenantIsolation` i drugi) prepoznaju upit
     po tom nizu.
303. **Merchant vidi isto.** `monerium_order_id` u `intent.paid`/`payment.underpaid`/`payment.late`
     payloadu i u `GET /api/intents/:sid` (i listi) je `settlementId(row)` = `monerium_order_id ??
     settlement_ref`, dakle za fiat isti `swan_…` kao prije. `payment.received` (`rcv_<ref>`) se i dalje
     gradi iz `buildSyntheticOrder`, samo se više ne sprema. Dokaz:
     `test/fixtures/swan/merchant-payloads-pre-s3.json` je snimljen istim testom
     (`fiatSettleNoSynthetic.test.ts`, `CAPTURE_PRE_S3=1`) na `origin/main` 17dd3c9; S3 kod daje
     identičan izlaz (outbox id/tip/payload + javni GET) za živi i sandbox tenant.
304. **Admin v2 detalj za fiat:** nema linka na v1 `/admin/orders/…` (u koraku stoji `provider_ref`
     događaja, a blok je „Uplata (swan)” bez „Sirovi JSON (v1)”). Korak „Proslijeđeno na odredište →
     0x000…0000 · fiat_notify” nestaje jer forwarda više nema (odluka 203).
305. **Sweep (`sandbox/db.ts`) se ne mijenja.** Novi `swan_` redovi više ne nastaju, a stare briše 0037.
     Sweep i dalje briše `intent_settlements` i `credit_events` sandbox tenanta. `simulate.ts` dobiva
     samo `isSettled` (odluka 302); `sim_` put ostaje (odluka 200).
306. **Migracija 0037** stare Swan intente svodi na novi oblik (`monerium_order_id`, `forward_id` → NULL)
     samo ako postoji red u `intent_settlements` s istim refom (u prodi 4/4 vezano, upit 20. 11.). Zatim
     briše `fiat_notify` forwarde i `swan_` ordere na koje više ne pokazuje nijedan intent.
307. **Behavior-change, stari testovi koji padaju (10):**
     - `swanAdapter.test.ts` „re-reads the transaction…” traži `monerium_order_id = swan_…`,
       sintetski order i `fiat_notify` forward; „a redelivery…” traži 1 forward. Sada ih nema (odluka 300).
     - `fiatSettlementReaders.test.ts` (S2, 4 testa × 2 tenanta): `deleteSynthetic` očekuje da postoji
       po jedan sintetski order i forward, test „pogled = sintetski red” čita spremljeni order, a test
       „bez reda u intent_settlements čita se kao prije” se oslanja na sintetski order kao rezervu.
       Ono što je S2 tim testovima dokazivao (čitatelji ne trebaju sintetski red) sada pokriva
       `fiatSettleNoSynthetic.test.ts`, gdje redova nema od početka.
308. **Živa provjera (20. 11.):** deploy `bdcd7f0b` + migracija 0037 (u prodi 0 `swan_` ordera, 0
     `fiat_notify` forwarda, 4 Swan namire ostaju; stari `vmwjxqts8ajj` i dalje vraća isti
     `monerium_order_id` i `settled`). Novi intent `x22x58fvjk8s` (admin v2, `sbx-d166d9a98b`, 12,34 €)
     → gumb „Simuliraj uplatu (Swan)” → `paid`, `monerium_order_id` NULL, red u `intent_settlements`
     (`swan_bosci_6a7e…`, `credit_event_id` vezan), 0 novih `swan_` ordera i forwarda. `changes()` u D1
     batchu radi (odluka 301). Ovaj sandbox tenant nema merchant webhook, pa outbox ni prije ni sada
     nema redova; jednakost payloada dokazuje zlatni test (odluka 303).

## S4 (2026-11-20)

400. **Preduvjet ponovljen (odluka 100).** Upiti 1 i 2 u prodi 20. 11. u 20:15: i dalje jedina Monerium
     uplata nakon #155 je `sq6x4g29kx8e` (notified 5 + booked 6, `intent_settlements.credit_event_id` = 6).
     Upit 3 (neusklađenost `monerium_order_id` ⇔ settlement) daje 5 = 5 Swan namira bez
     `monerium_order_id` od S3 (odluka 301), dakle očekivano. S4 smije krenuti.
401. **Jedna jezgra, dva ulaza.** `inflow/matcher.ts` `matchReferenceless` (kratka referenca → stray) je
     jedini kod koji odlučuje kojem intentu pripada uplata bez reference. `matchCreditEvent` (fiat) i
     `matchMoneriumOrder` (Monerium) ga zovu; `forward.ts` više nema vlastito traženje
     (`matchShortRef`, `isStray` i blok resolvera su uklonjeni). Razlike koje ostaju su ulazne, ne
     logičke: Monerium čita memo pa `referenceNumber` (`shortRefFromOrder`), prozor stray resolvera
     sidri na `placedAt` (ne na `processedAt` booked događaja, inače bi se prozor pomaknuo), a resolver
     radi samo uz `STRAY_RESOLVER=1` (dep izostaje). Swan ostaje isti (`stray` uvijek uključen).
402. **Memo rutiranje nije pogađanje.** Ako remittance imenuje sid, adresu ili kampanju
     (`isReferenceless` = ne), matcher vraća `{kind:'memo'}` i ništa ne traži; o tome odlučuje gate
     `authorizeForward` kao i dosad (tenant, whitelist, mint adresa, latch). Swan sid grana
     (`sid_other_tenant`, `sid_already_settled`) ostaje samo za fiat jer fiat nema gate.
403. **Matcher ne prenosi novac i ne bira konačni sid sam.** Za stray vraća cijeli redoslijed claimova
     (`sids`); `forward.ts` `claimForward` uzima prvi slobodan (latch 0018), kao prije. Zato je
     „tko je dobio uplatu” poznat tek nakon claima.
404. **`credit_events.matched_sid` = izvršena odluka.** Nakon uspješnog claima forward upisuje na
     `<order>:booked` događaj `matched_sid` = preuzeti sid, `matched_by` = `sid` | `short_ref` |
     `stray` | `manual` (reroute), a za višeznačan stray bilješku `stray_ambiguous: <sids>` (isti oblik
     kao Swan). Park upisuje `matched_sid` NULL i `park: <razlog>`, pa se parkirana uplata vidi među
     nevezanima u admin v2 i kad je memo imao sid. Notified događaj i zapis u webhooku
     (`recordMoneriumCredit`, `stray_preview`) se ne mijenjaju. Upis je `ForwardDeps.recordMatch`
     (opcionalan, `safely`): pad upisa nikad ne zaustavlja forward. Cron reconcile koji forwarda order bez
     inbox reda nema što ažurirati.
405. **Bez promjene ponašanja na putu novca.** Forward redovi, potpisi, park razlozi, alerti, merchant
     webhookovi i namire su isti; jedina nova stvar su stupci `matched_*` na booked događaju (podatak za
     admin, nijedan stari test ga ne čita). Dokaz: `scripts/compat-check.sh` zelen bez oznake
     (backend, shopify/worker, wallet; base 5e52bbd) i replay `test/moneriumReplay.test.ts` (odluka 406).
406. **Replay.** `test/moneriumReplay.test.ts` vozi 22 scenarija kroz pravi `handleMoneriumWebhook` (stvarni
     D1, potpisane isporuke, mockan samo `router/safe`): sid paid/underpaid/late, kratka referenca
     (trusted, untrusted → stray), stray (jedan, višeznačan, konflikt, nema, resolver isključen), dvostruki
     webhook (isti i novi webhook-id, sid i stray), created → processed i stale created, `mint_address_mismatch`,
     `resolved_offrail`, goli `0x`/`gnosis:`, direct mode (D4 owed, `direct_settle`), reroute. Zlatni izlaz
     `test/fixtures/monerium/replay-pre-s4.json` snimljen je na `origin/main` 5e52bbd (`CAPTURE_PRE_S4=1`);
     S4 kod daje identičan `compared` (namire, intenti, forwardi, potpisi, alerti, merchant webhookovi,
     outbox, odgovor handlera). `creditMatch` se snima, ali ne uspoređuje; razlika pre/post je točno
     odluka 404 (npr. 04a `stray_preview: coded…` → `short_ref`, parkovi → `park: <razlog>`, reroute → `manual`).
     Nije pokriveno: neuspjeli broadcast/revert/nonce, krivi profil, `cmp:`/`direct_contribution`, `rcpt1`.
407. **Zatečeno ponašanje, zapisano, ne mijenjano u S4** (replay ga čuva; svaka promjena = `behavior-change`):
     preview na ponovljenoj isporuci straya pali „zaprimljeno” na drugom kandidatu (09b); preview radi i
     prije parka zbog `mint_address_mismatch` (11); `payment.received` ide samo kad je sid u memou, pa ga
     stray i kratka referenca nikad ne šalju (04a, 05, 06, 14a); parkirani order sa sid-om pošalje
     `payment.received` pa `forward.blocked` (11, 12, 13c); nakon reroutea stari `failed` red ostaje uz novi.
     Kandidati za S7 ili zaseban PR.

408. **Matija je odobrio vrata S4 (20. 11. u sesiji):** merge #173, deploy backenda (bez migracije) i živa Monerium sandbox uplata.
409. **Živa provjera nije završena (20. 11.).** Nakon deploya `26c3ccde` intenti `yks2cbuti8cd` (`italk-sandbox`) i
     `x2dz9i9ujkmz` (`crosulja-staging`), oba 1,00 € iz admin v2, dobili su `monerium-sandbox-transfer` → `ok`,
     ali ni nakon 7+ min nema nijedne isporuke u `monerium_webhook_events` (zadnja id 507, 19. 11.), ni s krivim
     potpisom. Handler zapisuje svaku isporuku prije obrade, pa novi kod nije pozvan; zastoj je kod Monerium
     sandboxa (obrada ili webhook pretplata). I dva `italk-sandbox` intenta otvorena prije deploya
     (`228z6xgkmzt7`, `es4nz7ff2sjk`) stoje u `pending`. Nastavak: vrh `S5.md`.
