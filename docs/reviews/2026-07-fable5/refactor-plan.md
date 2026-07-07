# Refactor plan za Opus 4.8

Glavni deliverable. Faze po prioritetu. Svaka stavka referencira nalaze po ID-u,
ima procjenu opsega (S/M/L), ovisnosti, i eksplicitna "NE DIRAJ" upozorenja gdje
su relevantna. Svaka stavka je pisana da se može dati Opusu kao **samostalan
zadatak**.

## Legenda opsega
- **S** = ≤ pola dana, lokalizirano, jasan test.
- **M** = 1–2 dana, dira više fileova ili traži migraciju.
- **L** = > 2 dana, arhitektonski (DO, RPC failover, nonce infra).

## NE DIRAJ (iz handoff §5 — fix koji ovo mijenja je regresija)
- EPC 10-linijski layout / HUB3 14 polja (FL-02/04 diraju **duljinu/validaciju**,
  NE layout).
- Monerium forward gating `issue && order.updated && state='processed'`.
- Settle single-fire: atomski `confirmForwardOnce` + `markIntentPaid`
  `WHERE state='pending'`. BW-01 DODAJE amount-provjeru NA taj guard, ne mijenja
  ga. BW-03 ne dira flip nego dedup-ordering oko njega.
- sid multi-forme parsiranje (`=`→`.` itd.).
- Checkout `jsonForScript()` escape.
- Relay pre-flight `getCode(safe)` OBAVEZAN (WR-02 DODAJE guard na fallback, ne
  uklanja pre-flight).
- Wallet nikad ne briše passkeye; server-side recovery TRAJNO odbijen (ADR 0001).
- Passkey dedup: get-first probe + excludeCredentials (NE stabilni user.id).

---

## F0 — Pokrij slijepu točku PRIJE fixova (blokira F1 na wallet crypto)

**F0-1 [M] Review-only pass `wallet-core-crypto` scopea.**
Nalazi: (nedovršeni finder — `unverified.md`). Pročitati u cijelosti
`passkey.ts`, `bootstrap.ts`, `recover.ts`, `paperWallet.ts`, `safeOwners.ts`,
`activate.ts`, `eip681.ts` s MONEY/SEC lećom; verificirati passkey-dedup i
bootstrap-atomic-swap invarijante; dopuniti `wallet-pwa.md` novim nalazima.
**Ovisnost:** nema; radi PRVO. **Zašto blokira:** F1 fixovi na `accounts.ts`
(WP-01/02) diraju iste putove; ne fixati naslijepo.

**F0-2 [S] Re-verify neverificiranih nalaza** iz `unverified.md` tablice
(WP-01/02/03/06, BW-08/11, XD-03, CT-01) čitanjem stvarnih fajlova. Potvrdi ili
obori svaki PRIJE nego uđe u F1/F2.

---

## F1 — MONEY-BUG + SEC (odmah, prije bilo kojeg deploya novih feature-a)

**F1-1 [S] Amount rekoncilijacija na paid flip.** Nalazi: **BW-01, DB-02**.
U `markIntentPaid`/`flipPaidAndNotify` usporediti `amount_received_cents` s
`amount_cents`; definirati underpay/overpay ponašanje (preporuka: ne slati golo
"paid" — webhook uvijek nosi `{expected, received}`). **NE DIRAJ** atomicnost
`WHERE state='pending'` — samo dodaj provjeru iznosa.
*Acceptance:* test €50 očekivano / €30 primljeno → nije tiho `paid`.

**F1-2 [M] Idempotentan forward (backend + wallet).** Nalazi: **BW-02, DB-01,
WR-01**. (a) Backend: `UNIQUE(order_id, target_address)` migracija +
`INSERT…ON CONFLICT DO NOTHING` guard prije `forwardViaSafe`. (b) Serijalizirati
forward EOA nonce (backend router) i relayer EOA nonce (wallet) — nonce manager
ili per-EOA lock. **Ovisnost:** (b) idealno L-scope DO (vidi F2-4), ali minimalni
S-fix je `viem nonceManager` + kratki mutex. *Acceptance:* dvije istovremene
`maybeForward`/`/api/relay` → točno jedan broadcast; load test bez replace-anih
txova.

**F1-3 [M] Forward retry + dedup-ordering popravak.** Nalazi: **BW-03, BW-04**.
(a) Ne markirati `webhook-id` obrađenim dok forward nije `submitted`; (b) cron
reconcile proširiti da pokupi `failed`/stale `pending` forwardove uz
`attempts`-backoff i alert nakon max. **NE DIRAJ** forward gating uvjet.
*Acceptance:* forward failed na jedinoj dostavi → cron ga retry-a; nakon max →
alert, ne tihi gubitak.

**F1-4 [S] Zaključaj javne PII endpointe.** Nalazi: **BW-05, DB-03**. Staviti
`/api/monerium/orders(/:id)`, `/api/hpb/accounts`, `/api/hpb/transactions` iza
`bearerAuth` ili per-sid scoping; checkout migrirati na scoped read.
*Acceptance:* neautenticiran curl → 401; checkout i dalje radi.

**F1-5 [S] CREATE2 guard na relay fallback grani.** Nalaz: **WR-02**. Izvući
predict-guard u helper, pozvati ga i u hot-failed→cold grani kad `skipSafe=false`.
**NE DIRAJ** pre-flight `getCode`. *Acceptance:* hot-failed + `safeNow=false` +
mismatch → 400, nema deploya.

**F1-6 [S] Self-custody: ne trustaj backend recovery-owner/account.** Nalazi:
**WP-01, WP-02** (nakon F0 re-verify). Prihvatiti backend račun/recovery-owner
samo ako se poklapa s lokalno izvedenom vrijednošću (client predict); inače
read-only/odbijeno. **Dira ADR 0001** — pažljivo. *Acceptance:* backend vrati
nepoznat signer/owner → ne postaje spendable / ne mijenja identitet.

**F1-7 [S] GP proxy iza autha.** Nalaz: **BW-06**. `bearerAuth`/Turnstile +
allowlist putanja umjesto `/*`. *Acceptance:* neautenticiran `/api/gp-proxy` →
401 kad je GP omogućen.

**F1-8 [S] Timing-safe secret usporedbe.** Nalaz: **BW-07**. Zamijeniti
`key !== secret` s `timingSafeEqualString` (već postoji) na `/api/onchain/scan`
i `/api/og-preview`. *Acceptance:* grep bez `!== secret`.

**F1-9 [S] POS sid rotacija.** Nalaz: **FL-01**. Rotirati `sid`+intent na svaku
novu prodaju. *Acceptance:* nova prodaja = novi `sid`, status `pending`.

---

## F2 — BUG + RISK (nakon F1)

**F2-1 [S] Amount/format validacija (Flutter + wallet).** Nalazi: **FL-04, FL-05,
FL-06, FL-02, WP-05**. hr-locale parser, odbij ≤0, FINA duljine polja, `sid`
validacija protiv dijeljenog `SID_RE`, `tokenDecimals` guard, Receive iznos u
centima. **NE DIRAJ** EPC/HUB3 layout. *Acceptance:* amount test matrica zelena;
HUB3 poštuje FINA duljine.

**F2-2 [S] Currency + state + ADDR_RE guardovi (backend).** Nalazi: **BW-08,
BW-12, BW-09**. `&& currency==='eur'` u gate; jedan `resolveOrderState` helper
(uklj. meta fallback) na oba mjesta; `ADDR_RE` granica.
*Acceptance:* testovi po nalazu.

**F2-3 [S] Error-swallowing → vidljivo stanje.** Nalazi: **FL-03, FL-07, FL-08,
CT-03, WR-04, WR-05**. tokenBalance propagira grešku; POS poll offline indikator;
Blockscout paginacija; `getForwardStatus` razlikuje unknown/RPC; `readCount`
finite-guard; relay pre-flight u try/catch. *Acceptance:* po nalazu.

**F2-4 [L] Atomski gas capovi + nonce infra (Durable Object).** Nalazi: **WR-03,
WR-01 (robusna verzija), BW-02(b)**. DO za global gas counter i/ili relayer nonce
serijalizaciju. Referencira `docs/security/relayer-threat-model.md`.
*Acceptance:* burst load ne prekoračuje global cap × concurrency.

**F2-5 [M] RPC failover wrapper.** Nalaz: **XD-02**. `viem fallback([...])`
dijeljen backend + wallet; ≥1 pouzdan endpoint uz javni. *Acceptance:* ubij
primarni RPC → sve on-chain operacije rade preko fallbacka.

**F2-6 [S] Ostali RISK-ovi.** Nalazi: **BW-13** (webhook body cap prije upisa),
**BW-14** (timestamp tolerancija), **WP-07** (Send idempotency key), **WP-08**
(/recover ne pre-fila sweep URL), **WP-09** (Embed threshold guard), **WP-11**
(GP fund gate enforce ili ukloni lažni komentar), **WR-06** (Turnstile
observability/fail-closed opcija), **WP-10** (SDK connect/createAccount split),
**WP-04** (setIdentity čisti balance).

---

## F3 — REFACTOR + TEST-GAP (kad F1/F2 slegnu)

**F3-1 [M] Test paket za MONEY/SEC površinu.** Nalazi: svi **TEST-GAP** +
**XD-01**. Prioritet (najviše lovi):
1. `markIntentPaid` amount rekoncilijacija (F1-1 regression guard).
2. Forward idempotencija: dvije istovremene dostave → jedan broadcast (F1-2).
3. Webhook signature verify (valid/invalid/rotated/timestamp).
4. `webhook-id` idempotencija + failed-forward retry (F1-3).
5. **CREATE2 parity**: `clientPredict === relayerPredict` (XD-01) — matrica
   1-owner/2-owner/campaign-salt.
6. `sid`/routing parser sve accept-forme + ADDR_RE granica.
7. `eurToWei` rubni iznosi.
8. Relayer limits atomicnost + hot/cold odluka (`relay.ts`).
9. Flutter: EPC/HUB3 amount+duljine, intent polling, POS state machine.
*Acceptance:* svaki F1 fix ima pripadajući regression test; CI zelen.

**F3-2 [M] Konsolidacija duplikacije.** Nalazi: **XD-03, XD-04, WP-12,
FL-REFACTOR**. IBAN validacija+jedan izvor, hmac/decodeSecret util, `BankingClient`
base, `balance.ts`/`balances.ts` merge (+ trunkacija), block-explorer helper,
Flutter BigInt→double util. Čisto altitude; bez ponašajnih promjena (testovi iz
F3-1 čuvaju).

---

## Redoslijed ovisnosti (sažeto)

```
F0-1, F0-2  ─┬─►  F1-6 (wallet self-custody)
             └─►  (potvrda WP/BW/CT/XD neverificiranih)
F1-1 ─► F3-1(#1)
F1-2 ─┬─► F2-4 (DO robusna verzija)     F3-1(#2,#8)
F1-3 ─┴─► F3-1(#4)
F1-4, F1-5, F1-7, F1-8, F1-9  (nezavisni S)
F2-5 (RPC failover)  smanjuje okidače za BW-03/BW-04/WR-07 — poželjno rano
XD-01 parity test  → F3-1(#5), neovisan, može odmah
```

## Preporučeni prvi 5 zadataka za Opus (max ROI / min rizik)
1. **F1-1** (underpayment paid) — najizravniji "lažno plaćeno" put, S, izoliran.
2. **F1-4** (PII endpointi) — SEC, S, jasan.
3. **F1-2(a)** (UNIQUE + ON CONFLICT na forwards) — MONEY, S dio prije nonce L.
4. **F1-5** (relay fallback CREATE2 guard) — MONEY-latent, S, jasan test.
5. **XD-01** (CREATE2 parity test) — nema koda za mijenjati, samo test koji
   trajno štiti od najskupljeg (stranding) buga; može paralelno.
