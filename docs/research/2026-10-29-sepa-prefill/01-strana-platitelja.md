# Dio A — strana platitelja: tko popunjava SEPA (Instant) nalog bez tipkanja

Provjereno 2026-10-29 web pretragom i čitanjem primarnih izvora gdje su dostupni. Oznake:
**VERIFIED** = primarni izvor ili naš pokus · **REPORTED** = treća strana · ⚠️ = neprovjereno /
nema izvora · **INFERENCE** = naš zaključak.

## Sažetak

1. **Nijedan javni izvor ne kaže da ijedna hrvatska banka čita EPC QR (BCD).** Hrvatske
   aplikacije dokumentirano čitaju HUB3 (PDF417; RBA i kao QR). Wikipedijin popis zemalja s
   EPC QR-om (AT, BE, FI, DE, NL, LU, EE, LV, LT, IT) ne uključuje HR ni SI. Aircash EPC QR
   **čita** (naš test 2026-10-11), ali odbija `EE…` IBAN. Za PBZ, HPB i RBA s EPC QR-om nemamo
   rezultat. → **test na uređaju**, vidi [test-plan-uredaji.md](test-plan-uredaji.md).
2. **HUB3 s ne-HR IBAN-om nijedna testirana HR aplikacija ne pušta** (PBZ, HPB, RBA, Aircash;
   VERIFIED 2026-10-11, `docs/research/aircash/05`). Javnog izvora o suprotnom nismo našli.
3. **Deep link koji puni SEPA nalog praktično ne postoji.** `payto:` (RFC 8905) je Informational
   RFC bez dokazane bankovne podrške. Revolut nema `iban=` deep link (statička analiza, energy
   dnevnik §14.2). bunq.me, revolut.me i Wise linkovi plaćaju **račun te institucije**, a ne
   proizvoljni IBAN.
4. **Wero** radi P2P u BE/FR/DE, e-commerce u DE/BE (FR jesen 2026, NL 2027), POS/QR najavljen
   za jesen 2026. Za Hrvatsku nema traga. **SRTP** je u homologacijskim valovima 2026., uz
   pilot CaixaBank/BBVA. Ni jedno ni drugo danas nije put za HR platitelje.
5. **PSD2 PIS** je jedini nađeni mehanizam koji HR banku navodi da izvrši **popunjen** nalog na
   proizvoljan IBAN, uključujući Monerium `EE…`. Enable Banking (s njim već imamo AIS
   aplikaciju) navodi Zabu, PBZ, Erste i RBA; OTP ne. Ključno otvoreno pitanje je
   **dopušta li agregator proizvoljnog beneficiara** i po kojoj cijeni. Vidi §6.

## Matrica A

Stupci: EPC = čita EPC QR (BCD 001/002) · HUB3 = čita HUB3 PDF417/QR · ne-HR = prihvaća ne-HR
IBAN primatelja · Ref = zadržava referencu/opis · Inst = SEPA Instant po zadanom · Link = deep
link / URI.

| Aplikacija | EPC | HUB3 | ne-HR | Ref | Inst | Naknada | Link | Izvor / datum |
|---|---|---|---|---|---|---|---|---|
| **Revolut** (iOS/Android) | ✅ parser na poslužitelju (`BCD`, `SPC`) | ❌ | ✅ | ⚠️ redovito ispusti kad saldo ≥ iznos | ✅ (SCT Inst od 2022-03-07) | 0 (Standard, SEPA) | ❌ nema `iban=` | energy dnevnik §14, §24 (VERIFIED, naš pokus); EPC `sct_inst.csv` |
| **PBZ** iOS | ⚠️ test | ✅ PDF417 | ❌ čita `EE…`, ne pušta | ✅ HUB3 polja | ⚠️ (bira platitelj) | ⚠️ | ❌ | aircash/05 (VERIFIED 2026-10-11) |
| **HPB** biz | ⚠️ test | ✅ PDF417 | ❌ isto | ✅ | ⚠️ | ⚠️ | ❌ | aircash/05 (VERIFIED) |
| **RBA** biz | ⚠️ test | ✅ PDF417 **i QR** | ❌ isto | ✅ | ⚠️ | ⚠️ | ❌ | aircash/05 (VERIFIED) |
| **Aircash** | ✅ čita | ✅ | ❌ „Unknown code“ s `EE…`; uvjeti: samo HR/SI/AT(/RO/SK) | ✅ | ❌ batch, cut-off 13:00 | 0 | ❌ | aircash/README (VERIFIED) |
| Zaba, Erste (George), OTP, Addiko, Agram, Istarska | ⚠️ | ⚠️ (vjerojatno ✅ PDF417) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | nema javnog izvora |
| **KEKS Pay** (Erste) | ⚠️ | ⚠️ „skeniranje 2D barkoda“ za režije | ⚠️ | ⚠️ | ⚠️ | P2P na bilo koji IBAN besplatno | ❌ | apkmirror release notes (REPORTED, iz doba kune); novilist.hr promo |
| **N26** | ✅ skeniranje QR-a puni ime i IBAN | ❌ | ✅ | ⚠️ (referencu ručno, prema N26 uputi) | ⚠️ | ⚠️ | ❌; Wero u DE/FR | support.n26.com „How to make a SEPA transfer“ (VERIFIED); mobiflip 2021 |
| **bunq** | ✅ | ❌ | ✅ | ⚠️ | ⚠️ | ⚠️ | bunq.me = naplata na bunq račun | Billit popis (REPORTED) |
| **Wise** | ⚠️ nije nađeno | ❌ | ✅ | ⚠️ | — | — | ❌ | — |
| BE: Argenta, Belfius, BNP Paribas Fortis, ING, KBC, VDK | ✅ | ❌ | ✅ (SEPA) | ⚠️ | ⚠️ | ⚠️ | Payconiq/Wero (domaći) | Billit popis (REPORTED) |
| NL: ING, ASN, SNS, Knab | ✅ | ❌ | ✅ | ⚠️ | ⚠️ | ⚠️ | iDEAL→Wero | Billit (REPORTED) |
| NL: Rabobank, ABN AMRO | ❌ | ❌ | — | — | — | — | iDEAL→Wero | treća strana (REPORTED ⚠️) |
| DE: Sparkasse, VR, Deutsche, Commerzbank | ✅ GiroCode | ❌ | ✅ | ✅ | ⚠️ | ⚠️ | Wero | Wikipedia + vendor docs (REPORTED); popis na girocode.de |
| AT (Stuzza / „Zahlen mit Code“) | ✅ | ❌ | ✅ | ✅ | ⚠️ | ⚠️ | — | Wikipedia (REPORTED) |
| SI: NLB Klik, Sparkasse, OTP, UniCredit | ⚠️ EPC; ✅ **UPN QR** | ❌ | UPN = samo SI račun | ✅ | ⚠️ | ⚠️ | — | NLB uvjeti UPN; slo-tech.com forum 11.6.2026 (REPORTED) |
| CH (QR-bill `SPC`) | — | — | Revolut: **samo CH IBAN** | ✅ | — | — | — | help.revolut.com en-CH (VERIFIED) |

### Napomene uz matricu

- **Revolut ispušta referencu.** To nije format (testirano ~45 varijanti), nego ponašanje brzog
  ekrana. Rezerve su kratka referenca intenta (ADR 0028) i stray resolver (ADR 0018). Iznos
  nikad ne nosi identitet.
- **Slovenija i VoP u praksi.** Na slo-tech forumu (11.6.2026) korisnici javljaju da Sparkasse
  SI kod skeniranog QR-a „skoraj vedno jamra o neujemanju naziva prejemnika“, a NLB Klik ne.
  Svaka banka je provjeru implementirala „malo po svoje“. Isto treba očekivati i kod nas za
  ime primatelja na Monerium IBAN-u (§7).
- **EPC „MSCT QR“** (Standardisation of QR-codes for Mobile Initiated SEPA (Instant) Credit
  Transfers, lipanj 2022) je informativan dokument. Prema SIX-u (12/2022) nikoga ne obvezuje.
  Nismo našli nijednu banku koja ga implementira za plaćanje na proizvoljan IBAN.

## 4. Deep linkovi i URI

| Mehanizam | Što radi | Proizvoljan IBAN? | Status |
|---|---|---|---|
| `payto://iban/<IBAN>?amount=EUR:1.00&message=…` (RFC 8905) | Generička URI shema za platni cilj | da (po specifikaciji) | Informational RFC (2020), ne standard. Implementacija samo u GNU Taleru. Bankovnu aplikaciju koja registrira `payto:` nismo našli ⚠️ → **test na iOS-u** (otvara li išta) |
| Revolut `revolut.me` / `pay.revolut.com` | Plaća Revolut korisnika ili trgovca | ❌ | VERIFIED (energy §14.2) |
| bunq.me | Naplatni link na **bunq račun** primatelja (iDEAL/Wero, kartica) | ❌, novac sjeda na bunq | REPORTED (bunq.me pomoć, 2026) |
| Wise payment link / request | Naplata na Wise račun | ❌, novac sjeda na Wise | ⚠️ |
| „Share payment“ linkovi HR banaka | — | — | nije nađeno |

**INFERENCE:** link „otvori moju banku s popunjenim nalogom na IBAN X“ u HR/EU ne postoji izvan
PSD2 PIS-a (§6) i Wero/iDEAL ekosustava (koji plaćaju trgovca preko acquirera).

## 5. Sheme bez kartice

| Shema | Stanje | HR | Za nas |
|---|---|---|---|
| **Wero (EPI)** | P2P u BE/FR/DE, ~56 M korisnika (EPI). E-commerce DE od 11/2025, BE. FR u pilotu, jesen 2026. LU 2026, NL 2027. POS (NFC + QR) najavljen za jesen 2026. | Nema najave pristupanja HR banaka ⚠️ (pretraga bez rezultata) | Plaćanje trgovca ide preko acquirera (Worldline, PayPlug…), dakle na **merchantov** račun. Moguće za Mod 2 kasnije, ne za HR platitelje danas. |
| **iDEAL → Wero** | iDEAL logo nestaje krajem 2026. | — | NL platitelji |
| **SRTP** (EPC SEPA Request-to-Pay) | Homologacijski valovi 2026 (IV–VI, IX–XI). EDS otvoren sudionicima. Pilot CaixaBank/BBVA (interni). ERPB 6/2026: „potential increased uptake… public bodies“. | Nema HR sudionika ⚠️ | Pratiti. Bio bi pravi odgovor (zahtjev s referencom ide u platiteljevu banku), ali nije živ. |
| Bizum (ES), Bancomat Pay (IT), Payconiq (BE/LU), Bluecode | Domaće sheme, većinom na putu u Wero/EPI ili EMPSA | ❌ | Nisu relevantne za HR platitelje |

## 6. PSD2 PIS — popunjen i potvrđen nalog na bilo koju banku

Kako radi: platitelj na checkoutu odabere banku, preusmjeri se u nju (redirect; na mobitelu
često app-switch), vidi **već popunjen** nalog (IBAN, iznos, opis s referencom) i potvrdi ga
SCA-om. Banka izvršava običan SCT ili SCT Inst. PISP novac **ne dira** (PSD2), pa nema
skrbništva.

| Pružatelj | HR pokrivenost | Proizvoljan beneficiar | Cijena | Izvor |
|---|---|---|---|---|
| **Enable Banking** | Zaba (AIS + PIS izrijekom), PBZ, Erste, RBA navedeni. **OTP: „not yet supported“.** Croatia banka ugašena (HPB, 3/2026). Erste: „app switch is not supported“. SCT preko svih HR API-ja; SCT Inst preko PIS-a nije naveden ⚠️ | ⚠️ nije navedeno | ⚠️ nije javno | enablebanking.com/docs/markets/hr (VERIFIED 2026-10-29) |
| GoCardless Bank Account Data | AIS. Novi upisi navodno zatvoreni | — | — | dev.to (REPORTED ⚠️) |
| TrueLayer | ⚠️ HR nepotvrđen | Mandati: „your TrueLayer merchant account, or another external account“. Merchant account traži sanctions screening (datum rođenja, adresa) | ⚠️ | docs.truelayer.com (VERIFIED) |
| Token.io | ⚠️ | „Transfer destinations are typically TPP-controlled accounts… can be manually added to the dashboard“, dakle **unaprijed registrirana odredišta** | ⚠️ | docs.token.io SIP v2 (VERIFIED) |
| Tink, Yapily | ⚠️ HR nepotvrđen | ⚠️ | ⚠️ | openbankingtracker (REPORTED, bez HR detalja) |

**INFERENCE:** odredišta registrirana unaprijed **odgovaraju našem modelu**: tenantov Monerium
IBAN je poznat, stabilan i KYB-an. Ne treba nam „bilo koji IBAN“, nego „N IBAN-a koje
registriramo po tenantu“. Isti whitelist već imamo on-chain (ADR 0016, 0026). Mod 2 problem iz
energy dnevnika §14.4 („agregator često dopušta samo verificirani račun trgovca“) zato
vjerojatno **nije** blokada. Tenant **jest** verificirani trgovac s vlastitim IBAN-om. To treba
potvrditi pitanjem Enable Bankingu.

**Pitanja za Enable Banking** (imamo aktivnu AIS aplikaciju, `ENABLE_BANKING_APPLICATION_ID`):
1. Je li PIS dostupan na našoj aplikaciji i pod kojim ugovorom (oni kao licencirani PISP)?
2. Smije li `creditor_account` biti IBAN izvan HR (`EE…`, LHV) i mora li biti registriran?
3. Podržavaju li HR ASPSP-ovi preko njih `SCT Inst` (`payment_type` / `instant`)?
4. Prenosi li se `remittance_information` (Ustrd / Strd) netaknut do primatelja?
5. Cijena po iniciranoj uplati.

## 7. Verification of Payee (od 9.10.2025.)

- Obvezno za sve PSP-ove u eurozoni, uključujući EMI (Uredba 2024/886, čl. 5c(9)). LHV je
  responding PSP od 2025-08-04, Revolut od 2025-08-24, svih 20 HR banaka od početka 10/2025
  (aircash/03, VERIFIED).
- Monerium: „Every IBAN issued through Monerium is in the individual account holder's own
  name — not a shared or pooled account.“ (monerium.com/partners, VERIFIED 2026-10-29).
  **INFERENCE:** VoP za tenantov `EE…` IBAN trebao bi vratiti KYB ime tenanta (npr.
  „ITalk d.o.o.“). Ime u EPC/HUB3 kodu zato mora biti **točno KYB ime**, a ne „MPT“ ni
  „Monerium“.
- „No match“ ne blokira plaćanje (čl. 5c(5)), ali platitelja plaši. Kod HUB3 se ime reže na
  25 znakova, pa je moguć „close match“.
- Nismo provjerili što LHV stvarno vraća → test 0,01 € (test-plan, T6).

## Izvori (provjereno 2026-10-29)

- Enable Banking HR: https://enablebanking.com/docs/markets/hr/
- N26 SEPA transfer: https://support.n26.com/en-de/payments-transfers-and-withdrawals/transfers/how-to-make-a-debit-transfer ; https://www.mobiflip.de/shortnews/n26-neue-funktionen-per-update-epc-qr-code-scanner-fuer-android-und-mehr/
- Billit (popis BE/NL banaka s EPC QR): https://www.billit.eu/en-int/help-page/expenditure/payment-options-in-billit/paying-invoices-with-an-epc-qr-code/
- EPC QR (Wikipedia): https://en.wikipedia.org/wiki/EPC_QR_code
- SIX, „QR-bill light in SEPA“ (12/2022): https://www.six-group.com/en/site/pay-magazine/experts/qr-bill-light-in-sepa.html
- Revolut Swiss QR: https://help.revolut.com/en-CH/help/receiving-payments/sending-money-to-an-external-bank-account/sending-qr-code-payments/business
- RFC 8905: https://www.rfc-editor.org/rfc/rfc8905.html
- Wero: https://en.wikipedia.org/wiki/Wero_(payment) ; https://www.payplug.com/blog/payment-wero/ ; https://worldline.com/en-lu/home/main-navigation/resources/blogs/2026/what-is-wero-and-when-can-merchants-start-using-it ; https://epicompany.eu/key-figures/
- SRTP: https://www.ecb.europa.eu/paym/groups/erpb/shared/pdf/25th-ERPB%20meeting%20on%2018%20June%202026/Status_update_on_payment_and_payment-related_schemes.pdf ; https://thepaypers.com/payments/news/caixabank-and-bbva-launch-first-interbank-rtp-in-europe
- TrueLayer: https://docs.truelayer.com/docs/provide-user-information-for-payments
- Token.io: https://docs.token.io/products/tpp/sip/sip-v2/sip-v2-restricting-beneficiary-ac
- GoCardless BAD upisi: https://dev.to/johnfrandsen/gocardless-bank-account-data-alternatives-what-to-use-when-signups-are-disabled-326d
- bunq.me: https://finantresnoticias.com/bancos/bunq-me-bunq-to-pedir-dinero-enlaces-pago/
- KEKS Pay: https://www.apkmirror.com/apk/erste-banka-d-d/keks-pay/keks-pay-3-1-0-release/ ; https://www.novilist.hr/ostalo/promo/keks-pay-rezije-besplatna-usluga-primanja-i-placanja-rezija-obuhvaca-sve-telekome-i-sve-vise-izdavatelja-racuna-u-nasoj-zupaniji/
- Slovenija UPN/VoP: https://slo-tech.com/forum/t854361/0 ; https://nlb.si/content/dam/nlb/pdf-files/osebne-finance/placila/splosni-pogoji_izvrsevanja_upn_mercator_20_6_2023.pdf
- Monerium: https://monerium.com/partners/
- Interno: `docs/research/aircash/03`, `05`; energy.domovina.ai `docs/2026-09-15-dnevnik-izvedbe.md` §14.2, §14.4
