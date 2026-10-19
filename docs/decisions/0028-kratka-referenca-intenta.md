# ADR 0028 — Kratka referenca intenta (3 znamenke) kao zamjena za dugi opis plaćanja

- **Status:** Predloženo (2026-10-19), čeka implementaciju
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

Svaki intent uz dugi `memo` dobiva **kratku referencu**: niz od 3 znamenke (`007`), jedinstven
među **živim** intentima istog tenanta (isti primateljev IBAN). Kad Revolut ispusti opis,
uplatitelj u *Reference* upiše samo `007`.

- **Dodjela.** Rail dodjeljuje kratku referencu pri `POST /api/intents` iz bazena `000`–`999`
  po tenantu. Jedinstvenost drži D1, a ne aplikacijski kod: djelomični `UNIQUE (tenant_id,
  short_ref)` nad živim intentima ili zasebna tablica zauzeća s istim ograničenjem. Dva
  istovremena zahtjeva ne smiju dobiti isti kod.
- **Kruženje.** Kod se oslobađa kad je intent plaćen ili kad prođe prozor u kojem uplata još
  može stići. Banka zna kasniti: 7. 10. su dvije uplate stigle 7 i 23 min nakon isteka, a
  `STRAY_LOOKBACK_SECONDS` je 48 h. Kod se zato **ne** oslobađa na `expires_at`, nego na
  `expires_at` + prozor zadržavanja. Kad se bazen napuni, dužina raste na 4 znamenke. To je
  ista ideja kao gitov kratki hash: kratko dok je jedinstveno, dulje samo kad mora.
- **Uparivanje.** U webhooku, kad memo nema `mpt:`/`gnosis:`/`cmp:` prefiks: ako opis,
  nakon normalizacije (trim, bez razmaka i interpunkcije), nosi točno jedan kod koji odgovara
  živom intentu tog tenanta, nalog se veže uz taj intent kao da je nosio `sid`. Iznos se i dalje
  provjerava kao dosad (BW-01 under/over). Odredište je uvijek `payment_intents.target_address`,
  kao kod stray resolvera, i prolazi `authorizeForward`. Kod koji ne pogodi živi intent →
  uobičajeni stray put (0018).
- **Prikaz.** Uz QR veliko i odvojeno: „Ako Revolut ostavi Reference prazno, upiši **007**”.
  Kod je čitljiv i sa screenshota i s ekrana računala, bez kopiranja. EPC QR i dalje nosi puni
  memo; kratka referenca je rezerva, ne zamjena.

## Otvoreno

1. **Tipfeler.** Jedna kriva znamenka može pogoditi tuđi živi intent. Iznos to djelomično
   hvata (mora biti jednak), ali kod istog iznosa ne. Opcija je kontrolna znamenka (3 + 1,
   mod 10 ili Damm), koja hvata svaku pojedinačnu krivu znamenku i zamjenu susjednih. Odluka
   pri implementaciji: 3 znamenke ili 3 + kontrolna.
2. **Potvrda o uplati (0022).** Potvrda danas traži da opis nosi `sid` izveden iz ključa
   uplatitelja. Treba odlučiti smije li kratka referenca usidriti potvrdu. Rizik: tko zna tuđi
   kod, može ga upisati u svoju uplatu. Time pokloni uplatu tuđem intentu, ali ne dobiva
   ništa. Treba provjeriti dokazuje li potvrda tada i dalje ono što tvrdi.
3. **Dužina prozora zadržavanja** u odnosu na veličinu bazena: 1000 kodova po tenantu s 48 h
   zadržavanja napuni se tek uz oko 20 napuštenih intenta na sat.
4. **Kratki prefiks `sid`-a umjesto zasebnog koda** (git short-hash) je prirodna varijanta, ali
   `sid` potvrde je izveden iz ključa (`r1…`) i ne može se ponovno izvući kad se sudari. Zato je
   prijedlog zaseban kod; odluka pri implementaciji.
