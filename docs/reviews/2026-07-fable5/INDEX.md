# Fable 5 nezavisni review — pay.domovina.ai (2026-07-07)

Nezavisni review cijelog codebasea payment raila. Metoda: multi-agent
fan-out (13 finder agenata po podsustavima) → dedup → adversarial verify.
Svaki MONEY/SEC/BUG nalaz je traceovan protiv **stvarnog koda**, ne protiv
docs/komentara/ADR-ova.

> **Napomena o izvedbi.** Fan-out je pokrenut pod Fable 5. Zbog isteka
> kredita 4 od 13 finder agenata (`wallet-core-crypto`, `cross-money-flow`,
> `cross-duplication`, `cross-test-gap`) i cijeli automatski verify pass nisu
> dovršeni pod Fable 5. **Verifikaciju svih high-severity nalaza i pokrivanje
> nedovršenih scopeova ručno je dovršio Opus 4.8** čitanjem stvarnih fajlova
> (dokumentirano po nalazu). Coverage mapa dolje pošteno označava što je
> pod-pokriveno — vidi `wallet-core-crypto` (P) i preporuku F0 u
> `refactor-plan.md`.

## Ground checks (izvršeno, zeleno)

- `backend`: `vitest` **25/25 pass**, `tsc --noEmit` **čist**
- `wallet`: `tsc --noEmit` **čist**
- `flutter analyze`: **0 issues**

Nema tip-grešaka — svi nalazi su semantički.

## Brojevi po severityju (verificirano)

| Severity | Broj | Od toga CONFIRMED protiv koda |
|---|---|---|
| MONEY-BUG | 6 | 6 |
| SEC | 5 | 5 |
| BUG | 15 | 11 (4 medium-conf, treba Opus re-check) |
| RISK | 12 | 12 |
| REFACTOR | 4 | 4 |
| TEST-GAP | 4 (konsolidirano) | 4 |

Ukupno **46 konsolidiranih nalaza** (iz 68 sirovih; dedupliciralo se ~22).

## TOP-10 prioriteta (redoslijed za Opus 4.8)

1. **BW-01 [MONEY-BUG]** — Underpayment/overpayment označava intent
   `paid` bez usporedbe primljenog i očekivanog iznosa. Merchant dobije
   "plaćeno" za manje novca nego što je tražio. *(shema `0007` čak komentira
   "actual may differ from intent", ali kod nikad ne usporedi.)*
2. **BW-02 / WR-01 [MONEY-BUG]** — Dvostruki forward / nonce-race. Backend
   `maybeForward` je check-then-act bez atomskog zasuna (samo ne-unique
   indeks na `order_id`), a i backend forward EOA i wallet relayer EOA nemaju
   nonce serijalizaciju → dva paralelna zahtjeva ili dupliciraju transfer ili
   jedan tiho nestane (intent nikad ne flipa u `paid`).
3. **BW-03 [MONEY-BUG]** — Webhook-id dedup označava event obrađenim PRIJE
   nego što je forward trajno izvršen; failed/evictani forward na jedinoj
   obrađenoj dostavi nikad se ne retry-a (cron reconcile pokriva samo
   `submitted`, ne `failed`/nepostojeće).
4. **BW-04 [MONEY-BUG]** — Neuspjeli broadcast (`result.ok === false`) se
   nikad automatski ne retry-a; EURe trajno parkiran u Safe-u nakon jednog
   RPC hiccupa.
5. **BW-05 / DB-03 [SEC]** — Javni neautenticirani read endpointi cure PII
   platitelja (IBAN, ime, memo, cijeli `raw_json` Monerium ordera) + sve
   bankovne transakcije: `/api/monerium/orders(/:id)`, `/api/hpb/accounts`,
   `/api/hpb/transactions`.
6. **WP-01 / WP-02 [SEC]** — `syncAccountsWithBackend` / `ensureRecoveryOwner`
   trustaju backendov `recovery_owner` bez lokalne verifikacije → injektiran
   račun s napadačevim recovery ownerom postaje drainable; poison seeda buduće
   derived račune. Dotiče self-custody invarijantu (ADR 0001) — visok prioritet.
7. **BW-02 supplement / CT-01 [SEC-latent]** — safe-tx batch `005` daje
   delegatecall na MultiSend BEZ Roles transaction-unwrappera → ruši
   "EURe.transfer only" ograničenje role (latentno: registry put još nije live).
8. **WR-02 [RISK/MONEY-latent]** — Cold-path FALLBACK grana relayera (hot
   pao, `safeNow=false`) redeploya Safe BEZ CREATE2 consistency guarda koji
   primarna grana ima → moguć stranding na RPC deployed→undeployed flipu.
9. **FL-01 [MONEY-BUG (POS)]** — `sid` se ne rotira nakon završenog plaćanja;
   POS mod prikaže lažni "Primljeno ✓" za novu prodaju (matcha stari `paid`
   intent).
10. **XD-01 + XD-02 [RISK/TEST-GAP]** — (a) dvije nezavisne CREATE2
    implementacije (klijent Safe protocol-kit vs relayer hardkodirani
    init-code-hash) bez parity testa; (b) jedan hardkodirani
    `rpc.gnosischain.com` bez fallbacka na CIJELOM on-chain putu (backend +
    wallet) — SPOF na svaki settle/read/broadcast.

## Coverage mapa (podsustav × dimenzija)

Legenda: ✓ pregledano i verificirano · P pod-pokriveno (finder pao, djelomično
pokrio Opus) · − izvan opsega/nije primjenjivo

| Podsustav | MONEY | SEC | BUG | RISK | REFACTOR | TEST-GAP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Backend intents/settle | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Backend Monerium/webhook | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Backend router/contracts | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Backend admin/checkout/proxy | ✓ | ✓ | ✓ | ✓ | − | ✓ |
| D1 shema | ✓ | ✓ | ✓ | ✓ | − | ✓ |
| Wallet PWA state/storage | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Wallet PWA rute/embed/SDK | ✓ | ✓ | ✓ | ✓ | − | ✓ |
| Wallet PWA crypto (passkey/webauthn/bootstrap/recover) | P | P | P | P | − | P |
| Wallet relayer (functions) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Flutter app | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Skripte (safe-tx, scripts) | ✓ | ✓ | − | ✓ | ✓ | − |

**Poštena rupa:** `wallet-core-crypto` (passkey.ts, bootstrap.ts, recover.ts,
paperWallet.ts, safeOwners.ts, activate.ts, eip681.ts u cijelosti) NIJE dobio
namjenski finder pass. Opus je verificirao `webauthnSig.ts` (ispravan — vidi
GOOD) i `wallet/functions/_lib/safe.ts` + `relay.ts` (crypto pipeline
relayera), ali passkey kreiranje/recovery/paper-wallet seed pathovi imaju samo
posrednu pokrivenost preko `wallet-state-storage` i `wallet-routes-ui`.
**Preporuka: F0 — namjenski review-only pass tog scopea prije F1** (vidi
`refactor-plan.md`).

## Dokumenti

- `backend-worker.md` — BW-*, CT-* (intents, Monerium, router, admin, checkout, proxy)
- `db-schema-and-contracts.md` — DB-*, CT-* (D1 shema, PaymentRegistry, safe-tx role setup)
- `wallet-pwa.md` — WP-* (state, storage, rute, embed/SDK)
- `wallet-relayer.md` — WR-* (functions gas-spending površina)
- `flutter-app.md` — FL-* (QR/EPC/HUB3, POS, polling)
- `cross-cutting.md` — XD-* (duplikacija, RPC SPOF, CREATE2 parity)
- `refactor-plan.md` — **glavni deliverable za Opus 4.8**: faze F0–F3
- `unverified.md` — plauzibilno-ali-neverificirano + nedovršeni finder scope

## Što je DOBRO (NE "popravljati")

- **Settle single-fire arhitektura** (`intents/confirm.ts`): tri nezavisna
  puta (waitUntil poll / cron reconcile / read path) svi funneliraju kroz
  atomski `submitted→confirmed` flip `confirmForwardOnce`. Dependency-injected,
  unit-testabilno bez D1/RPC. Ovo je čist, dobro promišljen dizajn.
- **`markIntentPaid` atomski conditional UPDATE** (`WHERE state='pending'`):
  ispravan idempotent single-fire; expired intent se nikad ne uskrsava.
- **`webauthnSig.ts`**: ispravna low-s normalizacija (P-256 malleability),
  stroga byte-for-byte clientDataFields rekonstrukcija (fail-safe throw na
  ne-kanonski redoslijed), točan Safe contract-signature layout.
- **`relay.ts` pre-flight `getCode` + primarni cold-path CREATE2 guard**:
  ispravno sprječava empty-address silent-success stranding (empirijski
  izborena invarijanta). Jedini nedostatak je fallback grana (WR-02).
- **`wallet/functions/_lib/safe.ts`**: konsolidacija CREATE2-kritičnih
  konstanti u jedan single-source-of-truth (prije su bile ručno sinkronizirane
  kopije). Ispravan potez — treba samo parity test s klijentom (XD-01).
- **`eurToWei`**: string-split izbjegava floating point za wei konverziju.
- **`amount_cents INTEGER`** kolone: novac se u D1 drži kao integer minor units,
  ne REAL — nema floating-point akumulacije.
- **Standard Webhooks HMAC verify**: timing-safe usporedba + podrška rotaciji
  ključa (v1 tokeni). Solidno.
