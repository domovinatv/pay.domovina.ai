Radimo pinka SEPA doprinos u ovom repou (/Users/ms/git/domovinatv/domovina.ai).
Cilj: ekran uspjeha („Hvala na podršci ✓”) mora se prikazati ODMAH kad Monerium zaprimi
SEPA uplatu (~1 s), a ne tek nakon minta EURe-a. Ispod njega stoji mirna napomena da se
izdavanje EURe-a još čeka. UX mora biti kao kod kartice: odobrenje odmah, namira kasnije.

## Kontekst (provjereno u pay.domovina.ai, 2026-09-28)

Rail endpoint GET https://mpt.domovina.ai/api/intents/<sid> vraća `status.stage`:
awaiting_payment | received_processing | minted | forwarding | settled | rejected | expired.
Mjereno na 49 produkcijskih uplata:
- `received_processing` nastupa u ISTOJ sekundi kad SEPA Instant stigne u Monerium;
- kad je uplatitelj već plaćao s tog IBAN-a, `settled` dođe za oko 9 s;
- kad je to PRVA uplata s novog IBAN-a, Monerium je drži na ručnoj provjeri
  („counterpart is not screened"): izmjereno 1 min – 8 h do minta;
- 0/49 odbijeno, ali `rejected` postoji.
`intent.paid` webhook (→ pinka `mark_contribution_paid` → `contribution_status = 'paid'`) okida
tek na `settled`.

## Trenutni kod (lib/pinka_sdk/src/widgets/pinka_contribute_panel.dart)

- `_submitSepa` (≈l.318): `_Phase.paid` postavlja SAMO `widget.client.waitForPaid(...)`,
  koji polla Supabase RPC `contribution_status`. Zato uspjeh čeka `settled`.
- `_startStatusPolling` (≈l.368): polla /api/intents/<sid> svake 3 s, ali samo puni stepper
  („Korak M/N"). Komentar kaže da je to „ukras”.
- `_buildPaid` (≈l.1190): ikona, `pinkaThanksForSupport`, `pinkaPaymentConfirmedOnchain`,
  gumb „Doniraj još jednom”.

Dva postojeća buga koja treba popraviti usput:
1. `waitForPaid` (lib/pinka_sdk/src/pinka_client.dart:250) odustaje nakon 100 × 3 s = 5 min i
   vrati false. `_submitSepa` tada prekine OBA timera, a panel ostane zamrznut na QR-u sa
   stepperom koji se više ne osvježava. Točno to se događa kod prve uplate s novog IBAN-a.
2. `fetchIntentStatus` (lib/pinka_sdk/src/util/pinka_intent_status.dart) čita
   `body['rejected_reason']`, a rail ga vraća kao `status.rejected_reason`, pa je razlog odbijanja uvijek null.

## Zadatak

1. Rail status postaje okidač za uspjeh. Kad `stage` ∈ {received_processing, minted, forwarding,
   settled}, prijeđi u stanje uspjeha. Uvedi npr. `_Phase.received` uz postojeći `_Phase.paid`
   (ili jedno stanje s podstanjem, kako je čišće). Animacija ili ikona uspjeha i haptika okidaju se
   TOČNO JEDNOM po intentu i ne ponavljaju se kad kasnije stigne `settled` ili RPC `paid`.
2. Nakon uspjeha NE gasi polling. Rail status i `waitForPaid` rade dalje sve do `settled`/RPC `paid`
   ili `rejected`. Makni ograničenje od 5 min iz ovog toka (npr. parametar bez limita ili
   zasebna petlja vezana uz život widgeta) i sve timere otkaži u `dispose`/`_resetForAnother`.
   Countdown holda sakrij čim je uplata zaprimljena, jer novac je stigao i kasna uplata se ionako kreditira.
3. Tekst ispod uspjeha, po fazi (nove l10n tipke u app_hr.arb i app_en.arb, pa regeneriraj):
   - received_processing: „Uplata je zaprimljena. Izdavanje EURe-a je u tijeku. Kod prve
     uplate s novog računa provjera može potrajati. Ne moraš ništa raditi.”
     Ako je stage > ~60 s u toj fazi, istakni dio o prvoj uplati. Nikakav lažni progress
     i nikakvo obećanje „sekunde”. Ne piši „AML”, samo „provjera”.
   - minted/forwarding: „EURe izdan, prosljeđuje se kampanji…”
   - settled ili RPC paid: postojeći `pinkaPaymentConfirmedOnchain`.
   Mali stepper može ostati ispod kao sekundarni detalj.
4. `widget.onPaid` (zid, kvadratić) i dalje zovi samo na RPC `paid`, jer doprinos u bazi postaje
   `paid` tek tada. Ako zid ili kvadratić trebaju odmah pokazati „u obradi”, predloži mi rješenje
   prije nego ga implementiraš.
5. `rejected` nakon što je uspjeh već prikazan: zamijeni ga jasnom porukom `pinkaIntentRejected`
   (+ razlog), bez animacije. `expired` bez zaprimljene uplate ostaje kao danas.
6. On-chain (in-app wallet) putanja se ne mijenja.
7. Testovi u test/pinka_contribute_panel_test.dart (fake status fetcher/klijent):
   uspjeh na received_processing prije RPC paid; animacija samo jednom kroz
   received → minted → settled; rejected nakon received; polling ne staje nakon 5 min;
   parsiranje `status.rejected_reason`. Zatim provjeri u browseru na mobilnoj širini.

Prije izmjena mi ukratko potvrdi plan i sva mjesta koja diraš. Commitaj i pushaj kad testovi prođu.
