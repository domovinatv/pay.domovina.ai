# HANDOFF — Fable 5 nezavisni review CIJELOG codebasea + refactor plan

_Pokreni u zasebnoj Claude Code sesiji s modelom **Fable 5**. Kontekst: sve
dosad je implementirano s Opus 4.8 (brzo i dobro), ali želim da jači model
neovisno prođe SVE implementacije. Output je REVIEW + PLAN u repou — **ne
refactor**. Popravke će naknadno raditi Opus 4.8 po tom planu._

**Smiješ koristiti multi-agent workflow orkestraciju** (fan-out po
podsustavima, adversarial verify svakog nalaza) — želim iscrpnost, ne brzinu.

---

## 0. Prvo: git worktree (OBAVEZNO — projektno pravilo)

```bash
git worktree add ../pay.domovina-fable5-review review/fable5-codebase
cd ../pay.domovina-fable5-review
```

## 1. Cilj

Nezavisan, temeljit review svakog podsustava: korektnost, sigurnost (ovo je
**payment rail — pravi novac se kreće**), race/idempotencija, Workers
ograničenja, arhitektura, dupliciranje, test coverage. Rezultat su dokumenti
u `docs/reviews/2026-07-fable5/` koje Opus 4.8 može konzumirati stavku po
stavku.

**NEZAVISNO znači:** ne vjeruj komentarima, docs tvrdnjama ni ADR-ovima —
verificiraj ih protiv koda. Postojeći docs su pisani od modela koji je pisao
i kod; dijele iste slijepe točke. Nalaz iz docs ≠ nalaz iz koda.

## 2. Opseg (mapiraj sam, ali minimalno OVO)

| Podsustav | Gdje | Fokus |
|---|---|---|
| Backend Worker | `backend/src/` (Hono + D1 + KV) | webhook sigurnost/idempotencija, intents/settle/stage, router/safe.ts (Zodiac Roles forward), admin auth, checkout XSS površina, provideri |
| D1 shema | `backend/migrations/` | indeksi vs. stvarni queryji, constraint rupe |
| Contracts + safe-tx | `backend/contracts/`, `backend/safe-tx/` | PaymentRegistry, role setup batchevi |
| Wallet PWA | `wallet/src/` (74 filea — najveći dio!) | passkey/WebAuthn flow, Safe deploy/send pipeline, recovery putevi, storage model, GP integracija |
| Wallet relayer | `wallet/functions/` | **novac na lancu**: pre-flight getCode, gas caps, origin provjere, CREATE2 single-truth |
| Flutter app | `lib/`, `test/` | QR generiranje (EPC/HUB3), payment status polling, POS mod |
| Skripte | `scripts/*.mjs` | samo sanity — je li nešto od toga defakto produkcijska ovisnost |

Preskoči: `experiments/wallet-wasp` (submodule, showcase), `build/`,
`node_modules/`, `screenshots/`, `wallet/dist/`.

## 3. Review dimenzije (po podsustavu, redom prioriteta)

1. **MONEY-BUG** — put kojim se novac može izgubiti, zaglaviti, duplo
   poslati, ili lažno prijaviti ("plaćeno" koje nije). Uključuje replay,
   race između webhook retryja / crona / read-patha, partial-failure sredine
   (npr. D1 upis prošao, chain TX nije, Worker evictan između).
2. **SEC** — auth rupe, injection (SQL/XSS/header), secret handling, CORS,
   webhook signature bypass, SSRF, unauthenticated write endpointi.
3. **BUG** — obična korektnost (edge caseovi, parsiranje, tipovi, TTL/expiry
   logika, timezone/unix pretpostavke).
4. **RISK** — Workers ograničenja (waitUntil lifetime, CPU, D1 limits,
   subrequest broj), RPC single-point (rpc.gnosischain.com bez fallbacka?),
   rate limiting, error-swallowing (`catch {}` bez loga).
5. **REFACTOR** — dupliciranje (backend ↔ wallet/functions dijele li
   CREATE2/EPC/webhook-sign logiku?), altitude problemi, mrtvi kod,
   inkonsistentni idiomi između Opus sesija.
6. **TEST-GAP** — što od MONEY/SEC površine nema test (backend ima samo
   2 test filea na 31 src; wallet vjerojatno 0).

## 4. Metoda (obavezno)

- **Adversarial verify prije zapisivanja:** svaki MONEY/SEC/BUG nalaz mora
  imati konkretan failure scenarij (ulaz/stanje → pogrešan ishod) koji si
  provjerio protiv stvarnog koda, ne po sjećanju na pattern. Plauzibilan-ali-
  neprovjeren nalaz ide u zaseban odjeljak "Neverificirano", ne među nalaze.
- **Ground checks:** `cd backend && npm ci && npm test && npm run typecheck`;
  `flutter analyze`; `cd wallet && npm ci && npx tsc --noEmit` (build po
  potrebi). Sve što tvrdiš o ponašanju koda mora biti konzistentno s ovim.
- **Coverage mapa:** u INDEX.md tablica podsustav × dimenzija s ✓/− da se
  vidi što je stvarno pregledano — bez tihog preskakanja.
- Pročitaj prvo: `CLAUDE.md`, `docs/decisions/INDEX.md`,
  `docs/reference/paid-on-confirmed-settlement.md`,
  `docs/relayer-threat-model.md` (ako postoji), `docs/postmortems/`.

## 5. NE-DIRAJ invarijante (nalazi koji ovo "poprave" su FALSE POSITIVE)

Ovo su namjerne, empirijski izborene odluke — refactor plan ih smije
enkapsulirati, ali NE mijenjati semantiku:

- EPC QR: strogi 10-linijski layout s pozicijskim praznim linijama
  (Revolut iOS); HUB3: svih 14 FINA polja uklj. prazan payer blok.
- Monerium forward gating: SAMO `kind='issue' && order.updated &&
  state='processed'` — nikad na `order.created` (race, ModuleTransactionFailed).
- Settle single-fire: atomski `submitted→confirmed` UPDATE u
  `confirmForwardOnce` je JEDINI okidač paid+webhook efekata; drugi zasun
  `pending→paid` u `markIntentPaid`. Expired intent se nikad ne uskrsava.
- sid parsiranje: SEPA mapira `=` u `.` (i druge forme) — višestruke
  accept-forme su namjerne.
- Checkout inline `<script>`: `jsonForScript()` escape (`<`,`>`,`&`,U+2028/9)
  — stored XSS fix, ne "pojednostavljuj".
- Relay: pre-flight `getCode(safe)` je OBAVEZAN (EVM call na prazan address
  = silent success, izgubljeno 1.05 EURe 2026-05-25).
- Wallet NIKAD ne briše passkeye (Signal API brisanje = trajno zaključana
  sredstva; već jednom revertano). Server-recovery za wallet je TRAJNO
  ODBIJEN (self-custody princip).
- Passkey dedup: get-first probe + excludeCredentials, NE stabilni user.id.

## 6. Output format

```
docs/reviews/2026-07-fable5/
  INDEX.md                 — executive summary, brojevi po severityju,
                             top-10 prioriteta, coverage mapa
  backend-worker.md        — nalazi po podsustavu (jedan file po retku
  wallet-pwa.md              tablice iz §2; spajaj manje po potrebi)
  wallet-relayer.md
  flutter-app.md
  db-schema-and-contracts.md
  refactor-plan.md         — plan za Opus 4.8 (vidi dolje)
  unverified.md            — plauzibilno ali neprovjereno (ako ima)
```

**Format nalaza** (svaki): `[SEVERITY] naslov` + `file:line` + failure
scenarij + predloženi fix + acceptance criteria (kako Opus dokazuje da je
popravljeno — test/komanda/ponašanje). Numeriraj (`BW-01`, `WP-03`…) radi
referenciranja.

**refactor-plan.md** je glavni deliverable za Opus 4.8: faze po prioritetu
(F1 = MONEY/SEC odmah, F2 = BUG/RISK, F3 = REFACTOR/TEST-GAP), svaka stavka
referencira nalaze po ID-u, ima procjenu opsega (S/M/L), ovisnosti između
stavki, i eksplicitno "ne diraj" upozorenja iz §5 gdje su relevantna.
Piši ga tako da se svaka stavka može dati Opusu kao samostalan zadatak.

Zapiši i **što je DOBRO** (arhitektonske odluke koje treba zadržati) — da
budući refactor ne "popravi" ispravne stvari.

## 7. Izvan opsega

- Bilo kakva izmjena produkcijskog koda, testova ili configa (SAMO docs).
- Deploy bilo čega.
- Review `experiments/`, git submodula i vanjskih repoa (domovina-api itd.)
  — smiješ NOTIRATI sučelja prema njima kao rizik, ne reviewati ih.

## 8. Predaja

Commit + push na `review/fable5-codebase` (auto-push odobren; NE merge u
main — merge radimo nakon što pregledam). Završni sažetak: broj nalaza po
severityju, top-5 najkritičnijih s jednom rečenicom svaki, i preporučeni
redoslijed za Opus 4.8. Vraćamo se u glavnu sesiju na pregled.
