# TODO — isključivo ručni koraci (Matija)

Sve ostalo Claude radi autonomno. Redoslijed = preporučeni prioritet. Stavke 1–3 su jedine
koje blokiraju razvoj (i to tek od Faze 3); Faze 0–2 idu odmah bez ičega s ove liste.

## 1. Partner registracija (self-service, ~15 min) — odgovornost: samo ti
- [ ] https://partners.gnosispay.com → registracija s podacima **ITalk d.o.o.**
- [ ] Pri registraciji navesti SVE domene (kasnije dodavanje = dashboard, ali bolje odmah):
      `wallet.domovina.ai`, `pay.domovina.ai`, staging domene (CF Pages preview pattern ako ga
      prihvaćaju), + tenant domene ako kartica ide i njima (sportklub/zupa — odluči)
- [ ] Zapiši **PartnerID** i **APP_ID** → javi mi ih (PartnerID ide u env, nije tajna)
- ℹ️ Bez ovoga: nema webhooka, nema PSE-a, nema SIWE s produkcijske domene. Besplatno je i instantno.

## 2. Pitanja za Gnosis Pay ekipu (imaš kontakt s calla) — pošalji prije Faze 3
- [x] ~~Je li Apple Pay / Google Pay tokenizacija omogućena za Hrvatsku?~~ **POTVRĐENO
      2026-06-11**: Gnosis Pay na Apple HR listi (support.apple.com/hr-hr/109516), u Google
      Wallet HR tablici kao "Visa Debit", i u Apple Wallet bank pickeru (tvoj screenshot)
- [ ] Postoji li **push provisioning** za partnere (one-click in-app Add to Apple Wallet kao u
      Revolutu) ili je ručni unos PAN-a jedini put? Planira li se? Što se događa kad korisnik u
      Apple Wallet bank pickeru odabere "Gnosis Pay" — vodi li u njihovu native app?
- [ ] Potvrda da je **Hrvatska na listi podržanih zemalja** za KYC/izdavanje (nigdje nije objavljena lista)
- [ ] Max aktivnih kartica: 5 ili 3? (docs su kontradiktorni)
- [ ] Verificira li se ERC-1271 SIWE na Gnosis chainu? Može li **smart account biti signup
      identitet** i inicijalni Delay-owner GP Safe-a? (imat ćeš i naše empirijske nalaze iz Faze 0)
- [ ] Status pilot programa za izdavanje kartica / što očekuju od nas za acceptance
- [ ] EURe **V1 vs V2** za GP Safe-ove (njihovi docs još citiraju V1 adresu kod card paymenta)

## 3. PSE certifikat (Faza 3) — ceremonija je ručna
- [ ] Ja generiram EC P-256 ključ + CSR (`CN=gp_<APP_ID>`) — ključ ostaje lokalno/secret
- [ ] **Ti uploadaš CSR u Partners Dashboard** i preuzmeš potpisani cert chain
- [ ] `wrangler secret put GNOSISPAY_PSE_KEY` + `GNOSISPAY_PSE_CERT` (paste s tvoje strane,
      kao i dosad s tajnama)
- [ ] U dashboardu konfiguriraj **webhook URL** (dat ću ti točan endpoint kad receiver bude deployan)
- [ ] Submit našeg **PSE CSS-a** GP timu (ja ga autoriram, ti ga šalješ kroz dashboard/kontakt)

## 4. Prvi pravi korisnik = ti (Faza 4, e2e validacija)
- [ ] Vlastiti GP onboarding s pravim dokumentima: Sumsub KYC (hrvatska osobna/putovnica),
      source-of-funds, +385 telefon — ovo je ujedno empirijska potvrda da HR prolazi
- [ ] Izdaj virtualnu karticu, ručno je dodaj u Apple Pay na svom iPhoneu
- [ ] Kupnja na pravom POS-u (Konzum test 🙂) → zajedno verificiramo webhook + Activity
- ⚠️ Tvoja SIWE adresa se trajno veže za tvoj GP account — odaberi je svjesno (po Plan A/B
      odluci iz Faze 0, dogovorit ćemo se prije nego potpišeš)

## 5. Monerium — službeni kontakt (post-MVP, tvoj postojeći plan)
- [ ] Kad kartični MVP bude složen, javi se Moneriumu službeno (danas: samo ITalk KYB + firmin
      IBAN; korisnici nemaju Monerium profile). Partnerski odnos bi otvorio osobne IBAN-e
      vezane na DOMOVINA Safe-ove kroz naš vlastiti integration — do tada GP-ov IBAN wrapper
      pokriva taj use-case za korisnike kartice (vidi 04)

## 6. Legal / compliance (paralelno, ne blokira development)
- [ ] Pročitaj **Monavate cardholder ToS** (EEA) i GP Privacy Policy — naši korisnici ih
      prihvaćaju kroz naš UI; provjeri ima li išta sporno za ITalk kao distributera
- [ ] Naša Pravila privatnosti: dopuna da kartični onboarding ide kroz Gnosis Pay/Sumsub/Monavate
      (mi ne pohranjujemo KYC podatke — to nam drži GDPR scope minimalnim, ali mora pisati)
- [ ] Razmisli treba li ITalk-u pravno mišljenje o ulozi "distributera" GP kartica u HR
      (GP/Monavate su issuer i regulirani subjekt, mi smo tehnički integrator — ali provjeri)

## 7. Odluke koje trebam od tebe (možeš odmah)
- [ ] **Scope tenanata**: kartica samo za domovina brand ili i sportklub/zupa? (utječe na
      domain whitelist u #1 i feature flag)
- [ ] **Default daily limit** pri deployu (GP default 350 €; raspon 1–8000) — prijedlog: 200 €
- [ ] Smije li tab "Kartica" biti vidljiv u simple-mode prikazu ili samo u punom?

---
*Reference: cache dokumentacije u `~/.cache/gnosispay-docs/pages/` (101 stranica, 2026-06-11);
ostatak plana u ovom folderu. Firecrawl ključevi: `~/.config/firecrawl/keys.json` (aktivni ima
~1338 kredita).*
