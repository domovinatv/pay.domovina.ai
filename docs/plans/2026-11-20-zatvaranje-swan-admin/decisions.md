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
