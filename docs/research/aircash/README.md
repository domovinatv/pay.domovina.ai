# Aircash kao platni kanal za MPT intente (HUB3 PDF417 → Monerium)

Istraženo 2026-10-10 (tri paralelna research agenta, primarni izvori: aircash.eu uvjeti
i cjenik na snazi od 1.10.2026, HNB registar 29.9.2026, EPC registri sudionika 9.10.2026,
HUB3 v6 specifikacija, sepa.hr pain.001 uputa, Uredba (EU) 2024/886, Aircashov vlastiti
WooCommerce plugin). Ovo je **single source of truth** za Aircash u ovom repou.

Prilozi sa svim citatima i URL-ovima:

| Datoteka | Sadržaj |
|---|---|
| [01-proizvod-naknade-limiti.md](01-proizvod-naknade-limiti.md) | Licenca, Slikaj i plati, nadoplate, isplate, KYC, uvjeti |
| [02-developer-api-sandbox.md](02-developer-api-sandbox.md) | Aircash Pay API rekonstruiran iz plugina, sandbox, Abon, payout |
| [03-sepa-rail-vop-hub3-vs-revolut.md](03-sepa-rail-vop-hub3-vs-revolut.md) | Sponzorska banka, SCT Inst, VoP, HUB3 → ISO 20022, Revolut usporedba |
| [05-hub3-format-provjera.md](05-hub3-format-provjera.md) | HUB3 PDF417 naspram spec v6 i 8 stvarnih računa, Dart PDF417 bug |
| [04-zasto-aircash-suradnja.md](04-zasto-aircash-suradnja.md) | Za i protiv suradnje iz Aircashove perspektive, modeli M1–M4, dosadašnji kontakt (airKUNA pitch 6/2026) |

Oznake: **VERIFIED** = primarni izvor, **REPORTED** = treća strana, **UNKNOWN** = nema izvora,
**INFERENCE** = naš zaključak iz provjerenih činjenica.

## Zaključak

Ideja „Apple Pay nadoplata besplatno → Slikaj i plati naš HUB3 → SEPA Instant na Monerium →
resolve intenta" **u objavljenom obliku ne radi**, iz dva neovisna razloga:

1. **Država IBAN-a primatelja.** Uvjeti §11.1 dopuštaju Slikaj i plati samo prema IBAN-ima
   iz popisa država: HR, SI, AT (cjenik dodaje RO, SK). **Estonija nije nigdje na popisu**, a
   Monerium IBAN je `EE…` (LHVBEE22). Ni isplata na IBAN (HR, SI, AT, DE, ES, CY, GR, RO)
   ne uključuje EE. *VERIFIED popis; INFERENCE da će EE biti odbijen — potreban test na uređaju.*
2. **Nije instant.** Aircash nije sudionik SCT ni SCT Inst sheme (BIC `AIDOHR22` nije u EPC
   registrima), ide preko sponzorske banke (prema Matiji PBZ, neobjavljeno) s cut-offom 13:00 CET: isti ili
   sljedeći radni dan. Revolut ide SCT Inst i Monerium minta za ~10 s. *VERIFIED.*
   Uredba 2024/886 obvezuje Aircash na slanje instant plaćanja do **9.4.2027**.

Prva dva koraka ideje **jesu** točna: Apple/Google Pay nadoplata je 0 EUR (do 1.000 EUR po
transakciji), a Slikaj i plati je 0 EUR. *VERIFIED.*

## Aircash vs Revolut

| | Revolut | Aircash |
|---|---|---|
| Regulatorni status | Revolut Bank UAB (LT banka) | E-money institucija, HNB IEN116, passport cijeli EEA |
| Nadoplata Apple Pay | 0 za EEA potrošačke kartice; limit £12k / 7 dana | 0 EUR, max 1.000 EUR / tx |
| Nadoplata karticom | 0 (EEA, ne-komercijalne) | 0 EUR, max 700 EUR / tx |
| Skeniranje | EPC QR (empirijski potvrđeno kod nas) | „QR ili barkod s računa" — HUB3/EPC se nigdje ne spominju eksplicitno |
| Plaćanje skeniranog koda | Običan SEPA transfer, besplatno, **na bilo koji SEPA IBAN** | Slikaj i plati, 0 EUR, **samo HR/SI/AT(/RO/SK) IBAN-i** |
| Brzina | SCT Inst (sudionik od 2022) → Monerium ~10 s | Batch, cut-off 13:00 → T+0/T+1 |
| Prijenos na proizvoljan IBAN | Besplatno (SEPA) | „Isplata" 1 % (promo do 31.12.2026) pa 2 %, max 550 EUR (jedan izvor kaže 500), bez EE |
| VoP | U EPC VOP registru od 2025-08-24 | Nije u EPC VOP registru (vjerojatno preko sponzorske banke) |
| Javni API / sandbox | n/a (koristimo samo kao platiteljevu app) | Nema portala; Aircash Pay API čitljiv iz plugina, sandbox uz ručno odobrenje |

## Što se prenosi u remittance (bitno za matching)

Prema sepa.hr pain.001 uputi (VERIFIED), HUB3 model + poziv na broj idu u
`RmtInf/Strd/CdtrRefInf/Ref` kao `HR00<ref>` bez razmaka. **Za prekogranično plaćanje
(HR → EE) opis (`AddtlRmtInf`) se ne koristi** — preživljava samo referenca. Naš sadašnji
HUB3 nosi `gnosis:0x…` u polju opisa (14), pa bi se u prekograničnom slučaju izgubio.
Posljedice za `backend/src/monerium/sid.ts` ako ikad budemo primali HUB3 uplate:

- routing ne smije ovisiti o opisu; intent referencu stavljati u polje 12 (poziv na broj),
- matcher treba skinuti `HR\d\d` prefiks i crtice i tražiti u Ref, Ustrd i EndToEndId,
- stray resolver (ADR 0018, tenant + iznos + vrijeme) je rezerva kad reference nema.

HUB3 polje IBAN ima max 21 znak i spec opisuje samo hrvatski IBAN; `EE` (20 znakova) stane,
ali nije pokriven specifikacijom. Prihvaćaju li ga hrvatske bankovne aplikacije — UNKNOWN.

## Varijante koje bi mogle raditi

| # | Varijanta | Instant? | Trošak za platitelja | Prepreke |
|---|---|---|---|---|
| A | **HR naplatni IBAN** (tenantov račun u HR banci) u HUB3 kodu; Aircash Slikaj i plati → HR račun; matching preko postojećih AIS providera (`backend/src/providers/enable_banking.ts`, `gocardless.ts`); tenant sam prebacuje na svoj Monerium IBAN | Ne (T+0/T+1 do HR računa, plus prijenos dalje) | 0 | Za tenantov vlastiti promet nije hold-and-forward; za MPT u ime trećih jest (Monerium BToS §16, vidi `docs/compliance/`). Sweep HR → Monerium je dodatni korak. |
| B | **Aircash Pay merchant** (Frame API v2: `initiate` → redirect/QR → ping → signed `status` pull; `PartnerTransactionId` = intent id) | Da, unutar Aircasha | 0 za korisnika | Ugovor + KYB s Aircashom, ručno odobrenje sandboxa, MDR neobjavljen, isplata s Aircash merchant računa na IBAN — rok UNKNOWN; opet sweep na Monerium. Mali integracijski posao. |
| C | **Monerium IBAN iz HR/SI/AT** | Ovisi o Aircashu | 0 | Ne znamo izdaje li Monerium takve IBAN-e — pitati Monerium. Čak i tada ostaje batch do 9.4.2027. |
| D | Aircash „Isplata" na EE IBAN | — | 1–2 % | EE nije na popisu; isto bi bilo samo za vlastiti račun (§3.7). Ne vrijedi. |

Rizik za sve varijante (INFERENCE): obrazac „nadoplata karticom → odmah isti iznos van" je
klasični AML signal; uvjeti §5.2/§5.3 daju Aircashu diskrecijsko pravo limitiranja i blokade,
a §3.7 zabranjuje korištenje računa za potrebe treće osobe. Besplatnost Slikaj i plati
ekonomski stoji upravo zato što je ograničena na domaće račune (izlaz na proizvoljni IBAN
naplaćuje 1–2 %).

## Jeftini odlučujući testovi

1. **Aircash Slikaj i plati, HUB3 s Monerium `EE…` IBAN-om, 1 €.** Odbija li kod skeniranja,
   kod potvrde, ili izvrši? Ako izvrši: vrijeme do Monerium `processed` i što stigne u `memo` /
   `referenceNumber`. — *ovo jedno rješava pitanje 1*
2. Isti HUB3 s **HR IBAN-om koji nije biller** (npr. privatni ili d.o.o. račun) — prolazi li?
   (preduvjet za varijantu A)
3. Aircash → Nadoplata → Bankovni račun: znamenke 5–11 prikazanog HR IBAN-a = VBDI sponzorske banke.
4. Revolut EPC QR 0,01 € na tenantov Monerium IBAN s imenima „ITalk d.o.o." i „Monerium EMI ehf."
   → koje ime LHV vraća u VoP-u (bitno i za postojeći Revolut kanal).
5. Isti HUB3 s EE IBAN-om u 2–3 hrvatske bankovne aplikacije (m-zaba, PBZ, George) i
   usporedba što Monerium primi (`HR00…` u Ref vs Ustrd).

Pitanja za mail (info@aircash.eu, Monerium): EE IBAN u Slikaj i plati; prenosi li se poziv na
broj; skriveni dnevni/mjesečni limiti; plan za SCT Inst prije 2027; Aircash Pay MDR i rok
isplate merchantu; izdaje li Monerium HR/SI/AT IBAN-e.

## Napomena o Aircash pluginu

Aircashov WooCommerce plugin isključuje provjeru TLS certifikata (`sslverify => false`) i
nosi zajednički „platform" privatni ključ s lozinkom pored njega. Ako radimo varijantu B,
**ne kopirati** te obrasce: vlastiti RSA par po tenantu, ključ u secretu, TLS verifikacija uključena.
