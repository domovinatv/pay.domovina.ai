# Zašto bi Aircash htio (ili ne htio) surađivati s MPT-om

Radni dokument, 2026-10-10. Cilj je objektivna procjena prije razgovora s Aircashom: što im
nudimo, što ih košta, i gdje su stvarne prepreke. Činjenice o Aircashu su iz priloga
[01](01-proizvod-naknade-limiti.md)–[03](03-sepa-rail-vop-hub3-vs-revolut.md) i nose iste oznake
(VERIFIED / REPORTED / UNKNOWN / INFERENCE).

## Dosadašnji kontakt

Izvor: `~/git/airkuna` (privatna arhiva, nije u ovom repou).

| Datum | Što | Gdje |
|---|---|---|
| 2026-06-16 | Pitch deck **airKUNA × Aircash**: Aircash kao EMI izdavatelj reguliranog euro EMT-a („KUNA", Monerium EURe model), mi kao on-chain sloj, podjela treasury yielda | `airkuna/pitch-deck/aircash-airkuna-pitch*.{typ,pdf,md}` |
| prije 18.6. | Razgovor o konceptu s Filipom Šaravanjom (navedeno u poruci) | `airkuna/airkuna-outreach/2026-06-18-linkedin-hrvoje-cosic-aircash.txt` |
| 2026-06-18 | LinkedIn poruka Hrvoju Ćosiću (CEO) + deck | isto |
| 2026-06-20 | ZEF/EEB dokument: Aircash kao ciljani EMI partner u „interim" fazi | `airkuna/airkuna-outreach/2026-06-20-zef-airkuna-eeb-cirkularna-ekonomija.md` |

U arhivi **nema zapisa o odgovoru**. Prvi pitch je tražio najveći mogući korak (Aircash izdaje
EMT pod MiCA-om). Ovaj dokument predlaže ljestvicu manjih koraka gdje je prvi gotovo besplatan.

## Polazne činjenice

- Aircash je HNB e-money institucija (IEN116), passport u cijelom EEA. *VERIFIED*
- Apple/Google Pay nadoplata 0 EUR (≤1.000 EUR/tx); Slikaj i plati 0 EUR, ali samo prema
  HR/SI/AT(/RO/SK) IBAN-ima i batch (cut-off 13:00). *VERIFIED*
- Aircash nije izravni sudionik SCT/SCT Inst; ide preko sponzorske banke. Matija navodi da je to
  **PBZ** (*REPORTED interno; potvrda: VBDI `2340009` u Aircash IBAN-u za nadoplatu*).
- Uredba (EU) 2024/886 obvezuje Aircash da do **9.4.2027** nudi slanje i primanje instant
  plaćanja. *VERIFIED* To je za ~6 mjeseci, pa SCT Inst nije naš zahtjev nego njihov rok.
- Revolut u HR: besplatan SEPA na bilo koji IBAN, SCT Inst, ali **litavski IBAN**. *VERIFIED/REPORTED*
- Aircash već ima crypto narativ: in-app ulaganje kao tied agent Bitpande (6 EUR/mj od 1.10.2026). *VERIFIED*

## Modeli suradnje (od najmanjeg prema najvećem)

| # | Model | Što Aircash mora napraviti | Što mi radimo |
|---|---|---|---|
| M1 | **Monerium IBAN-i MPT tenanata kao registrirani billeri** u Slikaj i plati (ili EE na popis država) | Konfiguracija whiteliste; po želji samo za IBAN-e koje im mi prijavimo | HUB3 s referencom u polju 12 (ne u opisu), matcher za `HR00<ref>` |
| M2 | M1 + **SCT Inst** za te uplate | Ništa dodatno nakon 9.4.2027 (zakonski rok) | — |
| M3 | **Aircash Pay merchant**: MPT/tenant kao partner na Frame API-ju | Standardni merchant onboarding, sandbox odobrenje | Integracija `initiate` / `status` / refund (mali posao); sweep s merchant računa na Monerium |
| M4 | **airKUNA**: Aircash izdaje EMT, mi on-chain sloj | MiCA notifikacija HNB-u, white paper, rezerve, audit | Ugovori, mint/redeem orkestracija (postojeći stack) |

## Zašto bi Aircash htio

| Argument | Za koje modele | Pouzdanost |
|---|---|---|
| **Instant je ionako obaveza do 9.4.2027.** Kad SCT Inst postoji, prihvaćanje MPT uplata je konfiguracija, ne projekt. | M1, M2 | VERIFIED rok; trošak INFERENCE |
| **Pariteta s Revolutom za hrvatske korisnike.** Revolut plaća bilo koji SEPA IBAN besplatno i instant; Aircash danas ne. „Aircash plaća sve što i Revolut, a ima hrvatski brand i podršku" je jasna poruka. | M1, M2 | INFERENCE |
| **Priljev depozita.** Svaka MPT uplata počinje nadoplatom u Aircash; novac na kratko živi kao njihov e-novac (float). | M1–M3 | INFERENCE |
| **Prihod od trgovaca.** Aircash Pay naplaćuje trgovcima (MDR neobjavljen); MPT tenanti (e-Demokracija, pinka, Shopify trgovci) su novi merchanti bez akvizicijskog troška za Aircash. | M3 | INFERENCE; MDR UNKNOWN |
| **Regulirani on-chain euro bez vlastitog razvoja.** Stack (wallet, pay, MPT, Safe + Zodiac Roles) radi u produkciji na Monerium EURe. Aircash bi dobio dokazanu izvedbu, ne ideju. | M4 | VERIFIED da stack radi |
| **Crypto narativ koji već imaju.** Bitpanda partnerstvo pokazuje apetit; MiCA EMT je reguliraniji i bliži njihovoj licenci od trgovanja kriptom. | M4 | INFERENCE |
| **Domaći partner i domaće use-caseove.** e-Demokracija članarine, lokalne zajednice, podcast crowdfunding — hrvatski kontekst gdje je Aircash jači od Revoluta. | sve | INFERENCE |

## Zašto ne bi htio (ili bi oklijevao)

| Argument | Za koje modele | Težina |
|---|---|---|
| **Ekonomika nadoplate.** Besplatna nadoplata karticom isplati se jer izlaz na proizvoljni IBAN košta 1–2 %. Besplatan Slikaj i plati prema EE IBAN-u otvara „kartica → IBAN" put bez naknade i jede prihod od Isplate. Ublaženje: whitelist samo MPT IBAN-a, ne cijele Estonije. | M1, M2 | **Visoka** |
| **Chargeback na nepovratnu uplatu.** Apple Pay nadoplata može biti osporena; novac je u međuvremenu otišao na Monerium i mintan on-chain. Aircash snosi kartični rizik, a povrat s lanca ne postoji. | M1, M2 | **Visoka** |
| **AML i sponzorska banka.** Uplate e-money izdavatelju koji minta kriptoimovinu su viši rizik; PBZ kao sponzor može tražiti de-risking. §3.7 uvjeta zabranjuje korištenje računa za treće osobe. | M1–M3 | **Visoka** |
| **Konkurencija Bitpandi.** Aircash zarađuje na Bitpanda ulaganju; jeftin EURe on-ramp preko MPT-a zaobilazi taj kanal. | M1, M2 | Srednja |
| **Naša veličina i zrelost.** ITalk d.o.o. je mala firma, volumen je danas mali, MULTI_TENANT_RAIL još iza zastavice. Velikoj EMI s 1M+ korisnika jedan mali partner nije prioritet. | sve | Srednja |
| **Naša otvorena compliance pitanja.** Monerium BToS §16 (hold-and-forward) nije razriješen; Aircash due diligence će to pronaći. Merchant-direct model (svaki tenant vlastiti Monerium KYB) to ublažava. | M1–M3 | Srednja |
| **Monerium kao posrednik.** Novac prolazi kroz konkurentskog EMI-ja; za M4 Monerium je izravna konkurencija. | M1, M2, M4 | Niska–srednja |
| **M4 je velik regulatorni projekt.** MiCA EMT traži notifikaciju, white paper, upravljanje rezervama; prinos se ne smije davati imateljima (MiCA čl. 50). Podjela treasury yielda s tehnološkim partnerom traži pravni pregled. | M4 | Visoka |
| **Bez odgovora na prvi pitch.** Moguće da je prioritet nizak ili da je prvi zahtjev bio prevelik. | sve | UNKNOWN |

## Što bi mi morali ponuditi da prepreke padnu

1. **Uska whitelist umjesto otvaranja Estonije** — samo Monerium IBAN-i registriranih MPT tenanata,
   s KYB-om tenanta. Rješava ekonomiku i AML opseg (M1).
2. **Limit i odgoda za sredstva s kartice** — npr. plaćanje MPT-u samo iz salda starijeg od N dana
   ili do X EUR/mj s kartičnog izvora. Smanjuje chargeback rizik; odluka je Aircashova.
3. **Merchant-direct model** — Aircash plaća izravno tenantov KYB-ani Monerium IBAN; MPT ne drži
   tuđi novac, samo javlja status (vidi `docs/research/2026-09-monerium-first-iban-screening.md`).
4. **Podaci prije ugovora** — pilot na 1 tenantu (ITalk) s izvještajem o volumenu, chargebackovima
   i vremenu namire.

## Preporuka

- Početi od **M1 + pilot**, ne od airKUNA. To je mali zahtjev s jasnom vrijednošću za Aircash
  (pariteta s Revolutom) i rješivim rizicima.
- Prije razgovora: test 1 € HUB3 s EE IBAN-om u Aircashu i VBDI provjera (README, „Jeftini testovi").
  Ako EE prolazi već danas, razgovor je samo o instantu i limitima.
- airKUNA (M4) držati kao dugoročnu opciju; ne miješati je u prvi operativni zahtjev.

## Otvorena pitanja za Aircash

1. Može li Slikaj i plati prema specifičnim EE IBAN-ima (registrirani biller)?
2. Kad Aircash uvodi SCT Inst za odlazna plaćanja, i hoće li Slikaj i plati ići instant?
3. Prenosi li se HUB3 poziv na broj u `CdtrRefInf/Ref`?
4. Pravila za sredstva s kartice kod plaćanja prema EMI/crypto primateljima.
5. Aircash Pay: MDR, rok i način isplate merchantu, uvjeti sandboxa.
6. Interes za EMT (MiCA) — samo ako sami otvore temu.
