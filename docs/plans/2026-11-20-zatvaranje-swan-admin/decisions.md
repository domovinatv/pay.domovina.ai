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
