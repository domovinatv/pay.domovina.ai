# ADR 0028 — Kratka referenca intenta (3 znamenke) kao zamjena za dugi opis plaćanja

- **Status:** Accepted (2026-10-20), implementirano 2026-10-20 (`backend/src/intents/shortRef.ts`, migracija 0031). Predloženo 2026-10-19
- **Kontekst:** MPT rail (`backend/`), uparivanje SEPA naloga s intentom
- **Gradi na:** [0018](0018-stray-payment-resolver.md) (stray resolver) ·
  [0022](0022-potvrda-o-uplati-vezana-uz-kljuc-uplatitelja.md) (potvrda o uplati) ·
  [0025](0025-mpt-router-umirovljen-svi-tenanti-direct.md) (§Revolut bez reference) ·
  [0026](0026-project-router-ogranicen-na-projektne-safeove.md) (ProjectRouter)
- **Odluka vlasnika:** Matija Stepanic, 19. 10. 2026.

## Problem

Revolut iOS nakon skeniranja EPC QR-a ispušta *Reference* kad stanje pokriva iznos. Opis
`gnosis:<Safe> sid:<sid>` ima ~75 znakova i ne može se prepisati. Kopiranje radi samo ako su
QR i aplikacija banke na istom uređaju. Ne radi kad je QR na računalu, a skenira se mobitelom,
niti kad je QR spremljen kao screenshot, a kopiranje zaboravljeno.

Bez reference ostaje stray resolver (0018), koji uparuje samo po tenantu, iznosu i vremenu. Kad
više ljudi istovremeno plaća isti iznos (npr. 100 × 1 € na sajmu):

- novac stigne na pravi Safe ako svi kandidati vode na isti Safe;
- **pripisivanje je proizvoljno.** Uplata uzme najnoviji nezauzet intent, pa jedan ekran javi
  „stigla” za tuđu uplatu, a uplatitelj čiji intent nije pogođen čeka do isteka;
- kad kandidati vode na **različite** Safeove (Lukavec i Rab po 1 €), resolver parkira nalog i
  ništa se ne pomakne bez ručnog preusmjeravanja.

## Odbačeno: mijenjanje iznosa

**Ne radimo.** Ne radimo jedinstven iznos po intentu (1,00 → 1,01 → 1,02), centski nonce
ni bilo koju drugu varijantu u kojoj iznos nosi identitet uplate. Iznos je ono što uplatitelj
želi dati, a ne kanal za podatke. Ovo je odluka vlasnika i ne predlaže se ponovno.

## Odluka

Svaki intent uz dugi `memo` dobiva **kratku referencu**: 3 znamenke + 1 kontrolna (`0071`), jedinstvenu
među **živim** intentima istog tenanta (isti primateljev IBAN). Kad Revolut ispusti opis,
uplatitelj u *Reference* upiše samo taj kod.

**Kontrolna znamenka (odluka 2026-10-20).** Kod je uvijek tijelo + 1 kontrolna znamenka:
**3 + 1**, a kad se bazen od 1000 tijela potroši, **4 + 1**, pa 5 + 1 itd. Kontrolna znamenka
hvata svaku pojedinačnu krivu znamenku i zamjenu susjednih. Damm to hvata potpuno; Luhn ne
hvata zamjenu 09↔90, pa je preporuka Damm. Kod s krivom kontrolnom znamenkom se **nikad** ne
uparuje: ide na stray put (0018) kao da opisa nema. Uz rotaciju je prelazak na 4 + 1
malo vjerojatan.

- **Dodjela.** Rail dodjeljuje kratku referencu pri `POST /api/intents` iz bazena `000`–`999`
  po tenantu. Jedinstvenost drži D1, a ne aplikacijski kod: djelomični `UNIQUE (tenant_id,
  short_ref)` nad živim intentima ili zasebna tablica zauzeća s istim ograničenjem. Dva
  istovremena zahtjeva ne smiju dobiti isti kod.
- **Kruženje.** Kod se oslobađa kad je intent plaćen ili kad prođe prozor u kojem uplata još
  može stići. Banka zna kasniti: 7. 10. su dvije uplate stigle 7 i 23 min nakon isteka, a
  `STRAY_LOOKBACK_SECONDS` je 48 h. Kod se zato **ne** oslobađa na `expires_at`, nego na
  `expires_at` + prozor zadržavanja. Kad se bazen napuni, tijelo raste na 4 znamenke (4 + 1). To je
  ista ideja kao gitov kratki hash: kratko dok je jedinstveno, dulje samo kad mora.
- **Uparivanje.** U webhooku, kad memo nema `mpt:`/`gnosis:`/`cmp:` prefiks: ako opis,
  nakon normalizacije (trim, bez razmaka i interpunkcije), nosi točno jedan kod koji odgovara
  živom intentu tog tenanta, nalog se veže uz taj intent kao da je nosio `sid`. Iznos se i dalje
  provjerava kao dosad (BW-01 under/over). Odredište je uvijek `payment_intents.target_address`,
  kao kod stray resolvera, i prolazi `authorizeForward`. Kod koji ne pogodi živi intent →
  uobičajeni stray put (0018).
- **Prikaz.** Uz QR veliko i odvojeno: „Ako Revolut ostavi Reference prazno, upiši **0076**”.
  Prikazuje se kao jedan niz (`0071`), a uplatitelj ne mora znati koja je znamenka kontrolna.
  Kod je čitljiv i sa screenshota i s ekrana računala, bez kopiranja. EPC QR i dalje nosi puni
  memo; kratka referenca je rezerva, ne zamjena.

## Implementacija (2026-10-20)

- **Migracija 0031.** `payment_intents.short_ref` je trajni zapis koda. Zauzeće drži tablica
  `intent_short_refs` s `PRIMARY KEY (tenant_id, short_ref)`. Redak je živ dok je
  `hold_until > sada` i intent nije plaćen. Dodjela je jedan upsert
  (`ON CONFLICT … DO UPDATE … WHERE redak nije živ`): mrtav redak preuzme, živ nikad, pa dva
  istovremena `POST`-a ne mogu dobiti isti kod ni kad oba pročitaju isti slobodan skup.
- **Dodjela** (`allocateShortRef`): slučajno slobodno tijelo od 3 znamenke. Za 3 i 4 znamenke čita
  zauzeti skup i bira među slobodnima, pa tijelo raste tek kad je bazen stvarno pun. Dodjela je
  best effort: ako ne uspije, intent nastaje s `short_ref = null` (kod je rezerva, ne uvjet).
  Svi putovi stvaranja intenta (javni, sandbox, `receipt-intent`) idu kroz `insertWithRetry`.
- **Uparivanje** (`handleForward`, `previewStraySid`): samo kad memo nema adrese, `sid`-a ni
  kampanje. Normalizacija skida razmake, interpunkciju i simbole; mora ostati točno jedan niz
  znamenki s ispravnom Damm znamenkom. Memo i `referenceNumber` ne smiju nositi dva različita
  koda. Pogodak mora biti živ, nenaplaćen, bez živog forwarda (`pending/submitted/confirmed`)
  i **pouzdan po SR-01**. Promašaj ide u stray resolver kao prije. Pogodak dobiva
  `memo_prefix = 'code'`, jedan kandidat i isti gate (`authorizeForward`).
- **API:** `short_ref` na vrhu JSON-a intenta (`POST /api/intents`, `GET status_url`, lista).
  Checkout prikazuje kod veliko ispod reference (`data-revolut-reference`).

## Otvoreno

1. ~~Tipfeler~~ — riješeno kontrolnom znamenkom (3 + 1, Damm), odluka 2026-10-20.
2. ~~Potvrda o uplati (0022)~~ — **riješeno 2026-10-20: kratki kod NE daje potvrdu.** Kod je
   javan na ekranu i nije izveden iz ključa uplatitelja, pa ne dokazuje tko je platio. Forward
   nađen kodom nosi `memo_prefix = 'code'`: ne sidri potvrdu (`receipts/link.ts` ga ne broji kao
   opis uplatitelja), a `receiptKind` ga na lancu bilježi kao `rcpt1-unbound`, kao stray.
3. ~~Dužina prozora zadržavanja~~ — **riješeno 2026-10-20: `expires_at` + 48 h**
   (`SHORT_REF_HOLD_SECONDS = STRAY_LOOKBACK_SECONDS`). Isti prozor u kojem stray resolver još
   prihvaća kasnu uplatu; kod oslobođen ranije mogao bi kasnu uplatu poslati tuđem intentu.
   Plaćen intent oslobađa kod odmah. 1000 kodova po tenantu napuni se tek uz ~20 napuštenih
   intenta na sat; tada tijelo naraste na 4 + 1.
4. ~~Kratki prefiks `sid`-a~~ — **odbačeno**: zaseban kod, iz razloga navedenog u prijedlogu.
