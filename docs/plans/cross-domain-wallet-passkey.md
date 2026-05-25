# Plan — cross-domain Domovina Wallet usage

**Status:** Proposed, not yet accepted.
**Date:** 2026-05-25
**Owner:** Matija Stepanic, ITalk d.o.o.

## Goal

A single Domovina passkey + single Gnosis Safe should be usable from:
- `wallet.domovina.ai` (today: works)
- Any other `*.domovina.ai` first-party app (mpt, donate, future community apps)
- Any arbitrary third-party community dApp on a non-`domovina.ai` TLD

Top-up via SEPA (Monerium) once → balance available everywhere the wallet is
embedded. No re-onboarding per app, no separate Safes per surface.

## The constraint that drives the design

WebAuthn passkeys are bound to a single **Relying Party ID** (RP ID) at
`navigator.credentials.create` time, and there is no rename API. The browser
will only surface a passkey to JS running on the matching RP origin
(or a stricter subdomain).

Importantly: the **on-chain SafeWebAuthn signer does NOT enforce RP ID**.
The proxy verifies a P-256 signature over a clientDataHash + authenticatorData
against the stored pubkey. It does not check what origin produced the assertion.
The browser is the only gatekeeper on RP ID; any origin that can convince the
browser to produce an assertion against the stored pubkey can sign for the Safe.

The plan therefore is about **how to convince the browser to surface the
passkey to other origins**, not about smart-contract changes.

## Three implementation options

### Option 1 — Parent-domain RP ID

Set `RP_ID = 'domovina.ai'` (parent) instead of `'wallet.domovina.ai'`
(subdomain) at passkey creation time. Passkeys created with that RP ID are
surface-able to any `*.domovina.ai` page.

- **Pro:** Trivial. Zero contract change. Standard W3C, works in every browser.
- **Pro:** All first-party sites (wallet, mpt, donate, future) can natively
  use the same passkey.
- **Con:** Does NOT help third-party `*.community.app` TLDs.
- **Con:** Existing passkeys (RP ID = `wallet.domovina.ai`) cannot be
  retroactively rescoped. Either keep using them as wallet-only, or run a
  "promote passkey" flow that enrolls a second passkey under `domovina.ai`
  and adds it as a second Safe owner.

### Option 2 — Related Origin Requests (WebAuthn Level 3)

W3C's official cross-domain mechanism. The RP publishes
`/.well-known/webauthn` at its domain listing related origins; those origins
can request assertions with the RP's RP ID.

```json
{
  "origins": [
    "https://anycommunity.app",
    "https://anothercommunity.io"
  ]
}
```

- **Pro:** Exactly the right primitive. Any TLD can share the passkey.
  Central whitelist remains under our control.
- **Pro:** No iframe, no SDK — native WebAuthn API on the third-party site.
- **Con:** iOS Safari support is rolling but not universal as of 2026-05.
  Chrome 128+ supports it; Firefox catching up.
- **Verdict:** Future ideal. Plan target ~2027 once iOS Safari adoption is
  broadly stable.

### Option 3 — Iframe SDK (Magic.link / Privy pattern)

Community dApp embeds `wallet.domovina.ai` as an iframe. The WebAuthn call
runs inside the iframe (origin = `wallet.domovina.ai`), so RP ID matches.
The iframe and outer page communicate via `postMessage`.

```html
<script src="https://wallet.domovina.ai/sdk.js"></script>
<script>
  const wallet = await Domovina.connect();
  const txHash = await wallet.send({ to: '0x…', amount: '1.5' });
</script>
```

- **Pro:** Works today, every browser. Industry-standard pattern.
- **Pro:** Wallet domain remains `wallet.domovina.ai`, RP ID unchanged —
  existing passkeys continue working without migration.
- **Pro:** Same Safe, same balance, no contract change.
- **Con:** Iframe is a third-party context — Safari ITP blocks storage by
  default. Mitigation: Storage Access API one-tap consent.
- **Con:** Requires shipping + maintaining the SDK package.

## Recommendation: hybrid 1 + 3

**Ship in this order:**

1. **Iframe SDK first.** Unblocks every cross-domain scenario immediately
   without touching existing passkeys or contracts. Establishes the
   embedded-wallet API surface that community dApps integrate against.
2. **Parent-domain RP ID for new enrollments.** New passkeys are created
   under `RP_ID = 'domovina.ai'`. First-party `*.domovina.ai` apps can then
   use them natively (no iframe). Existing passkeys keep working on
   `wallet.domovina.ai`.
3. **Migration affordance for existing users.** Settings → "Proširi pristup
   na sve aplikacije" → enroll a second passkey under `domovina.ai` RP +
   `addOwnerWithThreshold` on the Safe. User now has two passkeys controlling
   the same Safe; the new one works everywhere on `*.domovina.ai` natively
   plus via the iframe SDK from anywhere else.
4. **Related Origin Requests, 2027+** once iOS Safari has stable broad
   support. Replaces the iframe SDK for third-party dApps with a native
   WebAuthn call; iframe SDK remains as fallback for older browsers.

## Phasing (concrete tasks)

### Phase A — Iframe SDK MVP (~1-2 sessions)

- New repo `sdk.domovina.ai` (or sub-path on wallet.domovina.ai serving
  `/sdk.js` + `/embed.html`).
- Two artefacts:
  - **Embed HTML page** at `wallet.domovina.ai/embed` — minimal app that
    handles `connect`, `getAddress`, `send`, `signMessage` commands via
    `postMessage`. Strips the full app UI; only renders modal-style prompts
    for actions that need user attention (passkey prompt, Send confirmation).
  - **Bundler-friendly SDK JS** that creates the iframe, manages
    `postMessage` round-trips, exposes a Promise-based API.
- Storage Access API consent flow built in — first command from a fresh
  third-party context shows a one-line consent prompt before the iframe
  can use its passkey/state.
- Reference integration: a tiny test page at `sdk-test.domovina.ai` showing
  the connect → send flow end-to-end.
- README with copy-paste integration snippet for community dApp developers.

### Phase B — Parent-domain RP ID for new enrollments (~0.5-1 session)

- `wallet/src/lib/constants.ts` — change `RP_ID` derivation:
  - If `window.location.hostname` ends in `.domovina.ai`, return
    `'domovina.ai'`. Otherwise current behaviour.
- `createPasskey()` continues to work — new passkeys silently land under the
  parent RP ID. No new user-facing flag.
- The on-chain signer is unchanged (it does not care about RP ID).
- Confirm via test: create new wallet on wallet.domovina.ai → open
  donate.domovina.ai → existing passkey surfaces in the picker.

### Phase C — Existing-passkey "expand access" affordance (~0.5-1 session)

- Settings → Sigurnost → new row "Proširi na sve domovina.ai aplikacije".
- Tap → enrolls a second passkey under `RP_ID = 'domovina.ai'` with a
  different `user.id` (so iCloud/Google show it as a distinct entry).
- Issues a `addOwnerWithThreshold` call on the user's Safe via the existing
  relay path so the second passkey is now an owner.
- New PasskeyRecord saved alongside the original; both visible in
  WalletSwitcherSheet with a "domain scope" label.
- Edge: user might not want to migrate (e.g. wants to keep wallet.domovina.ai
  isolated). Affordance is opt-in; nothing forced.

### Phase D — Related Origin Requests (2027+, gated on iOS Safari support)

- Publish `wallet.domovina.ai/.well-known/webauthn` with whitelist of
  partner community origins.
- SDK fallback path: detect Related Origin support, prefer it over iframe
  for assertion calls when available.
- Iframe path stays in place for browsers without ROR support.

## Open questions

- **SDK package distribution.** NPM (`@domovina/wallet-sdk`) vs raw script
  tag vs both. NPM is more idiomatic for serious integrators; raw script
  tag lowers barrier for casual demos. Probably ship both.
- **Embed UI fidelity.** Minimal modal vs full app inside iframe. Minimal
  modal feels more native to the host dApp; full app risks identity confusion
  ("am I on wallet.domovina.ai or community.app?"). Lean minimal modal.
- **SDK auth model for third-party dApps.** Anyone can `<script src="…">` —
  do we want optional `appId` parameters that we whitelist server-side for
  analytics / abuse signal? Probably yes for v2; v1 ships open.
- **postMessage origin verification.** SDK must verify `event.origin ===
  'https://wallet.domovina.ai'` on every incoming message; iframe must
  similarly verify the parent origin during initial handshake. Standard
  CSP discipline.
- **Activity feed parity.** Onchain Transfer events read directly from
  Gnosis — same across all surfaces. No replication needed.
- **Recipient address book scope.** Currently per-device (localStorage on
  wallet.domovina.ai). Cross-domain via iframe inherits the same store
  automatically (same origin). For `*.domovina.ai` native pages under
  Phase B, the localStorage is per-subdomain — a small "address book sync"
  feature could move it to a hosted endpoint or use Service Worker
  cross-tab broadcast. Open.

## What this plan does NOT change

- **ADR 0001 self-custody posture.** Same passkey-only authority over user
  Safes. Iframe SDK runs in our origin but **does not hold any key** — every
  signature still requires the user's biometric.
- **ADR 0003 / 0004 verifier custody for SBT.** Orthogonal — the cross-
  domain plan is about user wallet UX, not the Phase 5 phone attestation
  verifier.
- **Relay model.** Same CF Worker `/api/relay`; same xDAI gas sponsorship;
  same 5/day free-tier quota (now per-signer-address — which is stable
  across surfaces since it derives from the same passkey pubkey).

## References

- [ADR 0001 — no server-side recovery](../decisions/0001-no-server-side-recovery.md)
- WebAuthn Level 3 — Related Origin Requests:
  https://w3c.github.io/webauthn/#sctn-related-origins
- Storage Access API: https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API
- Magic.link iframe pattern (reference for embed UX):
  https://magic.link/docs
- Privy embedded wallet SDK (reference for iframe-based wallets):
  https://docs.privy.io
