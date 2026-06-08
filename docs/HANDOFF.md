# Handoff — wallet passkey/identity work (as of 2026-06-07)

Session handoff for the wallet self-custody work. Durable rationale lives in the
ADRs + postmortem referenced below; this file is the "where we are / what's next".

## Branch & deployments

- **Branch:** `feat/passkey-name-equals-safe-address` (NOT merged to `main`; no PR yet).
  Everything below is on this branch.
- **Stable** `wallet.domovina.ai` (CF Pages `wallet-domovina`) = OLD code (`main`). Untouched.
- **Staging** `wallet-staging.domovina.ai` (CF Pages `wallet-staging`) = THIS branch, **same
  backend** (same `RELAY_KV`, same `mpt.domovina.ai` registry, same Gnosis). Deploy with
  `cd wallet && npm run ship:staging` (forces `--branch main` → staging production). The
  custom domain is required (not `*.pages.dev`) so passkey RP ID resolves to `domovina.ai`.
  Per-project secret `RELAYER_PRIVATE_KEY` is set; **secret changes need a redeploy**. See
  `wallet/docs/STAGING.md`.
- **Everything is UNTESTED on-chain** (needs a real passkey + funded relayer).

## What shipped this session (all on the branch, deployed to staging)

- **ADR 0011** — passkey `user.name` = Safe address (bootstrap-atomic-swap to beat the
  create()-input/address-output chicken-and-egg). **Demoted to optional by ADR 0013.**
- **ADR 0012** — 1-of-2 recovery seed as a second Safe owner + MetaMask/app.safe.global
  interop. Code: `wallet/src/lib/bootstrap.ts`, `wallet/functions/api/bootstrap-deploy.ts`.
- **ADR 0013** — **passkey = identity (one), Safe = account (many)**. First slice shipped:
  single-identity creation (fixed name `DOMOVINA Wallet` via `identityKeychainName()` + a
  1-of-2 recovery seed, reveal-on-tap), and a **maximally simplified homepage** (removed
  "Linkaj postojeći wallet" + "Ne vidim ga — stari passkey" + the dead outgoing-linking
  code). Incoming `/link` + `/link-callback` untouched.
- **`/recover`** route + `wallet/src/lib/recover.ts` — recover funds from a counterfactual
  passkey-owned Safe. Identifies the controlling passkey via **P-256 pubkey recovery from a
  WebAuthn assertion** (no credentialId/localStorage needed) → match
  `predictSafe(getSigner(pubkey), salt)` → relay cold-path deploy+withdraw.
- **`wallet/functions/api/relay.ts`** — CREATE2 guard moved to cold-path-only so already-
  deployed bootstrap Safes (safeAddress = `predict(EOA)`, not `predict(signer)`) can send.
- **Postmortem 0001** (`docs/postmortems/0001-*`) — **4.16 EURe permanently trapped** in a
  1/1 passkey-only pinka campaign Safe `0x0fE72f49936158936820198d8B0af0Ef509559f3` (lost
  passkey). Recoverable via `/recover` ONLY if the original passkey ever resurfaces;
  written off as a standing lesson. This is why ADR 0012's 1-of-2 default exists.

## Next slice (ADR 0013) — multi-account: many Safes under ONE passkey

The heart of the model, not yet built. Requires:
1. **Re-key the local registry by `safeAddress`** (today `wallet/src/lib/passkey.ts` keys by
   `credentialId`, which hardcodes 1 passkey = 1 Safe). A record gains a `saltNonce`.
2. **"New account"** mints a Safe = `predictSafe(signer, saltN)` under the EXISTING passkey
   (no new WebAuthn create). The passkey already exists → no bootstrap-EOA needed.
3. **Send** passes each account's `saltNonce` to `/api/relay` (the relay already supports it).
4. **One reusable recovery owner** (seed) co-owns all the user's accounts (not a fresh EOA
   per Safe).
5. **Backend** `/api/wallets` (mpt.domovina.ai, OUT OF REPO) must map `credentialId → MANY
   Safes` and accept an EOA-derived `safeAddress` for cross-device restore.

## Open follow-ups

- **pinka per-campaign Safes are still 1/1 passkey-only** (`pinka-finance/app/lib/chain/safe.ts`)
  → same trap as Postmortem 0001. Add an alternative recovery owner before real money flows.
- **Backend** registry must accept EOA-derived `safeAddress` (else cross-device restore of
  bootstrap/1-of-2 wallets breaks).
- **On-chain test** of creation + recovery on staging.
- **PR** `feat/passkey-name-equals-safe-address` → `main` (then `ship:default` to stable).

## Test on wallet-staging.domovina.ai

- Home → simplified (Kreiraj wallet + Već imam passkey).
- Create → Face ID → "Prikaži recovery seed" → import the 12 words into MetaMask → must
  resolve to the SAME Safe (1-of-2 owner).
- `/recover?safe=<0x>&campaign=<id>&to=<dest>` → Face ID → identify → withdraw.

## Key constraints (don't relearn the hard way)

- Passkeys are scoped to RP ID `domovina.ai`; WebAuthn/recovery/creation only work on a
  `*.domovina.ai` HTTPS origin (NOT localhost, NOT `*.pages.dev`).
- A single passkey as the only owner of funds = permanent-loss risk (Postmortem 0001).
  Default to ≥2 recovery paths (ADR 0012/0008).
- CF Pages secret changes apply only after a redeploy.
- ADRs: `docs/decisions/INDEX.md`. Memory index is auto-loaded each session.
