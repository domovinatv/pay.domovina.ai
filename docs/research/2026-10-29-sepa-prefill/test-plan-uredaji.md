# Test plan na uređajima — SEPA prefill (2026-10-29)

Cilj: zatvoriti ⚠️ iz [01](01-strana-platitelja.md) pokusom, ne pretragom. Svaki test je
uplata od **0,01 €** (ili samo skeniranje do ekrana potvrde, bez slanja, gdje piše „do
potvrde“). Ne ponavljati pokuse koji su već gotovi: HUB3 s `EE…` (aircash/05, 11.10.) i
Revolut EPC format (~45 varijanti, energy §24).

## Generiranje kodova

```bash
npm i --no-save bwip-js          # jednom, u korijenu repoa (samo za PNG)
EE_IBAN=<tenant EE IBAN> HR_IBAN=<tenant HR IBAN> NAME="ITalk d.o.o." \
  OUT=~/Desktop/kodovi npx -y tsx docs/research/2026-10-29-sepa-prefill/gen-test-codes.ts
```

Skripta koristi rail buildere (`backend/src/intents/epc.ts`, `hub3.ts`), pa su kodovi
identični onima s checkouta. Za svaki kod piše `.txt` i `.png`. IBAN-i ne idu u git.
Prikazati na monitoru **bez LED treperenja** (ne pod reflektorom, energy §24) ili isprintati.

## Testovi

| ID | Kod | Pitanje | Uspjeh znači |
|---|---|---|---|
| **T1** | EPC QR, **HR** IBAN | Čita li HR bankovna aplikacija EPC (BCD) uopće? | HR banke mogu dobiti i EPC, pa jedan kod pokriva i Revolut i HR (uz HR IBAN) |
| **T2** | EPC QR, **EE** (Monerium) IBAN | Ako T1 prolazi: pušta li banka EPC s `EE…` (HUB3 s `EE…` ne pušta)? | **Najvažniji test.** Ako da, HR banke mogu plaćati izravno na Monerium bez HR IBAN-a |
| **T3** | HUB3 u **QR-u**, HR IBAN | Čitaju li HUB3 kao QR i druge osim RBA? | HUB3 QR umjesto PDF417 na uskom ekranu (ADR 0020 t. 2) |
| **T5** | `payto://iban/EE…?…` kao QR i kao link (AirDrop/iMessage sebi) | Otvara li išta na iOS-u `payto:`? | Ako ništa: `payto:` je mrtav za nas (očekivano) |
| **T6a / T6b** | EPC na `EE…` s imenom „ITalk d.o.o.“ / „Monerium EMI ehf.“ | Što VoP vraća za Monerium IBAN? | Utvrđujemo točno ime koje mora stajati u kodu; „no match“ na T6a = problem |
| **T7** | Bez koda: ručni unos u Revolut **nakon** skeniranja T2 | Može li se na brzom ekranu dodati opis (energy §14.4)? | Uputa „zalijepi opis prije potvrde“ |

Opcionalno, ako netko u blizini ima račun: **N26 / bunq / njemačka Sparkasse** s T2 (EPC na `EE…`).
Očekujemo prolaz (REPORTED u 01) i mjerimo zadržava li opis.

## Tablica rezultata

Upisati: ✅ prolazi do slanja · 🟡 čita, ali nešto fali (napisati što) · ❌ ne čita / odbija
(točna poruka) · — nije testirano. Za poslane uplate dodati: je li referenca stigla (rail log /
Monerium order `memo`) i vrijeme do `paid`.

| Aplikacija | T1 EPC HR | T2 EPC EE | T3 HUB3-QR HR | T5 payto | T6a VoP točno | T6b VoP krivo | Napomena |
|---|---|---|---|---|---|---|---|
| Revolut iOS | — | (poznato ✅) | — | — | — | — | |
| PBZ iOS | — | — | — | — | — | — | |
| HPB biz | — | — | — | — | — | — | |
| RBA biz | — | — | (poznato ✅) | — | — | — | |
| Aircash | (✅ čita?) | (poznato ❌) | — | — | — | — | |
| KEKS Pay | — | — | — | — | — | — | |
| Zaba / Erste George (ako je dostupno) | — | — | — | — | — | — | |

## Što s rezultatom

- **T2 prolazi u ijednoj HR banci** → EPC na Monerium postaje drugi kod na checkoutu za HR
  platitelje. Upisati u 01, matricu A i README. Tenant bez HR IBAN-a tada ne treba ADR 0020.
- **T2 pada svugdje** → potvrđeno je da HR banke trebaju HR IBAN (ADR 0020) ili PSD2 PIS
  (skica [ADR 0031](../../decisions/0031-psd2-pis-popunjen-nalog.md)).
- **T6a „no match“** → otvoriti s Moneriumom pitanje koje ime LHV vraća za tenantov IBAN, prije
  bilo kakvog širenja.
