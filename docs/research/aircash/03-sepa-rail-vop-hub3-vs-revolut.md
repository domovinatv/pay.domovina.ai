# Aircash → external IBAN (Monerium EE/LHV) vs Revolut: rail research

Researched 2026-10-10. Sources are listed at the end with the exact quotes used.
Labels: **VERIFIED** means a primary or official source was read directly. **REPORTED** means a secondary source, or an official page that is indirect on the point. **INFERRED** means our own reasoning from verified facts. **UNKNOWN** means no source was found.

## TL;DR

1. **Aircash is not a SEPA scheme participant in its own right.** Its BIC `AIDOHR22` does not appear in the EPC SCT, SCT Inst or VOP registers (publication of 2026-10-09). All 20 Croatian SCT Inst participants are banks plus HNB. So Aircash's outgoing transfers go through a sponsor or settlement bank, and **which bank that is remains UNKNOWN**. Aircash's own terms describe a batch cut-off of **13:00 CET** with value date the same day or the next business day. That is SEPA SCT, **not SCT Inst**. Expect a T+0/T+1 arrival at Monerium, not about 10 s.
2. **The main blocker: Scan&Pay is gated by the payee IBAN's country.** The terms say bill payment by 2D code "is enabled according to the IBAN of the service provider based in the EU for countries whose current list" is on the features page. That page lists Scan&Pay for **Croatia, Slovenia and Austria** (the fees page adds RO and SK). **Estonia is not listed.** IBAN withdrawal countries are HR, SI, AT, DE, ES, CY, GR and RO, again **without EE**. A HUB3 code carrying the Monerium `EE…` IBAN will very likely be rejected in Aircash (INFERRED, needs a test with a real account).
3. **HUB3 spec:** the IBAN field is up to 21 characters and is described only as the Croatian IBAN construction. An EE IBAN (20 characters) fits the length but is outside what the spec describes. Model and reference become SEPA `RmtInf/Strd/CdtrRefInf/Ref` = `HR00<ref>` (no spaces). For a **cross-border** payment, which a payment to EE is, the Croatian guide says `AddtlRmtInf` (the description) is **not used**, so only the reference survives.
4. **VoP** (Art. 5c IPR) applies in the euro area from **9 Oct 2025 to all PSPs, EMIs included**. LHV has been a VOP responding PSP since 2025-08-04. A recipient name in the code that does not match LHV's account-holder name produces a "no match / close match" warning. It does not block the payment (Art. 5c(5)).
5. **Revolut** has free SEPA transfers on Standard, is a direct SCT Inst participant, and charges nothing for EEA consumer Apple Pay top-ups. That makes it the better rail. **Aircash** has free Apple Pay top-ups (≤1000 EUR per transaction) and free Scan&Pay, but only to HR/SI/AT(/RO/SK) payees, non-instant.

---

## 1. Aircash's outgoing payment infrastructure

| Fact | Status | Source |
|---|---|---|
| Aircash d.o.o., Zagreb, is an e-money institution licensed by HNB, register no. IEN116 | VERIFIED | Aircash wallet T&C §1.1: "issues electronic money in accordance with the approval of the supervisory body, the Croatian National Bank … under number IEN116" |
| BIC `AIDOHR22` (head office, Chromos Tower, Ulica grada Vukovara 271) | REPORTED (third-party BIC directory) | ohmyfin.ai |
| **Not in the EPC SCT register, SCT Inst register or VOP register** (searched for "aircash" and "AIDO") | VERIFIED | EPC RoP CSV exports `sct.csv`, `sct_inst.csv`, `vop.csv` (publication 2026-10-09) |
| Croatian SCT Inst participants: 20, all credit institutions plus HNB (Addiko, Agram, Kovanica, Croatia banka, Erste, HNB, HPB, Imex, IKB Umag, J&T, Karlovačka, KentBank, OTP, Partner, Podravska, PBZ, RBA, Samoborska, Slatinska, ZABA) | VERIFIED | `sct_inst.csv` |
| NKSInst: "participants can only be banks" (as of the 2020 launch) | REPORTED (old HNB announcement, via search summary) | hnb.hr NKSInst announcement |
| Sponsor bank for outgoing SEPA | **UNKNOWN**. Not published. PBZ is a verified Aircash partner for ATM cash-out ("Withdraw money … at any PBZ ATM"), but that does not prove PBZ is the settlement bank. **Cheap check:** open Aircash → Deposit → Bank account. Digits 5–11 of the HR IBAN shown are the VBDI of the bank holding Aircash's account (e.g. 2340009 = PBZ, 2360000 = ZABA, 2402006 = Erste, 2484008 = RBA, 2390001 = HPB, 2500009 = Addiko). | — |
| Timing: Scan&Pay (§11.3) and payment to bank account (§13.4): "For orders received by 1 p.m. (CET) on a business day, the transaction will be executed on the same business day … after 1 p.m. … no later than the next business day" | VERIFIED | Aircash wallet T&C |
| Fees page: Paying bills / Scan: "Processing: Up to one business day", "Fees: 0 EUR", "Applicable only for Croatian, Austrian, Romanian, Slovenian and Slovakian market." | VERIFIED | aircash.eu/naknade (fee table in page JSON) |
| Withdraw to bank account (IBAN): "One business day", fee 2% (promo 1% until 31.12.2026), "Limit per transaction 500 EUR" | VERIFIED | aircash.eu/naknade |
| Withdrawal-to-IBAN countries: "Croatia, Slovenia, Austria, Germany, Spain, Cyprus, Greece and Romania." | VERIFIED | aircash.eu/hub/aircash-features |
| Scan&Pay: "Scan&Pay bill payments are available in Croatia, Slovenia and Austria." | VERIFIED | aircash.eu/hub/aircash-features |
| Terms §11.1: "Placing a payment order is done by scanning the 2D code on the invoice/payment slip and is enabled according to the IBAN of the service provider based in the EU for countries whose current list can be found at any time on the link https://aircash.eu/aircash-features/" | VERIFIED | Aircash wallet T&C |

**What this means for the rail (INFERRED):**
- Monerium (`EE…`, LHVBEE22) is not in any Aircash payee-country list. Scan&Pay of our HUB3 code will most likely be refused at scan time, or when the payment is created. **This must be tested on a real device.**
- Even if it went through, it would be a batch SCT (cut-off 13:00), so the money would land at LHV the same day or the next business day. "Pay in seconds" would not hold. Scan&Pay is also described as paying "bills" from "service providers". Using it as a funding leg for a crypto on-ramp is a gray area under T&C §11.2 ("exclusively for valid and legal payments").
- A workaround that would work: a **Croatian collection IBAN** (one of our own HR accounts, e.g. at HPB/PBZ) as the HUB3 payee, then forward from it to Monerium. That adds a hop and a custody question (cf. our existing compliance note about hold-and-forward under Monerium BToS §16).
- Another path: become an **AircashPay merchant** ("Pay for Services – Payments to the partner's account: Processing Instantly, Fees 0 EUR" for the user). This is available through WSPay or a Magento plugin. The merchant-side fee is not published (UNKNOWN).

**IPR obligations for Aircash (VERIFIED, Reg. 2024/886 text):** euro-area EMIs and PIs must offer sending and receiving of instant credit transfers by **9 April 2027**: "PSPs that are electronic money institutions … located in a Member State whose currency is the euro shall offer PSUs the payment service of sending and receiving instant credit transfers in euro … by 9 April 2027." The IPR also amends the SFD so that EMIs and PIs can access designated payment systems directly (REPORTED, Osborne Clarke via search). Aircash is therefore expected to offer SCT Inst by April 2027 at the latest, either through a sponsor bank or by direct access. A TIPS participant listing for Aircash was not found (UNKNOWN).

## 2. Instant Payments Regulation and Verification of Payee

- **VoP deadline (VERIFIED, Art. 5c(9)):** "PSPs located in a Member State whose currency is the euro shall comply with this Article by 9 October 2025." There is no separate deferral for EMIs or PIs in Art. 5c. The 2027 deferral for EMIs and PIs is only in Art. 5a (instant sending and receiving). So **Aircash (HR, euro area) and Revolut Bank UAB (LT) must both run VoP since 9 Oct 2025.**
- **Register status (VERIFIED, `vop.csv`):** LHV (`LHVBEE22XXX`) is "Ready for operations, Requesting PSP; Responding PSP" since 2025-08-04. Revolut Bank UAB (`RVUALT2VXXX`) has been ready since 2025-08-24. All 20 Croatian banks have been ready since early October 2025. **Aircash is not in the EPC VOP register.** It may check through its sponsor bank or a non-EPC mechanism (UNKNOWN).
- **What VoP does (VERIFIED, Art. 5c(1)(a)):** "the payee's PSP shall verify whether the payment account identifier … and the name of the payee provided by the payer match. Where they do not match, the payer's PSP shall … notify the payer … Where [they] almost match, the payer's PSP shall indicate to the payer the name of the payee associated with the payment account identifier".
- **It does not block the payment (VERIFIED, Art. 5c(5)):** "PSPs shall ensure that the performance of the service ensuring verification … does not prevent payers from authorising the credit transfer concerned."
- **Pooled or virtual accounts (VERIFIED, Art. 5c(1)(c)):** where an account "is held by a PSP on behalf of multiple payees", the PSP confirms whether the indicated payee is among them. This may matter if Monerium IBANs are LHV-held accounts on behalf of Monerium customers.
- **Impact on our rail (INFERRED):** the name in HUB3 field 7 (max 25 characters) or EPC QR line 6 is checked against the name LHV returns for the Monerium IBAN. For our tenant IBANs that is presumably the KYB'd holder (e.g. "ITalk d.o.o."), not "Monerium EMI ehf.". **What LHV actually returns for a Monerium IBAN is UNKNOWN.** It can be tested cheaply: send 0.01 € from Revolut by EPC QR with the name set to "ITalk d.o.o." and read the VoP result screen. Truncating to 25 characters (the HUB3 limit) may cause a "close match" result.

## 3. HUB3 / HRVHUB30 and the SEPA remittance mapping

- **Spec (VERIFIED, HUB "HUB 3A obrazac – specifikacija PDF417 barkoda", version 6, for payment slips from 1 Jan 2023):** 14 fields. Field 10 is "Broj računa primatelja (IBAN)" with a maximum of 21 characters. The text describes only "Hrvatska konstrukcija IBAN transakcijskih računa sadrži 21 znak" (HR + 2 check digits + 7-digit VBDI + 10-digit account). Foreign IBANs are neither explicitly allowed nor forbidden. An EE IBAN (20 characters) fits the length. DE (22) and others would not fit.
- Model field: "Ispred dvoznamenkastog broja modela stavlja se oznaka HR." (e.g. `HR00`). Reference: digit groups separated by hyphens per FINA rules. "Nakon uvođenja ISO 11649 standarda upisivat će se referenca pošiljatelja (može uključivati i slova)." Field 13 purpose code is ISO 20022 (e.g. `COST`). Field 14 description holds 35 characters. Allowed charset: digits, Croatian letters, Q W X Y, space, `, . : - + ? ' / ( )`.
- **Do Croatian bank apps accept a foreign IBAN in a scanned uplatnica?** UNKNOWN. No source found. It needs per-app testing (m-zaba, PBZ, Erste George, RBA, HPB, OTP, Addiko).
- **Mapping to ISO 20022 (VERIFIED, sepa.hr "SCTInst Uputa za klijente pain.001", valid from 01.01.2023):**
  - **National euro payment:** structured remittance is mandatory. `RmtInf/Strd/CdtrRefInf/Tp/CdOrPrtry/Cd = SCOR`, optional `Issr = "HR ref"`, and `Ref` = model + reference "u nizu, bez razmaka (npr. HR002016-04-04)". Use `HR99` if there is no reference. "Ako se popunjava poziv na broj bez modela, obavezno se popunjava model HR00." The description goes into `Strd/AddtlRmtInf` (mandatory).
  - **Cross-border euro payment (Croatian bank → EE IBAN):** "Koriste se ili nestrukturirani detalji plaćanja ili strukturirani detalji plaćanja. Nije dozvoljeno koristiti polje Dodatni detalji plaćanja (2.168)". `Ref` "može biti prema ISO 11649 (RF...) ili Vlastita oznaka". `EndToEndId` carries "referenca (poziv na broj HR, RF oznaka), vlastita oznaka ili NOTPROVIDED".
  - **Consequence (INFERRED):** a payment from a Croatian bank to Monerium most likely arrives with `Strd/CdtrRefInf/Ref = "HR00<ref>"` and **without the description**. Alternatively, if the app sends unstructured remittance, `Ustrd` holds some concatenation. The backend matcher should strip an `HR\d\d` prefix and hyphens, and look in Ref, Ustrd and E2E. For pan-EU robustness consider an **RF creditor reference (ISO 11649)**. HUB3 v6 has no defined way to carry RF in the 4-character model field, so it is only usable in EPC QR line 9 (structured reference).

## 4. Revolut, for comparison

| Item | Status | Source / quote |
|---|---|---|
| SEPA transfers free on Standard: "Free. This means payments in euros that are sent to an account outside your country but inside the Single Euro Payments Area" | VERIFIED | Revolut "Personal Fees (Standard)" en-HR, version applying from 9 July 2026 |
| Card top-up: "Stored card: free. However, if you add money with a card that has not been issued within the EEA … or … a commercial card then we may charge a small fee" | VERIFIED | same |
| Apple/Google Pay: "These same fees apply when adding money with Apple Pay or Google Pay. Fees apply for … Business and commercial cards; Cards issued outside the EEA or UK". "Your account's first card top-up will be free of charge, no matter the card type." | VERIFIED | help.revolut.com en-HR card-deposit-limits-and-fees |
| Top-up limits: "Up to 10,000 € … within 31 days with unverified cards; Up to 10 card top-ups within 24 hours; Digital wallet top-ups … limited to £12,000 … within 7 days; Up to £3,000 … within 24 hours for new customers"; annual limit across all methods | VERIFIED | same |
| SCT Inst: Revolut Bank UAB `RVUALT2VXXX` in SCT Inst register since 2022-03-07; VOP since 2025-08-24 | VERIFIED | EPC CSVs |
| EPC QR scanning (Payments → + → QR icon) | REPORTED (third-party guides). Also our own empirical finding that Revolut iOS scans our strict 10-line EPC QR (project memory). | comparateurbanque.com, elkqr.com |
| Croatian Revolut customers hold LT IBANs (no HR branch IBAN found) | REPORTED | search summary of court and transfer documents |

## 5. Apple Pay top-up economics

- **IFR caps (REPORTED via secondary legal summaries of Reg. 2015/751):** 0.2% for consumer debit and 0.3% for consumer credit interchange in the EEA. Commercial cards are exempt. That exemption is exactly why Revolut charges fees on commercial and non-EEA cards, whose interchange is uncapped.
- **Why "free" works (INFERRED):** an EEA consumer debit top-up costs the EMI roughly 0.2% IFR plus scheme and acquirer fees, on the order of a few tenths of a percent (estimate, not sourced). The EMI recovers this through float, card spend interchange, and **exit fees**. Aircash charges 1–2% to withdraw to an IBAN, 4% for cash at partners and 2% at PBZ ATMs, so "top up by card, cash out to IBAN" does not pay off. Free Scan&Pay is limited to bill payees in HR/SI/AT(/RO/SK), which keeps that leg from becoming a free card-to-any-IBAN cash-out.
- **Aircash Apple Pay / Google Pay (VERIFIED, fees page):** "Processing Instantly", "Fees None", "Limit per transaction 1000 EUR". Card top-up: 0 EUR, 1–700 EUR per transaction. From **1.10.2026** cash deposits above 100 EUR per month carry a monthly usage fee of EUR 3.00 for HR-verified users (VERIFIED). Card and Apple Pay are not listed as triggers. Aircash T&C §5.2/5.3 reserve unexplained limit management and account holds when "a deviation in the Account balance is noticed".
- **Scheme side (REPORTED):** Visa requires MCC 6540 (stored-value load) merchants to process pay-ins as Account Funding Transactions (AFT) via Visa Direct or Mastercard Send. Wallet loads are a distinct, monitored transaction class. Interchange on AFT/6540 in the EEA could not be verified (UNKNOWN). Public data on chargeback exposure was not found (UNKNOWN). Apple Pay tokens with SCA reduce fraud chargebacks but not "item not received" disputes.

## 6. Aircash paying to foreign IBANs, exchanges or Monerium

- No reports were found, in Croatian or English, of Aircash payments to Monerium, Bitstamp, Kraken or other exchanges, or of Aircash blocking crypto recipients (UNKNOWN).
- Aircash T&C has no explicit crypto clause (VERIFIED by full-text grep for crypto, kripto and virtual asset). Generic refusal grounds apply: §3.8 unlawful use, the refusal and AML clause, §11.2 "valid and legal payments", and §3.7 account "used solely for the User's personal needs". The structural block is the payee-IBAN country whitelist (section 1), not a crypto rule.

## Recommended empirical tests (cheap, decisive)

1. On an Aircash account, scan a HUB3 code with a Monerium `EE…` IBAN for 1 €. Does it refuse at scan time, refuse at confirm, or execute? If it executes, note the time to Monerium `processed` and what lands in `memo`.
2. Read the VBDI from the Aircash deposit IBAN in the app to identify its account bank.
3. Pay 0.01 € by EPC QR from Revolut to the tenant Monerium IBAN with different payee names ("ITalk d.o.o.", "Monerium EMI ehf.") and record the VoP result.
4. Scan the same HUB3 code with an EE IBAN in 2–3 Croatian bank apps to see whether the field is accepted. Then compare the remittance Monerium receives (`HR00…` in Ref vs. Ustrd).

## Sources

- Aircash wallet General T&C (current): https://aircash.eu/general-terms-and-conditions-aircash-wallet (§1.1, §3.7, §3.8, §5.2–5.3, §11.1–11.6, §13.1–13.6)
- Aircash fees (tables embedded in page JSON): https://aircash.eu/naknade/
- Aircash features / country lists: https://aircash.eu/aircash-features/ → https://aircash.eu/hub/aircash-features
- Aircash pay-bill help: https://aircash.eu/en-HR/support/pay-bill-aircash-app ; blog (2026-05-18): https://aircash.eu/en-HR/blog/paying-bills
- Aircash withdraw: https://aircash.eu/withdraw-money ; deposit: https://aircash.eu/en-HR/support/deposit-money-aircash-account
- AircashPay for webshops: https://aircash.eu/business/webshops
- BIC directory: https://ohmyfin.ai/swift-codes/AIDOHR22
- EPC Register of Participants (downloads): https://www.europeanpaymentscouncil.eu/what-we-do/participating-schemes/register-participants/registers-participants-sepa-payment-schemes ; CSVs: …/participants_export/sct_inst/sct_inst.csv, …/sct/sct.csv, …/vop/vop.csv
- Regulation (EU) 2024/886 (IPR): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R0886 (Art. 5a, 5b, 5c)
- ECB IPR page: https://www.ecb.europa.eu/paym/retail/instant_payments/html/instant_payments_regulation.en.html ; Osborne Clarke: https://www.osborneclarke.com/insights/what-are-key-obligations-and-timelines-eu-instant-payments-regulation
- HNB NKSInst announcement: https://www.hnb.hr/en/-/announcement-on-the-beginning-of-operation-of-the-nksinst-payment-system
- HUB3A PDF417 spec v6: https://www.hub.hr/sites/default/files/inline-files/2DBK_EUR_Uputa_1.pdf (older v5: https://www.hub.hr/sites/default/files/inline-files/2dbc_0.pdf)
- sepa.hr SCT Inst pain.001 guide (euro, from 01.01.2023): https://sepa.hr/wp-content/uploads/2022/05/SCTInst-Uputa-za-klijente-pain.001-euro_01.01.2023.pdf
- sepa.hr models overview: https://sepa.hr/wp-content/uploads/2018/07/Jedinstveni-pregled-osnovnih-modela-poziva-na-broj_4.8.2018.pdf
- Revolut Personal Fees (Standard), HR: https://www.revolut.com/en-HR/legal/standard-fees/
- Revolut card top-up limits and fees: https://help.revolut.com/en-HR/help/adding-money/card-deposit-limits-and-fees/
- IFR summaries: https://osborneclarke.com/insights/cap-on-eu-interchange-fees-new-regulation-published ; https://www.centralbankmalta.org/ifr
- Visa AFT / MCC 6540: https://developer.visaacceptance.com/docs/vas/en-us/payouts-aft/developer/ctv/rest/payouts-aft-dev/payouts-appendix-mapping.html
- Revolut EPC QR (third party): https://www.comparateurbanque.com/?p=169896 ; https://www.elkqr.com/kb/qr-code-types/epc-payment-qr
