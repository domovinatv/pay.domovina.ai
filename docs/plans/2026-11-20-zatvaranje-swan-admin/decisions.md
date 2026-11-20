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
