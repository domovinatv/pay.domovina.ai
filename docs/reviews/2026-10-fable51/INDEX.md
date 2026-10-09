# Fable 5.1 nezavisni review — pay.domovina.ai (2026-10-02)

Drugi nezavisni prolaz kroz cijeli codebase, na HEAD `4b39998`. Nastavlja se na
`docs/reviews/2026-07-fable5/` (srpanj) i `2026-09-webhook-events-review.md`
(rujan). Metoda: backend money rail pročitan **u cijelosti ručno** (Fable 5.1);
wallet crypto/relayer i wallet UI + Flutter kroz dva namjenska finder prolaza,
svaki nad cijelim fajlovima, s file:line za svaku tvrdnju. Nijedan nalaz nije
preuzet iz dokumentacije ili memorije bez provjere u kodu.

Deliverable za Opus 5.5 je **`implementation-plan.md`**. Ovaj INDEX je karta.

> **Nastavak (2026-10-09):** `../2026-10-fable51-r2/` pregledava što je Opus
> napravio nakon ovog reviewa (ADR 0017/0018/0019 f0, admin prijava, Shopify) i
> nosi stanje svih P0/P1 odavde (§C u `rail-multi-tenant-stray.md`).

## Ground checks (izvršeno 2026-10-02, zeleno)

| Provjera | Rezultat |
|---|---|
| `backend`: `vitest run` | **124/124 pass** (9 fajlova) |
| `backend`: `tsc --noEmit` | čist |
| `wallet`: `tsc --noEmit` | čist |
| `flutter analyze` | 0 issues |
| CREATE2 parity relayer ↔ klijent (XD-01) | **empirijski potvrđeno** uživo protiv Gnosis RPC-a (init-code-hash i 2-owner predikcija se poklapaju s protocol-kit 7.1.0) — ali test i dalje ne postoji |

Nema tip-grešaka; svi nalazi su semantički.

## Što se promijenilo od srpnja

- **Backend** (28 commita): tenant payout whitelist (ADR 0016), Telegram alerting,
  outbox + lifecycle eventi, monotoni upsert ordera, Monerium reconcile cron,
  checkout „uspjeh na received". Riješeno iz srpnja: BW-03, BW-09, XD-03, rujanski
  A1–A5/B1–B3/D1. **Otvoreno i dalje: BW-01, BW-02, BW-04 (retry), BW-05, BW-06,
  BW-07, BW-08, BW-11, BW-12 (pola), BW-13, BW-14, CT-01, CT-03, XD-02.**
- **Wallet**: `git diff 017c99e..HEAD -- wallet` je **prazan**. Svi WP-*/WR-* nalazi
  iz srpnja su otvoreni; srpanjska rupa „wallet-core-crypto" (F0) je ovim
  reviewom zatvorena i dala je 14 novih nalaza (WC-01..14).
- **Flutter**: samo `payment_status.dart` + `payment_status_page.dart` (POS zelen
  na received) — što je donijelo 3 nova nalaza o istinitosti POS-a.

## Brojevi

| Severity | Srpanj (otvoreno) | Novo (listopad) | Ukupno otvoreno |
|---|---|---|---|
| MONEY-BUG | 5 (BW-01, BW-02, BW-04, DB-01, FL-01) | 4 (WC-01, WC-02, FL-N-01, BW-15*) | 9 |
| SEC | 7 (BW-05, BW-06, BW-07, WP-01, WP-02, CT-01, DB-03) | 5 (BW-18, BW-19, WC-03, WU-01, BW-22*) | 12 |
| BUG | ~12 | 9 (BW-16†, BW-20, BW-23, FL-N-03, WC-05, WC-06, WC-07, WC-09, BW-27) | ~21 |
| RISK | ~10 | 14 | ~24 |
| TEST-GAP | 4 | 3 (WC-14, FL-N-05, WU-07) | 7 |

\* BW-15 je BUG po mehanizmu, ali mijenja što merchant dobije (`paid` vs `late`) — MONEY-semantika. BW-22 je RISK koji postaje SEC pod opterećenjem.
† BW-16 je MONEY-RISK: novac ne nestaje, ali zaglavi bez alarma.

Novih nalaza ukupno **35** (BW-15..28, DB-04, WC-01..14, WU-01..07, FL-N-01..05).

## TOP-10 (redoslijed za Opus 5.5)

1. **BW-01 / DB-02 [MONEY]** — underpayment flipa `paid`. I dalje otvoreno od srpnja; `intents/db.ts:76-108`. *Plan P0-1.*
2. **WC-01 + BW-18 [SEC/MONEY]** — javni `POST /api/wallets/:cred/accounts` + klijent koji slijepo persistira → napadač podmetne „račun" na koji žrtva primi uplatu. `credential_id` je javan preko `/family`. *Plan P0-3 (server) + P1-5 (klijent).*
3. **WC-02 [SEC/MONEY]** — neautenticirani backfill `recovery_owner` + klijent ga upisuje u identitet → napadač su-vlasnik svih budućih derived računa i GP Safea. *P0-3 + P1-5.*
4. **WU-01 [SEC]** — `/embed` potvrda + Face ID gumb su clickjackable (`frame-ancestors *`); iznos koji korisnik vidi nije ono što potpisuje. *P0-4.*
5. **DB-04 / BW-02 [MONEY]** — i dalje nema atomskog zasuna na `monerium_forwards`; nonce bez serijalizacije. *P0-2.*
6. **BW-15 [MONEY-semantika]** — istek intenta se materijalizira samo 6-satnim cronom; `paid` vs `late` ovisi o cronu; checkout stoji na „istječe za 0:00" do 6 h. *P0-7.*
7. **BW-16 + BW-17 [MONEY-RISK/OPS]** — dropped tx ostaje `submitted` zauvijek bez alarma i gladuje reconcile red; nema admin retryja forwarda; alarm „order bez forwarda" šalje se u točno jednom 10-min prozoru. *P1-1 + P0-6.*
8. **BW-05 / BW-07 / BW-06 [SEC]** — PII rute, timing-usporedba tajne, GP open proxy: sve otvoreno od srpnja, sve S. *P0-5.*
9. **FL-N-01 / FL-N-02 / FL-N-03 [MONEY/UX]** — POS kiosk može trajno ostati zelen na kasni odgovor; zelen i tijekom Monerium screeninga koji može završiti odbijanjem; zelen kad je forward `failed`/`blocked` i trgovac novac nije dobio. *P1-2.*
10. **WC-04 [RISK]** — relayer hot path prihvaća bilo koju adresu s kodom i ne kapira gas → dnevni budget relayera se može spaliti u jednom danu. *P1-8.*

## Dokumenti

- `backend-money-rail.md` — stanje svih srpanjskih BW/DB/CT/XD nalaza + novi BW-15..28, DB-04.
- `wallet-crypto-relayer.md` — F0 pass: WC-01..14, stanje WP-01/02 i WR-01..08, empirijska CREATE2 parity provjera.
- `wallet-ui-flutter.md` — WU-01..07, FL-N-01..05, stanje WP-03..12 i FL-01..08.
- `implementation-plan.md` — **glavni deliverable**: P0/P1/P2 zadaci, svaki samostalan, s testom i „NE DIRAJ".

## Pitanja za Matiju (ne blokiraju P0, ali određuju detalje)

1. **Grace nakon isteka** (BW-15): uplata koja stigne nakon `expires_at` — uvijek `late` (preporuka) ili `paid` unutar N minuta?
2. **Underpayment ponašanje** (BW-01): preporuka je novi event `payment.underpaid` + intent ostaje `pending` dok merchant ne odluči. Alternativa: `paid` s `amount_mismatch` flagom. Treba potvrda što pinka može konzumirati.
3. **`/embed` arhitektura** (WU-01): popup `/confirm` (robusno, dira SDK UX) ili minimum (arm-delay + busy + visibility)?
4. **safe-tx/006** on-chain kapica po transferu: potpisati ili ne (P2-5).
5. **Monerium `/orders` paginacija** (BW-28): netko s pristupom lokalnim Monerium docs treba potvrditi.

## Što je DOBRO (ne „popravljati")

- Settle single-fire (`confirmForwardOnce` + `markIntentPaid WHERE pending`) — i dalje ispravno; svi novi fixovi idu **oko** njega.
- Outbox: PK = webhook-id, klasifikacija, backoff, parkiranje in-flight pokušaja, potpis pri slanju.
- Monotoni upsert ordera sa SQL rankom; jednak rank se primjenjuje (važno za kasni webhook).
- `authorizeForward` kao jedina točka odluke, s potpunom test matricom park razloga.
- CREATE2 parity relayer ↔ klijent (empirijski), `webauthnSig.ts`, `recover.ts` pubkey recovery, mnemonic koji nikad ne napušta memoriju, dedup po ADR-u, nema brisanja passkeya, 'swap' 1/1 mod nedostupan iz UI-ja.
- Embed/SDK origin model (pinned origin, single-use `dw_state`, allowlist povratka) — problem je clickjacking, ne origin.
- `jsonForScript`, `escapeAttr`, admin `escapeHtml` dosljedno.
- Alert-test endpoint i fail-open alerting s eksplicitnim `configured/ok`.
- Tenant ključ iskreno dokumentiran kao identifikator, ne autentikacija.

## Napomene o memoriji (za Matiju)

- Memorija `project_multi_passkey_safe_shipped` spominje cross-TLD N-to-N peer linking (iframe + Safari redirect); finder je grepao `wallet/src` i **nije našao** taj kod na `main` — ili je na grani ili je uklonjen. Ažurirati memoriju nakon provjere.
- Memorija `project_relayer_abuse_defense_shipped` kaže „per-IP+global gas caps" — stvarno su to **brojači poziva**, ne gasa (WC-04).
