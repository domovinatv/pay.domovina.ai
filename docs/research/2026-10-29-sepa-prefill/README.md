# SEPA (Instant) prefill i izvori dojave uplate: što stvarno radi (2026-10-29)

Istraživanje, bez koda. Pitanje: tko platitelju popuni SEPA nalog bez tipkanja (barkod, link,
shema) i tko primatelju javi „uplata stigla“ osim Moneriuma. Svaka tvrdnja ima izvor i datum u
prilozima. ⚠️ = neprovjereno.

| Datoteka | Sadržaj |
|---|---|
| [01-strana-platitelja.md](01-strana-platitelja.md) | Matrica A: EPC QR / HUB3 / ne-HR IBAN / referenca / instant po aplikaciji; `payto:`, Wero, SRTP, PSD2 PIS, VoP |
| [02-strana-primatelja.md](02-strana-primatelja.md) | Matrica B: Monerium, Wise, Revolut Business, bunq, Swan, Stripe, AIS, bank-push-gateway; virtualni IBAN po intentu |
| [test-plan-uredaji.md](test-plan-uredaji.md) | Testovi T1–T7 za vlasnikove aplikacije + tablica rezultata |
| [gen-test-codes.ts](gen-test-codes.ts) | Generator testnih kodova iz rail buildera (`epc.ts`, `hub3.ts`) |
| [ADR 0031](../../decisions/0031-psd2-pis-popunjen-nalog.md) | Skica: PSD2 PIS preko Enable Bankinga (Proposed) |

## Zaključak

„Drugi su to riješili“ vrijedi **unutar jedne države**: GiroCode u DE/AT, EPC QR u BE/NL/FI,
UPN QR u SI, HUB3 u HR, Swiss QR u CH. Svaka domaća shema radi s **domaćim** IBAN-om
primatelja. Prekogranični prefill na `EE…` IBAN iz hrvatske banke nitko nije javno riješio
barkodom ni linkom. Od svih nađenih mehanizama samo PSD2 PIS zaobilazi to ograničenje.

### Matrica A — platitelj (skraćeno, puna u 01)

| | EPC QR | HUB3 | `EE…` primatelj | Referenca | Instant |
|---|---|---|---|---|---|
| Revolut | ✅ | ❌ | ✅ | ⚠️ ispušta | ✅ |
| PBZ / HPB / RBA | ⚠️ **T1** | ✅ (RBA i QR) | ❌ s HUB3; ⚠️ s EPC (**T2**) | ✅ | ⚠️ |
| Aircash | ✅ čita | ✅ | ❌ | ✅ | ❌ batch |
| Zaba, Erste, OTP, KEKS Pay | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| N26, bunq, BE/NL/DE/AT banke | ✅ (REPORTED / N26 VERIFIED) | ❌ | ✅ | ⚠️ | ⚠️ |
| `payto:` | — | — | po specifikaciji ✅ | ✅ | — | 
| **PSD2 PIS** (Enable Banking: Zaba, PBZ, Erste, RBA) | n/a, nalog dolazi popunjen | | ⚠️ pitanje beneficiara | ✅ | ⚠️ |
| Wero / SRTP | nije u HR | | | | |

`payto:`: nijedna bankovna aplikacija nije nađena (test T5).

### Matrica B — primatelj (skraćeno, puna u 02)

| | Vrsta | Kašnjenje | Identitet bez reference | HR IBAN | Novac drži |
|---|---|---|---|---|---|
| Monerium | webhook | sekunde (+ screening prve uplate) | ❌ (ADR 0018/0028 rezerve) | ❌ `EE` | tenant |
| Wise / Revolut Business / bunq | webhook | sekunde–minute | ❌ | ❌ | tenant |
| **Swan / Stripe vIBAN po intentu** | webhook | ⚠️ | ✅ **odredište = identitet** | ❌ | tenant (ako je račun njegov) |
| AIS (Enable Banking) | polling | sati | ❌ | ✅ | tenant |
| bank-push-gateway | push → webhook | sekunde | ❌ (poziv na broj ⚠️ po banci) | ✅ | tenant |

## Što isprobati prvo

1. **Test T2** ([test-plan](test-plan-uredaji.md)): EPC QR na Monerium `EE…` u PBZ, HPB i
   RBA. Košta 5 minuta, a mijenja cijelu sliku. Ako ijedna HR banka pusti EPC na `EE…`, HR
   platitelji imaju prefill **bez** HR IBAN-a i bez PIS-a.
2. **Test T6** (VoP, 0,01 €): utvrditi ime koje LHV vraća za tenantov Monerium IBAN. Ono mora
   stajati u svakom kodu.
3. **Mail Enable Bankingu** s pet pitanja iz ADR 0031 (PIS na našoj aplikaciji, `EE…`
   beneficiar, SCT Inst, remittance, cijena). Nema troška, a otključava ili zatvara jedini
   prekogranični put.
4. Tek nakon 1–3: odluka između **ADR 0031** (PIS) i **ADR 0020** (HR IBAN + gateway) za HR
   platitelje. Virtualni IBAN po intentu (Swan/Stripe) držati kao opciju za Mod 2 tenante koji
   primaju od Revolut/EU platitelja i ne trebaju EURe.

## Usput nađeno

- **ADR 0020 t. 4.3** predlaže „jedinstveni iznos po otvorenom intentu (1,00 / 1,01 / 1,02 €)“.
  To krši pravilo od 19. 10. 2026. (CLAUDE.md: iznos nikad ne nosi identitet). Treba ga izbaciti
  prije nego se ADR 0020 prihvati.
- GoCardless Bank Account Data navodno ne prima nove integracije (REPORTED ⚠️). Enable Banking
  ostaje jedini AIS/PIS pružatelj koji već imamo.
- Wise `balances#credit` je deprecated, zamjena je `balances#update`.
