# Aircash: product research for the HUB3 → Monerium (EE IBAN) rail idea

Researched 2026-10-10. Primary sources: aircash.eu (current wallet T&C in force from **1 Oct 2026**, fee page "Naknade" showing values "na 10.9.2026.", support articles), and the HNB register PDF dated 29 Sep 2026. aircash.eu is a Next.js/Storyblok SPA, so the page text was pulled out of the embedded RSC payload with curl. WebFetch alone returns empty fee tables.

Labels: **VERIFIED** means a primary source (Aircash or HNB). **REPORTED** means press, a forum or a third party. **UNKNOWN** means no source found. **INFERENCE** marks my own reading of the sources.

---

## TL;DR for the rail idea

| Step | Status |
|---|---|
| Apple Pay top-up free | **VERIFIED**: 0 EUR, max 1,000 EUR per transaction |
| Bill payment ("Slikaj i plati") free | **VERIFIED**: 0 EUR, "do jednog radnog dana" (up to one business day) |
| Bill payment to an **EE (Estonian) IBAN** | **VERIFIED that EE is not on the supported list.** Bill pay is limited to HR, SI, AT, RO (the fee page also lists SK) billers / IBANs. **INFERENCE: an EE Monerium IBAN will very likely be rejected.** |
| Instant settlement | **VERIFIED not instant**: orders received before 13:00 CET on a working day settle the same day, later ones the next working day |
| HUB3 model + poziv na broj carried to the payee | **UNKNOWN** |
| Fallback: "Isplata na bankovni račun" (withdrawal to IBAN) | 1% promo until 31.12.2026, then 2%; max 550 EUR per transaction; payee IBAN countries are HR, SI, AT, DE, ES, CY, GR, RO. **EE is not listed.** It is framed as a payout to the user's **own** account. |

Bottom line: as published, Aircash cannot pay a Monerium EE IBAN for free. The only plausible free leg is bill pay, and bill pay is restricted by country, with Estonia not included. A Croatian-IBAN collection account, such as a Monerium HR IBAN if one exists, or a partner HR account, would be needed. The flow would also not be instant.

---

## 1. Company and licence

- **Legal entity: VERIFIED.** "Aircash d.o.o., Ulica grada Vukovara 271, 10000 Zagreb, Hrvatska, OIB: HR99833713101 … izdaje elektronički novac sukladno odobrenju … Hrvatske narodne banke … upisan u registar platnih institucija i institucija za elektronički novac HNB-a te … EBA pod brojem IEN116." (Wallet T&C §1.1, https://aircash.eu/hr-HR/opci-uvjeti)
- **Licence decision: VERIFIED.** "authorised … by the Croatian National Bank pursuant to its decision dated 3 October 2019 (decision number: 251-020/10-19/BV) and registered under number IEN116." (Investing Access Terms, https://aircash.eu/en-HR/trading-access-terms-en)
- **HNB register entry: VERIFIED** (register dated 29 Sep 2026).
  - IEN116 Aircash d.o.o.: "izdavanje elektroničkog novca i pružanje platnih usluga povezanih s izdavanjem elektroničkog novca". Authorised 3.10.2019, entered 10.6.2020.
  - Additional unrelated payment services (6. money remittance; 3. execution of payment transactions incl. credit transfers, direct debits, cards; 5. issuing instruments / acquiring) were added 19.12.2025 and entered 27.4.2026.
  - Passported "neposredno" (direct cross-border provision) to: AT, BE, BG, CY, CZ, DE, DK, **EE**, ES, FI, FR, GR, IE, IS, IT, LI, LV, LT, LU, HU, MT, NL, NO, PL, PT, RO, SE, SI, SK.
  - Source: https://www.hnb.hr/documents/d/guest/h-registar-pruzatelja-platnih-usluga-i-izdavatelja-e-novca-pdf
- **Countries where the app actually operates: VERIFIED.**
  - The market switcher lists PT, ES, AT, INT, HR, DE, IT, FR, BG, RO, PL, SK, CZ, SI, HU, GR, BA, RS, TR, CY and CH (https://aircash.eu, all pages).
  - Features vary by country. T&C §1.10: "Funkcionalnosti Aircash aplikacije i dostupne usluge mogu varirati ovisno o lokaciji Korisnika."
- **Investing / Bitpanda: VERIFIED.** "Aircash also acts as a tied agent of Bitpanda Financial Services GmbH … authorised and supervised by the Austrian FMA." (https://aircash.eu/en-HR/trading-access-terms-en)

## 2. Bill payment ("Slikaj i plati" / Scan&Pay)

- **How it works: VERIFIED.** "Na početnom ekranu klikni na 'Slikaj i Plati' · Slikaj QR kod ili barkod s računa · Ukoliko želiš možeš promijeniti iznos računa · Potvrdi plaćanje · Plaćanje će biti vidljivo primatelju najkasnije sljedeći radni dan." Also: "U Aircash aplikaciji nije moguće platiti račun koji nema barkod ili QR kod." (https://aircash.eu/hr-HR/podrska/kako-platiti-racun)
  - Only scanned codes are accepted; there is no manual IBAN entry for bill pay.
  - The user can edit the amount.
- **Fee: VERIFIED free.**
  - Fee page, "Plaćanje računa → Slikaj i plati": "Izvršenje: Do jednog radnog dana · Naknada: 0 EUR · Vrijedi samo za hrvatsko, austrijsko, rumunjsko, slovensko i slovačko tržište." (https://aircash.eu/hr-HR/naknade)
  - Support article: "plaćati hrvatske, slovenske, austrijske i rumunjske račune bez naknade."
  - T&C §11.6 still allows a fee "u iznosu određenom Naknadama". It is currently 0.
- **Payee scope / IBAN countries: VERIFIED.**
  - T&C §11.1: "Zadavanje naloga za plaćanje vrši se skeniranjem 2D koda na računu/općoj uplatnici te je omogućeno prema IBAN-u pružatelja usluge sa sjedištem u EU za države čiji aktualni popis … možete pronaći na poveznici" (link → https://aircash.eu/hr/aircash-mogucnosti/, which redirects to /hr-HR/hub/upoznaj-aircash).
  - That page says: "Scan&Pay plaćanje računa dostupno je u Hrvatskoj, Sloveniji i Austriji."
  - The three sources disagree slightly (HR/SI/AT vs HR/SI/AT/RO vs HR/SI/AT/RO/SK). **Estonia is never listed.**
  - "IBAN-u pružatelja usluge" (the IBAN of a service provider / biller) suggests the feature is meant for billers.
  - Whether there is a hard registered-biller whitelist: **UNKNOWN**. Nothing says only pre-registered billers are accepted.
- **Pay to a foreign EE IBAN: UNKNOWN / INFERENCE no.** EE is not in any supported list. Only an empirical test with a HUB3 code pointing at an EE IBAN would settle it.
- **Per-transaction / daily / monthly limits for bill pay: UNKNOWN.** The fee page shows no per-transaction limit for Slikaj i plati. T&C §5.2/§14.6 say generically that "Izdavatelj postavlja početne limite i zadržava pravo upravljanja limitima … nije dužan obrazlagati."
- **Settlement timing: VERIFIED.** T&C §11.3: "za naloge zaprimljene do 13:00h (CET) radnim danom, nalog će biti izvršen isti radni dan … iza 13:00h … najkasnije sljedeći radni dan." This is not SEPA Instant; it is likely an NKS/SEPA batch (**INFERENCE**). Failed or returned payments are re-credited as e-money (§11.4). The user gets a PDF confirmation (§11.5).
- **HUB3 model + poziv na broj + opis passed to the payee: UNKNOWN.** No source states it. Billers rely on the reference, so it is probably carried for HR payees (**INFERENCE**).

## 3. Top-up methods and fees (fee page, values as of 10.9.2026)

| Method | Fee | Limit per tx | Speed | Status |
|---|---|---|---|---|
| Cash (Tisak, iNovine, INA, Tifon) | 0 EUR up to 100 EUR per calendar month. Above that, a **3.00 EUR monthly "naknada za korištenje" from 1.10.2026** (applies to users verified with a Croatian ID) | 500 EUR | instant | VERIFIED |
| Card (Visa/MC/Maestro/Diners/JCB/Discover) | 0 EUR | 700 EUR | instant | VERIFIED |
| Bank account (IBAN transfer) | 0 EUR. Bank charges may reduce the credited amount. Returns for a wrong or missing reference cost up to 1 EUR (EUR) or 3 EUR (other currencies) | — | up to 2 working days | VERIFIED |
| Apple Pay / Google Pay | 0 EUR | **1,000 EUR** | instant | VERIFIED |

- Source: https://aircash.eu/hr-HR/naknade. Support page: https://aircash.eu/hr-HR/podrska/kako-uplatiti-novac-na-aircash-racun
- **Personal IBAN? VERIFIED no.** Bank top-up goes to a pooled account: "IBAN Aircash d.o.o. · Model: HR00 · Poziv na broj" (unique per user), and the payment is returned if the reference is wrong. T&C §5.1.3 says returns happen within 10 working days.
- **Instant inbound: VERIFIED.** With instant payments, money arrives within 1 h (06–21), within 2 h (21–24), or after 06:00. A standard payment sent after 15:00 arrives the next working day.
- Abon vouchers (5/10/20/25/50 EUR, sold at 200k+ locations in Europe) can be redeemed in the app: **REPORTED/VERIFIED** (https://aircash.eu/en-RO/hub/abon-top-up-your-aircash-easily).

## 4. Outgoing transfers to an IBAN

- **Fee page "Isplata → Bankovni račun": VERIFIED.** "Izvršenje: Jedan radni dan · Naknada 2% / 1%* · Limit po transakciji 550 EUR · *Podizanje novca na bankovni račun (IBAN). Promotivno razdoblje nudi smanjenu naknadu od 1% do 31.12.2026. Standardna naknada nakon toga iznosi 2%."
- **Speed: VERIFIED.** "Novac će biti vidljiv na tvom bankovnom računu najkasnije sljedeći radni dan, ali obično bude vidljivo unutar nekoliko minuta" (https://aircash.eu/hr-HR/podrska/kako-podici-novac-s-aircash-racuna). T&C §13.4 gives the same 13:00 CET cut-off as bill pay.
  - "Usually minutes" hints at instant for some routes, but SEPA Instant is never named: **UNKNOWN**.
- **Allowed IBAN countries: VERIFIED.** "Isplatu možeš napraviti i izravno na svoj bankovni račun na IBAN-e izdane u sljedećim zemljama: Hrvatska, Slovenija, Austrija, Njemačka, Španjolska, Cipar, Grčka i Rumunjska." (https://aircash.eu/hr-HR/hub/upoznaj-aircash). **EE is not included.**
- **Own account vs third party: VERIFIED that the wording is mixed.**
  - The marketing and fee-page wording say "svoj bankovni račun" and "Podizanje".
  - T&C §13.1 says more generally: "plaćanje na bankovni račun čije je podatke unio unutar Aircash aplikacije … prema primateljima na dostupnim područjima."
  - T&C §6.2 (off-app redemption) requires an account "otvoren na ime Korisnika".
  - **INFERENCE:** in practice it is treated as a payout to the user's own account.
- Remittance to Turkey and Nepal bank accounts: 1% (0% promo), limit 1,000 EUR. **VERIFIED.**

## 5. KYC tiers and limits

- **Mandatory full KYC at onboarding: VERIFIED.** Registration requires a photo of the ID (ID card, passport or residence card) plus a selfie video. "Provjera identiteta bit će izvršena u najkraćem mogućem roku" (https://aircash.eu/hr-HR/podrska/kako-postati-aircash-korisnik). T&C §3.2–3.4 cover remote video onboarding, and §4.3 says full functionality comes only after successful ID verification.
- **No published unverified tier: UNKNOWN.** Older T&C versions may have had one; this was not checked.
- **Balance caps and daily/monthly limits: UNKNOWN (not published).** T&C §5.2, §6.3.4, §13.6 and §14.6 let Aircash set and manage limits at its discretion "u skladu s propisima … sprječavanja pranja novca", without having to explain them. It "monitors linked transactions" and may hold or verify transactions. §5.3 allows blocking on "neuobičajene aktivnosti".
- The only published numbers are the per-transaction limits above: cash in 500, card 700, Apple/Google Pay 1,000, P2P 1,000, IBAN out 550, cash out 500, PBZ ATM 300.
- **Restriction that card-funded money cannot be withdrawn to an IBAN: UNKNOWN.** No such clause appears in the current wallet T&C.

## 6. Other products

- **P2P "Slanje"** by phone number: 1% fee, 1,000 EUR per transaction, instant. The recipient must register and complete KYC within 72 h or the money is returned. **VERIFIED** (fee page; https://aircash.eu/hr-HR/podrska/kako-poslati-novac-aircash-korisniku)
- **Aircash Pay** (merchant payments):
  - Online or via a QR shown at a POS, authorised in the app. T&C §7 (**VERIFIED**).
  - "Uplate na račun partnera" cost 0 EUR, limit depends on the partner (**VERIFIED**).
  - Hrvatska lutrija in the Marketplace: 4% (**VERIFIED**).
  - Merchants can also pay into a wallet (payouts), T&C §10 (**VERIFIED**).
- **Abon**: a prepaid e-money voucher with separate T&C ("Opći uvjeti poslovanja za izdavanje Abon elektroničkog novca", T&C §1.6). Used for top-up and for paying iGaming and other merchants. **VERIFIED/REPORTED.**
- **Aircash Mastercard** (prepaid, physical and up to 5 virtual): **VERIFIED.**
  - 5 EUR card, no monthly fee.
  - ATM in the EU: 1.50 EUR + 2%. Outside the EU: 1.99 EUR + 3%.
  - **3% fee on gambling-MCC transactions.**
- **Crypto / investing**: an in-app investing platform operated by **Bitpanda** (crypto-assets, financial instruments, metals), with Aircash as Bitpanda's tied agent. Monthly "platforma za ulaganje" usage fee is 6.00 EUR (including the 3 EUR cash feature) from 1.10.2026. **VERIFIED** (https://aircash.eu/en-HR/trading-access-terms-en, fee page). There is no native crypto purchase inside the e-money wallet itself.
- Cash out: 4% at partner locations, 2% at PBZ ATMs with a code. **VERIFIED.**

## 7. Clauses relevant to the "card-funded → forward to IBAN / crypto" pattern

- **No explicit clause found** that forbids forwarding card-funded balance to an IBAN, or that forbids paying crypto or e-money issuers. **VERIFIED absence** in the current wallet T&C (searched for kripto, crypto, kockanje, zabranjen).
- Relevant general clauses (**VERIFIED**, wallet T&C https://aircash.eu/hr-HR/opci-uvjeti):
  - §3.7: the account "smije se koristiti isključivo za osobne potrebe Korisnika … ne smije … otvoriti Račun kojim će se koristiti za potrebe treće osobe … svako postupanje protivno … smatrat će se zloporabom". This is a risk if a merchant flow makes users act as conduits.
  - §3.8: no unlawful use.
  - §11.2: bill pay is to be used "isključivo za valjana i zakonita plaćanja".
  - §5.2/§5.3: discretionary limits, monitoring of linked transactions, blocking on unusual activity.
  - §7.7: refusal of payments for AML or fraud suspicion.
  - §5.1.2: you may only use cards you are authorised to use.
  - §17: blocking.
- The card T&C (https://aircash.eu/en-HR/general-terms-and-conditions-for-aircash-cards) §6.3 and §8.3 forbid only illegal purchases.
- **INFERENCE:** a pattern of card top-up followed immediately by an outbound transfer of the same amount to an e-money issuer (Monerium) is a classic AML red flag. Expect limit throttling or blocks under §5.3 at volume, even without an explicit ban.

---

## Sources

- Wallet T&C, current (in force 1.10.2026, dated 31.7.2026): https://aircash.eu/hr-HR/opci-uvjeti (EN: https://aircash.eu/en-HR/general-terms-conditions)
- Fees (Naknade), values as of 10.9.2026: https://aircash.eu/hr-HR/naknade (EN: https://aircash.eu/en-HR/fees)
- Bill payment support: https://aircash.eu/hr-HR/podrska/kako-platiti-racun
- Top-up support: https://aircash.eu/hr-HR/podrska/kako-uplatiti-novac-na-aircash-racun
- Withdrawal support: https://aircash.eu/hr-HR/podrska/kako-podici-novac-s-aircash-racuna
- Onboarding / KYC: https://aircash.eu/hr-HR/podrska/kako-postati-aircash-korisnik
- P2P: https://aircash.eu/hr-HR/podrska/kako-poslati-novac-aircash-korisniku
- Features by country (link target of T&C §11.1 / §13.1): https://aircash.eu/hr-HR/hub/upoznaj-aircash
- Investing Access Terms (Bitpanda tied agent): https://aircash.eu/en-HR/trading-access-terms-en
- Card T&C: https://aircash.eu/en-HR/general-terms-and-conditions-for-aircash-cards
- Legal archive (older T&C and fee PDFs): https://aircash.eu/en-HR/terms-condition-archive
- HNB register of payment service providers and e-money issuers (29.9.2026): https://www.hnb.hr/documents/d/guest/h-registar-pruzatelja-platnih-usluga-i-izdavatelja-e-novca-pdf
- Paying bills blog (EN): https://aircash.eu/en-HR/blog/paying-bills
- Abon: https://aircash.eu/en-RO/hub/abon-top-up-your-aircash-easily
- AmCham profile (EBA / all EU): https://www.amcham.hr/en/members/aircash-doo

## Open questions (need an empirical test or an email to info@aircash.eu)

1. Does Slikaj i plati accept a HUB3 PDF417 or EPC QR whose IBAN is EE (Monerium)? If not, does it accept an HR IBAN belonging to a non-biller (a private person or company)?
2. Are the HUB3 model + poziv na broj and the opis passed through in the outgoing credit transfer (SEPA RemittanceInformation / structured creditor reference)?
3. Is there any hidden daily or monthly cap on bill pay, and on Apple Pay top-ups?
4. Is outbound settled via SEPA Instant (SCT Inst) or batch? The T&C imply batch with a 13:00 cut-off.
