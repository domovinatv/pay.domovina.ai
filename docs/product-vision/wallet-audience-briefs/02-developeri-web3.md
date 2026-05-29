# Audience Brief 02 — Developers / Web3

> **Format za / Format for:** technical builders, smart-account / account-
> abstraction crowd, Gnosis/Safe ecosystem. Depth, code, addresses.
> **Derived from** the [SSOT](../wallet-blog-sourcebook.md) — if a fact
> conflicts, the SSOT wins.

| | |
|---|---|
| **Language** | English (primary), HR secondary |
| **Channels** | dev.to, Hacker News, X/Twitter threads, Safe/Gnosis forums |
| **Tone** | Precise, no marketing fluff. Show the wire, the gotchas, the addresses. |
| **Lean into** | passkey → ERC-1271, counterfactual deploy, MultiSend deploy+send, gas-sponsored relay, iframe SDK, RP-ID derivation. |

## Pitch
A **passkey-owned Safe smart account** on Gnosis Chain: WebAuthn P-256
signer, ERC-1271 verification, counterfactual address, gas-sponsored
relayer (5 free tx/day), and a drop-in iframe SDK. No custody, no seed.

## Key technical hooks
1. **WebAuthn P-256 → ERC-1271** — Face ID signs; the Safe validates via
   `SafeWebAuthnSignerFactory` / `SafeWebAuthnSharedSigner`.
2. **Counterfactual Safe** — address derived pre-deploy; first send is a
   MultiSend `deploy + transfer` batch.
3. **Gas-sponsored relay** — CF Worker submits, pays xDAI; KV rate-limit;
   pre-flight `getCode` gotcha (EVM call-to-empty-address returns success).
4. **One passkey, many domains** — parent-RP ID + cross-TLD peer linking,
   threshold-1 multi-owner.
5. **Iframe SDK** — `/sdk.js` + `/embed`, delegated not custodial.

## Posts for this audience (from backlog)
- **B3** — "Passkey-owned Safe: how we killed the seed phrase" → `send` + README diagram
- **B4** — "Gas-sponsored sends without the user touching xDAI" → `send`, `dark-mode`
- **B5** — "One passkey, many domains" → `landing-known`, `settings`
- **B6** — "Drop-in EURe payments for your dApp" → `receive-p2p`, wallet-wasp embed

## Canonical references to cite
- Repo + `functions/api/relay.ts`, `src/lib/safe.ts`, `src/lib/passkey.ts`
- [ADR 0001](../../decisions/0001-no-server-side-recovery.md) (self-custody),
  [0008](../../decisions/0008-multi-passkey-same-safe.md) (multi-passkey),
  [0009](../../decisions/0009-iframe-sdk-third-party-embedding.md) (SDK)
- Addresses: see SSOT §2 (factory, shared signer, Daimo verifier, EURe)

## CTA
"Star the repo · read ADR 0001 · embed `<script src=".../sdk.js">`."

## Guardrails (binding)
- **P256 precompile on Gnosis is unconfirmed** — say "DaimoP256Verifier
  fallback", don't claim precompile.
- Relayer pays gas; it does **not** hold user keys. Don't blur this.
- Phase 5 (onchain identity) is roadmap — future tense only.
