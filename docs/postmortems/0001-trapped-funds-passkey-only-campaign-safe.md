# Postmortem 0001 — 4.16 EURe trapped in a passkey-only (1/1) campaign Safe

**Date of incident:** 2026-06-07 (campaign created ~2026-06-02).
**Severity:** Funds operationally unrecoverable (not burned — see "Current state").
**Amount:** 4.16 EURe (4_160000000000000000 wei, Monerium EURe V2 `0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430`).
**Author:** Matija Stepanic + Claude.
**Related:** ADR [0001](../decisions/0001-no-server-side-recovery.md) (self-custody),
[0008](../decisions/0008-multi-passkey-same-safe.md) (multi-passkey recovery),
[0011](../decisions/0011-passkey-name-equals-safe-address.md),
[0012](../decisions/0012-recovery-seed-second-owner-interop.md).

> **Keep this. These 4.16 EUR are a permanent lesson. They stay trapped on purpose,
> as the cheapest possible reminder of why a single passkey must never be the only
> key to funds.**

## What happened

A test crowdfunding campaign on pinka.io (id `54a40b03-ccf9-44cb-9d46-977b520f1719`)
received **4.16 EURe** at its per-campaign Safe
`0x0fE72f49936158936820198d8B0af0Ef509559f3` on Gnosis Chain.

When the creator (Matija) later tried to access the funds:

- The Safe is **counterfactual (never deployed)** — `eth_getCode` returns `0x`. The
  EURe sits at the CREATE2 address waiting for the Safe to be deployed.
- Opening the wallet at `wallet.domovina.ai` reported *"Ovaj passkey nije registriran
  ni lokalno ni na serveru"* — the controlling passkey was in neither the local nor
  the backend registry.
- The campaign was created ~5 days earlier in an **unknown browser/profile**; the
  creator could not identify which passkey in Apple Passwords was the one used.

## Root cause

The campaign Safe is a **1/1 Safe whose single owner is the creator's passkey
WebAuthn signer** (derived from the P-256 pubkey; saltNonce =
`keccak256("pinka:campaign:<id>")` = `0x29a152…`; see
`pinka-finance/app/lib/chain/safe.ts`). There is **exactly one key** that can ever
sign for it: the original passkey's private key, held only in the authenticator
(Apple Passwords / iCloud Keychain or wherever it was created).

That passkey could not be located. With no second owner (no EOA seed, no second
passkey per ADR 0008), there is **no signing path** → the Safe can never be deployed
or swept. A passkey is not inherently backed up: platform sync (iCloud/Google) helps
**within** an ecosystem, but a credential created in an unidentified browser/profile
(or a different platform account) can become unreachable, and then it is gone.

## Recovery attempt (what we built, and why it still wasn't enough)

We built a device-independent recovery tool — `src/lib/recover.ts` + the
`/recover` route (`src/routes/Recover.tsx`):

1. **Identify** — a WebAuthn assertion lets us recover the P-256 public key via
   ECDSA public-key recovery (2 candidates), then match
   `predictSafe(getSigner(pubkey), campaignSalt)` against the target Safe. No
   credentialId / localStorage / DB record needed up front.
2. **Withdraw** — sign the EURe transfer with the passkey, then the relay cold path
   deploys the signer + Safe (at the campaign salt) and executes the transfer
   atomically.

The tool is **mechanically correct** (verified the relay reaches the cold-path
deploy). But step 1 is fundamental: it can only succeed if the user can present the
**original passkey**. Every passkey available in Apple Passwords was tried; none
recovered to `0x0fE7…`. No tool can manufacture a private key that isn't there.

`/recover` is kept in the codebase: it will recover this (or any) passkey-owned Safe
the instant the controlling passkey resurfaces, and is the right tool for legitimate
recovery of counterfactual passkey Safes in general.

## Current state

- 4.16 EURe remain on-chain at `0x0fE72f49936158936820198d8B0af0Ef509559f3`, forever.
- **Not burned**: recoverable at any future time *if* the original passkey is found
  (e.g. surfaces in another browser, Google Password Manager, or platform account)
  via `/recover`.
- **Operationally**: written off. Deliberately left trapped as a standing lesson.

## Lessons → actions

1. **A single passkey must never be the only key to funds that matter.**
   → ADR 0012: the default new-wallet mode is **1-of-2** (passkey + a 12-word
   recovery seed importable into MetaMask / app.safe.global). Either key signs; losing
   one is non-fatal. This incident is the production proof of why that default exists.

2. **pinka per-campaign Safes are still 1/1 passkey-only — same trap. FOLLOW-UP.**
   Campaign Safes derive `owners=[passkeySigner], threshold 1`. They need an
   alternative recovery owner (1-of-2 with the creator's seed, or a platform
   co-signer) before real money flows through them. Until then, every campaign Safe
   carries this exact risk.

3. **Surface recovery at creation, not after.** A recovery key the user never wrote
   down doesn't exist. ADR 0012 shows the seed reveal-on-tap at creation; consider
   making backup setup a more prominent onboarding step for funds-bearing wallets.

4. **Passkeys are an availability risk, not just a security win.** Document clearly
   (in-product) that a passkey created in one browser/profile may not appear
   elsewhere, and that the recovery seed / second owner is the real safety net.

## On-chain reference

| Field | Value |
|---|---|
| Safe (counterfactual) | `0x0fE72f49936158936820198d8B0af0Ef509559f3` |
| Chain | Gnosis (100) |
| Token | EURe V2 `0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430` |
| Balance | 4.16 EURe |
| Owner model | 1/1, owner = creator's WebAuthn passkey signer |
| saltNonce | `keccak256("pinka:campaign:54a40b03-ccf9-44cb-9d46-977b520f1719")` = `0x29a152b9b3a1d92364194dbdc5d985a04d7297fbbb14f2b321cbe652ffb30de7` (dec `18829860119051292744280629506485095973949926145537959600391126010155152641511`) |
| Deployed | No (`getCode` = `0x`) |
