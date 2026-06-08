# ADR 0013 — Passkey = identity, Safe = account (one daily passkey, many accounts)

**Status:** Accepted (direction). First slice (single-identity creation + homepage
simplification) and multi-account slice (many Safes per passkey) both implemented on
`feat/passkey-name-equals-safe-address`; untested on-chain.
**Date:** 2026-06-07 (multi-account slice 2026-06-08)
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Supersedes (as default):** ADR 0011 (passkey name = Safe address) — demoted from
default to an optional/niche mode. **Keeps:** ADR 0012 recovery seed (but as ONE
reusable recovery key, not a fresh ephemeral per Safe). **Inherits:** ADR 0001
(self-custody), ADR 0008 (threshold-multi-owner recovery). **Motivated by:**
[Postmortem 0001](../postmortems/0001-trapped-funds-passkey-only-campaign-safe.md).

## Context

Practical use exposed that **1 passkey = 1 Safe** is an anti-pattern: a user with
many passkeys cannot tell which one logs into which wallet. Password managers collapse
them under one website entry; you end up hunting. (This is what ADR 0011's
name=address tried to mitigate — but the real fix is to not have many passkeys at all.)

Simultaneously, Postmortem 0001 proved the opposite failure: a **single** passkey as
the only key traps funds if it's lost.

The resolution separates two things that were conflated:

- **Daily login** wants exactly ONE passkey — an identity, fixed name, no choosing.
- **Recovery** wants a SECOND key — but off the login path (break-glass), so it never
  reintroduces "which passkey?".

The anti-pattern is *multiple passkeys as separate identities/Safes*. Multiple keys
*co-owning one identity's Safes* (recovery) is good and necessary.

## Decision

### Decision 1 — Passkey = identity (one), Safe = account (many)

A user has ONE everyday passkey (the identity), with a stable, fixed keychain name
(`identityKeychainName()` → e.g. `DOMOVINA Wallet`). All accounts are **Safes owned by
that one passkey's signer**, derived at different saltNonces
(`predictSafe(signer, saltN)`), named/colored **in the app**, not in the password
manager. Adding an account does NOT create a new passkey.

```mermaid
flowchart TB
    PK["ONE passkey (identity)\nfixed name: DOMOVINA Wallet"]
    PK -->|signer owns| A["Safe: Glavni (salt 0)"]
    PK --> B["Safe: Ušteđevina (salt 1)"]
    PK --> C["Safe: Firma (salt 2)"]
    R["ONE recovery key (seed)\nbreak-glass, backed up once"]
    R -. "co-owner (1-of-2) of each Safe" .-> A
    R -. .-> B
    R -. .-> C
```

### Decision 2 — One reusable recovery key (not one per Safe)

Recovery is a single key the user backs up **once** and that co-owns **all** their
accounts (1-of-2 per ADR 0012). Lose the daily passkey → the recovery key (imported to
MetaMask / app.safe.global) controls everything. Lose the recovery key → the daily
passkey still works. Never used at login. (Implementation note: the per-Safe ephemeral
EOA of ADR 0011/0012 becomes a single account-scoped recovery owner; reuse it as the
second owner across the user's Safes.)

### Decision 3 — name=address demoted to optional

ADR 0011 (passkey user.name = Safe address) solved "which of my 30 passkeys". With one
identity passkey that problem is gone, so the default keychain name is the fixed
identity name. name=address + the per-Safe bootstrap remain available only for the
deliberate single-purpose-Safe / pre-provisioning (`cmp:`) cases — not the default.

### Decision 4 — Maximally simplified homepage

The landing page is reduced to the essential actions:
- **No wallet yet:** value prop + **Kreiraj wallet** (primary) + **Otvori postojeći
  passkey** (secondary, for iCloud/Google-synced passkeys on a new device).
- **Has wallet:** the account card(s) (open on tap) + a slim **Otvori postojeći
  passkey**.

Removed from the homepage: **"Linkaj postojeći wallet"** (outgoing cross-TLD linking
initiation) and **"Ne vidim ga — stari passkey"** (legacy `wallet.domovina.ai`
migration). Legacy passkeys remain reachable: "Otvori postojeći passkey" already falls
back to the legacy RP. The INCOMING `/link` + `/link-callback` routes are untouched
(other sites can still link to this wallet); only the outgoing-initiation UI left the
homepage (can return in Settings later if needed).

## Consequences

### Positive
- One passkey, one fixed name → login is unambiguous; the "which passkey?" pain is gone.
- Many accounts without many credentials; account identity lives in-app (names/colors),
  durable cross-device via the ADR 0012 PRF-encrypted metadata blob (future).
- Simpler architecture: with a fixed identity name, the default needs no
  address-before-passkey bootstrap (that was only for name=address).
- Reconciles with Postmortem 0001: still 1-of-2 (passkey + one recovery key), so no
  single point of loss.

### Negative / trade-offs
- All accounts share one signer → on-chain **linkable** (an observer sees common
  ownership). Acceptable default; use a separate passkey/Safe deliberately when
  compartmentalization matters (the demoted name=address mode).
- Multi-account requires re-keying the local registry by **safeAddress** (today it is
  keyed by credentialId, which assumes 1 passkey = 1 Safe), plus Send passing each
  account's saltNonce (the relay already supports it), plus a backend registry that maps
  credentialId → MANY Safes for cross-device restore. **This is the next slice.**

## Implementation tracking

| Item | Status |
|---|---|
| `identityKeychainName()` fixed identity name | ✅ |
| Creation default = one identity passkey + 1-of-2 recovery seed (reuse ADR 0012 'add') | ✅ |
| Homepage simplification + remove Linkaj/Legacy buttons | ✅ |
| Multi-account: registry keyed by safeAddress, "new account" mints Safe under same signer | ✅ coded ([[#multi-account-implementation]]), untested on-chain |
| One reusable recovery owner across all accounts | ✅ coded — `PasskeyRecord.recoveryOwner` persisted at creation; reused for every derived account |
| Cross-device: backend maps credentialId → many Safes | ⏳ client sends best-effort (`registerAccountWithBackend`); backend route out of repo |
| In-app account names/colors + PRF metadata backup | 🟢 names done (per-account, in-app); colors/PRF backup future (ADR 0012 Decision 4) |

### Multi-account implementation (2026-06-08) {#multi-account-implementation}

Chosen account-derivation model: **2-owner from birth** (Option A). A new account is a
counterfactual **1-of-2 `[passkeySigner, recoveryOwner]`** Safe at the next saltNonce —
the reusable recovery owner is baked into the CREATE2 address, so funds are **never
passkey-only** (closes the Postmortem 0001 trap that the ADR's literal `predict(signer,
saltN)` 1/1 phrasing would have reopened). Deploys lazily on first send via the relay
cold path; minting is pure-local (no Face ID, no gas).

- **Registry** — `src/lib/accounts.ts` (`domovina_accounts_v3`, keyed by safeAddress)
  layers derived accounts over the existing per-identity `PasskeyRecord` store
  (untouched). `WalletAccount` unifies bootstrap (the EOA-owned creation Safe, hot path)
  + derived (cold path). `deriveAccount()` predicts `[signer, recoveryOwner]` at
  `nextSaltNonce()`.
- **Relay** — `functions/api/relay.ts` `buildSafeInitializer(owners[])` +
  `predictSafeProxyAddress(owners[], salt)` generalised to 1- or 2-owner; new
  `recoveryOwner` body field; cold-path CREATE2 guard checks the 2-owner address.
  Owner order `[signer, recoveryOwner]` is canonical on both client + relay.
- **Send** passes `saltNonce` + `recoveryOwner` only for derived accounts; bootstrap
  sends are byte-identical to before.
- **UI** — `WalletSwitcherSheet` lists all accounts + "Novi račun" (name chips, gated on
  `recoveryOwner` presence); reachable from the home account-name chip + Settings.

**Known gaps (follow-ups):** (1) a derived account that is funded-but-never-sent-from is
counterfactual, so seed→MetaMask/app.safe.global interop only works AFTER first-send
deploys it (funds are still recoverable — the seed co-owns the address — but an EOA-
signed cold-path deploy path is not yet built). (2) Cross-device restore of derived
accounts needs the out-of-repo backend to map credentialId → many Safes. (3) The 2-owner
CREATE2 address match (protocol-kit client vs hand-built relay initializer) is **untested
on-chain** — the cold-path guard refuses on any drift, so the failure mode is a loud
rejection, not stranded funds.
