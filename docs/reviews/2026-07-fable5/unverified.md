# Neverificirano / nedovršeni scope

Nalazi koji su plauzibilni ali NISU prošli adversarial verify protiv koda
(verify pass je pao na kreditima pod Fable 5), plus scope koji nijedan finder
nije dovršio. Opus ovo treba re-checkati PRIJE nego se tretira kao potvrđeno.

## Nalazi koji čekaju Opus re-verify (imaju file:line, plauzibilni)

| ID | Severity | file:line | Zašto neverificirano |
|---|---|---|---|
| WP-01 | SEC | `wallet/src/lib/accounts.ts:291` | Opus nije čitao `accounts.ts` u cijelosti; dira ADR 0001 — verify PRIJE fixa |
| WP-02 | SEC | `wallet/src/lib/accounts.ts:387` | isto; poison recovery-owner tvrdnja treba trace kroz derive path |
| WP-03 | BUG | `wallet/src/lib/accounts.ts:288` | archive/sync interakcija nije direktno pročitana |
| WP-06 | BUG | `wallet/src/lib/accounts.ts:85` | JSON-guard tvrdnja plauzibilna, nije traceana |
| BW-08 | BUG | `backend/src/index.ts:227` | ovisi može li Monerium profil izdati ne-EUR order (runtime info) |
| BW-11 | BUG | `backend/src/intents/api.ts:63` | `expires_in_seconds` NaN→D1 500 — `api.ts` nije pročitan |
| XD-03 | BUG | `backend/src/intents/api.ts:34` | MPT_IBAN razmak — nije potvrđen čitanjem + tko konzumira IBAN |
| CT-01 | SEC | `backend/safe-tx/005-*.mjs:136` | deploy-ano ponašanje Roles modifiera nije verificirano offline |

## Nedovršeni finder scope (poštena rupa — treba F0 pass)

`wallet-core-crypto` finder je pao prije izvršenja. Sljedeći fileovi imaju samo
**posrednu** pokrivenost (preko state/routes findera), NISU čitani u cijelosti s
crypto/MONEY lećom:

- `wallet/src/lib/passkey.ts` — WebAuthn create/get, excludeCredentials dedup,
  user.id/name handling (memory: passkey-userid-dedup). **Kritično:** ovo je
  identity primitiv; get-first probe + excludeCredentials invarijanta se mora
  verificirati.
- `wallet/src/lib/bootstrap.ts` — ephemeral EOA atomic-swap (ADR 0011); curi li
  privatni ključ, gdje živi u memoriji, čisti li se.
- `wallet/src/lib/recover.ts` — recovery putevi (cross-device, seed).
- `wallet/src/lib/paperWallet.ts` — seed entropija, gdje se sprema/prikazuje.
- `wallet/src/lib/safeOwners.ts`, `activate.ts`, `eip681.ts` — owner mgmt,
  aktivacija računa, EIP-681 parsiranje (chain id / adresa / amount decimale).

**Verificirano iz tog scopea (Opus, ručno):** `webauthnSig.ts` (ispravno — vidi
INDEX GOOD), `wallet/functions/_lib/safe.ts` + `relay.ts` (relayer crypto
pipeline — nalazi WR-01/02, XD-01).

**Preporuka:** F0 u refactor-planu — namjenski review-only pass tog scopea
prije bilo kakvih F1 fixova, jer passkey/bootstrap/recover diraju trapped-funds
i self-custody invarijante (postmortem 0001, ADR 0001) gdje je greška skupa.

## Oboreni / ne-nalazi (za evidenciju)

- **`webauthnSig.ts` low-s / clientDataFields** — provjereno ISPRAVNO, nije
  nalaz (bilo bi false-positive "pojednostavi").
- **`eurToWei` floating point** — provjereno, string-split izbjegava float,
  ISPRAVNO.
- **`markIntentPaid` single-fire** — atomski conditional UPDATE, ISPRAVNO
  (invarijanta iz handoffa §5, ne dirati).
- **`confirmForwardOnce` atomicnost** — ISPRAVNO (invarijanta §5).
- **Monerium forward gating** (`issue && order.updated && processed`) — ISPRAVNO
  (invarijanta §5); BW-03/BW-12 se tiču okoline (dedup ordering, meta.state), NE
  samog gate uvjeta.
