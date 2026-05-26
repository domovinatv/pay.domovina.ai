# ADR 0008 — Multi-passkey, multi-domain ownership of one Safe

**Status:** Accepted, implemented (PRs #32, #35, #51, #54). Backfilled documentation.
**Date:** 2026-05-26 (decision date; implementation landed earlier same day across multiple PRs).
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits from:** ADR 0001 (self-custody — multi-passkey is the recovery mechanism). ADR 0007 (brand registry — supplies the link-target list).

## Context

A user can lose access to a wallet through many real-world events
that have nothing to do with key custody quality: device wiped before
restore, Apple ID locked, iCloud Keychain disabled, a tenant brand
they used yesterday has a different RP than today's, etc. ADR 0001
forbids server-side recovery; the only acceptable answer is
**multiple independent passkeys cooperating as co-owners of the same
Safe smart account**.

WebAuthn passkeys are bound to a specific Relying Party ID at create
time. The browser does not surface a passkey to a page whose RP scope
does not match. This produces two operationally distinct cases:

1. **Intra-RP (same domain).** User wants two passkeys on the same
   RP — e.g. iCloud Keychain primary + 1Password backup, or
   iPhone-Apple + Android-Google for cross-ecosystem coverage. All
   passkeys live in the same WebAuthn scope; the OS picker presents
   them together.

2. **Cross-RP (different TLDs).** User has a Safe with funds at
   `wallet.domovina.ai` and a new tenant wallet at
   `sportklub.domovina.ai` (different sibling subdomain) or
   `zupa321.hr` (different TLD entirely). The two RPs are
   incompatible — no shared passkey by WebAuthn design — so each
   domain enrolls its OWN passkey, and that passkey gets added as a
   Safe co-owner via cross-RP linking.

Both cases collapse to the same on-chain primitive:
`addOwnerWithThreshold(newSignerAddress, 1)` on the user's existing
Safe, signed by an existing owner. The differences are purely in the
bootstrap UX (how the new signer gets enrolled and how the user
authorizes adding it).

This ADR records both patterns and the iframe-vs-redirect bootstrap
mechanism that bridges different-origin browsing contexts.

## Decision

### Decision 1 — Threshold-1 multi-owner is the canonical recovery + multi-tenancy primitive

Every "extend my wallet" interaction adds a new Safe owner via
`addOwnerWithThreshold(newOwner, 1)`. Threshold STAYS at 1 — any
single passkey owner can independently sign any Safe transaction.
Two consequences follow:

- **No "approval quorum" UX.** Sending funds is single-signature
  through whichever passkey the user picks. Loss of any single
  passkey is non-fatal; loss of ALL passkeys is.
- **Owner-set growth is monotonic but reversible.** Adding owners is
  the recovery; removing compromised owners is `removeOwner`
  (Settings → Linked passkeys, future iteration). No protocol-level
  "rotate to single owner" needed.

### Decision 2 — Intra-RP: same-domain ExpandAccess flow (passkey #2 on this wallet)

For "add another passkey under the same RP" (the common multi-device
or multi-password-manager case):

- Entry: Settings → "Dodaj passkey" row (added in PR #52; previously
  gated to legacy-only — gate dropped to make this UX universal).
- Flow:
  1. Wallet enrolls a new passkey under the current RP (Face ID
     #1 — creation).
  2. Wallet computes the predicted WebAuthn signer address for the
     new passkey.
  3. Active passkey signs
     `safe.execTransaction(addOwnerWithThreshold(newSigner, 1))`
     (Face ID #2 — signing).
  4. Relay submits the tx; on confirmation, the new passkey is a
     full Safe owner.
- Implementation: `wallet/src/routes/ExpandAccess.tsx` + supporting
  `lib/safeOwners.ts` encoding helper.
- Use cases supported (no Certilia, no eIDAS, no special enrollment):
  iCloud + Google PM, 1Password vault as additional signer, YubiKey
  hardware key, iPhone + MacBook redundancy.

### Decision 3 — Cross-TLD: peer linking, iframe + Safari redirect bootstrap

For "I have a Safe on wallet.domovina.ai and want to use it on
zupa321.hr" (different TLD entirely, WebAuthn cannot bridge):

- Entry: Landing → "Linkaj postojeći wallet" → target picker
  (sibling brand or custom URL) → enroll new local passkey →
  authorize on target.
- Bootstrap mechanisms:
  - **iframe path (default for Chrome/Firefox/Edge):** tenant
    embeds `<iframe src="https://<targetDomain>/link?…">` with
    `allow="publickey-credentials-get; publickey-credentials-create"`.
    Target authorizes user with its own passkey, signs addOwner,
    `postMessage`-s result back to parent.
  - **Redirect path (Safari):** tenant stashes `PendingLink` in
    sessionStorage and top-level navigates to
    `https://<targetDomain>/link?…&returnMode=redirect&returnUrl=…`.
    Target authorizes, redirects back to
    `/link-callback?safeAddress=…&txHash=…`. Tenant
    `/link-callback` consumes pending link, persists PasskeyRecord
    locally, navigates to wallet home.

Safari path is mandatory because Safari ITP partitions third-party
iframe localStorage; WebAuthn calls inside such iframes are
unreliable and the user-gesture-bound Storage Access API workflow
adds prompts that frequently break the WebAuthn flow itself.

### Decision 4 — Peer linking is N-to-N (symmetric), no permanent "master"

Originally implemented (PR #51) with a hardcoded `MASTER_WALLET_DOMAIN
= 'wallet.domovina.ai'` and a tenant-only "link to master" button.
Generalized in PR #54: any brand build can be either authorizer or
requester for any other brand. Justification: all Safes are
peer-equivalent on-chain — same contract code, same threshold
semantics. The default brand's only "master" property was historical
accident; ADR 0008 codifies the symmetric model.

UI surface:
- All brands (including `default`) show the "Linkaj postojeći wallet"
  button.
- Click opens `PickLinkTargetView` listing all brand registry entries
  except the active one, plus a "Drugi wallet (custom URL)" input.
- User picks → enrolls new local passkey → opens chosen target's
  `/link` page via iframe or redirect.

### Decision 5 — Backend registry has Safe-as-family lookup

After linking, multiple credentialIds (each from a different RP) map
to the same `safe_address` in the backend wallet registry. ADR 0005
added `GET /api/wallets/family/:safeAddress` to enumerate all
passkeys for one Safe across all RPs — this powers the future
Settings "Where else does this wallet live" view and prevents
double-adding the same signer in the linking flow.

### Decision 6 — Iframe `/link` page hardening

The `/link` page on every brand exposes a Safe-owner-mutation flow to
any iframe parent. Mitigations baked in:
- `Content-Security-Policy: frame-ancestors *` (any TLD can embed) +
  `Permissions-Policy: publickey-credentials-get=*,
   publickey-credentials-create=*` in `wallet/public/_headers`.
- postMessage origin validation scoped to the user-chosen target —
  the tenant only listens for messages from the origin it explicitly
  navigated to.
- Namespaced message envelope (`ns: 'domovina-wallet-link'`) filters
  out random postMessage noise.
- The authorizer ALWAYS requires user-presence Face ID before signing
  addOwner. No silent grant possible.

## Consequences

### Positive

1. **One Safe, many devices, many domains.** A user with funds on
   `wallet.domovina.ai` can spend from `sportklub.hr` after one
   linking ceremony — same balance everywhere.
2. **Threshold-1 means no UX friction for daily use.** Each tenant
   uses its own native passkey via Face ID; the cross-tenant complexity
   is bootstrap-only.
3. **Loss of any single device / RP / password manager is recoverable**
   so long as the user retains access through another linked passkey.
4. **No third-party custodian, no recovery email, no seed phrase.**
   Recovery is "use any other passkey you have linked", aligning with
   ADR 0001 hard rules.
5. **Backend registry naturally tracks the wallet family.** Future
   Settings UI can show users where else their Safe is accessible
   from.

### Negative

1. **Owner-set growth is irreversible without ANOTHER `removeOwner`
   transaction.** Settings UI for removing compromised owners is a
   missing primitive — listed as future work.
2. **Custom URL link target trusts whatever the user typed.** No
   reputation system tells the user "this URL is a real DOMOVINA-
   pattern wallet". Mitigated by the authorizer-side Face ID
   requirement, but mis-clicks could authorize a malicious target.
3. **iframe surface area is broad.** `frame-ancestors *` means any
   site can embed `/link`. Critical that the authorizer-side UI is
   explicit about WHICH target requested authorization (current
   implementation renders `req.tenantName` prominently — keep this).
4. **Safari users always get the redirect roundtrip.** Slight UX
   penalty vs iframe — leaves the tenant tab during the flow. The
   alternative (Storage Access API + iframe) is worse.

### Neutral

1. **Multi-passkey ExpandAccess (Decision 2) is brand-agnostic.**
   Every brand's Settings page exposes it. No brand can opt out
   structurally; could be feature-flagged in `brand.enabledFeatures`
   if a future tenant insists.
2. **The flow does not let the user MOVE a Safe between RPs.** It
   adds NEW owners; the original Safe contract address stays the
   same forever.

## Implementation tracking

| Component | Status | PR |
|---|---|---|
| D1: Threshold-1 multi-owner primitive (Safe v1.4.1 + WebAuthnSignerFactory) | ✅ Shipped (Phase 3 foundation) | Pre-ADR; documented retroactively |
| D2: Intra-RP ExpandAccess (`/settings/expand-access`) | ✅ Shipped | #32 (initial), #52 (gate dropped — always visible) |
| D3: Cross-TLD `/link` page + iframe/redirect dispatch | ✅ Shipped | #51 (initial master-only), #54 (N-to-N peer) |
| D3: `/link-callback` for Safari redirect return | ✅ Shipped | #51 |
| D3: PendingLink sessionStorage round-trip helpers | ✅ Shipped | #51 |
| D4: N-to-N peer model (drop MASTER_WALLET_DOMAIN, drop IS_TENANT gate) | ✅ Shipped | #54 |
| D4: PickLinkTargetView with brand registry + custom URL | ✅ Shipped | #54 |
| D5: Backend `GET /api/wallets/family/:safeAddress` | ✅ Shipped | #51 |
| D6: CSP `frame-ancestors *` + Permissions-Policy on `/link` | ✅ Shipped | #51 |
| D6: postMessage origin validation + namespaced envelope | ✅ Shipped | #51, #54 |
| **Future**: Settings → "Linked passkeys" list (family view) | ⏳ Not started | Uses backend family endpoint shipped in #51 |
| **Future**: `removeOwner` UI for revoking compromised passkeys | ⏳ Not started | Safe contract supports it; UI not yet built |

## References

- ADR 0001 — Self-custody (this ADR is its realization for recovery).
- ADR 0005 — Backend `wallets/family` endpoint introduced.
- ADR 0007 — Brand registry that enumerates peer link targets.
- Memory: `[[project-cross-domain-wallet-plan]]`,
  `[[feedback-cross-device-passkey-recovery]]`,
  `[[reference-safe-passkey-gnosis]]`.
- WebAuthn RP scoping rules:
  https://www.w3.org/TR/webauthn-2/#scope
- Safari ITP iframe storage partitioning:
  https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Storage Access API (the rejected Safari alternative):
  https://privacycg.github.io/storage-access/
