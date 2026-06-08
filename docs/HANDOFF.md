# Handoff — wallet passkey/identity work (as of 2026-06-08)

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

## Multi-account slice (ADR 0013) — SHIPPED 2026-06-08 (on branch, staging)

Many Safes under ONE passkey, with the **2-owner-from-birth** model (Option A): a new
account is a counterfactual **1-of-2 `[passkeySigner, recoveryOwner]`** Safe at the next
saltNonce. The reusable recovery owner (the bootstrap seed's EOA address, now persisted
as `PasskeyRecord.recoveryOwner`) is baked into the CREATE2 address, so derived-account
funds are **never passkey-only** — deliberately deviating from the ADR's literal
`predict(signer, saltN)` 1/1 phrasing, which would have reopened the Postmortem 0001 trap.
Minting is pure-local (no Face ID, no gas); the Safe deploys lazily on first send.

- **`wallet/src/lib/accounts.ts`** (NEW) — `domovina_accounts_v3` keyed by safeAddress,
  layered over the untouched `PasskeyRecord` store. `WalletAccount` = bootstrap (hot path)
  ∪ derived (cold path). `deriveAccount()` / `nextSaltNonce()` / `listAllAccounts()` /
  active-account tracking (`domovina_active_account`). Canonical owner order
  `[signer, recoveryOwner]` via `derivedOwners()`.
- **`functions/api/relay.ts`** — `buildSafeInitializer(owners[])` +
  `predictSafeProxyAddress(owners[], salt)` generalised to 1-or-2 owners; new
  `recoveryOwner` body field; cold-path CREATE2 guard checks the 2-owner address.
- **`Send.tsx`** passes `saltNonce` + `recoveryOwner` for derived accounts only.
- **`state/store.ts`** carries `saltNonce`/`recoveryOwner`/`accountKind`/`accountName`;
  `setAccount(WalletAccount)`. **`Landing.tsx`** persists `recoveryOwner` at creation +
  enters via `setAccount(bootstrapAccountView(...))`.
- **UI** — `WalletSwitcherSheet` rewritten to accounts + "Novi račun" (name chips, gated
  on `recoveryOwner`); reachable from the home account-name chip + Settings (ungated).

## Open follow-ups

- **Derived-account seed interop**: a funded-but-never-sent derived Safe is counterfactual,
  so seed→MetaMask/app.safe.global works only AFTER first-send deploys it. Funds are still
  recoverable (seed co-owns the address) but the **EOA-signed cold-path deploy** path is
  not built yet. Build it so a lost-passkey-before-first-send derived account is recoverable.
- **Backend** `/api/wallets` (mpt.domovina.ai, OUT OF REPO) must (a) map `credentialId →
  MANY Safes` (client now POSTs `…/{credentialId}/accounts` best-effort via
  `registerAccountWithBackend`) and (b) accept EOA-derived `safeAddress` + persist
  `recoveryOwner` — else cross-device restore of derived/1-of-2 wallets breaks.
- **On-chain test** (staging): 2-owner CREATE2 address match (protocol-kit vs relay), a
  derived-account first-send deploy, and bootstrap creation + recovery. All UNTESTED.
- **pinka per-campaign Safes are still 1/1 passkey-only** (`pinka-finance/app/lib/chain/safe.ts`)
  → same trap as Postmortem 0001. Add an alternative recovery owner before real money flows.
- **PR** `feat/passkey-name-equals-safe-address` → `main` (then `ship:default` to stable).

## Test on wallet-staging.domovina.ai

- Home → simplified (Kreiraj wallet + Već imam passkey).
- Create → Face ID → "Prikaži recovery seed" → import the 12 words into MetaMask → must
  resolve to the SAME Safe (1-of-2 owner).
- **Multi-account:** home → tap the account-name chip (or Settings → Računi) → "Novi račun"
  → name it → a new derived account appears instantly (no Face ID). Fund it, then Send a
  small amount → first send must cold-path deploy the **2-owner** Safe and transfer in one
  tx (check the relay did NOT reject on the CREATE2 guard — that would mean the protocol-kit
  vs relay 2-owner initializer drifted). Switch back to the bootstrap account → its send
  must still hot-path exactly as before.
- `/recover?safe=<0x>&campaign=<id>&to=<dest>` → Face ID → identify → withdraw.

## Key constraints (don't relearn the hard way)

- Passkeys are scoped to RP ID `domovina.ai`; WebAuthn/recovery/creation only work on a
  `*.domovina.ai` HTTPS origin (NOT localhost, NOT `*.pages.dev`).
- A single passkey as the only owner of funds = permanent-loss risk (Postmortem 0001).
  Default to ≥2 recovery paths (ADR 0012/0008).
- CF Pages secret changes apply only after a redeploy.
- ADRs: `docs/decisions/INDEX.md`. Memory index is auto-loaded each session.
